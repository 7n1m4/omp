# ULTRATHINK_SYNTHESIS.md — Mission Mode: Consolidated Review Synthesis

Synthesis of independent reviews (VastCod security, NearFirefly architecture, SelectBug robustness/testing, OrdinaryCrow performance) plus `MISSION_ROBUSTNESS_ANALYSIS.md`, `MISSION_COMPLETENESS_AUDIT.md`, `MISSION_INTEGRATION_PLAN.md`, and cross reports (`cross1_parity.md`, `cross2_arch.md`, `cross3_readiness.md`). Read-only synthesis; no code changes.

## 1. Executive Summary

Mission mode in `packages/coding-agent` has solid foundational plumbing (CLI flags, session predicates/fields, `MissionFileService`, orchestrator tools, worker base agent, autonomy helper, model settings merge, dir pointer) and **already seeds the full mission directory layout** in `initMissionDir` (contrary to older audit notes — verified in `file-service.ts:47-73`). `bun run check` passes.

What remains is **wiring and hardening**, not scaffolding: worker spawning is a no-op inside `runMission`; access enforcement is never invoked from tool paths; model overrides are computed then discarded; state transitions lack guards/atomicity; handoff schema is richer in code than the review reports assumed (types already carry optional fields), but persistence/aggregation and validation execution are stubs. Performance review found no actionable hot-path defects.

Net risk: an autonomous run would stall (no worker spawning) or silently corrupt state (lossy reads, non-atomic writes, race-prone feature completion). The highest-leverage work is (a) real worker runner + model override consumption, (b) access enforcement wiring, (c) atomic/guarded state writes, (d) handoff persistence + aggregation, (e) validator invocation.

## 2. Severity Legend

- **Critical (C)**: blocks autonomous execution or corrupts state.
- **High (H)**: major correctness/robustness gap, must close before GA.
- **Medium (M)**: quality/observability/concurrency gap.
- **Low (L)**: polish/optional refactor.

Effort: **S** (<1 day), **M** (1–3 days), **L** (3–7 days), **XL** (>1 week). Effort assumes one focused engineer; parallelizable slices noted.

## 3. Consolidated Findings (deduplicated)

### 3.1 Critical

| ID | Finding | Source | Location | Severity | Effort |
|---|---|---|---|---|---|
| C1 | `runMission` never spawns workers; `workerModel`/`workerEffort`/`validationModel` computed then discarded; marks features completed unconditionally even on throw | NearFirefly, SelectBug, robustness | `mission/runner.ts` | C | L |
| C2 | Model overrides (`getMissionWorkerModel`, effort, validation worker model) never consumed in task executor / worker base agent (`model: "@task"` fixed) | robustness, cross reports | `config/mission-worker.ts`, `task/executor.ts`, `task/agents.ts` | C | M |
| C3 | `enforceMissionAccess` has zero callers; read/write/edit tools never invoke it; lexical-only (no symlink/realpath), TOCTOU possible | VastCod, SelectBug, robustness | `mission/file-service.ts:327-334`, tool paths | C | M |
| C4 | State machine has no transition guards/atomicity; `readMissionState` swallows errors and returns default; `startMissionRun` blindly flips proposed→approved→running; no file locking | NearFirefly, SelectBug | `mission/file-service.ts:186-225`, `mission/runner.ts` | C | M |
| C5 | No validator invocation or milestone gates (scrutiny/user-testing); `runValidators` stamps "pass" with empty findings | robustness, cross reports | `mission/file-service.ts:135-159` | C | L |
| C6 | Scope-growth guard integrated into `endFeatureRun` but `endFeatureRun` always returns `success:true` and marks feature completed even when paused; no paused-state UX/recovery | robustness | `mission/file-service.ts:263-282`, `checkScopeGrowth` | C | M |
| C7 | Handoff/transcript persistence never wired (dirs exist, nothing writes) | robustness, cross reports | `mission/runner.ts`, file service | C | M |
| C8 | Handoff schema mismatch vs droid reference (richer fields optional in code; aggregation helper `filterWorkerHandoffs` exists but unused by runner) | robustness, cross reports | `mission/types.ts:50-62`, `mission/file-service.ts:178-184` | C | S |

### 3.2 High

| ID | Finding | Source | Location | Severity | Effort |
|---|---|---|---|---|---|
| H1 | System prompt mission section minimal: no orchestrator role, validators, conventions, paused/completed state; `workerBaseId`/`validatorNames` never populated | robustness, NearFirefly | `system-prompt.ts` | H | M |
| H2 | Mission tools gated on `session.missionDir` presence rather than `isMissionMode()`; global registration returns null when absent | robustness, NearFirefly | `tools/mission.ts`, `tools/index.ts` | H | S |
| H3 | `resolveSubagentAutonomyLevel` never called in spawn path; autonomy not actually forced high | robustness | `spawn-policy.ts`, `task/executor.ts` | H | S |
| H4 | `start_mission_run` runs entire mission synchronously inside tool call (blocking, not cancellable/observable) | NearFirefly | `tools/mission.ts` | H | M |
| H5 | Duplicate completion paths (`runMission` + `end_feature_run`) can race/double-mark features | NearFirefly | `mission/runner.ts`, `tools/mission.ts` | H | M |
| H6 | `initMissionDir` only called by runner; tools/services can be instantiated before init and crash on read | NearFirefly | `mission/file-service.ts` | H | S |
| H7 | `retryWithBackoff` inconsistent max-attempt semantics, no delay cap/jitter, no timer cleanup; never used by runner | NearFirefly, SelectBug | `mission/runner.ts` | H | S |
| H8 | `runValidators` always returns pass with empty findings; no real validation pipeline or milestone gate commands (test/typecheck/lint) | robustness, cross reports | `mission/file-service.ts:135-159` | H | L |
| H9 | Progress log events lack richness (workerSessionId/spawnId/modelId/substitutedFromModelId, `worker_selected_feature`, daemon events) | robustness, cross reports | `mission/types.ts:64-85` | H | S |

### 3.3 Medium

| ID | Finding | Source | Location | Severity | Effort |
|---|---|---|---|---|---|
| M1 | `readFeatures`/`readValidationState` throw on missing/invalid; `readProgressLog`/`readMissionState` swallow all errors and return defaults (masks corruption) | robustness, NearFirefly, SelectBug | `mission/file-service.ts` | M | S |
| M2 | No input/schema validation in tools (`proposal`, `featureId`, `items`); feature IDs not checked for existence | robustness | `tools/mission.ts` | M | S |
| M3 | Concurrency safety: no locking/atomic compare-and-swap for mission-state writes; `#atomicWrite` uses fixed `.tmp` name (collision risk); no fsync; parallel `endFeatureRun` races | NearFirefly, SelectBug, OrdinaryCrow | `mission/file-service.ts:41-45` | M | M |
| M4 | `dismissHandoffItems` increments `lastReviewedHandoffCount` by `items.length` without bounds check against unreviewed count (can exceed total) | robustness, SelectBug | `mission/file-service.ts:306-314` | M | S |
| M5 | `checkScopeGrowth` appends `mission_paused` even when state is not running | NearFirefly | `mission/file-service.ts:284-304` | M | S |
| M6 | `resumeMission` appends `mission_paused` with reason "resumed" (semantically misleading) | NearFirefly | `mission/file-service.ts:227-241` | M | S |
| M7 | `initialFeatureCount` defaults to 0 and is never initialized when features are added, so `checkScopeGrowth` can immediately pause | NearFirefly | `mission/file-service.ts:14-16` | M | S |
| M8 | `readEffectiveModelSettings` untyped global cast (`settings as Record`), no validation, no persistence hook for `model-settings.json` | robustness, cross reports | `mission/file-service.ts:199-213` | M | S |
| M9 | No concurrency control / bounded worker pool in runner; sequential only; `mapWithConcurrencyLimit` exists but unintegrated | NearFirefly | `mission/runner.ts`, `task/parallel.ts` | M | M |
| M10 | Concurrency patterns duplicated across `parallel.ts`, `collab/registry.ts`, `cleanse/loop.ts` | NearFirefly | multiple | M | L |
| M11 | Module boundary: `MissionFileService` mixes persistence/schema/state/access/validation/model-merge; no DI/shared instance across runner/tools/guards | NearFirefly | `mission/file-service.ts`, `tools/mission.ts` | M | L |
| M12 | No structured logging/metrics around run lifecycle, retries, failures; observability minimal | SelectBug | `mission/runner.ts` | M | S |
| M13 | Paused-state handling UX and recovery absent (no resume/unpause path exposed, no dismiss/pruning guidance) | robustness | tools/prompt | M | M |

### 3.4 Low

| ID | Finding | Source | Location | Severity | Effort |
|---|---|---|---|---|---|
| L1 | Standalone modules optional (`state.ts`, `progress-log.ts`, `access.ts`) — currently inlined | robustness | `mission/` | L | M |
| L2 | Naming/compatibility (`mission-state.json`) — acceptable per cross report | robustness | — | L | — |
| L3 | `isLegacyMissionMode` never set true anywhere | robustness | session | L | S |
| L4 | `mission-worker-base.md` generic; lacks mission conventions, access rules, handoff format | robustness | `task/agents/mission-worker-base.md` | L | S |
| L5 | `recommendMission`/`proposeMission` use `Bun.write` without atomic rename | SelectBug | `mission/file-service.ts:316-325` | L | S |
| L6 | Prompt injection via unsanitized `missionDir` interpolation into system prompt | VastCod | `system-prompt.ts` | L | S |
| L7 | `missionDir` derived from `process.cwd()` without canonicalization/validation | VastCod | `main.ts` | L | S |
| L8 | `enforceMissionAccess` symlink escape; relative targets resolved against cwd not missionDir | VastCod | `mission/file-service.ts:327-334` | L | S |
| L9 | No tests for mission subsystem | SelectBug | `packages/coding-agent/test` | L | L |
| L10 | No idempotency guard for repeated `initMissionDir` writes (currently guarded by `fs.access` per file) | robustness | `mission/file-service.ts:65-72` | L | S |

### 3.5 Performance (OrdinaryCrow)

Review scope: file I/O, locking, worker spawning, progress log size, access checks. **No actionable defects identified** within allotted time; `bun check` clean. Recommendation: deeper focused profiling only after hot paths are named (likely progress-log read O(n) on every aggregation and repeated `readFeatures` in scope-growth loops). Treat as follow-up, not blocking.

## 4. Cross-Cutting Security (VastCod)

- Path containment is lexical only; symlinks bypass. Fix must use `fs.realpath` on both base and target, with TOCTOU mitigation (open-then-fstat or operate within resolved real path).
- Relative target paths should resolve against `missionDir`, not `process.cwd()`.
- `missionDir` should be canonicalized at session creation (`main.ts`).
- System prompt interpolation of `missionDir` should be sanitized/escaped (low risk but cheap).
- Access guard must be invoked at every read/write/edit entry point (not only file service).

## 5. Architecture (NearFirefly)

- Centralize transition table + guards for `MissionPhase` (proposed→approved→running→completed/paused) in a `state.ts` module; file service delegates.
- Separate repository (persistence) from state machine from access policy for testability.
- Provide a single shared `MissionFileService` instance per session (DI) instead of ad-hoc construction in runner/tools/guards.
- Gate tools on `isMissionMode()` not `missionDir`.
- Make `start_mission_run` asynchronous/non-blocking or document blocking contract; add cancellation/progress observation.

## 6. Robustness/Testing (SelectBug)

- Add mission-specific tests: file service (read/write/validate/scope-growth/dismiss), progress log aggregation/filter, runner retry/idempotency, access guard traversal, model settings merge.
- Replace lossy `catch → default` with typed errors; surface corruption.
- Bound `dismissHandoffItems` accounting; validate tool inputs.
- Atomic writes: unique tmp name + fsync + rename; concurrency lock (file lock or in-process mutex per missionDir).
- Retry policy: consistent max attempts, backoff cap + jitter, timer cleanup, used by runner.

## 7. Dependency Graph

```
C4 (guarded atomic state writes) ──┬── C1 (worker runner) ── C5 (validators)
                                   ├── C6 (scope-growth UX) ── M13
                                   └── C7 (persistence wiring)
C3 (access enforcement wiring) ───── C1 (runner needs bounded paths)
C2 (model override consumption) ─── C1 (runner spawns with overrides)
C8 (handoff schema) ─────────────── C1, C7
H2 (tool gating) ─────────────────── H4 (async runner)
H1 (system prompt) ───────────────── C1 (runner lifecycle docs)
H3 (autonomy wiring) ─────────────── C2
M3 (concurrency/locking) ─────────── C4, C6
M1/M4/M5/M6/M7/M8 (small fixes) ──── independent, can batch
L9 (tests) ───────────────────────── after C4/C1 stabilize
```

## 8. Prioritized Action Plan

### Phase 0 — Foundations (week 1, ~3 days, parallelizable)
1. **C4** Guarded state writes + atomic writes + typed errors. Effort M.
2. **C3** Access enforcement wiring + realpath containment. Effort M. (parallel with C4)
3. **M1, M4, M5, M6, M7, M8** small correctness fixes. Effort S each, batch. (parallel)
4. **L6, L7, L8** security hardening. Effort S each. (parallel)
5. **H2, H3** tool gating + autonomy wiring. Effort S each. (parallel)

### Phase 1 — Worker Execution (week 2, ~5 days)
6. **C2** Consume model overrides in executor + worker base agent. Effort M. (depends on H3)
7. **C8** Align handoff schema + aggregation wiring. Effort S.
8. **C1** Implement sequential worker runner with spawning, handoff aggregation, pause/complete checks. Effort L. (depends on C2, C4, C3, C8)
9. **C7** Transcript/handoff persistence wiring. Effort M. (depends on C1)
10. **H4** Make `start_mission_run` non-blocking/observable (or documented blocking). Effort M. (depends on C1)
11. **H5** Deduplicate completion paths. Effort M. (depends on C1)

### Phase 2 — Validation & Scope (week 3, ~4 days)
12. **C5/C6** Validators + milestone gate commands + scope-growth paused UX. Effort L. (depends on C4, C1)
13. **M9, M13** bounded pool + paused recovery. Effort M each.
14. **H1** Expand system prompt mission section. Effort M. (depends on C1, C5)
15. **H9** Richer progress events. Effort S. (parallel)

### Phase 3 — Hardening & Tests (week 4, ~3 days)
16. **M3, M10, M11, M12** concurrency/locking, dedup patterns, module boundaries, observability. Effort M–L.
17. **L9** Mission test suite. Effort L. (depends on Phase 1–2)
18. **H7, H8** retry policy cleanup, validator pipeline. Effort S–L.
19. Performance profiling follow-up (OrdinaryCrow). Effort M.

## 9. Recommended Next Implementation Batch (single coherent slice)

Per cross reports, start with a **single coherent slice** that unblocks worker runner and validators:

**Batch A (Phase 0 + first half of Phase 1), ~4–5 days, parallelizable across 2 engineers:**

- **Engineer 1 (state + access):** C4 (guarded atomic writes + typed errors), C3 (access enforcement wiring + realpath), M1, M4, M5, M6, M7, M8, L6, L7, L8, H2, H3.
- **Engineer 2 (model + handoff + runner skeleton):** C2 (model override consumption), C8 (handoff schema + aggregation), C1 (sequential worker runner skeleton that spawns with overrides and aggregates handoffs, with pause/complete checks), C7 (persistence wiring), H4 (non-blocking contract).

**Acceptance for Batch A:**
- `bun run check` passes.
- `start_mission_run` actually spawns `mission-worker-base` workers with resolved model overrides and aggregates `workerHandoffs`/`latestWorkerHandoff`.
- Access enforcement invoked on all read/write/edit paths and blocks traversal/symlink escapes (tests).
- State writes are atomic, guarded, and surface corruption instead of masking it.
- Handoff persistence writes transcripts/handoffs under `missionDir`.
- No regression in existing mission tests (none yet; add smoke tests).

**Out of scope for Batch A:** validators/milestone gates (C5), scope-growth UX (C6/M13), system prompt expansion (H1), full module refactor (M11), performance profiling. Those follow in Batch B.

## 10. Open Questions (carry forward)

1. Access allowed scope: missionDir only vs missionDir + repo working tree — verify against droid `chunk-d02rmc97.js` before finalizing C3.
2. Whether worker model override should merge global settings from persisted `model-settings.json` (droid does) — omp has no persistence hook (M8).
3. Whether `start_mission_run` should be blocking (droid) or async — decide in H4 (recommend documented blocking for parity, with progress observation).
4. Progress log aggregation O(n) cost — profile after Batch A (OrdinaryCrow follow-up).

## 11. Verification (main agent)

- `bun run check` (already passing at synthesis time).
- After Batch A: add mission file-service unit tests; run `bun run test:ts` for coding-agent; smoke `omp --mission` and `--worker-model` (only with `--mission`).
- Final verification owned by main agent per workflow policy.
