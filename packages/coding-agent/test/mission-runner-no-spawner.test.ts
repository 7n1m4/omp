import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as structuredSubagent from "../src/task/structured-subagent";
import { NO_WORKER_SPAWNER_ERROR, runMission } from "../src/mission/runner";
import { MissionFileService } from "../src/mission/file-service";
import { createStartMissionRunTool } from "../src/tools/mission";
import type { ToolSession } from "../src/tools";
import type { MissionFeaturesFile, ProgressLogEntry } from "../src/mission/types";

/** `runMission` only touches `session.missionDir`, so a directory stub is enough. */
function makeSession(dir: string): ToolSession {
	return { missionDir: dir } as unknown as ToolSession;
}

async function writePendingFeature(dir: string): Promise<void> {
	const svc = new MissionFileService(dir);
	const data: MissionFeaturesFile = {
		features: [
			{
				id: "f1",
				title: "t",
				description: "d",
				status: "pending",
				owner: null,
				handoffId: null,
				createdAt: "x",
				updatedAt: "x",
			},
		],
		initialFeatureCount: 1,
		scopeGrowthMultiplier: 1.5,
	};
	await svc.writeFeatures(data);
}

async function readFeatures(dir: string): Promise<MissionFeaturesFile> {
	const svc = new MissionFileService(dir);
	return await svc.readFeatures();
}

async function readLogEntries(dir: string): Promise<ProgressLogEntry[]> {
	const raw = await Bun.file(`${dir}/progress_log.jsonl`).text();
	return raw
		.split("\n")
		.filter(l => l.length > 0)
		.map(l => JSON.parse(l) as ProgressLogEntry);
}

describe("runMission without a worker spawner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not mark a feature completed when nothing spawns a worker", async () => {
		// Prevents: `/mission` + a run reporting success while no worker subagent was
		// ever launched — every feature was fabricated `successState: "success"`.
		using tempDir = TempDir.createSync("@mission-nospawn-");
		const dir = tempDir.path();
		await writePendingFeature(dir);

		await runMission(makeSession(dir));

		const features = await readFeatures(dir);
		expect(features.features[0].status).not.toBe("completed");
	});

	it("records the failure in the worker handoff instead of a fake success", async () => {
		// Prevents: a handoff claiming `successState: "success"` with summary "Completed"
		// when no worker ran, which is what silently closed out the feature.
		using tempDir = TempDir.createSync("@mission-nospawn-");
		const dir = tempDir.path();
		await writePendingFeature(dir);

		await runMission(makeSession(dir));

		const completed = (await readLogEntries(dir)).filter(
			(e): e is Extract<ProgressLogEntry, { type: "worker_completed" }> => e.type === "worker_completed",
		);
		expect(completed.length).toBe(1);
		expect(completed[0].handoff.successState).toBe("failure");
		expect(completed[0].handoff.summary).toContain(NO_WORKER_SPAWNER_ERROR);
		expect(completed[0].handoff.lastError).toBe(NO_WORKER_SPAWNER_ERROR);
	});

	it("does not mark a feature completed when the run's worker fails", async () => {
		// Prevents: the tool reporting a completed feature for a run whose worker
		// could not produce a handoff. `start_mission_run` now drives the run itself
		// and injects the spawner, so the runner reaches the spawner instead of its
		// no-spawner guard; a failing spawner must still leave the feature unfinished.
		using tempDir = TempDir.createSync("@mission-nospawn-");
		const dir = tempDir.path();
		await writePendingFeature(dir);

		const spawn = vi
			.spyOn(structuredSubagent, "runStructuredSubagent")
			.mockRejectedValue(new Error("worker unavailable"));
		const tool = createStartMissionRunTool(makeSession(dir));
		expect(tool).not.toBeNull();
		const result = await tool!.execute("call-mission-run", {}, undefined, undefined, undefined);
		const text = result.content[0];
		expect(text.type).toBe("text");
		const payload = JSON.parse(text.type === "text" ? text.text : "{}") as {
			success: boolean;
			error?: string;
		};
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(payload.success).toBe(true);
		expect((await readFeatures(dir)).features[0].status).not.toBe("completed");
		const completed = (await readLogEntries(dir)).filter(
			(e): e is Extract<ProgressLogEntry, { type: "worker_completed" }> => e.type === "worker_completed",
		);
		expect(completed.length).toBe(1);
		expect(completed[0].handoff.successState).toBe("failure");
		expect(completed[0].handoff.lastError).toBe("worker unavailable");
	});

	it("kills the run before it spawns a worker once the caller's signal is aborted", async () => {
		// Prevents: Ctrl-C during a mission run leaving every remaining feature to
		// keep spawning workers, because the tool dropped the signal it was handed.
		using tempDir = TempDir.createSync("@mission-abort-");
		const dir = tempDir.path();
		await writePendingFeature(dir);

		const spawn = vi.spyOn(structuredSubagent, "runStructuredSubagent");
		const abort = new AbortController();
		abort.abort();
		const tool = createStartMissionRunTool(makeSession(dir));
		expect(tool).not.toBeNull();
		const result = await tool!.execute("call-mission-abort", {}, abort.signal, undefined, undefined);

		expect(spawn).not.toHaveBeenCalled();
		const text = result.content[0];
		expect(text.type).toBe("text");
		const payload = JSON.parse(text.type === "text" ? text.text : "{}") as { success: boolean; cancelled?: boolean };
		expect(payload.success).toBe(true);
		expect(payload.cancelled).toBe(true);
		expect((await readFeatures(dir)).features[0].status).not.toBe("completed");
	});
});
