import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalIsTTY = process.stdin.isTTY;
let agentDirRoot: string | undefined;

beforeEach(async () => {
	agentDirRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-mission-settings-"));
	const agentDir = path.join(agentDirRoot, "agent");
	await fsp.mkdir(agentDir);
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	setAgentDir(agentDir);
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
	__resetDirsFromEnvForTests();
	if (agentDirRoot) await fsp.rm(agentDirRoot, { recursive: true, force: true });
	agentDirRoot = undefined;
});

async function run(parsed: Args, settings: Settings): Promise<CreateAgentSessionOptions | undefined> {
	const authStorage = await AuthStorage.create(":memory:");
	let observed: CreateAgentSessionOptions | undefined;
	try {
		await runRootCommand(parsed, [], {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async options => {
				observed = options;
				throw new Error("stop after session options");
			},
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
	} finally {
		authStorage.close();
	}
	return observed;
}

function baseParsed(rawArgs: string[] = []) {
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = path.join(agentDirRoot ?? os.tmpdir(), "sessions");
	return parsed;
}

it("enables mission mode from the mission.mode setting with no CLI flag (dead-toggle regression)", async () => {
	const settings = Settings.isolated({ "mission.mode": true });
	const observed = await run(baseParsed([]), settings);
	expect(observed?.missionMode).toBe(true);
	expect(observed?.missionDir).toBe(`${process.cwd()}/mission`);
});

it("does not enable mission mode when neither setting nor flag is set", async () => {
	const settings = Settings.isolated({});
	const observed = await run(baseParsed([]), settings);
	expect(observed?.missionMode).toBeFalsy();
	expect(observed?.missionDir).toBeUndefined();
});

it("CLI --mission flag wins over a false mission.mode setting", async () => {
	const settings = Settings.isolated({ "mission.mode": false });
	const observed = await run(baseParsed(["--mission"]), settings);
	expect(observed?.missionMode).toBe(true);
});

it("setting legitimizes --worker-model without --mission (validation relocation)", async () => {
	const settings = Settings.isolated({ "mission.mode": true });
	const observed = await run(baseParsed(["--worker-model", "gpt-5.1-codex"]), settings);
	expect(observed?.workerModelOverride).toBe("gpt-5.1-codex");
});

it("rejects an orphaned --worker-model with CliUsageError", async () => {
	const settings = Settings.isolated({});
	const parsed = baseParsed(["--worker-model", "gpt-5.1-codex"]);
	const authStorage = await AuthStorage.create(":memory:");
	try {
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async () => {
					throw new Error("stop after session options");
				},
			}),
		).rejects.toBeInstanceOf(CliUsageError);
	} finally {
		authStorage.close();
	}
});

it("CLI --worker-model beats the mission.workerModelOverride setting", async () => {
	const settings = Settings.isolated({ "mission.mode": true, "mission.workerModelOverride": "setting-id" });
	const observed = await run(baseParsed(["--mission", "--worker-model", "flag-id"]), settings);
	expect(observed?.workerModelOverride).toBe("flag-id");
});

it("uses mission.workerModelOverride setting when no CLI flag is given", async () => {
	const settings = Settings.isolated({ "mission.mode": true, "mission.workerModelOverride": "setting-id" });
	const observed = await run(baseParsed([]), settings);
	expect(observed?.workerModelOverride).toBe("setting-id");
});
