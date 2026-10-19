/**
 * Contracts: /mission mode toggle on InteractiveMode.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MISSION_TOOLS = [
	"propose_mission",
	"start_mission_run",
	"end_feature_run",
	"dismiss_handoff_items",
	"recommend_mission",
	"resume_mission",
];

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {},
		execute: async () => ({ content: [] }),
	} as unknown as AgentTool;
}

function missionModeEntryCount(manager: SessionManager): number {
	return manager
		.getEntries()
		.filter((e: { type?: string; mode?: string }) => e.type === "mode_change" && e.mode === "mission").length;
}

describe("InteractiveMode mission mode toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let originalCwd: string;
	let missionCwd: TempDir;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-mission-toggle-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const registryTools = [stubTool("read"), stubTool("todo")];
		const toolRegistry = new Map(registryTools.map(t => [t.name, t]));

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: () => {
					throw new Error("no stream");
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry,
			builtInToolNames: registryTools.map(t => t.name),
			ensureMissionRegistered: async () => {
				// gate-dependent: reads missionDir live; returns false if not set
				const sd = (session as unknown as { missionDir?: string }).missionDir;
				if (!sd) return false;
				for (const n of MISSION_TOOLS) toolRegistry.set(n, stubTool(n));
				return toolRegistry.has("propose_mission");
			},
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());

		missionCwd = TempDir.createSync("@pi-mission-cwd-");
		originalCwd = process.cwd();
		process.chdir(missionCwd.path());
	});

	afterEach(async () => {
		mode?.stop?.();
		await session?.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
		process.chdir(originalCwd);
		missionCwd?.removeSync?.();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("registers and activates all mission tools after /mission", async () => {
		for (const name of MISSION_TOOLS) {
			expect(session.getToolByName(name)).toBeUndefined();
		}
		await mode.handleMissionModeCommand();
		for (const name of MISSION_TOOLS) {
			expect(session.getEnabledToolNames()).toContain(name);
			expect(session.getToolByName(name)).toBeDefined();
		}
	});

	it("creates the mission directory with seed files on disk", async () => {
		await mode.handleMissionModeCommand();
		const missionDir = path.join(process.cwd(), "mission");
		expect(fs.existsSync(missionDir)).toBe(true);
		expect(fs.existsSync(path.join(missionDir, "features.json"))).toBe(true);
		expect(fs.existsSync(path.join(missionDir, "mission-state.json"))).toBe(true);
	});

	it("is idempotent on re-entry", async () => {
		await mode.handleMissionModeCommand();
		const mgr = session.sessionManager;
		const before = missionModeEntryCount(mgr);
		await mode.handleMissionModeCommand();
		const after = missionModeEntryCount(mgr);
		expect(after).toBe(before);
		expect(after).toBe(1);
	});

	it("blocks activation when plan mode is enabled", async () => {
		mode.planModeEnabled = true;
		const result = await mode.handleMissionModeCommand();
		expect(result).toBe(false);
		const mgr = session.sessionManager;
		expect(missionModeEntryCount(mgr)).toBe(0);
		const missionDir = path.join(process.cwd(), "mission");
		expect(fs.existsSync(missionDir)).toBe(false);
	});

	it("does not claim success when registration fails", async () => {
		vi.spyOn(
			session as unknown as { ensureMissionRegistered: () => Promise<boolean> },
			"ensureMissionRegistered",
		).mockResolvedValue(false);
		const showError = vi.spyOn(mode, "showError").mockImplementation(() => {});
		const result = await mode.handleMissionModeCommand();
		expect(result).toBe(false);
		const mgr = session.sessionManager;
		expect(missionModeEntryCount(mgr)).toBe(0);
		expect(showError).toHaveBeenCalled();
	});
});
