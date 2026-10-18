# Scout: Mission Mode Implementation in omp

## Scope
Reviewed `packages/coding-agent/src/mission/`, `tools/mission.ts`, `config/mission-worker.ts`, system prompt mission section, session fields, and main wiring. Cross-referenced against `MISSION_COMPLETENESS_AUDIT.md` and `MISSION_INTEGRATION_PLAN.md`.

## Implemented
- CLI flags `--mission`, `--worker-model` wired in `main.ts` → `sessionOptions.missionDir`/`missionMode`/`workerModelOverride`.
- Session predicates `isMissionMode()`/`isLegacyMissionMode()` in `agent-session.ts` (lines ~6738).
- Session fields: `missionMode`, `legacyMissionMode`, `missionDir`, `workerModelOverride` (types + construction).
- `MissionFileService`: init (transcripts/handoffs dirs), read/write features, validation state, progress log append/read/filter, mission state, effective model settings merge, start/end feature run, scope-growth check, dismiss handoffs, recommend/propose mission, enforceMissionAccess.
- Orchestrator tools in `tools/mission.ts`: propose/start/end/dismiss/recommend (gated on `session.missionDir`).
- Worker base agent `mission-worker-base.md` registered in `task/agents.ts`.
- `resolveSubagentAutonomyLevel(isMissionMode)` forces high in mission mode.
- System prompt includes mission dir + AGENTS.md reference when `missionDir` set.
- `config/mission-worker.ts`: env-based model/effort overrides (MISSION_* / DROID_*).

## Gaps vs plan/droid
- Layout incomplete: `initMissionDir` only creates transcripts/handoffs; missing architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, mission md, features.json/validation-state.json seeds.
- No `state.ts` machine beyond service methods; no standalone `progress-log.ts` aggregation helper; no standalone `access.ts`.
- `readEffectiveModelSettings` merges global+persisted but global read via untyped settings cast; no persistence hook for model-settings.json.
- Tools not registered in tool index? Need verify wiring in tools/index.ts and system prompt mission section gated on `isMissionMode()` not just missionDir.
- No worker pool integration: `getMissionWorkerModel` etc. not consumed in task/executor for model/thinking selection; autonomy forcing may not be wired into spawn path.
- No enforcement of `enforceMissionAccess` in read/write/edit tool paths.
- No transcript/handoff persistence wiring, no paused-state handling UX, no scope-growth guard integration beyond service.
- `mission-worker-base.md` model set to `@task`; worker model overrides not applied.
- No validation worker invocation/state updates beyond service.
- System prompt lacks orchestrator role, validators, conventions beyond directory pointer.

## Verification
`bun run check` passes (35.6s, no type errors).
