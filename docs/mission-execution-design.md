# Mission execution model — design brief

> Status: design options for the user to choose. Not yet implemented. Supervised by `MISSION_STATUS.md`.

READ-ONLY deliverable. No files edited, no formatter with a write side effect, no commits.
Grounded in the tree as of the concurrent `fix-fake-success` worker's landed state in
`src/tools/mission.ts` and `src/mission/runner.ts`.

---

## 0. Bottom line

The brief expected Option B to need an agent-executor handle threaded from `AgentSession` down to
`tools/mission.ts:44`. **It does not.** The spawn primitive is `runStructuredSubagent(request)` and its
only session input is a `ToolSession` — which the mission tool already holds in its factory.
`src/eval/agent-bridge.ts:217` already calls it directly from code, so the pattern is pre-existing and
proven. Option B's cost is ~60-100 lines of glue in `src/tools/mission.ts`, not a plumbing project.

Both options fix the same production bug. The decisive difference is not cost — it is that Option B
keeps the programmatic loop (per-feature status, retry/backoff, scope growth, cancellation) where it
already works and only replaces the missing worker, while Option A deletes the runner's driving logic
and re-encodes it in a system prompt that no test can enforce.

---

## 1. Shared facts (file:line)

### 1.1 Subagent spawning — one entry point, reachable from a tool

`src/task/structured-subagent.ts:108-164` — the request shape:

```ts
export interface StructuredSubagentRequest {
	session: ToolSession;                      // <-- the entire session contract
	invocationKind: "task" | "eval";
	assignment: string;
	agent?: string;
	model?: string | string[];                // per-spawn model override
	effort?: TaskEffort;                      // per-spawn effort hint
	outputSchema?: unknown;                   // caller-declared yield schema
	structured?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
```

`src/task/structured-subagent.ts:822`:

```ts
export async function runStructuredSubagent(request: StructuredSubagentRequest): Promise<StructuredSubagentResult> {
```

`src/task/index.ts:581-583` — the `task` tool:

```ts
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
```

`src/task/index.ts:1707-1710` — what it calls:

```ts
const execution = await runStructuredSubagent({
	session: this.session,
	invocationKind: "task",
	assignment,
```

`src/eval/agent-bridge.ts:216-220` — the decisive precedent; code (not an LLM) spawns a subagent with only
a `ToolSession`, from inside `src/`:

```ts
const execution = await runStructuredSubagent({
	session: options.session,
	invocationKind: "eval",
	assignment: parsed.prompt,
```

`src/cleanse/agent.ts:137` and `:171` do the same (`invocationKind: "task"`, `session: toolSession`).
Downward chain: `runStructuredSubagent` → `resolveEffectiveSubagentPolicy`
(`structured-subagent.ts:348`) → `runSubprocess` (`src/task/executor.ts:3985`) → `createAgentSession` for
the child → the run loop.

### 1.2 Is there any path from a tool to a spawn today?

No built-in tool spawns a subagent. The only code-level callers are `src/eval/agent-bridge.ts:217` and
`src/cleanse/agent.ts:137,171`; the `task` tool reaches the primitive through the LLM's tool-call path.
So: no tool-to-spawn path exists yet, but the primitive is trivially reachable from one — Option B's
anticipated blocker does not exist, and the eval bridge is the proof.

### 1.3 `ToolSession` exposes no spawn API

`src/tools/index.ts:218` opens `export interface ToolSession {`; the declaration runs to `:559`.
Relevant members: `missionDir?: string` (`:477`), `getSessionSpawns: () => string | null` (`:415`),
`asyncJobManager?: AsyncJobManager`, `agentOutputManager?: AgentOutputManager`, `settings: Settings`,
`sessionManager?: Pick<SessionManager, ...>`.

There is no executor, spawner, or agent-creation handle anywhere in it. The closest analogue is
`getGoalRuntime?: () => GoalRuntime` — used by `src/goals/tools/goal-tool.ts:85`
(`this.#session.getGoalRuntime?.()`) — but Option B does not need it, because
`runStructuredSubagent` takes the `ToolSession` it is already handed.

`src/session/agent-session.ts:841-844` exposes `missionMode`, `missionDir`, `workerModelOverride` —
session identity, not capability. `src/sdk.ts:2296` builds `const toolSession: ToolSession = {` as a
plain object literal, and the same object is handed to `createTools` (`sdk.ts:2529`) and, for mission
tools, to each factory via `BUILTIN_TOOLS[name](toolSession)` (`sdk.ts:3677-3696`).

### 1.4 Who the orchestrator is, and what it has

Mission mode is the ordinary top-level session with mission tools added on top.
`src/modes/interactive-mode.ts:6358-6369` sets
`await this.session.setActiveToolsByName([...new Set([...enabled, ...missionTools])])` — `enabled` is
whatever the session already has, which includes `task` by default (`src/tools/builtin-names.ts:21`).
`src/main.ts:2267-2270` does the same at launch for `--mission`.

The mission-specific prompt is `src/system-prompt.ts:1048-1063`:

```ts
if (options.missionMode) {
	const workerBaseId = options.workerBaseId ?? "mission-worker-base";
	const validatorNames = options.validatorNames?.length ? options.validatorNames : [...];
	const lines = [
		"## Mission Mode",
		"You are the orchestrator of a mission.",
		`Worker base id: ${workerBaseId}`,
		`Validators: ${validatorNames.join(", ")}`,
		...
		"Mission conventions: work only inside missionDir; follow AGENTS.md; hand off per format.",
		"Paused state: if mission state is paused, call resume_mission to resume; do not start new features.",
```

Absent: any instruction to call `task`, to loop over features, or to use `missionDir/features.json`. The
prompt does **not** describe a task-based workflow today. The `orchestrate` hidden notice
(`src/prompts/system/orchestrate-notice.md`) fires only on the magic keyword
(`src/modes/magic-keywords.ts:78-87`) and is unrelated to mission mode;
`resolveSubagentAutonomyLevel(isMissionMode)` (`src/task/spawn-policy.ts:60-62`) is dead code.

Depth: mission tools run at `session.taskDepth = 0` (`src/sdk.ts:2361`, `taskDepth: options.taskDepth ?? 0`),
so a worker spawn is 0→1, inside `cfgTaskMaxRecursionDepth`'s default `2`
(`src/task/settings.ts:330-334`); `canSpawnAtDepth` (`src/task/types.ts:71-73`) passes. `spawns: "*"`
(`src/sdk.ts:2389`, `getSessionSpawns: () => options.spawns ?? "*"`) resolves to an unrestricted
policy (`src/task/spawn-policy.ts:24-35`).

### 1.5 `mission-worker-base` and `model: "@task"`

`src/task/agents.ts:52-61`:

```ts
{
	fileName: "mission-worker-base.md",
	frontmatter: {
		name: "mission-worker-base",
		description: "Mission worker base agent",
		spawns: "*",
		model: "@task",
		thinkingLevel: AUTO_THINKING,
	},
	template: missionWorkerBaseMd,
},
```

`src/prompts/agents/mission-worker-base.md:1-20` has no `tools:` line, so `parseAgentFields`
(`src/discovery/helpers.ts:315-400`) yields `tools: undefined`. Consequence: the auto-add-`task` branch at
`src/task/executor.ts:4090-4098` does not apply — the worker receives the session's default full tool
surface, matching the prompt's "Tools: FULL access". Worth an explicit decision before shipping (see §3).

`@task` is a role alias, not a literal id. `src/config/model-resolver.ts:1295-1306`:

```ts
const singleAgentPattern = normalizedAgentPatterns.length === 1 ? normalizedAgentPatterns[0] : undefined;
const agentInheritsSessionModel = singleAgentPattern ? isSessionInheritedAgentPattern(singleAgentPattern) : false;
if (configuredAgentPatterns.length > 0) {
	if (singleAgentPattern === formatModelRoleAlias("task") || singleAgentPattern === `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}task`) {
		return { source: agentModel, patterns: configuredAgentPatterns };
	}
```

`expandRoleAlias` (`model-resolver.ts:1243-1250`) resolves it through `settings.getModelRole("task")`
(`src/config/settings.ts:1804-1807`) → `cfgModelRoles`. Unset, it falls through to
`activeModelPattern ?? getModelString() ?? getModelRole("default")` (`model-resolver.ts:1306-1310`).
So the worker inherits the session's strong model by default — **and per-spawn overrides CAN be
honoured**, because `requestModel` is the highest-priority input in `resolveEffectiveAgentModelSelection`
(`model-resolver.ts:1278-1283`).

### 1.6 Worker model resolution

`src/config/mission-worker.ts:1-17` — four env readers and nothing else:

```ts
export function getMissionWorkerModel(): string | undefined {
	return process.env.MISSION_WORKER_MODEL ?? process.env.DROID_WORKER_MODEL;
}
```

`src/mission/runner.ts:76-81` (post-fix):

```ts
const workerModel =
	getMissionWorkerModel() ??
	(typeof sessionRecord.workerModelOverride === "string" ? sessionRecord.workerModelOverride : undefined);
const workerEffort = getMissionWorkerReasoningEffort();
const validationModel = getMissionValidationWorkerModel();
const validationEffort = getMissionValidationWorkerReasoningEffort();
```

None of the four currently reaches a spawn — they only decorate progress-log entries
(`runner.ts:113-119, 187-193`). `workerModelOverride` comes from `--worker-model`
(which requires `--mission`, `src/main.ts:2262-2265`) or the `mission.workerModelOverride` setting
(`src/main.ts:2269-2270`, `src/modes/interactive-mode.ts:6352`); precedence is
**env `MISSION_WORKER_MODEL` > CLI flag > setting** (`runner.ts:76-77`).

`readEffectiveModelSettings()` (`src/mission/file-service.ts:199-212`) merges `model-settings.json` with
`settings.missionModelSettings` and has **no caller in `src/`** — only
`test/mission-subsystem.test.ts:124-126`. Dead until a spawner reads it.

### 1.7 Remaining live gaps (verified)

**C5 validators** — FIXED in the working tree (uncommitted; lands with the C5/C6/C7 work). `src/mission/file-service.ts` no longer fabricates `pass`:
`runValidators` now takes an optional third parameter, an injected execution seam
`spawnValidator?: (validator, featureId) => Promise<{ status; findings }>`. With no seam, each result is
`status: "fail"` with findings `["validator <name> did not run: no spawner configured"]` (never a
fabricated pass); the seam's verdict is recorded verbatim; a throwing validator yields `fail` with the
error message. `ValidationStatus` stays `"pass" | "fail" | "skipped"` and `types.ts` was not modified.
Residual (honest): validators still do not actually execute in a real mission run, because nothing wires a
real `spawnValidator` — the sole caller is `src/mission/runner.ts:210` (`await svc.runValidators(f.id)`)
with no seam, so a real run now records `fail` "did not run: no spawner configured". The seam is
injected rather than spawning directly because `runStructuredSubagent` requires a full `ToolSession`,
which `MissionFileService` (holding only a directory string) cannot reach; synthesizing a stub session
was rejected as worse than the bug. `validationModel`/`validationEffort` remain resolved but unused.
Wiring a real spawner is still outstanding.

**C6 ordering** — FIXED in the working tree (uncommitted; lands with the C5/C6/C7 work). `endFeatureRun` in `file-service.ts` (~line 300) decides
scope growth BEFORE any write; on pause it returns `{ success: true, paused: true, completed: false }`
without persisting `completed`, leaving the feature `in_progress` (no `paused`/`failed` variant was
invented). The two outcomes are mutually exclusive by construction (the pause branch returns early, so
`completed` can never be `true` alongside `paused: true`). Return type unchanged; callers needed no
change (`createEndFeatureRunTool` in `src/tools/mission.ts:234-243` is an opaque `JSON.stringify`
pass-through).

**C7 persistence** — FIXED in the working tree (uncommitted; lands with the C5/C6/C7 work). A new module
`src/mission/handoff-store.ts` now backs `handoffs/`: `handoffSlug(featureId)` gives a stable file stem,
mirroring `sanitizeIdbName` (`src/ida/store.ts:207-210`) - keep `[A-Za-z0-9._-]`, cap at
`MAX_SLUG_LENGTH = 48`, and append an 8-char `Bun.hash` digest whenever sanitizing changed the id. The
digest is deliberate: `feature/one` and `feature_one` sanitize identically and `__f1__` trims to `f1`, so
without it one feature's handoff silently overwrites another's. `handoffPath(missionDir, featureId)` is
`<missionDir>/handoffs/<slug>.json`, one file per feature. `writeHandoff(missionDir, handoff, featureId)`
is pretty-printed like the other mission state files and written via temp file + rename, so a crash
mid-write cannot truncate an earlier handoff; a synthesized failure handoff is persisted unchanged with
its `lastError`. `readLatestHandoff(svc, featureId)` reads that file and, when it is absent (a mission dir
predating the store), falls back to `filterWorkerHandoffs()` from `progress-log.ts`, taking the last
entry - reuse rather than a second way to read the same thing.

`runMission` now persists the handoff after the `worker_completed` progress entry on the success path
(`await writeHandoff(svc.missionDir(), finalHandoff, f.id)`), and has a single validation failure path
covering BOTH sources - a rethrow from `retryWithBackoff` AND a recorded `status: "fail"` that resolved
normally, via a new `failingValidatorFindings(svc, f.id)` helper in `runner.ts`, which is exactly the
second, subtler half of the bug originally documented here. On validation failure it writes the handoff
with `lastError`, appends a knowingly-failed `validation` result when the crash left state stale, pauses
the mission with `pauseReason = "validation_failed: <featureId>"`, appends a `mission_paused` progress
entry, reopens the feature from `completed` back to `in_progress`, and returns
`{ success: false, paused: true, validationFailed, validationError, aggregate }`. It threads
`options.spawnValidator` into `svc.runValidators(f.id, undefined, options.spawnValidator)`.

That whole block is gated on `workerError === undefined`. A failed worker never produced work to
validate, so validating it is not possible and recording validators as `fail` would misreport a
worker failure as a validation failure. `workerError` is the precise signal - "no worker ran" - and is
deliberately not `finalHandoff.successState`, which is `"failure"` for a handoff a worker honestly
reported as failed work. The gate sits outside the `try` so a skipped validation cannot be misread as
a validation crash by the `catch`.

Residual (honest): `RunMissionOptions.spawnValidator` is declared and threaded but `src/tools/mission.ts`
passes no spawner into `runMission` (verified: no `spawnValidator` in that file) - the same fail-closed
residual as C5. Real validators still never execute in a live run; the change makes failure honest and
durable, not absent. `initMissionDir` still creates the `transcripts/` and `handoffs/` directories, but
only `handoffs/` now has content. Return-shape addition: `runMission` also returns
`validationFailed`/`validationError` on the failure path; the only caller is `runMissionWithWorker`
(`src/tools/mission.ts:208`), consumed at `:229` by a whole-object `JSON.stringify`, so the addition is
additive and no caller destructures or type-narrows the old shape.

### 1.8 Cancellation

`RunMissionWorkerContext.signal` (`src/mission/runner.ts:49`, field at `:57`) comes from `RunMissionOptions.signal`
(`runner.ts:61`), and `src/tools/mission.ts` never passes it — so it is `undefined` on every mission run.
A worker **can** honour a signal: `ExecutorOptions.signal` (`src/task/executor.ts:495`) reaches
`executor.ts:1516-1521` → `requestAbort(... "signal")` → `abortActiveSession()` (`:1413-1420`) on the
child `AgentSession`. And an LLM-driven `task` call _does_ carry a signal:
`packages/agent/src/agent-loop.ts:3632-3636` passes `record.signal` to `tool.execute`, which is
`TaskTool.execute`'s third parameter (`src/task/index.ts:924-929`, `signal?: AbortSignal`) and is
forwarded from there into the spawn. So Option A's workers are cancellable for free; Option B's need
`signal` threading into the mission tool (~10 lines).

### 1.9 Existing tests

`test/mission-subsystem.test.ts` (181 lines) covers `MissionFileService` CRUD/validate, scope growth,
handoff dismissal, the access guard, model-settings merge, progress-log aggregation, and
`retryWithBackoff` (`:152-181`). It never calls `runMission` or `endFeatureRun`.
`test/interactive-mode-mission-toggle.test.ts` covers `/mission` registration and directory seeding.
`test/main-mission-settings.test.ts:87-120` covers `--worker-model` precedence.

Pre-existing type errors, confirmed by a read-only `bun check` and left untouched:
`test/mission-subsystem.test.ts(40,42)` "missing ... title, description, status, owner, and 3 more";
`(94,4)` and `(140,4)` "missing ... successState, artifacts".

---

## 2. Option A — Orchestrator-driven (the LLM drives work itself)

**Mechanism.** `start_mission_run` stops driving features. It becomes a readiness gate — keep
`svc.startMissionRun()` (`file-service.ts:216-227`, the `proposed|approved|paused → running` transition)
and return a compact list of `pending` features from `features.json`. The orchestrator LLM then loops:
pick one feature → `task` with `agent: "mission-worker-base"` (already in its toolset, §1.4) → read the
result → `end_feature_run` / progress log → next. The mission block in `system-prompt.ts:1053-1062` grows
the loop contract.

**Files touched (estimate, [INFERENCE]).** `src/system-prompt.ts` mission block, or a new
`src/prompts/system/mission-orchestrator.md` (~30-50 lines) — one, not both; `src/tools/mission.ts`
(rewrite `createStartMissionRunTool` to a gate, ~15-20 lines); `src/mission/runner.ts` (delete
`runMission` or reduce it to start + list, ~-60 lines); `src/mission/settings.ts` possibly a text
`cfgMissionWorkerModel` ([INFERENCE]).

**Effort: M.** Not for lines — A's runtime change is small — but because the loop becomes a prompt, and
every behaviour in it (claim exactly one feature, always call `end_feature_run`, never mark done without
work, honour pause) must be written and then validated against real models.

**What it fixes.** The silent no-op: `start_mission_run` no longer touches feature status, so nothing can
be fabricated. Work happens through the platform's best-exercised spawn path.

**What it leaves / loses.**

- **Retry/backoff dies.** `runMission`'s attempt loop (`runner.ts:136-147`) and `retryWithBackoff`
  (`runner.ts:28-45`) are deleted with the runner or kept unreachable; on failure the LLM decides.
- **Orchestrator drift.** If the model stops calling for the next feature (compaction, a turn ending, an
  error it works around), the mission stalls silently. Nothing detects it.
- **Model/effort overrides become prompt-level or lost.** The task tool exposes no `model` field:
  `src/task/types.ts:70-80` and `createTaskSchema` (`:169-200`) add only
  `effort`/`outputSchema`/`tools`/seance fields. A per-feature `MISSION_WORKER_MODEL` cannot be passed
  per spawn. Mitigation is a tagged session agent (`model: [workerModel]`) — mechanism exists
  (`ToolSession.getSessionAgents`, used at `src/task/index.ts:739`) but is still not per-feature.
- **The turn still blocks** for whichever feature is in flight.
- **C5/C6/C7 fixed** (validators no longer fabricate pass; endFeatureRun ordering; handoffs now persisted and validation failure now pauses), all uncommitted; the residual is that no `spawnValidator` is wired yet.

**Interaction with the runner's existing logic.** Delete: the per-feature loop
(`runner.ts:104-201`, and the second cancel block `:224-233`), `worker_started`/`worker_completed`
emission, `retryWithBackoff` usage, the `onWorkerStart`/`onWorkerComplete`/`onProgress`/`onCancel` hooks
(`runner.ts:62-65`). Keep: `startMissionRun` (`file-service.ts:216`), `completeIfAllFeaturesDone`
(`:257-263`), `checkScopeGrowth` (`:284-303`), the progress log. The "mark `in_progress` before work
starts" invariant (`runner.ts:106-112`) must be re-established where the LLM claims the feature, and a
crash mid-feature leaves it `in_progress` permanently.

**Failure modes.** The LLM skips a feature or fakes completion → feature marked done with no work (a
quieter variant of today's bug). The LLM calls `end_feature_run` without doing work → same. Retry on a
real failure depends on model judgement. Recovery requires the LLM to resume, or a manual
`resume_mission` plus a fresh turn.

**Cost/latency.** One orchestrator turn per feature, each with a nested worker. Comparable worker cost,
plus orchestrator tokens; cadence is model-decided and less predictable.

**Testability.** Weak. `runMission`'s residue is unit-testable; the loop is not. Verification needs real
LLM invocations asserting a call sequence.

---

## 3. Option B — Wire a real `spawnWorker` (the runner drives workers)

**Mechanism.** `src/tools/mission.ts` builds a spawner and hands it to the runner. Concretely
([INFERENCE] shape — nothing written):

```ts
import { runStructuredSubagent } from "../task/structured-subagent";

export async function spawnMissionWorker(context: RunMissionWorkerContext): Promise<WorkerHandoff> {
	const features = await context.svc.readFeatures();
	const feature = features.features.find(f => f.id === context.featureId);
	if (!feature) throw new Error(`Feature ${context.featureId} is gone`);
	const execution = await runStructuredSubagent({
		session: context.session,
		invocationKind: "task",
		assignment: renderMissionAssignment(feature, context.session.missionDir!),
		agent: "mission-worker-base",
		...(context.workerModel ? { model: context.workerModel } : {}),
		...(context.workerEffort ? { effort: context.workerEffort as TaskEffort } : {}),
		outputSchema: WORKER_HANDOFF_SCHEMA, // caller-declared, validated (structured-subagent.ts:236-247)
		structured: true,
		signal: context.signal,
	});
	return mapResultToHandoff(execution.result);
}
```

The assignment template already exists in substance: `src/prompts/agents/mission-worker-base.md:1-20`
carries the conventions ("Work only within missionDir; follow AGENTS.md; handoff format: salientSummary,
discoveredIssues, whatWasDone, whatWasLeft"). Per-feature work must be composed from the feature's
`title`/`description` and the mission conventions — a new template or an inline render, either way small.

**Exact capability to thread — and where it already exists.** Nothing beyond the `ToolSession` the
factory already receives (§1.1-1.3). The one genuinely new wiring is **`signal`** — and the mission
tool's current signature hides a bug. `packages/agent/src/types.ts:1100-1109`:

```ts
export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;
```

The abort signal is the **third positional parameter**. `AgentToolContext`
(`packages/agent/src/types.ts:1085-1107`) carries only `addAdditionalContext` plus the stream-session
slot — no `signal`. So `makeTool`'s `async execute(_ctx, params)` (`src/tools/mission.ts:20`) is
mislabeled in both directions: the parameter it calls `_ctx` actually _receives the abort signal_, and
the real context is the discarded 5th argument. The repo's own precedent names it correctly —
`src/goals/tools/goal-tool.ts:77-83`:

```ts
async execute(
	_toolCallId: string,
	params: GoalToolInput,
	_signal?: AbortSignal,
	_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
	_context?: AgentToolContext,
): Promise<AgentToolResult<GoalToolDetails>> {
```

Because `makeTool` is one shared closure for all six mission tools, correcting the signature costs the
other five nothing — `propose_mission`, `end_feature_run`, `dismiss_handoff_items`,
`recommend_mission`, `resume_mission` all ignore the signal today and should keep ignoring it. Only
`start_mission_run` consumes it. No new `AgentSession` field, no executor reference, no `ToolSession`
change; ~10 lines. `asyncJobManager`, `agentOutputManager`, `settings`, `modelRegistry`, `authStorage`,
`subagentEventBus` and `emitBeforeSubagentSpawn` are all already on the `ToolSession`
(`src/sdk.ts:2296-2465`, referenced by `buildExecutorOptions` at `structured-subagent.ts:578-690`).

Paths considered and rejected: (a) a `getMissionRuntime()` on `ToolSession` mirroring `getGoalRuntime` —
unnecessary indirection; (b) reaching the registered `task` `Tool` and calling its `execute` — bypasses
the approval wrapper and yields no `WorkerHandoff` contract; (c) pushing the spawn into
`AgentSession.ensureMissionRegistered` — the tool is created per session but the runner lives in the
tool path anyway.

**Files touched (estimate, [INFERENCE]).** `src/tools/mission.ts` (~60-100 lines: helper + assignment
template/import + the `runMission` call with `signal`); optionally a new `src/mission/worker-spawn.ts` if
the assignment template is shared with validators later; `src/mission/runner.ts` only if a
`spawnValidator` hook is added now (`RunMissionOptions` `:60-67`, ~10 lines); `src/mission/types.ts`
only if the log schema changes — it already carries `modelId/reasoningEffort/validationModelId`
(`:65-89`). CHANGELOG entry (`packages/coding-agent/CHANGELOG.md` "Unreleased/Added").

**Effort: S/M.**

**What it fixes.** Execution, immediately. Each pending feature gets a real `mission-worker-base`
subagent; `workerModel`/`workerEffort` (`runner.ts:76-81`) finally reach a spawn
(`requestModel`, `model-resolver.ts:1278-1283`); `attempts`/`retryCount` are recorded
(`runner.ts:139-147`); the `worker_completed` handoff is real; cancellation becomes real once `signal` is
threaded (`runner.ts:81`, `:214-233`); and the second cancel check after each feature has a worker
to actually cancel.

**What it leaves.** C5 fabrication fixed and C7 handoffs now persist (both still fail-closed on the unwired `spawnValidator`); C6 fixed. The tool call blocks the turn for the whole mission — no timeout applies,
because `task` is not in `TOOL_TIMEOUTS` (`src/tools/tool-timeouts.ts:10-20`).

**Interaction with the runner's existing logic.** Keep everything. The only behavioural change is that
`options.spawnWorker` is defined, so the `else { workerError = NO_WORKER_SPAWNER_ERROR }` branch
(`runner.ts:160-167`) stops firing. Delete nothing. Note that the concurrent worker also changed
`src/tools/mission.ts:41-50` to bail before `runMission` — Option B replaces that early-return with the
real spawner, which is exactly the intended shape.

**Failure modes.** Real failures are loud and classified: the spawner throws → `workerError` →
feature not marked completed (`runner.ts:177-179`) → the run reports failure. Partial progress is honest.
Blast radius: `mission-worker-base` has no `tools:` frontmatter (§1.5), so the worker gets the full
default tool surface; and calling `runStructuredSubagent` directly bypasses `ExtensionToolWrapper`, so
user `tools.approval` policy is not consulted on this internal path. Both warrant an explicit decision.
[INFERENCE] Durability: `#atomicWrite` (`file-service.ts:41-45`) is tmp+rename with no fsync and no
lock, so two concurrent `runMission`s on one `missionDir` would interleave `features.json` and
`progress_log.jsonl` writes. Identical risk under both options; a re-entrancy guard on
`start_mission_run` is cheap insurance either way.

**Cost/latency.** Deterministic: N features, one worker each, sequential by design. Slightly cheaper than
A (no orchestrator tokens), identical worker cost.

**Testability.** Strong. `runMission` is already a pure async function of `(session, options)`, so a stub
`spawnWorker` proves feature transitions, retry/backoff, cancellation, and aggregation without any LLM.
The spawner is testable by mocking `runStructuredSubagent` (the `agent-bridge.ts` shape) or with one real
spawn asserting the handoff schema. The three pre-existing type errors are untouched and do not block new
cases.

---

## 4. Side-by-side

| Row                         | Option A — orchestrator-driven                                                     | Option B — real `spawnWorker`                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Lines of change [INFERENCE] | ~10-30 net (prompt + tool rewrite; runner shrinks)                                 | ~60-100 net, all additive                                                                                            |
| New abstractions            | none (prompt-level loop)                                                           | one spawn helper + assignment template                                                                               |
| Enforcement                 | prompt-level; the LLM must obey                                                    | programmatic; same code shape as today                                                                               |
| Worker model support        | No `model` field on the task tool (`types.ts:70-200`); only a tagged session agent | `request.model` honoured (`model-resolver.ts:1278-1283`); `MISSION_WORKER_MODEL` / `--worker-model` work as designed |
| Cancellation                | automatic via the turn's tool signal (`agent-loop.ts:3632`)                        | needs `signal` threading into the mission tool (~10 lines)                                                           |
| Crash recovery              | depends on the LLM resuming; `in_progress` features can wedge                      | sequential runner; `attempts`/`maxRetries`/`backoff` already modelled (`runner.ts:139-147`)                          |
| Testability                 | no unit tests for the loop; LLM/eval only                                          | unit-testable today via a stub `spawnWorker`                                                                         |
| Silent no-op risk           | the LLM can stop, stall, or mark done without work                                 | fails loudly — `NO_WORKER_SPAWNER_ERROR` with no spawner; loud per-feature failure inside                            |
| Retry / backoff             | gone or advisory                                                                   | preserved verbatim                                                                                                   |
| Scope growth / pause        | fixed (C6) — scope check before write                                              | still callable (`runner.ts:224-233`); ordering now enforced                                                          |
| C5 validators               | fabrication fixed (seam exists, unwired)                                           | fabrication fixed; wiring a real spawner still outstanding                                                           |
| C6 `endFeatureRun` order    | fixed                                                                              | fixed                                                                                                                |
| C7 handoff persistence      | fixed (handoff store + validation-failure pause)                                   | fixed                                                                                                                |
| Blocking                    | `start_mission_run` blocks for the whole run                                       | same                                                                                                                 |
| New risk introduced         | none                                                                               | first tool-to-spawn path; bypasses `tools.approval`; full tool surface for the worker                                |

---

## 5. Recommendation

**Option B**, with `signal` threading in the same change and C6 fixed (in the working tree, uncommitted; lands with the C5/C6/C7 work).

1. **The anticipated blocker does not exist.** `runStructuredSubagent` needs only a `ToolSession`, and
   `src/eval/agent-bridge.ts:217` already does exactly this from code. The cost is glue, not plumbing, so
   the usual "B is expensive, take A" trade-off disappears.
2. **Both fix the same bug, so the tiebreaker is everything else** — and everything else (retries,
   cancellation, per-feature status honesty, and an already-written, testable loop) lives in
   `runner.ts`. B keeps it; A deletes it and re-describes it in English. A prompt cannot be
   regression-tested; a loop can. This is precisely the bug class — a harness marking work done that
   never ran — where enforcement is what is missing.
3. **Worker model/effort are already resolved and already orphaned** (`runner.ts:76-81` → log fields
   only). Only B gives them a destination; under A they are dead by construction, because the task tool
   exposes no per-spawn model field.
4. **A's honest strength is fewer new lines** (~10-30 vs ~60-100) and a prompt that iterates without a
   rebuild. That is real but paid for in enforcement and testability.

**Hybrid:** land B now, then extend the orchestrator prompt to let the LLM drive features directly for
interactive missions — with `end_feature_run` and the runner's status machinery as the enforcement floor
underneath. B is a prerequisite for that, not a competing choice.

**Prerequisite order:** (i) `spawnWorker` + `signal`; (ii) C6 `endFeatureRun` ordering — done in the working tree (uncommitted; lands with the C5/C6/C7 work); (iii) C5 wiring a real `spawnValidator` — fabrication fixed, wiring still outstanding (the C7 work landed without wiring one).

---

## 6. First three implementation steps if the user chooses B

1. **`src/tools/mission.ts`** — in `makeTool` (`:17-26`), correct the signature to the real positional
   contract (`packages/agent/src/types.ts:1100-1109`, precedent at `src/goals/tools/goal-tool.ts:77-83`):
   `async execute(_ctx, params)` (`:20`) becomes
   `async execute(_toolCallId, params, signal, _onUpdate)` — note the parameter currently named `_ctx`
   is actually the abort signal, and the real context is the 5th argument. Then pass
   `runMission(session, { signal, spawnWorker: spawnMissionWorker })`, replacing the early-return bail at
   `:41-50`. The other five mission tools keep ignoring both. Add `spawnMissionWorker` using
   `src/eval/agent-bridge.ts:209-235` as the reference shape.
2. **Assignment + handoff contract** — a small `renderMissionAssignment(feature, missionDir)` built from
   `src/prompts/agents/mission-worker-base.md:1-20` plus a caller `outputSchema` for `WorkerHandoff`, so
   the child's yield is validated (`structured-subagent.ts:236-247`, `resolveSchema`).
3. **`test/mission-runner-execution.test.ts`** — a stub `spawnWorker` proving feature transitions,
   retry/backoff, cancellation, and aggregation; then a mocked `runStructuredSubagent` test for
   assignment/model/effort mapping. Leave the three pre-existing type errors in
   `test/mission-subsystem.test.ts` alone.

---

## 7. Verification performed (read-only)

- `bun check`: reports exactly the three pre-existing type errors quoted in §1.9, all in
  `packages/coding-agent/test/mission-subsystem.test.ts` — `(40,42)` "missing ... title, description,
  status, owner, and 3 more", `(94,4)` and `(140,4)` "missing ... successState, artifacts" — and no
  errors anywhere in the mission subsystem (runner, file-service, tools). Typecheck run per AGENTS.md
  (`bun check`, never `tsc`/`npx tsc`); nothing fixed.
- `bun check` tail: `oxfmt --check` exits 1 on pre-existing format drift. When first recorded this spanned
  five unrelated files; on later verification only `src/mnemopi/backend.ts` still fails, the concurrent
  embedding agent having since fixed `src/config/model-roles.ts`, `src/mnemopi/config.ts`,
  `test/memory-tools.test.ts`, and `test/mnemopi-loop-phase-coverage.test.ts`. No failure is in a
  mission-owned file; the remaining drift belongs to that concurrent embedding work. Not touched.
- Provenance: every `file:line` citation in this brief was re-verified against the working tree after the
  no-spawner fix, because the tree was mutating while the brief was written. Six ranges had drifted
  (`tools/index.ts`, `sdk.ts` twice, `runner.ts`, `mission/file-service.ts`, `structured-subagent.ts`)
  and were corrected. `src/sdk.ts` had no uncommitted changes, so its two drifted lines came from
  committed mission-mode lineage rather than a concurrent editor.
- No edits, no formatters with a write side effect, no commits, no `git add/restore/checkout`.
