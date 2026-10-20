import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { MissionFileService } from "../src/mission/file-service";
import { runMission, type RunMissionWorkerContext } from "../src/mission/runner";
import type { MissionFeaturesFile, ProgressLogEntry } from "../src/mission/types";
import * as structuredSubagent from "../src/task/structured-subagent";
import type { EffectiveSubagentPolicy, StructuredSubagentResult } from "../src/task/structured-subagent";
import { renderMissionAssignment, spawnMissionWorker } from "../src/tools/mission";
import type { ToolSession } from "../src/tools";

/** `runMission` only touches `session.missionDir`, so a directory stub is enough. */
function makeSession(dir: string): ToolSession {
	return { missionDir: dir } as unknown as ToolSession;
}

/** A settled child run whose structured output validated against the handoff schema. */
function validResult(data: unknown): SingleResult {
	return {
		index: 0,
		id: "w1",
		agent: "mission-worker-base",
		agentSource: "bundled",
		task: "implement the feature",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		structuredOutput: { source: "caller", mode: "permissive", status: "valid", data },
		durationMs: 1,
		tokens: 1,
		requests: 1,
	};
}

function executionOf(result: SingleResult): StructuredSubagentResult {
	return {
		result,
		policy: {} as EffectiveSubagentPolicy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp",
		temporaryArtifacts: false,
	};
}

function successHandoff(): Record<string, unknown> {
	return {
		successState: "success",
		summary: "Implemented the feature",
		whatWasImplemented: "src/a.ts",
		verification: "bun test passed",
		artifacts: ["src/a.ts"],
	};
}

function buildFeatures(maxRetries?: number, backoff?: number): MissionFeaturesFile {
	return {
		features: [
			{
				id: "f1",
				title: "Add the widget",
				description: "Build the widget so it works.",
				status: "pending",
				owner: null,
				handoffId: null,
				createdAt: "x",
				updatedAt: "x",
				...(maxRetries !== undefined ? { maxRetries } : {}),
				...(backoff !== undefined ? { backoff } : {}),
			},
		],
		initialFeatureCount: 1,
		scopeGrowthMultiplier: 1.5,
	};
}

async function writePendingFeature(dir: string, retries?: { maxRetries: number; backoff: number }) {
	const svc = new MissionFileService(dir);
	const features = buildFeatures(retries?.maxRetries, retries?.backoff);
	await svc.writeFeatures(features);
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

/** Read the feature's live status while the runner is mid-flight. */
async function featureStatus(svc: MissionFileService, featureId: string): Promise<string> {
	const features = await svc.readFeatures();
	return features.features.find(f => f.id === featureId)?.status ?? "missing";
}

function workerContext(dir: string, svc: MissionFileService): RunMissionWorkerContext {
	return {
		session: makeSession(dir),
		svc,
		featureId: "f1",
		workerModel: undefined,
		workerEffort: undefined,
		validationModel: undefined,
		validationEffort: undefined,
		signal: undefined,
	};
}

describe("runMission with a worker spawner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drives a feature from pending through in_progress to completed when the worker succeeds", async () => {
		// Prevents: a spawned worker run that never advances feature status, leaving
		// the mission stuck on `pending` and reporting nothing was done.
		using tempDir = TempDir.createSync("@mission-run-ok-");
		const dir = tempDir.path();
		await writePendingFeature(dir);

		const observed: string[] = [];
		const result = await runMission(makeSession(dir), {
			spawnWorker: async context => {
				observed.push(`status:${await featureStatus(context.svc, context.featureId)}`);
				return { successState: "success", summary: "done", artifacts: [] };
			},
			onWorkerStart: () => {
				observed.push("event:worker_started");
			},
			onWorkerComplete: (_featureId, handoff) => {
				observed.push(`event:worker_completed:${handoff.successState}`);
			},
		});

		expect(result.success).toBe(true);
		expect(observed).toEqual(["event:worker_started", "status:in_progress", "event:worker_completed:success"]);
		const features = await readFeatures(dir);
		expect(features.features[0].status).toBe("completed");
	});

	it("retries a throwing worker with backoff and leaves the feature in_progress when every attempt fails", async () => {
		// Prevents: a worker that throws marking the feature `completed` anyway, or
		// the retry loop spinning with no delay between attempts.
		using tempDir = TempDir.createSync("@mission-run-fail-");
		const dir = tempDir.path();
		await writePendingFeature(dir, { maxRetries: 2, backoff: 1 });
		const startedAt = Date.now();
		let attempts = 0;

		const result = await runMission(makeSession(dir), {
			spawnWorker: () => {
				attempts += 1;
				throw new Error("worker exploded");
			},
		});

		// backoff 1ms doubling: attempt 2 waits 1ms, attempt 3 waits 2ms.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2);
		// maxRetries 2 means the feature is attempted three times.
		expect(attempts).toBe(3);
		expect(result.success).toBe(true);
		const features = await readFeatures(dir);
		expect(features.features[0].status).toBe("in_progress");
		const completed = (await readLogEntries(dir)).filter(
			(e): e is Extract<ProgressLogEntry, { type: "worker_completed" }> => e.type === "worker_completed",
		);
		expect(completed.length).toBe(1);
		expect(completed[0].handoff.successState).toBe("failure");
		expect(completed[0].handoff.lastError).toBe("worker exploded");
		expect(completed[0].handoff.retryCount).toBe(2);
	});
});

describe("spawnMissionWorker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the feature assignment and passes the configured model and effort to the child", async () => {
		// Prevents: the spawner hard-coding a model or effort, silently discarding
		// `MISSION_WORKER_MODEL`/`MISSION_WORKER_REASONING_EFFORT`.
		using tempDir = TempDir.createSync("@mission-spawn-map-");
		const dir = tempDir.path();
		await writePendingFeature(dir);
		const svc = new MissionFileService(dir);
		const requests: Record<string, unknown>[] = [];
		const spy = vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async (input: unknown) => {
			const request = input as Record<string, unknown>;
			requests.push(request);
			return executionOf(validResult(successHandoff()));
		});

		const context: RunMissionWorkerContext = {
			...workerContext(dir, svc),
			workerModel: "anthropic/claude-sonnet-4-5",
			workerEffort: "hi",
		};
		const handoff = await spawnMissionWorker(context);

		expect(spy).toHaveBeenCalledTimes(1);
		const request = requests[0];
		expect(typeof request.assignment).toBe("string");
		expect(request.assignment as string).toContain("Add the widget");
		expect(request.assignment as string).toContain("Build the widget so it works.");
		expect(request.assignment as string).toContain(dir);
		expect(request.agent).toBe("mission-worker-base");
		expect(request.model).toBe("anthropic/claude-sonnet-4-5");
		expect(request.effort).toBe("hi");
		expect(request.structured).toBe(true);
		expect(handoff).toMatchObject({
			successState: "success",
			summary: "Implemented the feature",
			whatWasImplemented: "src/a.ts",
			artifacts: ["src/a.ts"],
		});
	});

	it("leaves the model unset when no worker model is configured so the agent sentinel resolves", async () => {
		// Prevents: an unset `MISSION_WORKER_MODEL` resolving through the
		// subagent-forced path instead of `mission-worker-base`'s own `@task`.
		using tempDir = TempDir.createSync("@mission-spawn-nomodel-");
		const dir = tempDir.path();
		await writePendingFeature(dir);
		const svc = new MissionFileService(dir);
		const requests: Record<string, unknown>[] = [];
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async (input: unknown) => {
			requests.push(input as Record<string, unknown>);
			return executionOf(validResult(successHandoff()));
		});

		await spawnMissionWorker(workerContext(dir, svc));

		expect(requests.length).toBe(1);
		expect(Object.hasOwn(requests[0], "model")).toBe(false);
		expect(Object.hasOwn(requests[0], "effort")).toBe(false);
	});

	it("throws instead of returning a handoff when the child reports failure", async () => {
		// Prevents: a `successState: "failure"` handoff being returned, which the
		// runner reads as success and marks the feature `completed`.
		using tempDir = TempDir.createSync("@mission-spawn-fail-");
		const dir = tempDir.path();
		await writePendingFeature(dir);
		const svc = new MissionFileService(dir);
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () =>
			executionOf(
				validResult({
					successState: "failure",
					summary: "Could not finish",
					whatWasLeftUndone: "blocked on a decision",
					artifacts: [],
				}),
			),
		);

		let thrown: unknown;
		try {
			await spawnMissionWorker(workerContext(dir, svc));
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("worker reported failure");
		expect((thrown as Error).message).toContain("blocked on a decision");
	});

	it("throws instead of returning a handoff when the child result never validated", async () => {
		// Prevents: a child that crashed, was aborted, or exited nonzero being
		// mapped into a usable handoff and closing the feature out.
		using tempDir = TempDir.createSync("@mission-spawn-invalid-");
		const dir = tempDir.path();
		await writePendingFeature(dir);
		const svc = new MissionFileService(dir);
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () =>
			executionOf({
				...validResult(undefined),
				exitCode: 1,
				structuredOutput: { source: "caller", mode: "permissive", status: "invalid", error: "bad shape" },
			}),
		);

		let thrown: unknown;
		try {
			await spawnMissionWorker(workerContext(dir, svc));
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("bad shape");
	});
});

describe("renderMissionAssignment", () => {
	it("carries the feature identity, mission directory, and reporting contract", async () => {
		// Prevents: an assignment that omits the mission directory or the handoff
		// contract, so the worker cannot find the mission or report a failure.
		using tempDir = TempDir.createSync("@mission-assign-");
		const dir = tempDir.path();
		const text = renderMissionAssignment(
			{
				id: "f1",
				title: "Add the widget",
				description: "Build the widget so it works.",
				status: "pending",
				owner: null,
				handoffId: null,
				createdAt: "x",
				updatedAt: "x",
			},
			dir,
		);
		expect(text).toContain("`f1`");
		expect(text).toContain("Add the widget");
		expect(text).toContain("Build the widget so it works.");
		expect(text).toContain(dir);
		expect(text).toContain("successState");
		expect(text).toContain("verification");
	});
});
