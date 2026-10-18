# Cross-Analysis: Mission Mode Implementation Readiness (omp vs droid-reverse)

## 1. Readiness Summary

**omp is partially ready**: foundational plumbing (CLI flags, session predicates/fields, `MissionFileService`, orchestrator tools, worker base agent registration, autonomy forcing, system-prompt mission dir pointer, env-based model config) is implemented and `bun run check` passes. However, it is **not feature-complete** against the droid-reverse reference. The gap list in `scout_omp.md` is accurate and largely mirrors unimplemented droid subsystems.

**droid-reverse** is the reference: a fully realized mission mode with sequential worker runner, validator pipeline, scope-growth pausing, access enforcement, handoff aggregation, and model override merge. It was extracted from compiled chunks; no code changes made.

## 2. Side-by-Side Capability Matrix

| Capability | droid-reverse | omp | Status |
|---|---|---|---|
| CLI `--mission` / `--worker-model` | Yes | Yes (`main.ts`) | Done |
| Session mission predicates | Yes | `isMissionMode`/`isLegacyMissionMode` | Done |
| Session fields (missionDir, workerModelOverride) | Yes | Yes | Done |
| MissionFileService (features, validation state, progress log, mission state) | Yes | Yes | Done |
| Effective model settings merge (persisted+global) | Yes (`MissionFileService.readEffectiveModelSettings`) | Partial (untyped global cast, no persistence hook) | Gap |
| Mission dir layout (architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, features.json/validation-state.json seeds, mission md) | Yes | Only transcripts/handoffs dirs | Gap |
| Orchestrator tools (propose/start/end/dismiss/recommend) | Yes | Yes, gated on `missionDir` | Done (verify index wiring) |
| Worker base agent `mission-worker-base` | Yes (`mission-worker-base`) | Registered in `task/agents.ts` | Done (model `@task`, overrides not applied) |
| Autonomy forced high in mission mode | Yes | Yes (`resolveSubagentAutonomyLevel`) | Need verify wired into spawn path |
| System prompt mission section | Yes (orchestrator role, validators, conventions) | Only mission dir + AGENTS.md pointer | Gap |
| Model overrides consumed in task/executor | Yes (`getMissionWorkerModel`, effort, validation worker model) | Not consumed | Gap |
| Worker pool integration / sequential runner | Yes (`start_mission_run` blocks until handoff/pause/complete) | Absent | Gap |
| Validators (scrutiny-validator, user-testing-validator) | Yes (`PI = [XC, KC]`) | Absent (service only) | Gap |
| Milestone gate commands (test/typecheck/lint) | Yes (scrutiny validator) | Absent | Gap |
| Scope-growth guard → paused state | Yes | Service method exists; not integrated | Gap |
| Mission access enforcement in read/write/edit | Yes (`enforceMissionAccess`) | Service method exists; not wired into tool paths | Gap |
| Transcript/handoff persistence wiring | Yes | Absent | Gap |
| Paused-state handling UX | Yes | Absent | Gap |
| Handoff aggregation (`worker_completed` filter, `workerHandoffs`, `latestWorkerHandoff`) | Yes | Types only; no aggregation helper | Gap |
| Handoff schema (whatWasImplemented/whatWasLeftUndone/verification/successState/commitId/repoPath) | Yes | `WorkerHandoff` simplified (successState/summary/artifacts) | Gap (schema mismatch) |
| `dismiss_handoff_items` | Yes | Tool present | Done |
| Progress log events (worker_started/completed/selected_feature, mission_*) | Yes (full daemon events) | Basic progress log entries | Gap (event richness) |
| Mission state machine (`state.ts`) | Implicit in service/handlers | No standalone | Optional |
| Progress aggregation helper (`progress-log.ts`) | Yes (`chunk-29gpdxr7.js`) | Absent | Gap |
| Access module (`access.ts`) | Yes | Absent (in service) | Optional (refactor) |

## 3. Critical Path / Next Steps (ordered)

1. **Complete mission dir layout** (`MissionFileService.initMissionDir`): seed architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, features.json, validation-state.json, mission md. Unblocks orchestrator + worker context.
2. **Wire model overrides into spawn path**: consume `getMissionWorkerModel()`/effort/validation worker model in `task/` executor; apply to `mission-worker-base` instead of fixed `@task`.
3. **Implement worker runner**: sequential spawn loop (`start_mission_run` equivalent) blocking until handoff actionable / pause / complete; aggregate `workerHandoffs` + `latestWorkerHandoff`.
4. **Align handoff schema** with droid (whatWasImplemented, whatWasLeftUndone, verification, successState pass/fail, commitId/repoPath) and update progress-log filter.
5. **Add validators**: implement `scrutiny-validator` and `user-testing-validator` agents; run milestone gate commands; update validation state.
6. **Enforce access control**: call `enforceMissionAccess` in read/write/edit tool paths.
7. **Integrate scope-growth guard** into feature completion flow → paused state + UX.
8. **Expand system prompt** mission section: orchestrator role, validators, conventions, not just dir pointer.
9. **Persist transcripts/handoffs** and wire paused-state handling UX.
10. **Verify tool registration** in `tools/index.ts` and gating on `isMissionMode()` (not just `missionDir`).
11. **Add progress aggregation helper** and richer daemon events (mission_state_changed, mission_features_changed, mission_progress_entry, mission_heartbeat, mission_worker_started/completed).

## 4. Non-Goals / Deferred

- Binary untouched; no changes to droid-reverse.
- No new docs beyond this file (per assignment).
- Verification (`bun run check`) already passing; main agent owns final verification.

## 5. Blockers / Open Questions

- Whether `tools/index.ts` currently registers mission tools — scout flagged "Need verify wiring". Should confirm before proceeding.
- Whether worker model override should merge global settings from a persisted `model-settings.json` (droid does) — omp currently has no persistence hook.
- WorkerHandoff schema mismatch between omp simplified type and droid richer schema needs migration of any persisted data (none yet, so safe).

## 6. Recommended Immediate Action

Start with (1) layout + (2) model override wiring + (3) handoff schema alignment as a single coherent slice, since they unblock worker runner and validators. Delegate to a task agent for edits; main agent verifies with `bun run check`.