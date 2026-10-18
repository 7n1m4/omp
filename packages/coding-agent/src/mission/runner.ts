import type { ToolSession } from "../tools";
import { MissionFileService } from "./file-service";

export async function runMission(session: ToolSession): Promise<{ success: boolean }> {
	const svc = new MissionFileService(session.missionDir!);
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
		break;
	}
	return { success: true };
}
