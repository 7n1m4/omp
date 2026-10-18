import { MissionFileService } from "./file-service";
import type { WorkerHandoff } from "./types";

export async function latestWorkerHandoff(svc: MissionFileService): Promise<WorkerHandoff | undefined> {
	const entries = await svc.filterWorkerHandoffs();
	const last = entries[entries.length - 1];
	return last?.handoff;
}

export async function unreviewedHandoffCount(svc: MissionFileService): Promise<number> {
	const state = await svc.readMissionState();
	const handoffs = await svc.filterWorkerHandoffs();
	return Math.max(0, handoffs.length - state.lastReviewedHandoffCount);
}

export async function countsByStatus(svc: MissionFileService): Promise<Record<string, number>> {
	const entries = await svc.readProgressLog();
	const counts: Record<string, number> = {};
	for (const e of entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
	return counts;
}

export interface ProgressLogAggregate {
	total: number;
	byType: Record<string, number>;
	workerHandoffCount: number;
	lastWorkerHandoff: WorkerHandoff | undefined;
}

export async function aggregateProgressLog(svc: MissionFileService): Promise<ProgressLogAggregate> {
	const entries = await svc.readProgressLog();
	const byType: Record<string, number> = {};
	for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
	const handoffs = await svc.filterWorkerHandoffs();
	const last = handoffs[handoffs.length - 1];
	return {
		total: entries.length,
		byType,
		workerHandoffCount: handoffs.length,
		lastWorkerHandoff: last?.handoff,
	};
}
