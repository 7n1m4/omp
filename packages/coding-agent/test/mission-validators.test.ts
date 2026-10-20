import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MissionFileService } from "../src/mission/file-service";
import type { ValidationState } from "../src/mission/types";

/** What a real validator execution reports; the status the caller supplies drives the recorded outcome. */
interface SpawnedOutcome {
	status: ValidationState["results"][number]["status"];
	findings: string[];
}

/** A seed+read pair over a real mission directory, so `validation-state.json` is genuinely exercised. */
async function seeded(dir: string): Promise<MissionFileService> {
	const svc = new MissionFileService(dir);
	await svc.initMissionDir(dir);
	return svc;
}

async function readState(svc: MissionFileService): Promise<ValidationState> {
	return await svc.readValidationState();
}

/** The recorded result for one validator of one feature. */
function resultFor(state: ValidationState, validator: string, featureId: string) {
	return state.results.find(r => r.validator === validator && r.featureId === featureId);
}

describe("runValidators", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Consumer-visible failure: a feature could be recorded as `passing` overall with
	// `findings: []` for a validator that never executed, so `validation-state.json`
	// claimed an unvalidated feature was clean. A real clean run must still carry
	// whatever findings the validator actually produced -- including none.
	it("records a real pass with the validator's actual findings when it reports none", async () => {
		using tempDir = TempDir.createSync("@mission-val-pass-");
		const svc = await seeded(tempDir.path());
		const spawnValidator = vi.fn(async (): Promise<SpawnedOutcome> => ({ status: "pass", findings: [] }));

		await svc.runValidators("f1", ["scrutiny-validator"], spawnValidator);

		const state = await readState(svc);
		const result = resultFor(state, "scrutiny-validator", "f1");
		expect(result?.status).toBe("pass");
		expect(result?.findings).toEqual([]);
		expect(result?.featureId).toBe("f1");
		expect(state.overallStatus).toBe("passing");
		// The spawn must be a real invocation, not a recording: the seam is called once per validator.
		expect(spawnValidator).toHaveBeenCalledTimes(1);
	});

	// Consumer-visible failure: THE regression. A validator that reported blocking
	// findings was recorded as `status: "pass"` with `findings: []`, so a feature
	// whose validation failed looked clean in `validation-state.json` and the
	// mission continued as if nothing was wrong.
	it("records a failing status and the validator's own findings when it reports blockers", async () => {
		using tempDir = TempDir.createSync("@mission-val-fail-");
		const svc = await seeded(tempDir.path());
		const findings = ["missing migration for the new column", "no rollback path"];
		const spawnValidator = vi.fn(async (): Promise<SpawnedOutcome> => ({ status: "fail", findings }));

		await svc.runValidators("f1", ["scrutiny-validator"], spawnValidator);

		const state = await readState(svc);
		const result = resultFor(state, "scrutiny-validator", "f1");
		expect(result?.status).toBe("fail");
		// The findings must be the validator's, verbatim -- not a synthesized summary.
		expect(result?.findings).toEqual(findings);
		expect(state.overallStatus).toBe("failing");
	});

	// Consumer-visible failure: a validator that threw, timed out, or could not run
	// at all was recorded as `status: "pass"`, so the hardest validation failure --
	// the one that never produced a verdict -- read as a clean pass.
	it("records a non-passing result when a validator throws", async () => {
		using tempDir = TempDir.createSync("@mission-val-throw-");
		const svc = await seeded(tempDir.path());
		const spawnValidator = vi.fn(async (): Promise<SpawnedOutcome> => {
			throw new Error("validator process exited with code 1");
		});

		await svc.runValidators("f1", ["user-testing-validator"], spawnValidator);

		const state = await readState(svc);
		const result = resultFor(state, "user-testing-validator", "f1");
		expect(result?.status).not.toBe("pass");
		// The reason the validator produced no verdict must survive into the record.
		expect(result?.findings.join("\n")).toContain("validator process exited with code 1");
		expect(state.overallStatus).toBe("failing");
	});

	// Consumer-visible failure: `overallStatus` was computed from results the code
	// invented, so a run that never validated anything still reported `passing`.
	// With no spawner the honest answer is `failing` -- not a pass nobody earned.
	it("reports `failing` overall when no validator spawner was configured", async () => {
		using tempDir = TempDir.createSync("@mission-val-nosp-");
		const svc = await seeded(tempDir.path());

		await svc.runValidators("f1");

		const state = await readState(svc);
		expect(state.validators).toEqual(["scrutiny-validator", "user-testing-validator"]);
		expect(state.overallStatus).toBe("failing");
		for (const v of state.validators) {
			const result = resultFor(state, v, "f1");
			expect(result?.status).toBe("fail");
			expect(result?.findings.join("\n")).toContain("did not run");
		}
		expect(state.results).toHaveLength(2);
	});

	// Consumer-visible failure: aggregating every recorded result rather than the
	// last feature's let one failing feature hide behind another feature's pass, so
	// the overall status could not be read as "the mission's real mix".
	it("aggregates the real mix across features rather than the most recent one", async () => {
		using tempDir = TempDir.createSync("@mission-val-mix-");
		const svc = await seeded(tempDir.path());
		const spawnValidator = vi.fn(async (): Promise<SpawnedOutcome> => ({ status: "pass", findings: [] }));

		await svc.runValidators("f1", ["scrutiny-validator"], spawnValidator);
		let state = await readState(svc);
		expect(state.overallStatus).toBe("passing");

		// The second feature's validator fails. The earlier feature's pass must not
		// mask it: the aggregate reads every recorded result.
		const failing = vi.fn(async (): Promise<SpawnedOutcome> => ({
			status: "fail",
			findings: ["critical regression"],
		}));
		await svc.runValidators("f2", ["scrutiny-validator"], failing);

		state = await readState(svc);
		expect(state.overallStatus).toBe("failing");
		expect(resultFor(state, "scrutiny-validator", "f2")?.status).toBe("fail");
		// f1's result is retained, and it was a real pass, so the mix is 1 pass + 1 fail.
		expect(resultFor(state, "scrutiny-validator", "f1")?.status).toBe("pass");
		expect(state.results.filter(r => r.status === "pass")).toHaveLength(1);
		expect(state.results.filter(r => r.status === "fail")).toHaveLength(1);
	});
});
