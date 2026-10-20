import type { ToolSession } from ".";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type as arkType } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import type { SingleResult, StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import { MissionFileService } from "../mission/file-service";
import { NO_WORKER_SPAWNER_ERROR, runMission, type RunMissionWorkerContext } from "../mission/runner";
import { runStructuredSubagent, type StructuredSubagentResult } from "../task/structured-subagent";
import { handoffSlug } from "../mission/handoff-store";
import { getMissionValidationWorkerModel, getMissionValidationWorkerReasoningEffort } from "../config/mission-worker";
import type { MissionFeature, ValidationStatus, WorkerHandoff } from "../mission/types";
import missionAssignmentTemplate from "../prompts/agents/mission-assignment.md" with { type: "text" };
import missionValidationTemplate from "../prompts/agents/mission-validation-assignment.md" with { type: "text" };

const proposeSchema = arkType({ proposal: "string" });
const startSchema = arkType({});
const endFeatureSchema = arkType({ featureId: "string" });
const dismissSchema = arkType({ items: "string[]" });
const recommendSchema = arkType({ reason: "string" });
const resumeSchema = arkType({});

/**
 * Contract the `mission-worker-base` child yields. Declared here rather than
 * trusted from the child's prose: `runStructuredSubagent` validates against it,
 * and a child that cannot produce these fields is a failed run, not a handoff.
 */
const WORKER_HANDOFF_SCHEMA = {
	type: "object",
	required: ["successState", "summary", "artifacts"],
	properties: {
		successState: { type: "string", enum: ["success", "failure"] },
		summary: { type: "string" },
		whatWasImplemented: { type: "string" },
		whatWasLeftUndone: { type: "string" },
		verification: { type: "string" },
		commitId: { type: "string" },
		repoPath: { type: "string" },
		artifacts: { type: "array", items: { type: "string" } },
	},
};

/** Render the per-feature work order from the static assignment template. */
export function renderMissionAssignment(feature: MissionFeature, missionDir: string): string {
	return prompt
		.render(missionAssignmentTemplate, {
			feature_id: feature.id,
			feature_title: feature.title,
			feature_description: feature.description,
			mission_dir: missionDir,
		})
		.trim();
}

/**
 * Contract a validator child yields. Declared here rather than trusted from the
 * child's prose, exactly like `WORKER_HANDOFF_SCHEMA`: `runStructuredSubagent`
 * validates against it, so a validator that cannot produce a verdict is a failed
 * validation rather than a `pass` nobody earned.
 */
const VALIDATOR_VERDICT_SCHEMA = {
	type: "object",
	required: ["status", "findings"],
	properties: {
		status: { type: "string", enum: ["pass", "fail", "skipped"] },
		findings: { type: "array", items: { type: "string" } },
	},
};

/** Render one validator's assignment from the static validation template. */
function renderMissionValidationAssignment(validator: string, feature: MissionFeature, missionDir: string): string {
	return prompt
		.render(missionValidationTemplate, {
			validator_name: validator,
			feature_id: feature.id,
			feature_title: feature.title,
			feature_description: feature.description,
			mission_dir: missionDir,
			handoff_slug: handoffSlug(feature.id),
		})
		.trim();
}

/**
 * Why a settled child run is not a usable validator verdict, or `undefined` when
 * it is: an error, an abort, a nonzero exit, structured output that did not
 * validate, or no structured output at all. The validator's contract is to yield
 * a verdict, so a run without one produced nothing to judge the feature by.
 */
function missionValidatorFailure(result: SingleResult): string | undefined {
	if (result.error) return result.error;
	if (result.aborted) return result.abortReason ?? `validator ${result.agent} was aborted`;
	const structured: StructuredSubagentOutput | undefined = result.structuredOutput;
	if (structured && structured.status !== "valid") {
		return structured.error ?? "validator output failed schema validation";
	}
	if (result.exitCode !== 0) return `validator ${result.agent} exited with code ${result.exitCode}`;
	if (!structured) return `validator ${result.agent} returned no structured output`;
	return undefined;
}

/**
 * Why a settled child run is not a usable handoff, or `undefined` when it is:
 * an error message, an abort, a nonzero exit, or structured output that did not
 * validate. An absent `structuredOutput` counts too, because the worker's
 * contract is to yield one and a run without it produced nothing to hand back.
 */
function missionWorkerFailure(result: SingleResult): string | undefined {
	if (result.error) return result.error;
	if (result.aborted) return result.abortReason ?? "worker was aborted";
	const structured: StructuredSubagentOutput | undefined = result.structuredOutput;
	if (structured && structured.status !== "valid") {
		return structured.error ?? "worker output failed schema validation";
	}
	if (result.exitCode !== 0) return `worker exited with code ${result.exitCode}`;
	if (!structured) return "worker returned no structured output";
	return undefined;
}

/** Body of a structured-completion field, or `undefined` when absent or not a string. */
function recordString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

/** Body of an optional structured-completion field; blank strings count as absent. */
function recordDetail(record: Record<string, unknown>, key: string): string | undefined {
	const value = recordString(record, key);
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Convert the child's settled run into a handoff, throwing on every outcome
 * that is not a valid completion. The runner clears `workerError` the moment
 * `spawnWorker` returns any value, so returning a `failure` handoff would still
 * mark the feature `completed` — the fabricated-success bug this pass removes.
 * Only a throw keeps the feature `in_progress` and records `lastError`.
 */
function toWorkerHandoff(featureId: string, execution: StructuredSubagentResult): WorkerHandoff {
	const result: SingleResult = execution.result;
	const failure = missionWorkerFailure(result);
	if (failure) throw new Error(`Feature ${featureId}: ${failure}`);

	const data: unknown = result.structuredOutput?.data;
	if (data === undefined || data === null) {
		throw new Error(`Feature ${featureId}: worker produced no structured handoff`);
	}
	const record = data as Record<string, unknown>;
	const successState = recordString(record, "successState");
	if (successState !== "success" && successState !== "failure") {
		throw new Error(`Feature ${featureId}: handoff successState was ${JSON.stringify(record.successState)}`);
	}
	if (successState === "failure") {
		const summary = recordString(record, "summary");
		const reason = recordDetail(record, "whatWasLeftUndone") ?? recordDetail(record, "verification");
		throw new Error(
			`Feature ${featureId}: worker reported failure${summary ? `: ${summary}` : ""}${reason ? ` (${reason})` : ""}`,
		);
	}
	const summary = recordString(record, "summary");
	const rawArtifacts: unknown = record.artifacts;
	if (summary === undefined || !Array.isArray(rawArtifacts)) {
		throw new Error(`Feature ${featureId}: handoff is missing summary or artifacts`);
	}
	const artifacts = rawArtifacts.filter((item): item is string => typeof item === "string");

	const handoff: WorkerHandoff = { successState, summary, artifacts };
	const whatWasImplemented = recordDetail(record, "whatWasImplemented");
	if (whatWasImplemented !== undefined) handoff.whatWasImplemented = whatWasImplemented;
	const whatWasLeftUndone = recordDetail(record, "whatWasLeftUndone");
	if (whatWasLeftUndone !== undefined) handoff.whatWasLeftUndone = whatWasLeftUndone;
	const verification = recordDetail(record, "verification");
	if (verification !== undefined) handoff.verification = verification;
	const commitId = recordDetail(record, "commitId");
	if (commitId !== undefined) handoff.commitId = commitId;
	const repoPath = recordDetail(record, "repoPath");
	if (repoPath !== undefined) handoff.repoPath = repoPath;
	return handoff;
}

/** Resolve the coarse task effort the user configured, else leave it unset. */
function resolveEffort(workerEffort: string | undefined): TaskEffort | undefined {
	return workerEffort === "lo" || workerEffort === "med" || workerEffort === "hi" ? workerEffort : undefined;
}

/** Read the feature record the runner is currently driving. */
async function readFeature(svc: MissionFileService, featureId: string): Promise<MissionFeature | undefined> {
	const features = await svc.readFeatures();
	return features.features.find(f => f.id === featureId);
}

/**
 * Spawn one `mission-worker-base` child for a feature and return its handoff.
 *
 * `model` is passed only when the user configured one. `mission-worker-base`
 * declares `model: "@task"`, an agent-forced sentinel resolved by
 * `resolveSubagentModel`: an unprefixed model is subagent-forced while `@<id>`
 * is verbatim. Passing an unset or empty model would resolve down the
 * subagent-forced path instead of the agent's own `@task` — which is what made
 * the `MISSION_WORKER_MODEL` overrides inert while unset, and would keep
 * fighting the sentinel if we passed a placeholder.
 */
export async function spawnMissionWorker(context: RunMissionWorkerContext): Promise<WorkerHandoff | void> {
	const feature = await readFeature(context.svc, context.featureId);
	if (!feature) {
		throw new Error(`Feature ${context.featureId} is not listed in features.json`);
	}
	const assignment = renderMissionAssignment(feature, context.svc.missionDir());
	const model = context.workerModel?.trim() || undefined;
	const effort = resolveEffort(context.workerEffort);
	const execution = await runStructuredSubagent({
		session: context.session,
		invocationKind: "task",
		assignment,
		agent: "mission-worker-base",
		outputSchema: WORKER_HANDOFF_SCHEMA,
		structured: true,
		...(model !== undefined ? { model } : {}),
		...(effort !== undefined ? { effort } : {}),
		...(context.signal !== undefined ? { signal: context.signal } : {}),
	});
	return toWorkerHandoff(context.featureId, execution);
}

/**
 * Convert a settled validator run into the `{ status, findings }` verdict the
 * runner's `spawnValidator` seam expects, throwing on every outcome that is not
 * a real verdict. `runValidators` catches per-validator throws and records them
 * as `status: "fail"` with the reason, so an unrun validator reaches the feature
 * instead of ever surfacing as a pass.
 */
function toValidatorVerdict(
	validator: string,
	featureId: string,
	execution: StructuredSubagentResult,
): {
	status: ValidationStatus;
	findings: string[];
} {
	const result: SingleResult = execution.result;
	const failure = missionValidatorFailure(result);
	if (failure) throw new Error(`Validator ${validator} on feature ${featureId}: ${failure}`);

	const data: unknown = result.structuredOutput?.data;
	if (data === undefined || data === null) {
		throw new Error(`Validator ${validator} on feature ${featureId}: produced no verdict`);
	}
	const record = data as Record<string, unknown>;
	const status = recordString(record, "status");
	if (status !== "pass" && status !== "fail" && status !== "skipped") {
		throw new Error(
			`Validator ${validator} on feature ${featureId}: verdict status was ${JSON.stringify(record.status)}`,
		);
	}
	const rawFindings: unknown = record.findings;
	if (!Array.isArray(rawFindings)) {
		throw new Error(`Validator ${validator} on feature ${featureId}: verdict is missing findings`);
	}
	const findings = rawFindings.filter((item): item is string => typeof item === "string");
	// A `skipped` verdict is not fabricated as a `fail`: the validator declined to
	// judge the feature, and recording it honestly as `skipped` keeps that a
	// deliberate, visible outcome. It still blocks validation —
	// `failingValidatorFindings` treats anything that is not `pass` as failing.
	return { status, findings };
}

/**
 * Spawn one named validator child for a feature and return what it found.
 *
 * The seam signature is `(validator, featureId)`, and `runValidators` calls it
 * once per name with the same closure — so neither the validator nor the feature
 * may be closed over. The `ToolSession` the tool factory holds is the only source
 * for a spawn, and `validationModel`/`validationEffort` are read from the same
 * mission settings the runner reads, so a validator run resolves its model and
 * effort exactly as the worker run does.
 *
 * Every failure — a throw, a crash, an abort, a nonzero exit, output that never
 * validated, or an absent verdict — surfaces as an error. `runValidators` records
 * it as `status: "fail"` with the reason, and the runner's
 * `failingValidatorFindings` turns the recorded result into a run failure, so an
 * unvalidated feature can never report validated success.
 */
async function spawnMissionValidator(
	validator: string,
	featureId: string,
	session: ToolSession,
	signal?: AbortSignal,
): Promise<{ status: ValidationStatus; findings: string[] }> {
	if (!session.missionDir) {
		throw new Error(`Validator ${validator} cannot run: the session has no mission directory`);
	}
	const svc = new MissionFileService(session.missionDir);
	const feature = await readFeature(svc, featureId);
	if (!feature) {
		throw new Error(`Feature ${featureId} is not listed in features.json`);
	}
	const assignment = renderMissionValidationAssignment(validator, feature, svc.missionDir());
	const model = getMissionValidationWorkerModel()?.trim() || undefined;
	const effort = resolveEffort(getMissionValidationWorkerReasoningEffort());
	const execution = await runStructuredSubagent({
		session,
		invocationKind: "task",
		assignment,
		agent: validator,
		outputSchema: VALIDATOR_VERDICT_SCHEMA,
		structured: true,
		...(model !== undefined ? { model } : {}),
		...(effort !== undefined ? { effort } : {}),
		...(signal !== undefined ? { signal } : {}),
	});
	return toValidatorVerdict(validator, featureId, execution);
}

/**
 * The `spawnValidator` seam bound to one session's `ToolSession` and mission dir.
 * The tool's `signal` is carried through so Ctrl-C reaches the validator children
 * exactly as it reaches the worker — without it a cancelled run leaves both
 * validators executing against a feature the user already abandoned.
 */
function missionValidatorSpawner(session: ToolSession, signal?: AbortSignal) {
	return async (validator: string, featureId: string): Promise<{ status: ValidationStatus; findings: string[] }> =>
		await spawnMissionValidator(validator, featureId, session, signal);
}

function makeTool(
	session: ToolSession,
	name: string,
	description: string,
	schema: unknown,
	run: (svc: MissionFileService, session: ToolSession, params: unknown, signal?: AbortSignal) => Promise<string>,
): AgentTool | null {
	if (!session.missionDir) return null;
	const svc = new MissionFileService(session.missionDir);
	return {
		name,
		description,
		parameters: schema,
		async execute(
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback,
			_context?: AgentToolContext,
		): Promise<AgentToolResult> {
			const text = await run(svc, session, params, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	} as AgentTool;
}

/**
 * Wire the runner to both spawners. `RunMissionWorkerContext.session` is this
 * same `ToolSession`, and `StructuredSubagentRequest.session` accepts exactly
 * that type, so it is handed through with no adaptation.
 *
 * `spawnValidator` is filled from here because it is the only place a `ToolSession`
 * exists: `MissionFileService` — where `runValidators` lives — holds just a
 * directory string, and `runStructuredSubagent` needs a full session. Without this
 * seam `runValidators` records `status: "fail"` for every validator, which
 * correctly fails the run, so leaving it unfilled made every real mission run fail
 * its validation stage instead of ever validating anything.
 */
function runMissionWithWorker(session: ToolSession, signal?: AbortSignal): Promise<Record<string, unknown>> {
	if (!session.missionDir) return Promise.resolve({ success: false, error: NO_WORKER_SPAWNER_ERROR });
	return runMission(session, {
		spawnWorker: spawnMissionWorker,
		spawnValidator: missionValidatorSpawner(session, signal),
		...(signal !== undefined ? { signal } : {}),
	});
}

export function createProposeMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "propose_mission", "Propose a mission", proposeSchema, async (svc, _session, p) => {
		const params = p as { proposal: string };
		const r = await svc.proposeMission(params.proposal);
		return JSON.stringify(r);
	});
}

export function createStartMissionRunTool(session: ToolSession): AgentTool | null {
	return makeTool(
		session,
		"start_mission_run",
		"Start a mission run",
		startSchema,
		async (_svc, toolSession, _params, signal) => {
			// `run` receives the mission service, but the run needs the session the
			// factory holds: the spawner reads features from the same mission
			// directory and hands that `ToolSession` to `runStructuredSubagent`.
			return JSON.stringify(await runMissionWithWorker(toolSession, signal));
		},
	);
}

export function createEndFeatureRunTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "end_feature_run", "End a feature run", endFeatureSchema, async (svc, _session, p) => {
		const params = p as { featureId: string };
		if (typeof params.featureId !== "string" || params.featureId.trim().length === 0) {
			return JSON.stringify({ success: false, error: "featureId must be a non-empty string" });
		}
		const r = await svc.endFeatureRun(params.featureId.trim());
		return JSON.stringify(r);
	});
}

export function createDismissHandoffItemsTool(session: ToolSession): AgentTool | null {
	return makeTool(
		session,
		"dismiss_handoff_items",
		"Dismiss handoff items",
		dismissSchema,
		async (svc, _session, p) => {
			const params = p as { items: string[] };
			if (!Array.isArray(params.items)) {
				return JSON.stringify({ success: false, error: "items must be an array of strings" });
			}
			const r = await svc.dismissHandoffItems(params.items);
			return JSON.stringify(r);
		},
	);
}

export function createRecommendMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "recommend_mission", "Recommend a mission", recommendSchema, async (svc, _session, p) => {
		const params = p as { reason: string };
		const r = await svc.recommendMission(params.reason);
		return JSON.stringify(r);
	});
}

export function createResumeMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "resume_mission", "Resume a paused mission", resumeSchema, async (svc, _session) => {
		const r = await svc.resumeMission();
		return JSON.stringify(r);
	});
}
