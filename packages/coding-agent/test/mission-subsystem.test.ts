import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MissionFileService } from "../src/mission/file-service";
import { aggregateProgressLog, countsByStatus, latestWorkerHandoff, unreviewedHandoffCount } from "../src/mission/progress-log";
import { retryWithBackoff } from "../src/mission/runner";
import type { MissionFeaturesFile, ProgressLogEntry } from "../src/mission/types";

describe("mission file-service", () => {
	it("read/write/validate features", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		const data: MissionFeaturesFile = { features: [{ id: "f1", title: "t", description: "d", status: "pending", owner: null, handoffId: null, createdAt: "x", updatedAt: "x" }], initialFeatureCount: 1, scopeGrowthMultiplier: 1.5 };
		await svc.writeFeatures(data);
		const read = await svc.readFeatures();
		expect(read.features[0].id).toBe("f1");
		expect(svc.validateFeaturesFile({ features: [{ id: "" }], initialFeatureCount: 1, scopeGrowthMultiplier: 1.5 }).length).toBeGreaterThan(0);
	});

	it("scope growth pauses", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		const data: MissionFeaturesFile = { features: [{ id: "f1", title: "t", description: "d", status: "pending", owner: null, handoffId: null, createdAt: "x", updatedAt: "x" }, { id: "f2", title: "t2", description: "d2", status: "pending", owner: null, handoffId: null, createdAt: "x", updatedAt: "x" }], initialFeatureCount: 1, scopeGrowthMultiplier: 1.5 };
		await svc.writeFeatures(data);
		await svc.startMissionRun();
		const paused = await svc.checkScopeGrowth();
		expect(paused).toBe(true);
		const state = await svc.readMissionState();
		expect(state.state).toBe("paused");
		expect(state.pauseReason).toBe("scope_growth_limit_exceeded");
	});

	it("dismiss handoffs", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		const entry: ProgressLogEntry = { type: "worker_completed", workerId: "w1", featureId: "f1", handoff: { summary: "s" } , timestamp: new Date().toISOString() };
		await svc.appendProgressLog(entry);
		const r = await svc.dismissHandoffItems(["a"]);
		expect(r.dismissed).toBe(1);
		const unrev = await unreviewedHandoffCount(svc);
		expect(unrev).toBe(0);
	});

	it("access guard traversal", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		const inside = path.join(dir, "features.json");
		const outside = "/etc/passwd";
		const r1 = await svc.enforceMissionAccess(inside);
		expect(r1.allowed).toBe(true);
		const r2 = await svc.enforceMissionAccess(path.join(dir, "..", "x"));
		expect(r2.allowed).toBe(false);
		const r3 = await svc.enforceMissionAccess(outside);
		expect(r3.allowed).toBe(false);
	});

	it("model settings merge", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		await Bun.write(path.join(dir, "model-settings.json"), JSON.stringify({ model: "persisted" }));
		const merged = await svc.readEffectiveModelSettings();
		expect(merged.model).toBe("persisted");
	});
});

describe("progress-log", () => {
	it("aggregation/filter", async () => {
		using tempDir = TempDir.createSync("@mission-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		await svc.appendProgressLog({ type: "worker_completed", workerId: "w1", featureId: "f1", handoff: { summary: "s" } , timestamp: new Date().toISOString() } );
		await svc.appendProgressLog({ type: "mission_paused", pauseReason: "x", timestamp: new Date().toISOString() } );
		const agg = await aggregateProgressLog(svc);
		expect(agg.total).toBe(2);
		expect(agg.workerHandoffCount).toBe(1);
		const counts = await countsByStatus(svc);
		expect(counts.worker_completed).toBe(1);
		const latest = await latestWorkerHandoff(svc);
		expect(latest?.summary).toBe("s");
	});
});

describe("runner retry", () => {
	it("retries and succeeds", async () => {
		let calls = 0;
		const result = await retryWithBackoff(async () => {
			calls++;
			if (calls < 3) throw new Error("fail");
			return "ok";
		}, { maxRetries: 3, baseDelayMs: 1 });
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});
	it("idempotency throws after attempts", async () => {
		let calls = 0;
		await expect(retryWithBackoff(async () => { calls++; throw new Error("boom"); }, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow("boom");
		expect(calls).toBe(2);
	});
});