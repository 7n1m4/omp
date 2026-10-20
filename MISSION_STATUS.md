# MISSION_STATUS.md

Current verified state of mission mode after the in-session activation work. Superseded the four older root analysis docs, since removed (`MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, `MISSION_ROBUSTNESS_ANALYSIS.md`, `ULTRATHINK_SYNTHESIS.md`).

## Implemented and verified (committed)

- `9c8a8e1e88` — `/mission` reuses the canonical relaunch path via `restart()`.
- `e503ebd93a` — `mission.mode` / `mission.workerModelOverride` settings now take effect at launch; CLI flags take precedence over settings; the `--worker-model requires --mission` validation relocated from `cli/args.ts` to `main.ts`.
- `cf38e4d158` — in-session `/mission` activation via `InteractiveMode.handleMissionModeCommand()` (`modes/interactive-mode.ts:~6339`): plan-mode guard, already-active guard, creates `${cwd}/mission` via `MissionFileService.initMissionDir()`, sets `session.missionMode`/`missionDir`/`workerModelOverride`, registers + activates the six mission tools via `ensureMissionRegistered()` (`session/agent-session.ts:~6744`, closure in `sdk.ts`), suppresses the prompt-cache-miss marker (`lastAssistantUsage = undefined`), journals a `mode_change`. Live `ToolSession.missionDir` getter at `sdk.ts:~2347`.
- `a2a1227c5a` — "Mission" registered in `TAB_GROUPS["tasks"]` (`packages/tui/src/overlays/settings-defs.ts:100`) so mission settings render under their section heading in the Tasks tab.
- `6a78f0132d` — audit cleanups: dead `extraLaunchArgs` parameter removed from `restart()`; unused `(rest?, input?)` dropped from `handleMissionModeCommand()`; `/mission/` added to `.gitignore` (`/mission/`) so a run in the repo root does not leave untracked noise.
- `f8734ffeb2` — mission runs no longer fake success: a run with no worker spawner fails loudly via `NO_WORKER_SPAWNER_ERROR` instead of silently marking every feature completed. `start_mission_run` bails before mutating mission state; a failed attempt leaves the feature `in_progress`. Regression-tested in `mission-runner-no-spawner.test.ts`.
- `70ddd28aae` — removed four superseded mission analysis docs (`MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, `MISSION_ROBUSTNESS_ANALYSIS.md`, `ULTRATHINK_SYNTHESIS.md`); their disproven claims are preserved in the stale-claims section below.

## A user can verify these by hand

- `/mission` activates mission mode in the running session without relaunching omp.
- The mission dir is seeded with the full layout (`features.json`, `mission-state.json`, `validation-state.json`, `AGENTS.md`, `architecture.md`, `mission.md`, `validation-contract.md`, `services.yaml`, `init.sh`, plus `handoffs/`, `library/`, `skills/`, `transcripts/`).
- The six mission tools become available: `propose_mission`, `start_mission_run`, `end_feature_run`, `dismiss_handoff_items`, `recommend_mission`, `resume_mission`.
- Read/write/edit are access-restricted to the mission dir while mission mode is on.

## Known limitations — execution works; what remains is correctness of the bookkeeping

`f8734ffeb2` removed the silent fake: the no-spawner path in `mission/runner.ts` now assigns `workerError = NO_WORKER_SPAWNER_ERROR` instead of fabricating a handoff, and the status write is gated with `if (!workerError) { f.status = "completed"; }` (`mission/runner.ts:~181`), so a failed attempt leaves the feature `in_progress` — that guard still protects any direct `runMission` caller that passes no spawner, though `start_mission_run` no longer takes it. `5a0b02df94` wired the spawner: `runMissionWithWorker` (`packages/coding-agent/src/tools/mission.ts:~206`) passes `spawnWorker: spawnMissionWorker` into `runMission`, so `start_mission_run` (`packages/coding-agent/src/tools/mission.ts:225`) drives real work instead of bailing out. Each feature gets one `mission-worker-base` child spawned via `runStructuredSubagent` with the static Handlebars assignment prompt `prompts/agents/mission-assignment.md` (rendered by `renderMissionAssignment`, `mission.ts:~41`) and a `WORKER_HANDOFF_SCHEMA`-validated handoff (`mission.ts:~58`); `toWorkerHandoff` throws on an error, an abort, a nonzero exit, missing or invalid structured output, or a reported `failure`, so a worker that fails keeps its feature unfinished rather than completing it. The abort signal the tool is handed now reaches the runner (`mission/runner.ts:~88,155`) — it previously arrived in the position the code called `_ctx` and was dropped.

Also still live:

- `runValidators` (`mission/file-service.ts:~140-157`) stamps `status: "pass"` with empty findings without executing any validator.
- `endFeatureRun` (`file-service.ts:~268-288`) marks a feature completed before `checkScopeGrowth()` runs and returns `success: true` even when paused.
- Handoffs are never persisted to disk under `handoffs/` or `transcripts/`; they only exist inside `progress_log.jsonl` entries.
- `readMissionState` swallows read errors and returns a default (`file-service.ts:~192-199`); writes are a fixed temp file + rename with no fsync and no lock (`#atomicWrite`, `file-service.ts:~46-50`).

## Ranked next steps

1. **Harden the landed execution model** — Option B shipped in `5a0b02df94`: runs now spawn a `mission-worker-base` subagent per feature via `runStructuredSubagent` with a schema-validated handoff and a working abort path. What is left is hardening, not choosing an execution model.
2. Make `runValidators` actually execute; fix `endFeatureRun` ordering (it marks a feature completed before the scope-growth check); persist handoff files.

## Verified claims that the older analysis docs got WRONG

- Mission access enforcement IS wired: `tools/read.ts:~1684`, `edit/index.ts:~504`, `tools/write.ts:~800` all call `svc.enforceMissionAccess(...)` and throw `ToolError`. (C3 in the old docs claimed zero callers.)
- The handoff schema is rich: `mission/types.ts:~50-62` already carries `whatWasImplemented`, `verification`, `commitId`, `repoPath`, `attempts`, `retryCount`, `lastError`. (Old C8 claimed too thin.)
- `initMissionDir` DOES seed the full layout (`mission/file-service.ts:~47-73`). (Old C4 claimed only transcripts/handoffs.)
- `filterWorkerHandoffs` IS used, via `aggregateProgressLog` and `dismissHandoffItems` (`mission/progress-log.ts`). (Old C7 claimed unused.)
- The runner DOES mark features `in_progress` and appends `worker_started`/`worker_completed` progress entries (`mission/runner.ts:~98-103`). (Old C1's "no pending→in_progress" was wrong.)

## Note on the older root docs

`MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, `MISSION_ROBUSTNESS_ANALYSIS.md`, and `ULTRATHINK_SYNTHESIS.md` were removed in `70ddd28aae` because their Critical gap lists were substantially stale. Their disproven claims are preserved in the "Verified claims that the older analysis docs got WRONG" section above, which is still accurate. This file is now the single source of truth for mission mode's state.

`cross1_parity.md`, `cross2_arch.md`, `cross3_readiness.md`, and `scout_omp.md` remain at the repo root as peer pre-implementation snapshots (not deleted; the same caveat applies).
