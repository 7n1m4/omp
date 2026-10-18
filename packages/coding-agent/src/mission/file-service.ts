import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSettingsInitialized, settings } from "../config/settings";
import type { MissionState } from "./types";

import {
	type MissionAccessResult,
	type MissionFeaturesFile,
	type MissionModelSettings,
	type ProgressLogEntry,
	type ValidationState,
} from "./types";

export class MissionFileService {
	#missionDir: string;

	constructor(missionDir: string) {
		this.#missionDir = missionDir;
	}

	async initMissionDir(missionDir: string = this.#missionDir): Promise<void> {
		await fs.mkdir(missionDir, { recursive: true });
		await fs.mkdir(path.join(missionDir, "transcripts"), { recursive: true });
		await fs.mkdir(path.join(missionDir, "handoffs"), { recursive: true });
	}

	async readFeatures(): Promise<MissionFeaturesFile> {
		const raw = await Bun.file(path.join(this.#missionDir, "features.json")).text();
		return JSON.parse(raw) as MissionFeaturesFile;
	}

	async writeFeatures(data: MissionFeaturesFile): Promise<void> {
		await Bun.write(path.join(this.#missionDir, "features.json"), JSON.stringify(data, null, 2));
	}

	async readValidationState(): Promise<ValidationState> {
		const raw = await Bun.file(path.join(this.#missionDir, "validation-state.json")).text();
		return JSON.parse(raw) as ValidationState;
	}

	async writeValidationState(data: ValidationState): Promise<void> {
		await Bun.write(path.join(this.#missionDir, "validation-state.json"), JSON.stringify(data, null, 2));
	}

	async appendProgressLog(entry: ProgressLogEntry): Promise<void> {
		const line = JSON.stringify(entry) + "\n";
		await fs.appendFile(path.join(this.#missionDir, "progress_log.jsonl"), line, "utf8");
	}

	async readProgressLog(): Promise<ProgressLogEntry[]> {
		try {
			const raw = await Bun.file(path.join(this.#missionDir, "progress_log.jsonl")).text();
			return raw
				.split("\n")
				.map(l => l.trim())
				.filter(l => l.length > 0)
				.map(l => JSON.parse(l) as ProgressLogEntry);
		} catch {
			return [];
		}
	}

	async filterWorkerHandoffs(): Promise<Extract<ProgressLogEntry, { type: "worker_completed" }>[]> {
		const entries = await this.readProgressLog();
		return entries.filter(
			(e): e is Extract<ProgressLogEntry, { type: "worker_completed" }> =>
				e.type === "worker_completed" && e.handoff !== undefined,
		);
	}

	async readMissionState(): Promise<MissionState> {
		try {
			const raw = await Bun.file(path.join(this.#missionDir, "mission-state.json")).text();
			return JSON.parse(raw) as MissionState;
		} catch {
			return { state: "proposed", pauseReason: null, lastReviewedHandoffCount: 0, isLegacyMissionMode: false };
		}
	}

	async writeMissionState(data: MissionState): Promise<void> {
		await Bun.write(path.join(this.#missionDir, "mission-state.json"), JSON.stringify(data, null, 2));
	}

	async readEffectiveModelSettings(): Promise<MissionModelSettings> {
		let persisted: MissionModelSettings = {};
		try {
			const raw = await Bun.file(path.join(this.#missionDir, "model-settings.json")).text();
			persisted = JSON.parse(raw) as MissionModelSettings;
		} catch {
			persisted = {};
		}
		let global: MissionModelSettings = {};
		if (isSettingsInitialized()) {
			const s = settings as unknown as Record<string, unknown>;
			global = (s.missionModelSettings as MissionModelSettings) ?? {};
		}
		return { ...global, ...persisted };
	}

	async startMissionRun(): Promise<{ success: boolean }> {
		const state = await this.readMissionState();
		if (state.state === "proposed") state.state = "approved";
		state.state = "running";
		state.pauseReason = null;
		await this.writeMissionState(state);
		return { success: true };
	}

	async endFeatureRun(featureId: string): Promise<{ success: boolean; paused?: boolean }> {
		const features = await this.readFeatures();
		const feature = features.features.find(f => f.id === featureId);
		if (feature) {
			feature.status = "completed";
			feature.updatedAt = new Date().toISOString();
			await this.writeFeatures(features);
		}
		const paused = await this.checkScopeGrowth();
		return { success: true, paused };
	}

	async checkScopeGrowth(): Promise<boolean> {
		const features = await this.readFeatures().catch(() => null);
		if (!features) return false;
		const current = features.features.length;
		const limit = features.initialFeatureCount * features.scopeGrowthMultiplier;
		if (current > limit) {
			const state = await this.readMissionState();
			state.state = "paused";
			state.pauseReason = "scope_growth_limit_exceeded";
			await this.writeMissionState(state);
			await this.appendProgressLog({
				type: "mission_paused",
				pauseReason: "scope_growth_limit_exceeded",
				timestamp: new Date().toISOString(),
			});
			return true;
		}
		return false;
	}

	async dismissHandoffItems(items: string[]): Promise<{ success: boolean; dismissed: number }> {
		const state = await this.readMissionState();
		state.lastReviewedHandoffCount += items.length;
		await this.writeMissionState(state);
		return { success: true, dismissed: items.length };
	}

	async recommendMission(reason: string): Promise<{ success: boolean }> {
		await Bun.write(path.join(this.#missionDir, "recommendation.md"), reason);
		return { success: true };
	}

	async proposeMission(proposal: string): Promise<{ success: boolean; proposalPath: string }> {
		const proposalPath = path.join(this.#missionDir, "proposal.md");
		await Bun.write(proposalPath, proposal);
		return { success: true, proposalPath };
	}

	enforceMissionAccess(targetPath: string): MissionAccessResult {
		const resolved = path.resolve(targetPath);
		const base = path.resolve(this.#missionDir);
		if (resolved === base || resolved.startsWith(base + path.sep)) {
			return { allowed: true };
		}
		return { allowed: false, reason: `Path outside mission directory: ${targetPath}` };
	}
}
