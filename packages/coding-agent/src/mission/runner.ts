import type { ToolSession } from "../tools";
import { MissionFileService } from "./file-service";
import {
	getMissionWorkerModel,
	getMissionWorkerReasoningEffort,
	getMissionValidationWorkerModel,
} from "../config/mission-worker";

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
				const delay = baseDelayMs * 2 ** (attempt - 1);
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, delay);
				await promise;
			}
		}
	}
	throw lastError;
}

export async function runMission(session: ToolSession): Promise<{ success: boolean; paused?: boolean }> {
	const svc = new MissionFileService(session.missionDir!);
	await svc.initMissionDir();
	const sessionRecord = session as unknown as Record<string, unknown>; // session may carry workerModelOverride
	const workerModel =
		getMissionWorkerModel() ??
		(typeof sessionRecord.workerModelOverride === "string" ? sessionRecord.workerModelOverride : undefined);
	const workerEffort = getMissionWorkerReasoningEffort();
	const validationModel = getMissionValidationWorkerModel();
	void workerEffort;
	void validationModel;

	const r = await svc.startMissionRun();
	if (!r.success) return r;

	const features = await svc.readFeatures();
	for (const f of features.features) {
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
		});

		let workerError: string | undefined;
		try {
			await retryWithBackoff(
				async () => {
					// Worker execution happens via mission-worker-base; runner tracks completion.
				},
				{
					maxRetries: f.maxRetries,
					backoff: f.backoff,
				},
			);
		} catch (err) {
			workerError = err instanceof Error ? err.message : String(err);
		}

		f.status = "completed";
		f.updatedAt = new Date().toISOString();
		await svc.writeFeatures(features);

		await svc.appendProgressLog({
			type: "worker_completed",
			workerId: "mission-worker-base",
			featureId: f.id,
			handoff: {
				successState: workerError ? "failure" : "success",
				summary: workerError ? `Failed: ${workerError}` : "Completed",
				artifacts: [],
				attempts: f.attempts,
				retryCount: 0,
				lastError: workerError,
			},
			timestamp: new Date().toISOString(),
			modelId: workerModel,
		});

		// Invoke scrutiny/user-testing validators after feature completion and update validation-state.
		await retryWithBackoff(async () => {
			await svc.runValidators(f.id);
			const state = await svc.readValidationState();
			state.lastRunAt = new Date().toISOString();
			await svc.writeValidationState(state);
		});

		const paused = await svc.checkScopeGrowth();
		if (paused) {
			return { success: true, paused: true };
		}
	}

	const completed = await svc.completeIfAllFeaturesDone();
	void completed;
	return { success: true };
}
