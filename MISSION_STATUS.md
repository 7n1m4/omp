# MISSION_STATUS.md

Current verified state of mission mode after the in-session activation work. Supersedes the older root analysis docs (`MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, `MISSION_ROBUSTNESS_ANALYSIS.md`, `ULTRATHINK_SYNTHESIS.md`).

## Implemented and verified (committed)

- `9c8a8e1e88` — `/mission` reuses the canonical relaunch path via `restart()`.
- `e503ebd93a` — `mission.mode` / `mission.workerModelOverride` settings now take effect at launch; CLI flags take precedence over settings; the `--worker-model requires --mission` validation relocated from `cli/args.ts` to `main.ts`.
- `cf38e4d158` — in-session `/mission` activation via `InteractiveMode.handleMissionModeCommand()` (`modes/interactive-mode.ts:~6339`): plan-mode guard, already-active guard, creates `${cwd}/mission` via `MissionFileService.initMissionDir()`, sets `session.missionMode`/`missionDir`/`workerModelOverride`, registers + activates the six mission tools via `ensureMissionRegistered()` (`session/agent-session.ts:~6744`, closure in `sdk.ts`), suppresses the prompt-cache-miss marker (`lastAssistantUsage = undefined`), journals a `mode_change`. Live `ToolSession.missionDir` getter at `sdk.ts:~2347`.
- `a2a1227c5a` — "Mission" registered in `TAB_GROUPS["tasks"]` (`packages/tui/src/overlays/settings-defs.ts:100`) so mission settings render under their section heading in the Tasks tab.
- `6a78f0132d` — audit cleanups: dead `extraLaunchArgs` parameter removed from `restart()`; unused `(rest?, input?)` dropped from `handleMissionModeCommand()`; `/mission/` added to `.gitignore` (`/mission/`) so a run in the repo root does not leave untracked noise.

## A user can verify these by hand

- `/mission` activates mission mode in the running session without relaunching omp.
- The mission dir is seeded with the full layout (`features.json`, `mission-state.json`, `validation-state.json`, `AGENTS.md`, `architecture.md`, `mission.md`, `validation-contract.md`, `services.yaml`, `init.sh`, plus `handoffs/`, `library/`, `skills/`, `transcripts/`).
- The six mission tools become available: `propose_mission`, `start_mission_run`, `end_feature_run`, `dismiss_handoff_items`, `recommend_mission`, `resume_mission`.
- Read/write/edit are access-restricted to the mission dir while mission mode is on.

## Known limitations — a mission run does NOT execute real work (read this before testing)

`start_mission_run` (`packages/coding-agent/src/tools/mission.ts:44`) calls `runMission(session)` with no `spawnWorker`, so `mission/runner.ts` takes its `else` branch and fabricates `successState: "success"`, then unconditionally marks each feature `completed` (~line 176). No worker is spawned and no work is performed. Verified root cause: no tool in this codebase can spawn a subagent; `ToolSession` exposes no spawn API; `mission-worker-base` is hardcoded to `model: "@task"` (`packages/coding-agent/src/task/agents.ts:58`), so worker model overrides are inert for a spawned worker.

Also still live:

- `runValidators` (`mission/file-service.ts:~147-148`) stamps `status: "pass"` with empty findings without executing validators.
- `endFeatureRun` (`file-service.ts:~272`) marks a feature completed before the scope-growth check and returns `success: true` even when paused.
- Handoffs are never persisted under `missionDir/handoffs` or `transcripts/`; only `progress_log.jsonl` entries are written.
- `readMissionState` swallows errors and returns a default (`file-service.ts:~186-193`); writes use a fixed temp file + rename with no fsync/locking.

## Ranked next steps

1. Remove the fake-success `else` branch in `mission/runner.ts` so a run without `spawnWorker` fails loudly instead of silently completing features — highest leverage, no new architecture.
2. Decide the execution model: orchestrator LLM drives work via the `task` tool, or wire a real `spawnWorker` through the agent executor. Needs a design decision.
3. Make `runValidators` actually execute; fix `endFeatureRun` ordering; persist handoff files.

## Verified claims that the older analysis docs got WRONG

- Mission access enforcement IS wired: `tools/read.ts:~1684`, `edit/index.ts:~504`, `tools/write.ts:~800` all call `svc.enforceMissionAccess(...)` and throw `ToolError`. (C3 in the old docs claimed zero callers.)
- The handoff schema is rich: `mission/types.ts:~50-62` already carries `whatWasImplemented`, `verification`, `commitId`, `repoPath`, `attempts`, `retryCount`, `lastError`. (Old C8 claimed too thin.)
- `initMissionDir` DOES seed the full layout (`mission/file-service.ts:~47-73`). (Old C4 claimed only transcripts/handoffs.)
- `filterWorkerHandoffs` IS used, via `aggregateProgressLog` and `dismissHandoffItems` (`mission/progress-log.ts`). (Old C7 claimed unused.)
- The runner DOES mark features `in_progress` and appends `worker_started`/`worker_completed` progress entries (`mission/runner.ts:~98-103`). (Old C1's "no pending→in_progress" was wrong.)

## Note on the older root docs

`MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, `MISSION_ROBUSTNESS_ANALYSIS.md`, and `ULTRATHINK_SYNTHESIS.md` are pre-implementation analysis snapshots. Treat their Critical gap lists as historical context, not current truth — see the stale-claims list above.