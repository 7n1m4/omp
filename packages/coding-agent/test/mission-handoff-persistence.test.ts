import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MissionFileService } from "../src/mission/file-service";
import { handoffPath, readLatestHandoff } from "../src/mission/handoff-store";
import { runMission } from "../src/mission/runner";
import type { MissionFeaturesFile, ProgressLogEntry, ValidationState, WorkerHandoff } from "../src/mission/types";
import type { ToolSession } from "../src/tools";

/** `runMission` only touches `session.missionDir`, so a directory stub is enough. */
function makeSession(dir: string): ToolSession {
	return { missionDir: dir } as unknown as ToolSession;
}

/** A feature that can run: `maxRetries: 0` so a throwing worker fails immediately. */
function buildFeatures(featureId: string): MissionFeaturesFile {
	return {
		features: [
			{
				id: featureId,
				title: "Add the widget",
				description: "Build the widget so it works.",
				status: "pending",
				owner: null,
				handoffId: null,
				createdAt: "x",
				updatedAt: "x",
				maxRetries: 0,
			},
		],
		initialFeatureCount: 1,
		scopeGrowthMultiplier: 1.5,
	};
}

async function seedMission(dir: string, featureId: string): Promise<MissionFileService> {
	const svc = new MissionFileService(dir);
	await svc.initMissionDir(dir);
	await svc.writeFeatures(buildFeatures(featureId));
	return svc;
}

async function readFeatureStatus(dir: string, featureId: string): Promise<string> {
	const svc = new MissionFileService(dir);
	const features = await svc.readFeatures();
	return features.features.find(f => f.id === featureId)?.status ?? "missing";
}

async function readLogEntries(dir: string): Promise<ProgressLogEntry[]> {
	const raw = await Bun.file(`${dir}/progress_log.jsonl`).text();
	return raw
		.split("\n")
		.filter(l => l.length > 0)
		.map(l => JSON.parse(l) as ProgressLogEntry);
}

/** Make `runValidators` fail exactly like a crashed validator would. */
function validatorsFail(reason: string): void {
	vi.spyOn(MissionFileService.prototype, "runValidators").mockRejectedValue(new Error(reason));
}

/**
 * The `spawnValidator` option that runs and passes, threaded by `runMission` into
 * `runValidators`. This is the real production path when a caller fills the seam:
 * omitting it makes `runValidators` record `status: "fail"` for every validator,
 * which Bug 1's fix correctly treats as a failed validation.
 */
const passingValidator = async (
	validator: string,
	featureId: string,
): Promise<{ status: "pass"; findings: string[] }> => ({
	status: "pass",
	findings: [`${validator} checked ${featureId}`],
});

describe("mission validation failure", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records a failed validation durably and does not let the feature stand as validated", async () => {
		// Prevents: `retryWithBackoff` swallowing a validator crash, so a feature
		// already marked `completed` reports as a validated success while nothing
		// validated it and `validation-state.json` never records the failure.
		using tempDir = TempDir.createSync("@mission-validation-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");
		validatorsFail("validator crashed");

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.paused).toBe(true);
		expect(result.validationFailed).toBe("f1");
		expect(result.validationError).toBe("validator crashed");
		// The feature must not stand as a validated success.
		expect(await readFeatureStatus(dir, "f1")).toBe("in_progress");
		// The failure is in durable state, not just the return value.
		const state = JSON.parse(await Bun.file(`${dir}/mission-state.json`).text()) as {
			state: string;
			pauseReason: string | null;
		};
		expect(state.state).toBe("paused");
		expect(state.pauseReason).toBe("validation_failed: f1");
		const paused = (await readLogEntries(dir)).filter(e => e.type === "mission_paused");
		expect(paused[paused.length - 1]).toMatchObject({ pauseReason: "validation_failed: f1" });
	});

	it("does not complete a feature whose validators reported failure without throwing", async () => {
		// Prevents: the real `runValidators` resolving normally after recording
		// `status: "fail"` for validators that never ran (no `spawnValidator` is
		// passed), so the retry "succeeds", the feature is marked `completed`, and
		// the run reports success on a `validation-state.json` saying `failing`.
		// Only the recorded result proves validation; the return value does not.
		using tempDir = TempDir.createSync("@mission-validation-resolve-fail-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");
		// A throwing mock cannot reproduce this: `runValidators` resolves.
		vi.spyOn(MissionFileService.prototype, "runValidators").mockImplementation(async (id: string) => {
			const svc = new MissionFileService(dir);
			const state = await svc.readValidationState();
			state.results = state.results.filter(r => r.featureId !== id);
			state.results.push({
				validator: "scrutiny-validator",
				featureId: id,
				status: "fail",
				findings: ["validator scrutiny-validator did not run: no spawner configured"],
				runAt: new Date().toISOString(),
			});
			state.lastRunAt = new Date().toISOString();
			state.overallStatus = "failing";
			await svc.writeValidationState(state);
		});

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.validationFailed).toBe("f1");
		expect(result.validationError).toContain("no spawner configured");
		expect(await readFeatureStatus(dir, "f1")).toBe("in_progress");
		const state = JSON.parse(await Bun.file(`${dir}/validation-state.json`).text()) as ValidationState;
		expect(state.overallStatus).toBe("failing");
	});

	it("fails a run whose validator seam is unfilled rather than reporting validated", async () => {
		// Prevents: a run with no `spawnValidator` wired (today every real run)
		// recording `fail` for validators that never ran, yet returning
		// `success: true` with the feature `completed` — Bug 1 fixed only on paper.
		using tempDir = TempDir.createSync("@mission-validation-noseam-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.validationFailed).toBe("f1");
		expect(result.validationError).toContain("no spawner configured");
		expect(await readFeatureStatus(dir, "f1")).toBe("in_progress");
	});

	it("keeps the mission pausable when validation-state.json is unreadable", async () => {
		// Prevents: an unguarded `readValidationState()` rethrowing from the catch
		// block, rejecting `runMission` outright with nothing recorded and the
		// feature left `completed`.
		using tempDir = TempDir.createSync("@mission-validation-state-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");
		await Bun.write(`${dir}/validation-state.json`, "{ not json");
		validatorsFail("validator crashed");

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.validationFailed).toBe("f1");
		expect(await readFeatureStatus(dir, "f1")).toBe("in_progress");
	});

	it("records the failure in the validation state it did manage to write", async () => {
		// Prevents: a validator that wrote findings before crashing leaving no
		// trace of what it found, so a later resume retries blindly.
		using tempDir = TempDir.createSync("@mission-validation-findings-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");
		vi.spyOn(MissionFileService.prototype, "runValidators").mockImplementation(async (featureId: string) => {
			const svc = new MissionFileService(dir);
			const state: ValidationState = {
				validators: ["scrutiny-validator"],
				lastRunAt: new Date().toISOString(),
				results: [
					{
						validator: "scrutiny-validator",
						featureId,
						status: "pass",
						findings: ["found something"],
						runAt: new Date().toISOString(),
					},
				],
				overallStatus: "passing",
			};
			await svc.writeValidationState(state);
			throw new Error("second validator crashed");
		});

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
		});

		expect(result.success).toBe(false);
		expect(result.validationError).toBe("second validator crashed");
		const state = JSON.parse(await Bun.file(`${dir}/validation-state.json`).text()) as ValidationState;
		// The validator that ran kept its findings, and the run stamped the one that
		// crashed, so the state records both rather than losing the earlier evidence.
		const findings = state.results.filter(r => r.featureId === "f1").flatMap(r => r.findings);
		expect(findings).toContain("found something");
		expect(findings.some(f => f.includes("second validator crashed"))).toBe(true);
	});
});

describe("mission handoff persistence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a successful worker handoff to disk keyed to its feature and reads it back", async () => {
		// Prevents: handoffs living only in `progress_log.jsonl`, so a feature's
		// real handoff is unreachable after the run without replaying the whole log.
		using tempDir = TempDir.createSync("@mission-handoff-ok-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");
		const produced: WorkerHandoff = {
			successState: "success",
			summary: "Implemented the widget",
			whatWasImplemented: "src/widget.ts",
			verification: "bun test passed",
			artifacts: ["src/widget.ts"],
			attempts: 1,
			retryCount: 0,
		};

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => produced,
			spawnValidator: passingValidator,
		});

		expect(result.success).toBe(true);
		const svc = new MissionFileService(dir);
		const stored = await readLatestHandoff(svc, "f1");
		expect(stored).toEqual(produced);
		// Keyed to the feature, not a scan of the progress log.
		const handoffs = await Array.fromAsync(new Bun.Glob("handoffs/*.json").scan({ cwd: dir }));
		expect(handoffs).toEqual([`handoffs/${path.basename(handoffPath(dir, "f1"))}`]);
	});

	it("persists a synthesized failure handoff with its lastError visible", async () => {
		// Prevents: a worker that never produced a handoff leaving no durable
		// record of the failure, so the omitted handoff reads as "not attempted".
		using tempDir = TempDir.createSync("@mission-handoff-fail-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => {
				throw new Error("worker unavailable");
			},
			spawnValidator: passingValidator,
		});

		// The worker failure is the feature's outcome; validation never runs, so a
		// passing validator stub keeps this test about the handoff, not the run.
		expect(result.success).toBe(true);
		expect(result.validationFailed).toBeUndefined();
		expect(await readFeatureStatus(dir, "f1")).toBe("in_progress");
		const svc = new MissionFileService(dir);
		const stored = await readLatestHandoff(svc, "f1");
		expect(stored?.successState).toBe("failure");
		expect(stored?.lastError).toBe("worker unavailable");
		expect(stored?.summary).toContain("worker unavailable");
		// Not an invented success.
		expect(stored?.summary).not.toBe("Completed");
		expect(stored?.artifacts).toEqual([]);
	});

	it("keeps the return contract unchanged on the happy path", async () => {
		// Prevents: adding a validation-failure field changing what a successful
		// run reports to `start_mission_run` and the mission tool.
		using tempDir = TempDir.createSync("@mission-handoff-contract-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");

		const result = await runMission(makeSession(dir), {
			spawnWorker: async () => ({ successState: "success", summary: "done", artifacts: [] }),
			spawnValidator: passingValidator,
		});

		// The failure-only fields are absent, so a successful run is
		// indistinguishable from a pre-Bug-1 run at the consumer.
		expect(Object.keys(result).sort()).toEqual(["aggregate", "completed", "success"]);
		expect(result.success).toBe(true);
		expect(result.completed).toBe(true);
		expect(result.validationFailed).toBeUndefined();
		expect(result.validationError).toBeUndefined();
		expect(result.aggregate).toMatchObject({ workerHandoffCount: 1 });
	});

	it("leaves handoffs untouched for a mission directory that never ran a worker", async () => {
		// Prevents: writing a placeholder handoff at init time, which would make an
		// unstarted mission look like a feature had been attempted.
		using tempDir = TempDir.createSync("@mission-handoff-empty-");
		const dir = tempDir.path();
		await seedMission(dir, "f1");

		const entries = await Array.fromAsync(new Bun.Glob("handoffs/**").scan({ cwd: dir }));
		expect(entries).toEqual([]);
		const svc = new MissionFileService(dir);
		expect(await readLatestHandoff(svc, "f1")).toBeUndefined();
	});

	it("falls back to the progress log for a mission that predates the handoff store", async () => {
		// Prevents: removing the progress-log read path leaving pre-store missions
		// with no way to recover a handoff that was only ever logged.
		using tempDir = TempDir.createSync("@mission-handoff-legacy-");
		const dir = tempDir.path();
		const svc = new MissionFileService(dir);
		await svc.initMissionDir(dir);
		const legacy: WorkerHandoff = {
			successState: "success",
			summary: "Implemented before the store existed",
			artifacts: ["src/legacy.ts"],
		};
		await svc.appendProgressLog({
			type: "worker_completed",
			workerId: "mission-worker-base",
			featureId: "f1",
			handoff: legacy,
			timestamp: new Date().toISOString(),
		});

		expect(await readLatestHandoff(svc, "f1")).toEqual(legacy);
	});
});
