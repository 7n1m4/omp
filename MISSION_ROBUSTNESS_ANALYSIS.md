# Mission Mode Robustness Analysis (Autonomous Use)

Scope: `packages/coding-agent` mission subsystem as of 2026-10-18. Read-only analysis; no code changes. `bun run check` passes (34.92s, no type errors). Cross-references: `scout_omp.md`, `scout_droid.md`, `cross1_parity.md`, `cross2_arch.md`, `cross3_readiness.md`, `MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, droid-reverse `mission_mode_architecture.md` / `mission_mode_integration.md`.

## Executive Summary

Mission mode has foundational plumbing (CLI flags, session predicates/fields, `MissionFileService`, orchestrator tools, worker base agent, autonomy helper, system-prompt dir pointer, env model config) but is **not robust for autonomous use**. Critical paths are unwired: workers are never spawned with mission overrides, access enforcement is never invoked, scope-growth pausing is never triggered by completion flow, validators do not exist, transcripts/handoffs are never persisted, and the state machine has no transition guards. The orchestrator tools exist but `start_mission_run` does not actually run workers. System prompt lacks role/conventions/validators, so an LLM orchestrator cannot reliably drive the mission. Handoff schema is too thin for autonomous retry decisions. Net: mission mode today is a scaffold; autonomous runs would stall or silently corrupt state.

## Severity Scale

- **Critical (C)**: blocks autonomous mission execution or corrupts state.
- **High (H)**: breaks a core autonomous capability; workaround exists but fragile.
- **Medium (M)**: degrades robustness/observability; not blocking.
- **Low (L)**: polish/optional.

## Critical Gaps

### C1. No worker execution runner (`start_mission_run` is a no-op state flip)
- Evidence: `MissionFileService.startMissionRun()` only mutates `mission-state.json` to `running`; `tools/mission.ts` `createStartMissionRunTool` delegates to it. No spawning of `mission-worker-base`, no feature `pending -> in_progress`, no progress-log `worker_started`.
- Impact: orchestrator cannot actually drive work; autonomous missions never execute.
- Action: implement a sequential worker runner that, while `state === running`, picks next `pending` feature, marks `in_progress`, spawns `mission-worker-base` subagent with mission worker model/effort, appends `worker_started`, awaits completion, appends `worker_completed` with handoff, updates feature status, and re-evaluates scope growth. Gate on `paused`/`completed`.

### C2. Worker model overrides never applied
- Evidence: `config/mission-worker.ts` (`getMissionWorkerModel`, `getMissionWorkerReasoningEffort`, `getMissionValidationWorkerModel`) has zero callers. `task/executor.ts` does not reference mission. `mission-worker-base.md` frontmatter `model: "@task"` fixed. `session.workerModelOverride` (from `--worker-model`) stored but unused. `readEffectiveModelSettings()` merges persisted+global but has no persistence hook and untyped global cast.
- Impact: `--worker-model` and env overrides are inert; workers run on default model, defeating configurability and validation worker separation.
- Action: wire overrides into spawn path: resolve worker model as `workerModelOverride ?? getMissionWorkerModel() ?? readEffectiveModelSettings().workerModel`; apply reasoning effort; use for `mission-worker-base` spawn instead of `@task`. Add `getMissionValidationWorkerModel()` consumption for validators. Persist `model-settings.json` via a write hook and type the global settings read.

### C3. Access enforcement not wired into tool paths
- Evidence: `enforceMissionAccess` exists in `file-service.ts` but has zero callers (grep confirms). Read/write/edit tools never invoke it.
- Impact: in mission mode, workers/orchestrator can touch arbitrary non-mission files; mission isolation guarantee is absent. Autonomous agents may corrupt repo.
- Action: call `enforceMissionAccess` in read/write/edit tool handlers when `session.isMissionMode()`; block with clear error. Also enforce in task spawn cwd if applicable. Keep allowed paths: missionDir + (maybe) repo working tree per droid semantics—verify against reference before finalizing (open question).

### C4. No mission directory layout seeding
- Evidence: `initMissionDir` creates only `transcripts/` and `handoffs/`. Missing `architecture.md`, `validation-contract.md`, `AGENTS.md`, `skills/`, `services.yaml`, `init.sh`, `library/`, `features.json`, `validation-state.json` seeds, proposal/mission md. `MissionFileService.readFeatures/readValidationState` throw on missing files.
- Impact: service crashes on first use; orchestrator and workers lack conventions/context; no seed data for scope-growth guard.
- Action: extend `initMissionDir` to create full layout with sensible empty seeds (`features.json` with `initialFeatureCount: 0`, `scopeGrowthMultiplier` default e.g. 1.5; `validation-state.json` with validators list and `pending`). Write `AGENTS.md` registry (worker base id, validators). Create dirs/files idempotently. Call init at session start when `missionMode`.

### C5. No validators or milestone gates
- Evidence: `ValidationState` types exist but no `scrutiny-validator`/`user-testing-validator` agents. No invocation, no state updates, no milestone gate commands (test/typecheck/lint). `getMissionValidationWorkerModel` unused.
- Impact: validation phase absent; features can be marked complete without checks; autonomous completion untrustworthy.
- Action: add validator agent definitions; implement validation runner that runs validators against completed features, executes milestone gate commands, updates `validation-state.json` (`results`, `overallStatus`), and blocks feature completion on failure.

### C6. Scope-growth guard not integrated into completion flow
- Evidence: `checkScopeGrowth` exists but only called by `endFeatureRun`. `endFeatureRun` always returns `success: true` and marks feature completed even if paused. No paused-state UX/handling. `dismissHandoffItems` mutates `lastReviewedHandoffCount` without bounds/validation.
- Impact: scope creep may pause mission but caller ignores `paused`; mission continues incorrectly; handoff review accounting can drift.
- Action: make `endFeatureRun` honor paused state (return paused, skip further work), add transition guards (only running -> paused), and surface paused state to orchestrator/system prompt. Validate `dismissHandoffItems` counts against actual unreviewed handoffs.

### C7. State machine lacks transition guards and persistence atomicity
- Evidence: `startMissionRun` blindly sets `proposed -> approved -> running` regardless of current state. `readMissionState` returns default on any read error (masks corruption). No file locking/atomic writes; concurrent workers can race. No `completed` transition helper.
- Impact: invalid transitions possible; corrupted/partial JSON silently reset to `proposed`, losing mission; races in autonomous parallel runs.
- Action: implement explicit transition functions with precondition checks, atomic write (write temp + rename), fsync, and error propagation (not silent default). Add `completeMission()` when all features completed and validation passing.

### C8. Handoff schema too thin for autonomous retry
- Evidence: `WorkerHandoff` only `{ successState, summary, artifacts }`. Droid requires `whatWasImplemented`, `whatWasLeftUndone`, `verification`, `successState` pass/fail, `commitId`/`repoPath` if code changed. `ProgressLogEntry.worker_started` lacks `workerSessionId`, `spawnId`, `modelId`, `substitutedFromModelId`; no `worker_selected_feature` event.
- Impact: orchestrator cannot decide retry/reassign or verify claims; audit trail insufficient.
- Action: extend `WorkerHandoff` and `ProgressLogEntry` per droid schema; update aggregation filter. Migrate (none persisted yet, safe).

## High Gaps

### H1. System prompt mission section lacks role, validators, conventions
- Evidence: section only says orchestrator + worker base id/validators/dir pointer. `workerBaseId`/`validatorNames` never populated (no defaults), so lines are omitted. No conventions, tool usage, or paused-state handling guidance.
- Impact: LLM orchestrator lacks instructions; autonomous behavior unreliable.
- Action: default `workerBaseId = "mission-worker-base"`, `validatorNames = ["scrutiny-validator","user-testing-validator"]` in main/sdk; expand prompt with orchestrator duties, tool list, worker spawning rules, validation, scope-growth pause handling, access rules.

### H2. Mission tools gating on `missionDir` instead of `isMissionMode()`
- Evidence: `makeTool` checks `session.missionDir`; tools/index registration not gated on `isMissionMode()`. `missionDir` can be set without mission mode in edge cases.
- Impact: tools may appear in non-mission sessions with missionDir; inconsistent gating.
- Action: gate tool creation on `session.isMissionMode()` (and missionDir presence); verify registration in `tools/index.ts`.

### H3. `resolveSubagentAutonomyLevel` never called
- Evidence: helper exists in `spawn-policy.ts` but zero callers. Autonomy not actually forced high in mission mode.
- Impact: workers may run at medium autonomy; insufficient for autonomous execution.
- Action: call helper in task spawn path when parent session `isMissionMode()`; set autonomy high.

### H4. No transcript/handoff persistence wiring
- Evidence: dirs created but nothing writes transcripts/handoffs. No persistence of worker sessions or handoff artifacts.
- Impact: no durable audit; missions cannot be resumed/inspected.
- Action: persist worker transcripts under `missionDir/transcripts/`, handoff JSON under `missionDir/handoffs/`, wire into runner and handoff aggregation.

### H5. Paused-state UX and recovery absent
- Evidence: paused state written but no handling in tools/prompt; no resume/unpause path; no `dismiss`/pruning guidance.
- Impact: once paused, autonomous mission cannot recover without manual file edits.
- Action: add `resume_mission` or allow `start_mission_run` from paused after pruning; expose pause reason in system prompt and tool results; document recovery.

### H6. No progress aggregation helper / richer events
- Evidence: `filterWorkerHandoffs` exists but no standalone `progress-log.ts`; entries minimal. No daemon events (mission_state_changed, mission_features_changed, mission_progress_entry, heartbeat, worker started/completed).
- Impact: observability weak; external consumers cannot track mission.
- Action: add `mission/progress-log.ts` aggregation helpers (latest handoff, unreviewed count, counts by status) and emit events if harness supports.

### H7. `readEffectiveModelSettings` global read untyped + no persistence
- Evidence: casts `settings` to `Record<string,unknown>`; reads `s.missionModelSettings`; no write path for `model-settings.json`.
- Impact: settings may be missed; overrides cannot be persisted per mission.
- Action: type settings access via proper config interface; add `writeModelSettings` method and persistence hook.

### H8. Error handling in file service is lossy
- Evidence: `readFeatures`/`readValidationState` do not catch; `readProgressLog` catches all and returns `[]`; `readMissionState` catches all and returns default. JSON parse errors silently swallowed.
- Impact: data corruption hidden; autonomous runs continue on empty/default state.
- Action: distinguish missing file (ENOENT) from parse errors; propagate parse errors; validate schemas with runtime checks.

## Medium Gaps

### M1. No validation of inputs/schemas
- Evidence: tool schemas minimal (`proposal: string`, `featureId: string`, `items: string[]`). No validation of feature IDs existence, duplicate features, initialFeatureCount positivity, multiplier range.
- Impact: invalid data can be written; scope guard math can be NaN/Infinity.
- Action: validate in service methods; return structured errors; add schema validation (arktype) at boundaries.

### M2. No retry/backoff for worker failures
- Evidence: `WorkerHandoff.successState` can be `failure` but no retry policy, reassignment, or max-attempts tracking.
- Impact: a single worker failure stalls feature indefinitely.
- Action: add retry metadata to feature (attempts, lastError); orchestrator retry policy with max attempts and escalation to user.

### M3. Concurrency safety
- Evidence: no locking/atomic writes; `appendProgressLog` uses `fs.appendFile` (append atomic-ish but no fsync); multiple workers can write simultaneously.
- Impact: interleaved/corrupt JSONL under concurrent autonomous workers.
- Action: serialize writes via a mutex/queue in service; atomic rename for JSON files; fsync.

### M4. `dismissHandoffItems` accounting unsafe
- Evidence: increments `lastReviewedHandoffCount` by `items.length` without checking against actual unreviewed count; can exceed total.
- Impact: review cursor drift; handoffs skipped or negative counts.
- Action: clamp to available unreviewed count; validate item IDs.

### M5. No `worker_selected_feature` / model substitution events
- Evidence: progress log lacks events present in droid.
- Impact: audit/replay incomplete.
- Action: add event variants and emit in runner.

### M6. `mission-worker-base.md` generic and lacks mission conventions
- Evidence: worker prompt is generic task worker; no mission-specific instructions, access rules, handoff format.
- Impact: workers don't know handoff schema or mission constraints.
- Action: rewrite worker base prompt with mission conventions, handoff schema, access enforcement, and artifact expectations.

### M7. No `completed` transition / all-features-done detection
- Evidence: no helper to mark mission completed.
- Impact: mission never reaches `completed`; autonomous loop has no terminal condition.
- Action: add `completeMissionIfDone()` checking all features completed + validation passing.

### M8. No idempotency/init safety for repeated `initMissionDir`
- Evidence: `mkdir recursive` okay, but writes could overwrite; no guard.
- Impact: re-running init could clobber state.
- Action: make init only create missing files (check existence first).

## Low Gaps

### L1. Standalone modules optional (`state.ts`, `progress-log.ts`, `access.ts`)
- Evidence: plan calls for them; currently inlined in service.
- Impact: none functional; maintainability.
- Action: extract when refactoring; not required for robustness.

### L2. Naming/compatibility (`mission-state.json` vs mission state file)
- Acceptable per cross report.

### L3. `isLegacyMissionMode` never set true anywhere
- Evidence: field defaults false; no legacy path.
- Impact: legacy mode unreachable; may be intentional.
- Action: document or remove if unused.

## Cross-Cutting: User Approvals

- `propose_mission` confirmation type `propose_mission` exists in droid but omp tool does not trigger any permission confirmation; it just writes `proposal.md`. 
- Action: integrate with permission system: `propose_mission` should require user approval before transitioning to `approved`; add confirmation type registration. Without this, autonomous mode skips human-in-the-loop approval.

## Recommended Execution Order

1. C4 layout seeding + M8 idempotency (unblocks all file ops).
2. C7 state machine guards + atomic writes + H7 typed settings/persistence.
3. C2 model override wiring (config + executor + worker base model).
4. H3 autonomy wiring.
5. C1 worker runner + C8 handoff schema + H4 persistence + M5 events.
6. C3 access enforcement wiring.
7. C5 validators + milestone gates.
8. C6 scope-growth integration + H5 paused recovery + M4 dismiss safety + M7 completion detection.
9. H1 system prompt expansion + H2 gating + M6 worker prompt.
10. M1 input validation, M2 retry policy, M3 concurrency, H6 progress helper, H8 error handling.
11. L items and cleanup.

## Verification (main agent)

- `bun run check` (already passing).
- Unit tests: file service layout init, state transitions, scope growth, access enforcement, handoff aggregation, model settings merge.
- Smoke: `omp --mission` starts orchestrator; `--worker-model` only valid with `--mission`; mission tools appear only in mission mode.
- Integration: autonomous run spawns worker, records handoff, runs validator, pauses on scope growth.

## Open Questions

- Access enforcement allowed scope: missionDir only vs missionDir + repo working tree (verify against droid `chunk-d02rmc97.js`).
- Whether validators are separate agents or in-process checks; droid lists them as agents.
- Whether `start_mission_run` should block synchronously until completion/pause (droid) or return immediately; affects orchestrator loop design.
- Exact milestone gate commands (test/typecheck/lint) and where defined (services.yaml?).
