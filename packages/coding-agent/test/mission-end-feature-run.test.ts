import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MissionFileService } from "../src/mission/file-service";
import type { MissionFeature, MissionFeaturesFile } from "../src/mission/types";

const FEATURE: MissionFeature = {
	id: "f1",
	title: "t",
	description: "d",
	status: "in_progress",
	owner: null,
	handoffId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Seed a real mission dir so the persisted `features.json` is genuinely exercised. */
async function seedService(
	dir: string,
	features: MissionFeature[],
	overrides: Partial<MissionFeaturesFile> = {},
): Promise<MissionFileService> {
	const svc = new MissionFileService(dir);
	await svc.initMissionDir(dir);
	await svc.writeFeatures({
		features,
		initialFeatureCount: overrides.initialFeatureCount ?? features.length,
		scopeGrowthMultiplier: overrides.scopeGrowthMultiplier ?? 1.5,
	});
	return svc;
}

function feature(id: string, status: MissionFeature["status"]): MissionFeature {
	return { ...FEATURE, id, status };
}

describe("endFeatureRun", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Consumer-visible failure: the scope-growth check paused the mission, yet
	// `features.json` had already been written claiming the feature `completed`,
	// so the durable record said the work was done for a run that never landed.
	it("does not persist `completed` for a feature whose run the scope-growth check halts", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress")]);
		vi.spyOn(svc, "checkScopeGrowth").mockResolvedValue(true);

		const result = await svc.endFeatureRun("f1");

		const persisted = await svc.readFeatures();
		expect(persisted.features.find(f => f.id === "f1")?.status).toBe("in_progress");
		// Paused and completed must be distinguishable: the caller cannot otherwise
		// tell "this feature was completed" from "the mission halted".
		expect(result).toEqual({ success: true, paused: true, completed: false });
	});

	// Consumer-visible failure: one call reported both a pause and a mission
	// completion, so an agent read "mission complete" for a run that had halted.
	it("never reports a mission completion from the same call that reports a pause", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress")]);
		const scopeGrowth = vi.spyOn(svc, "checkScopeGrowth").mockResolvedValue(true);
		const completeIfAllFeaturesDone = vi.spyOn(svc, "completeIfAllFeaturesDone");

		const result = await svc.endFeatureRun("f1");

		expect(scopeGrowth).toHaveBeenCalledTimes(1);
		expect(completeIfAllFeaturesDone).not.toHaveBeenCalled();
		expect(result.paused).toBe(true);
		expect(result.completed).toBe(false);
	});

	// Consumer-visible failure: the real `checkScopeGrowth` (no spy) paused the
	// mission and the feature was still stamped `completed` on disk.
	it("leaves the feature unfinished when the real scope-growth limit is exceeded", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress"), feature("f2", "in_progress")], {
			initialFeatureCount: 1,
			scopeGrowthMultiplier: 1.5,
		});
		await svc.startMissionRun();

		const result = await svc.endFeatureRun("f1");

		const persisted = await svc.readFeatures();
		expect(persisted.features.find(f => f.id === "f1")?.status).not.toBe("completed");
		expect(result.paused).toBe(true);
		expect(result.completed).toBe(false);
		const state = await svc.readMissionState();
		expect(state.state).toBe("paused");
		expect(state.pauseReason).toBe("scope_growth_limit_exceeded");
	});

	// Consumer-visible failure: fixing the ordering broke the happy path -- the
	// feature stayed unfinished and the mission never completed once all work
	// was done, so the agent could not tell the mission had finished.
	it("marks the feature completed and completes the mission when all features are done", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress"), feature("f2", "in_progress")], {
			initialFeatureCount: 2,
		});
		await svc.startMissionRun();

		const first = await svc.endFeatureRun("f1");

		let persisted = await svc.readFeatures();
		expect(persisted.features.find(f => f.id === "f1")?.status).toBe("completed");
		expect(persisted.features.find(f => f.id === "f2")?.status).toBe("in_progress");
		expect(first).toEqual({ success: true, paused: false, completed: false });
		expect((await svc.readMissionState()).state).toBe("running");

		const second = await svc.endFeatureRun("f2");

		persisted = await svc.readFeatures();
		expect(persisted.features.every(f => f.status === "completed")).toBe(true);
		expect(second).toEqual({ success: true, paused: false, completed: true });
		const state = await svc.readMissionState();
		expect(state.state).toBe("completed");
		expect(state.pauseReason).toBeNull();
	});

	// Consumer-visible failure: an empty or blank `featureId` reported success
	// and rewrote `features.json` instead of failing the call.
	it("rejects an empty or non-string featureId without touching features.json", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress")]);
		const before = await svc.readFeatures();

		expect(await svc.endFeatureRun("")).toEqual({ success: false });
		expect(await svc.endFeatureRun("   ")).toEqual({ success: false });
		expect(await svc.endFeatureRun(undefined as unknown as string)).toEqual({ success: false });

		expect(await svc.readFeatures()).toEqual(before);
	});

	// Consumer-visible failure: an unknown feature id reported success and
	// completed the whole mission on someone else's behalf.
	it("rejects an unknown featureId", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress")]);

		expect(await svc.endFeatureRun("nope")).toEqual({ success: false });
		expect((await svc.readFeatures()).features[0].status).toBe("in_progress");
	});

	// Consumer-visible failure: a duplicated `end_feature_run` for the same
	// feature must keep the durable record stable -- it may not un-complete the
	// feature, resurrect the mission, or flip the pause flag on its own.
	it("is stable when called twice for the same feature", async () => {
		using tempDir = TempDir.createSync("@mission-efr-");
		const svc = await seedService(tempDir.path(), [feature("f1", "in_progress")], { initialFeatureCount: 1 });
		await svc.startMissionRun();

		const first = await svc.endFeatureRun("f1");
		const second = await svc.endFeatureRun("f1");

		expect((await svc.readFeatures()).features[0].status).toBe("completed");
		expect((await svc.readMissionState()).state).toBe("completed");
		expect(first.completed).toBe(true);
		// The second call completed nothing itself; the mission was already
		// complete, so it must not claim to have completed it again.
		expect(second).toEqual({ success: true, paused: false, completed: false });
	});
});
