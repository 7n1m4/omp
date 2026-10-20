import type { ToolSession } from "../tools";
import { MissionFileService } from "./file-service";
import {
	getMissionWorkerModel,
	getMissionWorkerReasoningEffort,
	getMissionValidationWorkerModel,
	getMissionValidationWorkerReasoningEffort,
} from "../config/mission-worker";
import { aggregateProgressLog } from "./progress-log";
import { writeHandoff } from "./handoff-store";
import type { MissionState, ProgressLogEntry, ValidationState, WorkerHandoff } from "./types";

/**
 * Why a feature attempt cannot run: `runMission` requires `options.spawnWorker`
 * because nothing else in the harness can launch a `mission-worker-base` subagent.
 * Recorded as the feature's `workerError` so the run reports failure instead of
 * fabricating a `success` handoff and marking the feature `completed`.
 */
export const NO_WORKER_SPAWNER_ERROR = "No worker spawner configured: runMission requires options.spawnWorker";

/**
 * Read mission state, or `null` when the state file is unreadable.
 *
 * Used only on the failure path, where an unreadable state file must not invent a
 * state: rethrowing from the catch would reject `runMission` outright (nothing
 * recorded, feature left `completed`), while defaulting to `"running"` would write
 * a pause the mission never entered. Returning `null` leaves the corpus between:
 * the feature is still reopened and the failure still recorded everywhere else.
 */
async function readMissionStateSafely(svc: MissionFileService): Promise<MissionState | null> {
	try {
		return await svc.readMissionState();
	} catch {
		return null;
	}
}

/**
 * Join the findings of every validator result for this feature that did not pass.
 *
 * A validation failure is not only a throw. `runValidators` returns normally while
 * recording `status: "fail"` with its findings — that is what it does for a
 * validator that never ran — so reading only the return value would mark the
 * feature `completed` on a `validation-state.json` that says `failing`. Returns
 * `undefined` when the feature has no failing or skipped result, which is the
 * only case that may proceed as validated.
 */
async function failingValidatorFindings(svc: MissionFileService, featureId: string): Promise<string | undefined> {
	let state: ValidationState;
	try {
		state = await svc.readValidationState();
	} catch {
		return undefined;
	}
	const findings = state.results
		.filter(r => r.featureId === featureId && r.status !== "pass")
		.flatMap(r => r.findings)
		.filter(finding => finding.length > 0);
	return findings.length > 0 ? findings.join("; ") : undefined;
}

export interface RetryBackoffOptions {
	maxAttempts?: number;
	attempts?: number;
	maxRetries?: number;
	baseDelayMs?: number;
	backoff?: number;
	backoffMs?: number;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryBackoffOptions = {}): Promise<T> {
	const maxAttempts =
		options.maxAttempts ?? options.attempts ?? (options.maxRetries !== undefined ? options.maxRetries + 1 : 3);
	const baseDelayMs = options.baseDelayMs ?? options.backoff ?? options.backoffMs ?? 250;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt < maxAttempts) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1));
				await promise;
			}
		}
	}
	throw lastError;
}

export interface RunMissionWorkerContext {
	session: ToolSession;
	svc: MissionFileService;
	featureId: string;
	workerModel: string | undefined;
	workerEffort: string | undefined;
	validationModel: string | undefined;
	validationEffort: string | undefined;
	signal: AbortSignal | undefined;
}

export interface RunMissionOptions {
	signal?: AbortSignal;
	onProgress?: (entry: ProgressLogEntry | { type: "aggregation"; aggregate: unknown }) => void | Promise<void>;
	onWorkerStart?: (featureId: string) => void | Promise<void>;
	onWorkerComplete?: (featureId: string, handoff: WorkerHandoff) => void | Promise<void>;
	onCancel?: () => void | Promise<void>;
	spawnWorker?: (context: RunMissionWorkerContext) => Promise<WorkerHandoff | void>;
	/**
	 * Executes one named validator for a feature and reports what it found.
	 *
	 * Without it `runValidators` records `status: "fail"` for every validator, so a
	 * run with no caller wired to this seam cannot validate anything and Bug 1's
	 * fix — a recorded failing result reopens the feature — correctly fails every
	 * run. The caller that can launch a `mission-worker-base` sibling is
	 * `src/tools/mission.ts`, which holds the `ToolSession` this service does not.
	 */
	spawnValidator?: (
		validator: string,
		featureId: string,
	) => Promise<{ status: ValidationState["results"][number]["status"]; findings: string[] }>;
}

export async function runMission(
	session: ToolSession,
	options: RunMissionOptions = {},
): Promise<{
	success: boolean;
	paused?: boolean;
	cancelled?: boolean;
	completed?: boolean;
	aggregate?: unknown;
	/** Set when validation failed: the feature id, and why. Only present on failure. */
	validationFailed?: string;
	validationError?: string;
}> {
	const svc = new MissionFileService(session.missionDir!);
	await svc.initMissionDir();
	const sessionRecord = session as unknown as Record<string, unknown>;
	const workerModel =
		getMissionWorkerModel() ??
		(typeof sessionRecord.workerModelOverride === "string" ? sessionRecord.workerModelOverride : undefined);
	const workerEffort = getMissionWorkerReasoningEffort();
	const validationModel = getMissionValidationWorkerModel();
	const validationEffort = getMissionValidationWorkerReasoningEffort();

	const r = await svc.startMissionRun();
	if (!r.success) return r;

	const features = await svc.readFeatures();

	const isCancelled = (): boolean => options.signal?.aborted === true;

	for (const f of features.features) {
		if (isCancelled()) {
			await options.onCancel?.();
			const state = await svc.readMissionState();
			if (state.state === "running") {
				state.state = "paused";
				state.pauseReason = "cancelled";
				await svc.writeMissionState(state);
			}
			await svc.appendProgressLog({
				type: "mission_paused",
				pauseReason: "cancelled",
				timestamp: new Date().toISOString(),
			});
			return { success: true, cancelled: true, paused: true };
		}
		if (f.status !== "pending") continue;
		f.status = "in_progress";
		f.updatedAt = new Date().toISOString();
		if (f.attempts === undefined) f.attempts = 0;
		f.attempts += 1;
		await svc.writeFeatures(features);

		await svc.appendProgressLog({
			type: "worker_started",
			workerId: "mission-worker-base",
			featureId: f.id,
			timestamp: new Date().toISOString(),
			modelId: workerModel,
			reasoningEffort: workerEffort,
			validationModelId: validationModel,
		});
		await options.onWorkerStart?.(f.id);
		await options.onProgress?.({
			type: "worker_started",
			workerId: "mission-worker-base",
			featureId: f.id,
			timestamp: new Date().toISOString(),
			modelId: workerModel,
			reasoningEffort: workerEffort,
			validationModelId: validationModel,
		} as ProgressLogEntry);

		let workerError: string | undefined;
		let handoff: WorkerHandoff | undefined;
		const maxRetries = f.maxRetries ?? 0;
		const delay = f.backoff ?? 250;
		let retryCount = 0;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				retryCount = attempt;
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, delay * Math.pow(2, attempt - 1));
				await promise;
			}
			try {
				if (options.spawnWorker) {
					const result = await options.spawnWorker({
						session,
						svc,
						featureId: f.id,
						workerModel,
						workerEffort,
						validationModel,
						validationEffort,
						signal: options.signal,
					});
					if (result) handoff = result;
					workerError = undefined;
				} else {
					// No spawner means no worker ever ran: the feature is NOT done.
					// Never fabricate a handoff here — a fake success silently marks
					// the feature completed when the user runs a mission run.
					workerError = NO_WORKER_SPAWNER_ERROR;
				}
				if (!workerError || attempt >= maxRetries) break;
			} catch (err) {
				workerError = err instanceof Error ? err.message : String(err);
				if (attempt >= maxRetries) break;
			}
		}

		const finalHandoff: WorkerHandoff = handoff ?? {
			successState: workerError ? "failure" : "success",
			summary: workerError ? `Failed: ${workerError}` : "Completed",
			artifacts: [],
			attempts: f.attempts,
			retryCount,
			lastError: workerError,
		};

		if (!workerError) {
			f.status = "completed";
		}
		f.updatedAt = new Date().toISOString();
		await svc.writeFeatures(features);

		await svc.appendProgressLog({
			type: "worker_completed",
			workerId: "mission-worker-base",
			featureId: f.id,
			handoff: finalHandoff,
			timestamp: new Date().toISOString(),
			modelId: workerModel,
			reasoningEffort: workerEffort,
			validationModelId: validationModel,
		});
		await options.onWorkerComplete?.(f.id, finalHandoff);
		await options.onProgress?.({
			type: "worker_completed",
			workerId: "mission-worker-base",
			featureId: f.id,
			handoff: finalHandoff,
			timestamp: new Date().toISOString(),
			modelId: workerModel,
			reasoningEffort: workerEffort,
			validationModelId: validationModel,
		} as ProgressLogEntry);

		let validationError: string | undefined;
		let recordedFindings: string | undefined;
		// Validating work that was never produced is not possible, so a failed
		// worker skips validation entirely instead of recording validators as
		// `fail`. `workerError` is the precise signal — "no worker ran" — not
		// `finalHandoff.successState`, which is `"failure"` for a handoff a
		// handoff-producing worker honestly reported as failed work.
		if (workerError === undefined) {
			try {
				await retryWithBackoff(async () => {
					await svc.runValidators(f.id, undefined, options.spawnValidator);
					const state = await svc.readValidationState();
					state.lastRunAt = new Date().toISOString();
					await svc.writeValidationState(state);
				});
				// `runValidators` returns normally when a validator fails — it records
				// `status: "fail"` with its findings instead of throwing — so the retry
				// above succeeding is not evidence the feature was validated. Reading the
				// recorded result is: without this, a feature whose validators never ran
				// is marked `completed` on a `validation-state.json` that says `failing`,
				// which is the same consumer-visible failure as a swallowed throw.
				recordedFindings = await failingValidatorFindings(svc, f.id);
				if (recordedFindings !== undefined) validationError = `validation failed: ${recordedFindings}`;
			} catch (err) {
				// `retryWithBackoff` rethrows the last failure; a throw here means the
				// feature was never validated, so it must not stand as a validated
				// success. This is the same class of bug as a mission run reporting
				// success with no worker: per-validator failures are now recorded by
				// `runValidators` itself as `status: "fail"`, so reaching this catch
				// means validation state could not be read or written at all.
				validationError = err instanceof Error ? err.message : String(err);
			}
			if (validationError !== undefined) {
				// One failure path for both sources: a throw from the retry above, and a
				// recorded `status: "fail"` that resolved normally. Leaving either to
				// fall through would mark the feature `completed` and report success.
				// No `.catch` on the write: a write failure here must escape, not be
				// swallowed. An unwritable mission dir is exactly why validation could
				// throw, so dropping the record silently would lose the only evidence.
				await writeHandoff(svc.missionDir(), { ...finalHandoff, lastError: validationError }, f.id);
				// `runValidators` records a validator failure as `status: "fail"`, and the
				// findings above came from such a result, so that case is already durable.
				// The throw case may have left the state file stale, so stamp a
				// knowingly-failed result to stop `overallStatus` reading "passing" for a
				// feature whose validation stage crashed.
				if (recordedFindings === undefined) {
					try {
						const state = await svc.readValidationState();
						// Append to whatever the validators recorded before the crash
						// instead of filtering their results away: a validator that ran
						// and found something leaves evidence worth keeping.
						state.results.push({
							validator: "validation",
							featureId: f.id,
							status: "fail",
							findings: [`validation did not complete: ${validationError}`.slice(0, 2000)],
							runAt: new Date().toISOString(),
						});
						state.overallStatus = "failing";
						await svc.writeValidationState(state);
					} catch {
						// Nothing left to record it in: the failure is already durable in
						// mission-state.json, progress_log.jsonl, and the handoff file.
					}
				}
				const failureState = await readMissionStateSafely(svc);
				// Only pause when the state file genuinely said "running". A fallback
				// default would write an invented state into mission-state.json.
				if (failureState) {
					failureState.state = "paused";
					failureState.pauseReason = `validation_failed: ${f.id}`;
					await svc.writeMissionState(failureState);
				}
				await svc.appendProgressLog({
					type: "mission_paused",
					pauseReason: `validation_failed: ${f.id}`,
					timestamp: new Date().toISOString(),
				});
				const reopened = await svc.readFeatures();
				const reopenedFeature = reopened.features.find(entry => entry.id === f.id);
				if (reopenedFeature && reopenedFeature.status === "completed") {
					reopenedFeature.status = "in_progress";
					reopenedFeature.updatedAt = new Date().toISOString();
					await svc.writeFeatures(reopened);
				}
				return {
					success: false,
					paused: true,
					validationFailed: f.id,
					validationError,
					aggregate: await aggregateProgressLog(svc),
				};
			}
		}

		await writeHandoff(svc.missionDir(), finalHandoff, f.id);

		const aggregate = await aggregateProgressLog(svc);
		await options.onProgress?.({ type: "aggregation", aggregate });

		if (isCancelled()) {
			await options.onCancel?.();
			const state = await svc.readMissionState();
			if (state.state === "running") {
				state.state = "paused";
				state.pauseReason = "cancelled";
				await svc.writeMissionState(state);
			}
			await svc.appendProgressLog({
				type: "mission_paused",
				pauseReason: "cancelled",
				timestamp: new Date().toISOString(),
			});
			return { success: true, cancelled: true, paused: true, aggregate };
		}

		const paused = await svc.checkScopeGrowth();
		if (paused) {
			return { success: true, paused: true, aggregate };
		}
	}

	const aggregate = await aggregateProgressLog(svc);
	const completed = await svc.completeIfAllFeaturesDone();
	return { success: true, completed: completed.completed, aggregate };
}
