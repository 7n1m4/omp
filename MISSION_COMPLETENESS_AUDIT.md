# Mission Mode Completeness Audit

## Summary

Partial implementation: CLI flags, session predicates, and a basic `MissionFileService` (types + file ops + access guard) exist. Tools, worker model overrides, enforcement wiring, system prompt, state machine, validators, persistence hooks are missing.

## Audit Table

| Component | Status | Evidence | Gaps |
|---|---|---|---|
| CLI flags (`--mission`, `--worker-model`) | Implemented | `packages/coding-agent/src/cli/args.ts` lines 55-56, 366-367, 444-445; flag-tables registration | None observed |
| Session predicates (`isMissionMode`, `isLegacyMissionMode`) | Implemented (basic) | `packages/coding-agent/src/session/agent-session.ts` 6738-6743 | Fields `missionMode`/`legacyMissionMode` storage not verified; no `missionDir` exposure evident |
| Mission directory & file service | Partial | `packages/coding-agent/src/mission/file-service.ts`, `types.ts` | Missing `state.ts`, `progress-log.ts` (aggregation helper in service only), `access.ts` standalone; layout incomplete (no architecture.md, validation-contract.md, AGENTS.md, skills/, services.yaml, init.sh, library/, mission md creation); `readEffectiveModelSettings` returns raw persisted only (no global merge) |
| Worker pool & autonomy | Missing | No `mission-worker-base`, `getMissionWorkerModel`, `getMissionWorkerReasoningEffort`, `getMissionValidationWorkerModel` | No worker base agent, model overrides, autonomy forcing |
| Orchestrator tools | Missing | No `propose_mission`, `start_mission_run`, `end_feature_run`, `dismiss_handoff_items`, `recommend_mission` | Entire tool layer absent |
| Permission & access enforcement | Partial | `enforceMissionAccess` exists in file-service | Not wired into read/write/edit tool paths |
| System prompt / role discovery | Missing | No mission section in system prompt | Orchestrator role, validators, conventions absent |
| Validation | Missing | Types only | No validator names (scrutiny/user-testing), no validation worker model, no state updates |
| Persistence & observability | Partial | Directories `transcripts/`, `handoffs/` created | No transcript/handoff persistence wiring, no scope-growth guard, no paused state handling |
| State machine | Missing | Types define phases but no implementation | `proposed->approved->running->completed/paused`, scope growth, `lastReviewedHandoffCount` absent |

## bun check

Passes (`bun run check` completed 38.00s, no type errors).