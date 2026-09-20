# Session state estimator (v0.3)

## Problem

v0.2 shows Jev the message plus the last 3 raw user turns and the last tool
result. That fails on ack chains ("ok", "continue", "yes" ×10 after a HARD
task: Jev sees nothing about the task), on long tool loops (one sampled
result hides 40 calls), and on task switches (stale tool output bleeds into
a new request). Sending more raw history is the wrong fix: cost is trivial
but irrelevant state degrades judgment and latency scales with input.

## Design

Jev is stateless, so the plugin keeps a small **typed session state** and
asks Jev to update it every turn. Jev is the transition function; our code
holds the state. Raw messages never accumulate.

### State (per session, in memory)

| Field | Type | Meaning |
|---|---|---|
| `difficulty` | score, 5 levels | how hard the current task is, as understood so far |
| `phase` | choice: exploring / designing / implementing / debugging / verifying / idle | where in the task we are |
| `scope` | choice: one-line / function / module / system | blast radius |
| `stuck` | score, 4 levels (0–3) | consecutive attempts that did not resolve |
| `task_anchor` | string, set by code | the message that started the current task (≤300 chars) |
| `turns` | int, set by code | turns since the anchor |

Fresh session / plugin restart: `null` state; the first call runs with no
prior state and converges within a turn or two.

### Per-turn call (one request, six questions)

Input state sent to Jev:

```json
{
  "message": "continue",
  "prior": { "difficulty": 4.4, "phase": "debugging", "scope": "module", "stuck": 2,
             "task_anchor": "Implement vector-clock based conflict resolution", "turns": 9 },
  "last_turn": { "tool_calls": 14, "errors": 2, "last_error": "race in merge()", "final_text": "…" }
}
```

`prior` is omitted when null. `last_turn` is a deterministic summary of the
last assistant message built in code (counts + last error + final text ≤300
chars), replacing the sampled `last_assistant_outcome`.

Questions:

| id | type | answers |
|---|---|---|
| `same_task` | noul | does `message` continue the task `prior.task_anchor` describes, or start something new? |
| `difficulty` | score | 5 concrete levels, from "trivial edit / lookup" to "distributed systems, concurrency, architecture" |
| `phase` | choice | the six phases above |
| `scope` | choice | the four scopes above |
| `stuck` | score | 0 "progressing" … 3 "third+ failed attempt at the same thing" |
| `tier` | choice | EASY / MEDIUM / HARD for **this message**, given everything above |

Policy in code after the answer:

- `same_task < 0.4` and `prior` exists → reset: anchor = message, turns = 0.
  Otherwise turns += 1.
- Store `{difficulty, phase, scope, stuck}` from the answers as the new state.
- Tier comes straight from Jev's `tier`. No hard-coded floor; the prior
  state is the floor. (Revisit if the bench shows flapping.)
- Heuristic EASY and `!override` turns still update `turns` but do not call
  Jev; state otherwise unchanged.

Everything Jev returns is logged: the state trajectory is the audit trail
(`difficulty 2.1 → 4.4`, `stuck 0 → 1 → 2`).

### Cache

Keyed on `JSON.stringify({message, prior, last_turn})`. Same message in the
same state is free; the state changes as the session moves, so the cache
mostly helps retries.

### What Jev never sees

Raw history. Only the shape of the task plus one anchor sentence. If a
future question needs content, add a typed field, not text.

## Benchmark

`jev-bench.mjs` gains a third part: **scripted sessions**. Each is a list
of turns `{message, last_turn?, want}`; the bench replays it through the
same update loop and scores every turn. Sessions to include:

1. HARD task, then 8 acks, then "continue" → HARD throughout.
2. HARD task, three failing test loops → `stuck` rising, tier stays HARD.
3. HARD task, then "fix the README typo" → `same_task` low, reset, EASY.
4. Environmental failure ("ModuleNotFoundError") on a MEDIUM task → MEDIUM,
   `stuck` does not climb past 1.
5. EASY chat, then a HARD request mid-session → escalates on that turn.

Existing parts 1 and 2 stay (part 2 runs with `prior = null` and a
synthesised `last_turn`).

Also an ablation flag `--no-state` that sends `prior = null` every turn, so
the README can show the delta the state produces.

## Out of scope

Persisting state across restarts. Acting on `stuck` (a "consider /compact"
toast) — the signal is logged; the toast is a follow-up once real logs show
it is reliable. Claude Code port.
