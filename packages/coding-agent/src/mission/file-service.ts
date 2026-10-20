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

const DEFAULT_FEATURES: MissionFeaturesFile = {
	features: [],
	initialFeatureCount: 0,
	scopeGrowthMultiplier: 1.5,
};

const DEFAULT_VALIDATION_STATE: ValidationState = {
	validators: [],
	lastRunAt: null,
	results: [],
	overallStatus: "pending",
};

const DEFAULT_MISSION_STATE: MissionState = {
	state: "proposed",
	pauseReason: null,
	lastReviewedHandoffCount: 0,
	isLegacyMissionMode: false,
};

export class MissionFileService {
	#missionDir: string;

	constructor(missionDir: string) {
		this.#missionDir = missionDir;
	}

	/** Mission directory this service owns. Read by the mission assignment renderer. */
	missionDir(): string {
		return this.#missionDir;
	}

	async #atomicWrite(filePath: string, data: string): Promise<void> {
		const tmp = `${filePath}.tmp`;
		await Bun.write(tmp, data);
		await fs.rename(tmp, filePath);
	}

	async initMissionDir(missionDir: string = this.#missionDir): Promise<void> {
		await fs.mkdir(missionDir, { recursive: true });
		await fs.mkdir(path.join(missionDir, "transcripts"), { recursive: true });
		await fs.mkdir(path.join(missionDir, "handoffs"), { recursive: true });
		await fs.mkdir(path.join(missionDir, "skills"), { recursive: true });
		await fs.mkdir(path.join(missionDir, "library"), { recursive: true });

		const files: Array<[string, string]> = [
			["architecture.md", "# Architecture\n"],
			["validation-contract.md", "# Validation Contract\n"],
			["AGENTS.md", "# Agents\n"],
			["services.yaml", ""],
			["init.sh", "#!/usr/bin/env bash\n"],
			["features.json", JSON.stringify(DEFAULT_FEATURES, null, 2)],
			["validation-state.json", JSON.stringify(DEFAULT_VALIDATION_STATE, null, 2)],
			["mission.md", "# Mission\n"],
			["mission-state.json", JSON.stringify(DEFAULT_MISSION_STATE, null, 2)],
		];
		for (const [name, content] of files) {
			const target = path.join(missionDir, name);
			try {
				await fs.access(target);
			} catch {
				await this.#atomicWrite(target, content);
			}
		}
	}

	validateFeaturesFile(data: MissionFeaturesFile): string[] {
		const errors: string[] = [];
		if (!data || !Array.isArray(data.features)) {
			errors.push("features must be an array");
			return errors;
		}
		if (
			typeof data.initialFeatureCount !== "number" ||
			!Number.isFinite(data.initialFeatureCount) ||
			data.initialFeatureCount < 0
		) {
			errors.push("initialFeatureCount must be a non-negative number");
		}
		if (
			typeof data.scopeGrowthMultiplier !== "number" ||
			!Number.isFinite(data.scopeGrowthMultiplier) ||
			data.scopeGrowthMultiplier <= 0
		) {
			errors.push("scopeGrowthMultiplier must be a positive number");
		}
		const ids = new Set<string>();
		for (const f of data.features) {
			if (!f || typeof f.id !== "string" || f.id.trim().length === 0) {
				errors.push("feature id must be a non-empty string");
				continue;
			}
			if (ids.has(f.id)) {
				errors.push(`duplicate feature id: ${f.id}`);
			}
			ids.add(f.id);
		}
		return errors;
	}

	async readFeatures(): Promise<MissionFeaturesFile> {
		const raw = await Bun.file(path.join(this.#missionDir, "features.json")).text();
		const parsed = JSON.parse(raw) as MissionFeaturesFile;
		const errors = this.validateFeaturesFile(parsed);
		if (errors.length > 0) {
			throw new Error(`Invalid features.json: ${errors.join("; ")}`);
		}
		return parsed;
	}

	async writeFeatures(data: MissionFeaturesFile): Promise<void> {
		const errors = this.validateFeaturesFile(data);
		if (errors.length > 0) {
			throw new Error(`Invalid features.json: ${errors.join("; ")}`);
		}
		await this.#atomicWrite(path.join(this.#missionDir, "features.json"), JSON.stringify(data, null, 2));
	}

	async readValidationState(): Promise<ValidationState> {
		const raw = await Bun.file(path.join(this.#missionDir, "validation-state.json")).text();
		return JSON.parse(raw) as ValidationState;
	}

	async writeValidationState(data: ValidationState): Promise<void> {
		await this.#atomicWrite(path.join(this.#missionDir, "validation-state.json"), JSON.stringify(data, null, 2));
	}
	/**
	 * Run the feature's validators and record what each one actually reported.
	 *
	 * `spawnValidator` is the seam that executes one named validator. Without it no
	 * validator ran at all, and recording `status: "pass"` anyway is the
	 * fabricated-result bug this method exists to prevent -- the same class as a
	 * mission run reporting success with no worker, whose precedent is
	 * `NO_WORKER_SPAWNER_ERROR` in `mission/runner.ts`. Wire the seam from
	 * `RunMissionOptions.spawnValidator` (one closure capturing the `ToolSession`,
	 * which this service does not hold) to make validators execute for real.
	 */
	async runValidators(
		featureId: string,
		validators: string[] = ["scrutiny-validator", "user-testing-validator"],
		spawnValidator?: (
			validator: string,
			featureId: string,
		) => Promise<{ status: ValidationState["results"][number]["status"]; findings: string[] }>,
	): Promise<void> {
		const state = await this.readValidationState();
		state.validators = validators;
		const now = new Date().toISOString();
		state.results = state.results.filter(r => r.featureId !== featureId);
		for (const v of validators) {
			// A validator that did not run, or that failed, is a failing result --
			// never a pass. `status: "pass"` here is the fabricated-validation bug.
			let status: ValidationState["results"][number]["status"] = "fail";
			let findings: string[] = [];
			if (!spawnValidator) {
				findings = [`validator ${v} did not run: no spawner configured`];
			} else {
				try {
					const outcome = await spawnValidator(v, featureId);
					status = outcome.status;
					findings = outcome.findings;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					findings = [`validator ${v} could not run: ${message}`];
				}
			}
			state.results.push({
				validator: v,
				featureId,
				status,
				findings,
				runAt: now,
			});
		}
		state.lastRunAt = now;
		state.overallStatus = state.results.some(r => r.status === "fail")
			? "failing"
			: state.results.length > 0
				? "passing"
				: "pending";
		await this.writeValidationState(state);
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
			return { ...DEFAULT_MISSION_STATE };
		}
	}

	async writeMissionState(data: MissionState): Promise<void> {
		await this.#atomicWrite(path.join(this.#missionDir, "mission-state.json"), JSON.stringify(data, null, 2));
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
		if (state.state !== "proposed" && state.state !== "approved" && state.state !== "paused") {
			return { success: false };
		}
		if (state.state === "proposed") state.state = "approved";
		state.state = "running";
		state.pauseReason = null;
		await this.writeMissionState(state);
		return { success: true };
	}

	async resumeMission(): Promise<{ success: boolean }> {
		const state = await this.readMissionState();
		if (state.state !== "paused") {
			return { success: false };
		}
		state.state = "running";
		state.pauseReason = null;
		await this.writeMissionState(state);
		await this.appendProgressLog({
			type: "mission_paused",
			pauseReason: "resumed",
			timestamp: new Date().toISOString(),
		});
		return { success: true };
	}

	async completeMission(): Promise<{ success: boolean }> {
		const state = await this.readMissionState();
		if (state.state !== "running" && state.state !== "paused") {
			return { success: false };
		}
		state.state = "completed";
		state.pauseReason = null;
		await this.writeMissionState(state);
		return { success: true };
	}

	async completeIfAllFeaturesDone(): Promise<{ success: boolean; completed: boolean }> {
		const features = await this.readFeatures().catch(() => null);
		if (!features) return { success: false, completed: false };
		const allDone = features.features.length > 0 && features.features.every(f => f.status === "completed");
		if (!allDone) return { success: true, completed: false };
		const r = await this.completeMission();
		return { success: r.success, completed: r.success };
	}

	async endFeatureRun(featureId: string): Promise<{ success: boolean; paused?: boolean; completed?: boolean }> {
		if (typeof featureId !== "string" || featureId.trim().length === 0) {
			return { success: false };
		}
		const features = await this.readFeatures();
		const feature = features.features.find(f => f.id === featureId);
		if (!feature) {
			return { success: false };
		}
		// Scope growth is a function of the feature count alone -- it does not read one
		// feature's status -- so deciding it before any write leaves `features.json`
		// unable to claim `completed` for a feature whose run the mission just halted.
		// The old order persisted `completed` first and discovered the pause afterwards,
		// so a halted run still left a durable record saying the work was done.
		const paused = await this.checkScopeGrowth();
		if (paused) {
			return { success: true, paused: true, completed: false };
		}
		feature.status = "completed";
		feature.updatedAt = new Date().toISOString();
		await this.writeFeatures(features);
		const c = await this.completeIfAllFeaturesDone();
		return { success: true, paused: false, completed: c.completed };
	}

	async checkScopeGrowth(): Promise<boolean> {
		const features = await this.readFeatures().catch(() => null);
		if (!features) return false;
		const current = features.features.length;
		const limit = features.initialFeatureCount * features.scopeGrowthMultiplier;
		if (current > limit) {
			const state = await this.readMissionState();
			if (state.state === "running") {
				state.state = "paused";
				state.pauseReason = "scope_growth_limit_exceeded";
				await this.writeMissionState(state);
			}
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
		const handoffs = await this.filterWorkerHandoffs();
		const maxDismissable = Math.max(0, handoffs.length - state.lastReviewedHandoffCount);
		const dismissed = Math.min(items.length, maxDismissable);
		state.lastReviewedHandoffCount += dismissed;
		await this.writeMissionState(state);
		return { success: true, dismissed };
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

	async enforceMissionAccess(targetPath: string): Promise<MissionAccessResult> {
		let base: string;
		try {
			base = await fs.realpath(this.#missionDir);
		} catch {
			base = path.resolve(this.#missionDir);
		}
		const resolved = path.resolve(targetPath);
		let realTarget = resolved;
		try {
			realTarget = await fs.realpath(resolved);
		} catch {
			const segments: string[] = [];
			let dir = path.dirname(resolved);
			let baseResolved = false;
			while (dir && dir !== path.dirname(dir)) {
				try {
					const realDir = await fs.realpath(dir);
					realTarget = path.join(realDir, ...segments.reverse());
					baseResolved = true;
					break;
				} catch {
					segments.push(path.basename(dir));
					dir = path.dirname(dir);
				}
			}
			if (!baseResolved) {
				realTarget = resolved;
			}
		}
		const normBase = base.replace(/\/+$/, "");
		const normTarget = realTarget.replace(/\/+$/, "");
		if (normTarget === normBase || normTarget.startsWith(normBase + path.sep)) {
			return { allowed: true };
		}
		return { allowed: false, reason: `Path outside mission directory: ${targetPath}` };
	}
}
