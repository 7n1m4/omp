import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { shouldEnterVibeModeOnStartup } from "../src/modes/interactive-mode";

describe("shouldEnterVibeModeOnStartup", () => {
	it("enters only when enabled and the session has no conversation or explicit mode", () => {
		expect(
			shouldEnterVibeModeOnStartup(
				{
					buildSessionContext: () => ({ messages: [] }) as never,
					getEntries: () => [] as never,
				},
				Settings.isolated({ "compaction.enabled": false }),
			),
		).toBe(false);
		const enabled = Settings.isolated({ "vibe.defaultOnStartup": true, "compaction.enabled": false });
		expect(
			shouldEnterVibeModeOnStartup(
				{
					buildSessionContext: () => ({ messages: [{}] }) as never,
					getEntries: () => [] as never,
				},
				enabled,
			),
		).toBe(false);
		expect(
			shouldEnterVibeModeOnStartup(
				{
					buildSessionContext: () => ({ messages: [] }) as never,
					getEntries: () => [{ type: "mode_change" }] as never,
				},
				enabled,
			),
		).toBe(false);
		expect(
			shouldEnterVibeModeOnStartup(
				{
					buildSessionContext: () => ({ messages: [] }) as never,
					getEntries: () => [] as never,
				},
				Settings.isolated({
					"vibe.defaultOnStartup": true,
					"vibe.enabled": false,
					"compaction.enabled": false,
				}),
			),
		).toBe(false);
		const fullEnabled = Settings.isolated({
			"vibe.defaultOnStartup": true,
			"vibe.enabled": true,
			"compaction.enabled": false,
		});
		expect(
			shouldEnterVibeModeOnStartup(
				{
					buildSessionContext: () => ({ messages: [] }) as never,
					getEntries: () => [] as never,
				},
				fullEnabled,
			),
		).toBe(true);
	});

	it("ignores metadata entries and treats compaction as conversation", async () => {
		const tempDir = TempDir.createSync("@pi-default-vibe-");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `startup-${Bun.nanoseconds()}`));
		try {
			const enabled = Settings.isolated({ "vibe.defaultOnStartup": true, "compaction.enabled": false });
			manager.appendModelChange("anthropic/claude-sonnet-4-5");
			manager.appendCustomEntry("my-extension-state", { foo: "bar" });
			expect(shouldEnterVibeModeOnStartup(manager, enabled)).toBe(true);

			manager.appendCompaction("prior conversation summary", undefined, "first-kept", 1000);
			expect(shouldEnterVibeModeOnStartup(manager, enabled)).toBe(false);

			manager.appendModeChange("vibe", {});
			manager.appendModeChange("none");
			expect(shouldEnterVibeModeOnStartup(manager, enabled)).toBe(false);
		} finally {
			await manager.close();
		}
	});
});
