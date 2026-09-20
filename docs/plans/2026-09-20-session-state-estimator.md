# Session State Estimator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the raw-turn window with a typed per-session state that Jev updates every turn, so tier decisions track the whole session's difficulty.

**Architecture:** `lib.ts` gets pure functions: `summarizeLastTurn(rows)` (deterministic counts from the last assistant message), `buildJevInput(message, prior, lastTurn)`, `jevUpdate(input, opts)` (one request, six questions), and `applyAnswers(prior, message, answers)` (reset-or-advance policy). `main.ts` keeps a `Map<sessionID, SessionState>` and threads it through. Bench gains scripted sessions and a `--no-state` ablation.

**Tech Stack:** TypeScript (Node 22, no build step), `node:test`, TypeSafe Jev HTTP API.

Design: `docs/plans/2026-09-20-session-state-estimator-design.md`.

---

### Task 1: `summarizeLastTurn` + `applyAnswers` (pure, unit-tested)

**Files:**
- Modify: `opencode-plugin/src/lib.ts` (replace `SessionState`, `buildSessionState`, `JEV_QUESTIONS`, `jevClassify`)
- Test: `opencode-plugin/tests/lib.test.ts` (replace the three `buildSessionState` tests)

Steps: write failing tests for the two pure functions → `node --test tests/lib.test.ts` fails → implement → passes → commit.

Types:

```ts
export type SessionState = {
  difficulty: number      // 0–4 weighted score
  phase: string
  scope: string
  stuck: number           // 0–3 weighted score
  task_anchor: string
  turns: number
}
export type LastTurn = { tool_calls: number; errors: number; last_error: string; final_text: string }
export type JevInput = { message: string; prior?: SessionState; last_turn?: LastTurn }
export type JevAnswers = {
  same_task: number; difficulty: number; phase: string; scope: string; stuck: number
  tier: Tier; confidence: number; probabilities: Record<string, number>
}
export type Classification = JevAnswers & { latency_ms: number; cacheHit?: boolean }
```

`summarizeLastTurn(rows)`: last assistant row → count `tool` parts, count `state.status === "error"`, last error string, last text part. `undefined` if no assistant row.

`applyAnswers(prior, message, a)`:
- `reset = !prior || a.same_task < 0.4`
- returns `{ difficulty: a.difficulty, phase: a.phase, scope: a.scope, stuck: a.stuck, task_anchor: reset ? message.slice(0,300) : prior.task_anchor, turns: reset ? 0 : prior.turns + 1 }`

`JEV_QUESTIONS`: six questions per the design (score criteria are ordered arrays).

`jevUpdate(input, opts)`: same fetch as `jevClassify`; maps `answers.*` into `Classification`.

### Task 2: wire `main.ts`

**Files:**
- Modify: `opencode-plugin/src/main.ts`

- `const sessionStates = new Map<string, SessionState>()`
- `sessionState()` helper → `lastTurn(sessionID)`: fetch messages, `summarizeLastTurn`.
- Classifier branch: `input = { message, prior: sessionStates.get(id), last_turn }` → `classifyCached(input)` → on result `sessionStates.set(id, applyAnswers(prior, message, result))`; `signals = { sameTask, difficulty, phase, scope, stuck }`.
- Heuristic / override branches: if a state exists, `turns += 1` (no Jev call).
- Log line includes the state.

Verify: `npx tsc --noEmit`, `node tests/smoke.mjs` (stub `session.messages` returns `[]` → `last_turn` undefined; cache test still passes because prior is undefined on both calls… **no**: after call 1 the state exists, so call 2's input differs. Update smoke test #2 to assert `source === "classifier"` and drop the cacheHit assertion; add a cache assertion by calling the *same* message a third time (prior now stable? turns increments → still differs). Decision: cache key excludes `prior.turns`. Then call 2 and 3 share prior except turns → call 3 hits cache.) Commit.

### Task 3: bench — scripted sessions + `--no-state`

**Files:**
- Modify: `opencode-plugin/tests/jev-bench.mjs`

- Parts 1–2 call `jevUpdate({message, last_turn?})` with no prior.
- Part 3: `SESSIONS` array per the design's five scripts; replay with `applyAnswers`, score each turn's `tier`, print the state trajectory per turn.
- `--no-state`: pass `prior: undefined` every turn.
- Run both, record numbers. Commit.

### Task 4: README + version

- README "How it works" → the state loop; benchmark table gains part 3 and the ablation delta; design-note bullets updated. `package.json` → 0.3.0. Commit, push.
