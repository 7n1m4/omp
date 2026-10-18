import type { ToolSession } from "../tools";
import { MissionFileService } from "./file-service";
import {
	getMissionWorkerModel,
	getMissionWorkerReasoningEffort,
	getMissionValidationWorkerModel,
} from "../config/mission-worker";

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 250;
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

export async function runMission(session: ToolSession): Promise<{ success: boolean }> {
	const svc = new MissionFileService(session.missionDir!);
	const workerModel = getMissionWorkerModel();
	const workerEffort = getMissionWorkerReasoningEffort();
	const validationModel = getMissionValidationWorkerModel();
	void workerModel;
	void workerEffort;
	void validationModel;
	const r = await svc.startMissionRun();
	if (!r.success) return r;
	const features = await svc.readFeatures();
	for (const f of features.features) {
		if (f.status !== "pending") continue;
		f.status = "in_progress";
		f.updatedAt = new Date().toISOString();
		await svc.writeFeatures(features);
		await svc.appendProgressLog({
			type: "worker_started",
			workerId: "mission-worker-base",
			featureId: f.id,
			timestamp: new Date().toISOString(),
		});
		await retryWithBackoff(async () => {
			await svc.runValidators(f.id);
			const state = await svc.readValidationState();
			state.lastRunAt = new Date().toISOString();
			await svc.writeValidationState(state);
		});
		f.status = "completed";
		f.updatedAt = new Date().toISOString();
		await svc.writeFeatures(features);
		break;
	}
	return { success: true };
}
