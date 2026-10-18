# Feature Parity: Droid Mission Mode vs omp

## Scope
Compares droid-reverse mission mode (reference) against omp implementation, using `scout_droid.md` and `scout_omp.md`. Read-only analysis; no code changes.

## Summary
omp has foundational plumbing (CLI flags, session predicates/fields, `MissionFileService`, orchestrator tools, worker base agent, autonomy forcing, system-prompt dir pointer, env model config). It is not feature-complete against droid. Major gaps: mission directory layout seeding, model override consumption, sequential worker runner, validators, access enforcement wiring, scope-growth integration, handoff aggregation/schema, system prompt orchestration role, transcript/handoff persistence, richer progress events.

## Parity Matrix

| Area | Droid | omp | Status |
|---|---|---|---|
| CLI `--mission`, `--worker-model` | Yes | Yes | Parity |
| Session predicates | Yes | `isMissionMode`/`isLegacyMissionMode` | Parity |
| Session fields | Yes | Yes | Parity |
| MissionFileService core | Yes | Yes | Partial |
| Effective model settings merge | Yes | Partial (untyped global cast, no persistence) | Gap |
| Mission dir layout seeding | Full layout | Only transcripts/handoffs | Gap |
| Orchestrator tools | Yes | Present, gated on missionDir | Verify wiring |
| Worker base agent | Yes | Registered, model `@task`, overrides unused | Gap |
| Autonomy forced high | Yes | Implemented | Verify spawn wiring |
| System prompt mission section | Full role/validators/conventions | Dir + AGENTS pointer only | Gap |
| Model overrides in executor | Yes | Not consumed | Gap |
| Sequential worker runner | Yes (`start_mission_run`) | Absent | Gap |
| Validators (scrutiny/user-testing) | Yes | Absent | Gap |
| Milestone gate commands | Yes | Absent | Gap |
| Scope-growth paused state | Yes | Service method only | Gap |
| Access enforcement in tool paths | Yes | Service method only | Gap |
| Transcript/handoff persistence wiring | Yes | Absent | Gap |
| Paused-state UX | Yes | Absent | Gap |
| Handoff aggregation | Yes | Types only | Gap |
| Handoff schema | Rich fields | Simplified | Gap |
| dismiss_handoff_items | Yes | Tool present | Parity |
| Progress events richness | Full daemon events | Basic entries | Gap |
| Progress aggregation helper | Yes | Absent | Gap |
| Access module standalone | Yes | In service | Optional |
| State machine standalone | Implicit | Absent | Optional |

## Critical Gaps (ordered)
1. Mission dir layout seeding in `initMissionDir`.
2. Consume mission worker model/effort/validation worker model in spawn path.
3. Implement sequential worker runner with handoff aggregation.
4. Align handoff schema with droid.
5. Add scrutiny/user-testing validators and milestone gates.
6. Wire `enforceMissionAccess` into read/write/edit paths.
7. Integrate scope-growth guard into completion flow + paused UX.
8. Expand system prompt mission section.
9. Persist transcripts/handoffs and paused-state UX.
10. Verify mission tool registration and gating on `isMissionMode()`.
11. Add progress aggregation helper and richer events.

## Handoff Schema Mismatch
droid requires: whatWasImplemented, whatWasLeftUndone, verification, successState (pass/fail), commitId/repoPath (if code changed). omp `WorkerHandoff` is simplified (successState/summary/artifacts). Migration safe (no persisted data yet).

## Model Override Gap
droid exposes `getMissionWorkerModel()`, `getMissionWorkerReasoningEffort()`, `getMissionValidationWorkerModel()`, merged with persisted+global settings. omp has `config/mission-worker.ts` env overrides and `readEffectiveModelSettings` but untyped global cast and no persistence hook; overrides not applied in task executor or worker base agent.

## Notes
- droid-reverse untouched.
- Verification remains main agent's responsibility.