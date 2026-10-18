import { register } from "../config/registry";

// Mission mode
export const cfgMissionMode = register({
	id: "mission.mode",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Mission Mode",
		description: "Enable mission mode for multi-feature mission execution",
	},
});

// Worker model override
export const cfgMissionWorkerModelOverride = register({
	id: "mission.workerModelOverride",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Mission",
		label: "Worker Model Override",
		description: "Override the model used for mission workers",
	},
});

// Autonomy high toggle
export const cfgMissionAutonomyHigh = register({
	id: "mission.autonomyHigh",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Mission",
		label: "High Autonomy",
		description: "Allow mission workers to act with high autonomy",
	},
});

// Mission directory display
export const cfgMissionDir = register({
	id: "mission.dir",
	type: "string",
	default: undefined,
	ui: {
		tab: "tasks",
		group: "Mission",
		label: "Mission Directory",
		description: "Directory used for mission state and artifacts",
	},
});
