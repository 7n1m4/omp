/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────

// Vibe mode
export const cfgVibeEnabled = register({
	id: "vibe.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Vibe Mode",
		description: "Enable vibe mode for directing persistent fast/good worker sessions",
	},
});

export const cfgVibeDefaultOnStartup = register({
	id: "vibe.defaultOnStartup",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Start in Vibe Mode",
		description: "Automatically enter vibe mode at the start of every new session",
		condition: "vibeModeEnabled",
	},
});
