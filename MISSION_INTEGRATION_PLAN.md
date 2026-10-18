# Mission Mode Integration Plan (omp)

Integration of "mission mode" (orchestrator + worker subagents + mission directory + durable state) into `packages/coding-agent/`, based on `/home/vi/droid-reverse/mission_mode_integration.md` and `mission_mode_architecture.md`. No code changes yet — this is the implementation plan and target file list.

## 0. Scope & assumptions

- Primary package: `packages/coding-agent/` (per AGENTS.md).
- New code lives in a new `src/mission/` module plus `src/tools/mission-*.ts` tool factories, reusing existing task/subagent, session, settings, and permission infrastructure.
- Keep cutover clean: mission tools registered as built-ins only when `isMissionMode()`; no parallel legacy shims.

## 1. CLI flags

Add to argument parsing and help:

- `--mission` — run session as orchestrator.
- `--worker-model <id>` — worker model override; valid only with `--mission`.

Files:
- `packages/coding-agent/src/cli/args.ts` — add `mission?: boolean` and `workerModel?: string` to `Args`.
- `packages/coding-agent/src/cli/flag-tables.ts` — register `--mission` as valueless flag and `--worker-model` as string flag in `STRING_SETTERS`/`VALUELESS_FLAGS`/optional flag sets.
- `packages/coding-agent/src/cli/launch-help.ts` — help text entries.
- `packages/coding-agent/src/main.ts` — validate `--worker-model` requires `--mission`; pass `mission`/`workerModel` into session creation options.

## 2. Session model & predicates

Implement session-level mission state and predicates used throughout.

Files:
- `packages/coding-agent/src/session/agent-session.ts` — add `isMissionMode()` / `isLegacyMissionMode()` predicates on session; store mission mode flag, `missionDir`, worker model overrides; expose to tools/system prompt.
- `packages/coding-agent/src/session/session-manager.ts` — persist/restore mission fields in session header/entries; resolve mission directory path; sub-session (worker) linkage.
- `packages/coding-agent/src/session/sub-sessions.ts` — track worker subagent sessions spawned under a mission.
- `packages/coding-agent/src/session/session-tools.ts` — wire mission tool factories conditionally.
- New `packages/coding-agent/src/mission/state.ts` — mission state machine (`proposed -> approved -> running -> completed|paused`), pause reasons, `lastReviewedHandoffCount`, scope-growth check.

## 3. Mission directory & file service

Create durable mission directory layout and typed read/write service.

Files:
- New `packages/coding-agent/src/mission/file-service.ts` — `MissionFileService`: create layout, read/write `features.json`, `validation-state.json`, `progress_log.jsonl`, `AGENTS.md`, markdown files; `readEffectiveModelSettings()` merge of persisted + global settings; `enforceMissionAccess()` guard.
- New `packages/coding-agent/src/mission/types.ts` — schemas: `Feature`, `ValidationState`, `ValidationResult`, `ProgressLogEntry`, `MissionState`, `MissionSettings`.
- New `packages/coding-agent/src/mission/progress-log.ts` — append + aggregate helpers (`readProgressLog`, filter `worker_completed` with handoff).
- New `packages/coding-agent/src/mission/access.ts` — `enforceMissionAccess(path)` restricting reads/writes to mission files within `missionDir`.

Layout (created by service init):
```
missionDir/
  architecture.md
  validation-contract.md
  validation-state.json
  features.json
  AGENTS.md
  skills/
  services.yaml
  init.sh
  library/
  progress_log.jsonl
  handoffs/
  transcripts/
```

## 4. Worker pool & autonomy

Workers are subagent sessions of base type `mission-worker-base`; autonomy forced high in mission mode.

Files:
- `packages/coding-agent/src/task/executor.ts` — accept mission worker base agent id; use `getMissionWorkerModel()` / `getMissionWorkerReasoningEffort()` for model/thinking; spawn as mission worker.
- `packages/coding-agent/src/task/structured-subagent.ts` — propagate mission context/worker model into subagent policy.
- `packages/coding-agent/src/task/spawn-policy.ts` — resolve `mission-worker-base` as allowed spawn in mission mode.
- `packages/coding-agent/src/task/persisted-revive.ts` — restore mission worker fallback chains on revival.
- `packages/coding-agent/src/config/settings.ts` — add mission worker model settings and `getMissionWorkerModel`, `getMissionWorkerReasoningEffort`, `getMissionValidationWorkerModel`.
- `packages/coding-agent/src/extensibility/extensions/types.ts` / runner — ensure `before_subagent_spawn` fires for mission workers (existing hook; no change unless needed).

Autonomy:
- Where `resolveSubagentAutonomyLevel` is defined (task subsystem; currently referenced via `chunk-3dferssm.js` equivalent), force `"high"` when session `isMissionMode()`.

## 5. Tools (orchestrator)

Register mission orchestrator tools, gated to mission mode.

Files:
- New `packages/coding-agent/src/tools/mission.ts` — factories for `propose_mission`, `start_mission_run`, `end_feature_run`, `dismiss_handoff_items`, `recommend_mission` using `MissionFileService` and state machine.
- `packages/coding-agent/src/tools/index.ts` — export mission tools; add to `BUILTIN_TOOLS`/`ToolName` (or conditional registration path in session-tools).
- `packages/coding-agent/src/tools/builtin-names.ts` — add mission tool names if central list exists.
- `packages/coding-agent/src/tools/approval.ts` (or permission confirmation registry) — add confirmation type `propose_mission` ("Approve a Mission proposal").

Tool behaviors:
- `propose_mission`: present plan for user review; confirmation type `propose_mission`; on approval state -> `approved`.
- `start_mission_run`: state -> `running`; spawn workers; append `worker_started` entries.
- `end_feature_run`: mark feature completed; check all done -> mission `completed`.
- `dismiss_handoff_items`: advance `lastReviewedHandoffCount`.
- `recommend_mission`: suggest next mission.

## 6. Permission & access enforcement

- `enforceMissionAccess` invoked in read/write tool paths (file read/write/edit) to block non-mission file access outside allowed scope when in mission mode.
- Files: `packages/coding-agent/src/tools/read.ts`, `write.ts`, edit module, `packages/coding-agent/src/mission/access.ts`, and tool session context in `tools/index.ts`.

## 7. System prompt / role discovery

- `packages/coding-agent/src/system-prompt.ts` — add mission-mode section when `isMissionMode()`: orchestrator role, worker base id, validator names, mission conventions; reference `missionDir/AGENTS.md`.
- `packages/coding-agent/src/prompts/system/` — add mission orchestrator prompt template (optional, following existing prompt files).
- Validators `scrutiny-validator` and `user-testing-validator` registered as agent definitions under `packages/coding-agent/src/.../agents` (locate agent definition registry; add two entries).

## 8. Validation

- Update `validation-state.json` via file service after validator runs.
- Validation worker model from `getMissionValidationWorkerModel()`.
- Scope growth guard: in state machine / `end_feature_run`, if `features.length > initialFeatureCount * scopeGrowthMultiplier`, set state `paused`, `pauseReason: "scope_growth_limit_exceeded"`, append `mission_paused` to progress log.

## 9. Persistence & observability

- Persist mission transcripts/handoffs under `missionDir/transcripts/`, `missionDir/handoffs/`.
- Progress log append on worker start/completion/pause.
- `lastReviewedHandoffCount` persisted in mission state.

## 10. Implementation order

1. CLI flags + args + help.
2. Session predicates + persistence.
3. `mission/` module (types, file service, progress log, state, access).
4. Settings additions (worker/validation models).
5. Tool factories + registration + approval confirmation type.
6. Worker spawn integration + autonomy.
7. System prompt + validators.
8. Access enforcement in read/write/edit.
9. Validation + scope growth guard.
10. Docs/changelog updates per AGENTS.md.

## 11. Files to create

- `packages/coding-agent/src/mission/types.ts`
- `packages/coding-agent/src/mission/state.ts`
- `packages/coding-agent/src/mission/file-service.ts`
- `packages/coding-agent/src/mission/progress-log.ts`
- `packages/coding-agent/src/mission/access.ts`
- `packages/coding-agent/src/tools/mission.ts`
- `packages/coding-agent/src/prompts/system/mission-orchestrator.md` (optional)

## 12. Files to modify (primary)

- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/cli/flag-tables.ts`
- `packages/coding-agent/src/cli/launch-help.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/sub-sessions.ts`
- `packages/coding-agent/src/session/session-tools.ts`
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/task/spawn-policy.ts`
- `packages/coding-agent/src/task/persisted-revive.ts`
- `packages/coding-agent/src/tools/index.ts`
- `packages/coding-agent/src/tools/builtin-names.ts`
- `packages/coding-agent/src/tools/approval.ts`
- `packages/coding-agent/src/tools/read.ts`
- `packages/coding-agent/src/tools/write.ts`
- edit module files (locate via `packages/coding-agent/src/edit`)
- `packages/coding-agent/src/system-prompt.ts`
- agent definition registry for `mission-worker-base`, `scrutiny-validator`, `user-testing-validator`

## 13. Verification (main agent)

- Typecheck `packages/coding-agent`.
- Unit tests for mission file service, progress log aggregation, scope growth guard, CLI flag validation.
- Smoke: `omp --mission` starts orchestrator; `--worker-model` only valid with `--mission`.