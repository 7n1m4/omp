# Cross-Architecture: Mission Mode — droid-reverse vs omp

## 1. Architecture Alignment

| Area | droid-reverse | omp | Status |
|---|---|---|---|
| CLI entry | `--mission`, `--worker-model` | Wired in `main.ts` → sessionOptions | Aligned |
| Worker base agent | `mission-worker-base` (`kF`) | `mission-worker-base.md` registered in `task/agents.ts` | Aligned (model override gap) |
| Autonomy forcing | `resolveSubagentAutonomyLevel` high when `isMissionMode` | Same helper exists | Aligned |
| Mission file service | `MissionFileService` w/ persisted+global merge | `MissionFileService` class | Partially aligned (layout) |
| Orchestrator tools | propose/start/end/dismiss/recommend | `tools/mission.ts` gated on `session.missionDir` | Aligned (registration verify) |
| Session predicates | `isMissionMode()` | `isMissionMode()`/`isLegacyMissionMode()` | Aligned |
| Access enforcement | `enforceMissionAccess` | service method exists, not wired into read/write/edit | Gap |
| Scope growth guard | state→paused, `pauseReason` | service method exists | Gap (integration) |
| Progress log | JSONL append/read/filter | same | Aligned |
| Handoff aggregation | filter worker_completed w/ handoff | `filterWorkerHandoffs()` | Aligned |
| Model settings | persisted + global merge, persistence hook | merge global+persisted; no persistence hook | Gap |
| Validators | scrutiny/user-testing list | validation state types only | Gap (no invocation) |
| System prompt | orchestrator role, validators, conventions | only dir + AGENTS.md pointer | Gap |
| Mission dir layout | architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, mission md, features/validation seeds | only transcripts/handoffs | Gap |

## 2. Data Model Alignment

### MissionState
- droid: persisted in missionDir; phase transitions proposed→approved→running→completed/paused; `pauseReason`, `lastReviewedHandoffCount`, `isLegacyMissionMode`.
- omp `MissionState`: identical fields (`state: MissionPhase`, `pauseReason`, `lastReviewedHandoffCount`, `isLegacyMissionMode`). **Aligned.**

### Features
- droid: statuses pending/in_progress/completed; `owner`, `handoffId`, timestamps; initialFeatureCount + scopeGrowthMultiplier.
- omp `MissionFeature`/`MissionFeaturesFile`: same. **Aligned.**

### Validation
- droid: validators `scrutiny-validator`, `user-testing-validator`; milestone gate commands (test/typecheck/lint).
- omp: `ValidationState`/`ValidationResult` types with `validators`, `results`, `overallStatus` (passing/failing/pending). **Schema aligned; no validator invocation wiring.**

### WorkerHandoff
- droid: requires `whatWasImplemented`, `whatWasLeftUndone`, `verification`; successState pass/fail; commitId/repoPath if code changed. Also `summary`, `artifacts` maybe.
- omp `WorkerHandoff`: `{ successState, summary, artifacts }` only. **Partial — missing implementation/verification/left-undone fields and commit/repo.** Need extend to match droid handoff schema (`chunk-8vz56md4.js`).

### ProgressLogEntry
- droid: worker_started includes workerSessionId, spawnId, featureId, modelId, substitutedFromModelId; worker_completed w/ handoff; worker_selected_feature; mission_paused.
- omp: `worker_started { workerId, featureId, timestamp }`; `worker_completed { workerId, featureId, handoff, timestamp }`; `mission_paused { pauseReason, timestamp }`. **Partial — missing modelId/substitutedFromModelId/workerSessionId/spawnId/worker_selected_feature.**

### MissionModelSettings
- droid: workerModel, workerReasoningEffort, validationWorkerModel.
- omp: same plus index signature. **Aligned.**

### MissionAccessResult
- both `{ allowed, reason? }`. **Aligned.**

## 3. Key Gaps to Close (omp)

1. **Mission dir layout**: seed architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, mission md, features.json, validation-state.json.
2. **WorkerHandoff schema**: extend with whatWasImplemented, whatWasLeftUndone, verification, commitId, repoPath.
3. **Progress log entries**: add workerSessionId/spawnId/modelId/substitutedFromModelId and worker_selected_feature event.
4. **Model settings persistence**: hook to write model-settings.json; wire getMissionWorkerModel etc into task executor.
5. **Access enforcement**: call enforceMissionAccess in read/write/edit paths.
6. **Scope growth**: integrate paused-state UX.
7. **Validators**: invoke scrutiny/user-testing; run milestone gates.
8. **System prompt**: orchestrator role, validators, conventions.
9. **Autonomy wiring**: ensure forcing in spawn path.
10. **Transcript/handoff persistence wiring.**

## 4. Non-Goals / Notes
- Binary untouched; omp uses Bun/TS. Naming differences (mission-state.json vs mission state file) acceptable if service owns mapping.
- `enforceMissionAccess` currently allows only paths under missionDir — droid semantics may differ; verify against `chunk-d02rmc97.js`.