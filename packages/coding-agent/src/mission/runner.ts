import type { ToolSession } from "../tools";
import { MissionFileService } from "./file-service";
import {
	getMissionWorkerModel,
	getMissionWorkerReasoningEffort,
	getMissionValidationWorkerModel,
	getMissionValidationWorkerReasoningEffort,
} from "../config/mission-worker";
import { aggregateProgressLog } from "./progress-log";
import type { ProgressLogEntry, WorkerHandoff } from "./types";

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
}

export async function runMission(
	session: ToolSession,
	options: RunMissionOptions = {},
): Promise<{ success: boolean; paused?: boolean; cancelled?: boolean; completed?: boolean; aggregate?: unknown }> {
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
				} else {
					handoff = {
						successState: "success",
						summary: "Completed",
						artifacts: [],
						attempts: f.attempts,
						retryCount,
					};
				}
				workerError = undefined;
				break;
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

		f.status = "completed";
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

		await retryWithBackoff(async () => {
			await svc.runValidators(f.id);
			const state = await svc.readValidationState();
			state.lastRunAt = new Date().toISOString();
			await svc.writeValidationState(state);
		});

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
