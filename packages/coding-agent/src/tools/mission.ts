import type { ToolSession } from ".";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type as arkType } from "@oh-my-pi/omptype";
import { MissionFileService } from "../mission/file-service";
import { runMission } from "../mission/runner";

function makeTool(
	session: ToolSession,
	name: string,
	description: string,
	schema: unknown,
	run: (svc: MissionFileService, params: unknown) => Promise<string>,
): AgentTool | null {
	if (!session.missionDir) return null;
	const svc = new MissionFileService(session.missionDir);
	return {
		name,
		description,
		parameters: schema,
		async execute(_ctx, params) {
			const text = await run(svc, params);
			return { content: [{ type: "text", text }], details: {} };
		},
	} as AgentTool;
}

const proposeSchema = arkType({ proposal: "string" });
const startSchema = arkType({});
const endFeatureSchema = arkType({ featureId: "string" });
const dismissSchema = arkType({ items: "string[]" });
const recommendSchema = arkType({ reason: "string" });
const resumeSchema = arkType({});

export function createProposeMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "propose_mission", "Propose a mission", proposeSchema, async (svc, p) => {
		const params = p as { proposal: string };
		const r = await svc.proposeMission(params.proposal);
		return JSON.stringify(r);
	});
}

export function createStartMissionRunTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "start_mission_run", "Start a mission run", startSchema, async () => {
		const r = await runMission(session);
		return JSON.stringify(r);
	});
}

export function createEndFeatureRunTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "end_feature_run", "End a feature run", endFeatureSchema, async (svc, p) => {
		const params = p as { featureId: string };
		if (typeof params.featureId !== "string" || params.featureId.trim().length === 0) {
			return JSON.stringify({ success: false, error: "featureId must be a non-empty string" });
		}
		const r = await svc.endFeatureRun(params.featureId.trim());
		return JSON.stringify(r);
	});
}

export function createDismissHandoffItemsTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "dismiss_handoff_items", "Dismiss handoff items", dismissSchema, async (svc, p) => {
		const params = p as { items: string[] };
		if (!Array.isArray(params.items)) {
			return JSON.stringify({ success: false, error: "items must be an array of strings" });
		}
		const r = await svc.dismissHandoffItems(params.items);
		return JSON.stringify(r);
	});
}

export function createRecommendMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "recommend_mission", "Recommend a mission", recommendSchema, async (svc, p) => {
		const params = p as { reason: string };
		const r = await svc.recommendMission(params.reason);
		return JSON.stringify(r);
	});
}

export function createResumeMissionTool(session: ToolSession): AgentTool | null {
	return makeTool(session, "resume_mission", "Resume a paused mission", resumeSchema, async svc => {
		const r = await svc.resumeMission();
		return JSON.stringify(r);
	});
}
