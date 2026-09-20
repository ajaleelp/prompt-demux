<div align="center">

> ## What we tried, what we measured, why we moved
>
> **v0.1 shipped a local ModernBERT classifier** (ONNX, CPU, ~31 ms, 750 MB).
> It worked, but we paused the project over five honest concerns — the two
> that mattered most:
>
> 1. **Per-message text is a weak proxy for effort.** *"fix it"* after 200k
>    tokens of debugging a race condition was classified from the three
>    words alone and dialed to the cheapest tier. The classifier never saw
>    the work it was about to dial effort for. No amount of retraining
>    fixes that — a single-string encoder structurally can't see context.
> 2. **Lighter models don't come free.** Measured on our labeled set: fp32
>    ModernBERT **66.7%**, int8 **43.3%** (worse than no model — it
>    collapsed MEDIUM and sent HARD prompts to EASY). And every change to
>    the tier definitions meant retraining.
>
> **We benchmarked [TypeSafe Jev](https://typesafe.ai) — a System One
> "decision model" that returns typed judgments over structured state
> instead of text — against the same set:**
>
> | Classifier | Text-only set (30) | Context-dependent turns (6) | Latency |
> |---|---|---|---|
> | ModernBERT fp32 (local) | 66.7% | *can't — sees text only* | 31 ms |
> | ModernBERT int8 (local) | 43.3% | *can't* | 17 ms |
> | **Jev, judging `{message, prior_user_turns, last_assistant_outcome}`** | **93–97%** | **6/6** | ~365 ms from Asia-Pacific (85–127 ms inference + RTT) |
>
> The context-dependent set is the point: `"fix it"` after a README typo →
> EASY (0.95); `"fix it"` after a failing vector-clock merge → HARD (1.00).
> `"try again"` after `ModuleNotFoundError: pytest` → MEDIUM with
> `failure_is_environmental = 0.94` — a flaky environment is no longer
> mistaken for a hard task. Reproduce it: `npm run bench` in `opencode-plugin/`.
>
> **So v0.2 deletes the Python service and the 750 MB model** and dials
> effort with one Jev call over the session's last few turns. The tier
> definitions are now three sentences of prose in
> [`lib.ts`](opencode-plugin/src/lib.ts) — edit them, no retraining.
>
> **What it costs, plainly:** the decision is no longer local — your message
> and the last ~3 turns go to `api.typesafe.ai`; ~10× the latency of the
> ONNX model (still well under the model call it precedes); a TypeSafe API
> key. Jev's MEDIUM confidence is soft (0.3–0.6) where EASY/HARD are ≥0.95,
> so the middle tier is where you'll see it hedge.
>
> Concern #5 from the pause — that harness discipline (plan-file + fresh
> context per phase, `/compact <focus>`) may matter more than any router —
> is still open. A smarter dial doesn't settle it.

# prompt-demux

**Dial the right amount of effort for every prompt.**

One typed judgment per message — over the **session state, not just the
text** — then **dial the response budget** for it: trivial chats get low
effort / a cheap model, hard problems get maximum effort / a stronger model.
Powered by [TypeSafe Jev](https://typesafe.ai); ~350 ms, no local model.

**Two knobs, one dial face.** A "route" is `provider/model[@variant]`:
- *model* — which model handles the request (`opencode/…`, `openrouter/…`, local `ollama/…`)
- *`@variant`* — how much reasoning **effort** that model applies (`@low` / `@high` / `@max`, or the provider's own preset)

You can hop models, hop effort, or both. Defaults in the repo are the
author's personal picks — not a prescription. `prompt-demux.json` is **your**
file to shape.

**Works entirely within OpenCode by default** — the built-in `opencode/`
provider (free [OpenCode Zen](https://opencode.ai/zen) account), no
third-party gateway. OpenRouter keys? One-line swap (see
[Configuration](#configuration)).

[![CI](https://github.com/ajaleelp/prompt-demux/actions/workflows/ci.yml/badge.svg)](https://github.com/ajaleelp/prompt-demux/actions)
[![Node](https://img.shields.io/badge/node-22%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

</div>

---

## Why this exists

Every prompt in a coding session doesn't deserve the same response budget.
"thanks!" and "design a distributed consensus protocol" shouldn't cost the
same in effort (or money). Two failure modes:

1. **Premium-everything**: maximum reasoning applied to trivial queries — slow, credits drain
2. **Cheap-everything**: a light model fumbles the hard task — time wasted redoing it

prompt-demux solves both: read each prompt's complexity, dialing the right
effort (and the right model) per message — spend heavily only where it
matters.

> **The defaults in this repo are what I prefer — not what you should use.** The
> dial just maps three complexity tiers to whatever effort/models *you* want.
> Pick models you have access to, tune effort to taste, use different providers
> per tier, use local models — it's all config.

### Why not just let a gateway auto-route (e.g. OpenRouter's `auto`)?

[`openrouter/auto`](https://openrouter.ai/openrouter/auto) is genuinely good.
This project exists because "genuinely good" wasn't the same as what I needed:

| | gateway `auto` (e.g. `openrouter/auto`) | prompt-demux |
|---|---|---|
| **What runs my prompt** | Opaque model picks from their catalog | You pin exact model *and effort level* per tier |
| **Effort control** | Server-side, opaque | Local, exact — `@variant` reasoning effort per tier, or per message |
| **Wallet topology** | One wallet — when it's empty, everything stops | **Multi-wallet runway**: map tiers to different providers/accounts — free tiers for EASY, a separate cheap pool for MEDIUM, premium credits only for HARD |
| **Top-up economics** | ~5% credit purchase fee on all usage | Most traffic can flow through direct/free channels |
| **Routing logic** | Server-side, not inspectable | Jev judgment over tier definitions *you* write in prose + your config — every decision logged with its probabilities |
| **Latency** | adds server-side round trip | ~350 ms Jev call (≈100 ms inference + RTT), then your model as usual |
| **Override / steering** | fallback model list | `!easy` `!hard` `!effort:low` `!mode:` prefixes, session-sticky modes |
| **Setup** | one line | plugin + a TypeSafe API key |

The killer feature is **credit runway**: when EASY goes to a free tier and
MEDIUM to a budget model, your premium credits become a *reserve for work
that actually needs them* — instead of the whole system dying when one
wallet hits zero. And because it's your mapping, "cheap" and "premium" are
whatever you define: different providers, different accounts, free tiers,
local models, whatever.

**When auto is the better choice:** if you already pay OpenRouter, don't
want to run anything local, and trust their router's judgment — use it.
This project trades convenience for control.

## Similar work (and how this differs)

The routing space is crowded — but the *combination* this plugin occupies is
not. Here's the honest landscape (Sept 2026):

| Project | What it is | How `prompt-demux` differs |
|---|---|---|
| [claude-code-router](https://github.com/musistudio/claude-code-router) (~37k★) | Local **proxy gateway** switching **models** across providers/agents | A proxy, not a plugin — can't touch OpenCode's per-message `model.variant` state; switches models (cache-expensive), not effort |
| [weave-os/router](https://github.com/weave-os/router) (~3.9k★) | Go proxy, per-action **model** route using a tiny embedder | Proxy again; effort-only in-process routing (which never breaks the cache) is its blind spot |
| [opencode-model-router](https://github.com/marco-jardim/opencode-model-router) (102★) | OpenCode plugin, but **LLM prompt delegation** — an orchestrator re-delegates via subagents | No ML classifier, no local model; costs an LLM round-trip per message; not cache-friendly by design |
| [opencode-reasoning-effort](https://github.com/Aliancn/opencode-reasoning-effort) | Narrows to one thing: patch `fetch` so `reasoning_effort` reaches the wire | Single-purpose patch; no complexity tiering, no fallback, no config |
| OpenRouter `auto` / `pareto-code` | Server-side opaque model routing | Not local, not auditable, no per-message effort dial, runs outside OpenCode |
| [flaviusapop/jev-router](https://github.com/flaviusapop/jev-router), [prismhq/jev-router](https://github.com/prismhq/jev-router), [blablanumerodeux/model-router](https://github.com/blablanumerodeux/model-router) | Jev-powered routers — **proxies** in front of Claude Code / Codex / opencode / LiteLLM | All feed Jev the **message text only** (one author tried adding metadata and found it lowered confidence). A proxy can't see the session; this plugin runs in-process and feeds Jev the last turns + last tool outcome, which is what flips `"fix it"` between EASY and HARD |

The combination that's unoccupied: **in-process OpenCode plugin +
session-state-aware Jev judgment + effort-first dialing (same model,
`@low/@high/@max`) + cache stickiness** — so the prompt cache never breaks
and short follow-ups inherit the difficulty of the work in progress. A proxy
can't see OpenCode's session or per-message effort state; an LLM-delegation
plugin spends more and can't guarantee cache warmth. Text-only Jev routers
top out at the ~76% ceiling every text-only classifier hits
([independent benchmark](https://dev.classmethod.jp/en/articles/jev-for-llm-model-routing/)).
That's the square this project sits in.

## What it does

```mermaid
flowchart TD
    A["User message in OpenCode"] --> B{"Leading !override?"}
    B -- "!easy / !hard / !effort:x / !mode:" --> C["Force tier, effort, or mode"]
    B -- no --> D{"Zero-cost heuristics"}
    D -- "greetings, acks" --> E["EASY - 0 ms"]
    D -- "real query" --> S["Last ~3 user turns + last assistant/tool outcome"]
    S --> F["TypeSafe Jev - one call, 3 typed questions - ~350 ms"]
    F --> G{"tier + confidence + continues_prior_work + failure_is_environmental"}
    C --> H["Active mode mapping"]
    E --> H
    G --> H
    H --> I["effort (default): gemini-3.8-flash@low / @high / @max - cache stays warm"]
    H --> I2["balanced (opt-in): EASY->glm-5.3-flash / MEDIUM->deepseek-v4-pro / HARD->kimi-k3"]
    I --> K["OpenCode calls the dialed model + effort"]
    I2 --> K
    H --> J["Free tier / budget pool / premium - your choice"]
    J --> K
    K --> L["Subagents: dialed per their own subtask"]
```

Every decision is logged (`dialed HARD -> .../kimi-k3@max source=classifier
confidence=0.99 continuesPriorWork=0.95`) and cached on *message + context* —
the same follow-up after the same work costs 0 ms.

## Verified behavior (live E2E on OpenCode 1.18.x, with the author's default routes)

| Scenario | Result |
|---|---|
| "thanks" | heuristic → EASY → gemini-3.8-flash@low (0 ms) |
| "Explain closures in JavaScript" | classifier → MEDIUM → gemini-3.8-flash@high |
| "Implement a distributed consensus algorithm" | classifier → HARD → gemini-3.8-flash@max |
| `!hard ...` prefix | override → HARD target, prefix stripped from model-visible text |
| `!mode:balanced ...` | switch to model-hopping mode, sticks for the session |
| effort mode (`@low/@high/@max`) | same model, reasoning-effort variant merged into the request (verified live) |
| Task-tool subagent | dialed **per its own task complexity** (child sessions flow through the same hook) |
| plugin off (`--pure`) | nominal model used (control test) |

## The cost math

Using the default `effort` mode on the `opencode/` provider (Zen pricing,
per answer) — one model, reasoning effort dialed per tier. Swap in your own
models/efforts and the numbers change, but the *shape* stays:

| Query | Dialed target | Cost | Un-dialed (max effort, every query) | Savings |
|---|---|---|---|---|
| "Reply with exactly: OK" (EASY) | gemini-3.8-flash@low | ~$0.00002 | ~$0.02 | **~99%** |
| "Explain closures..." (MEDIUM) | gemini-3.8-flash@high | ~$0.002 | ~$0.02 | ~90% |
| "Implement distributed consensus" (HARD) | gemini-3.8-flash@max | premium | premium | by design |

Illustrative session mix (70% EASY / 20% MEDIUM / 10% HARD, ~150-token
prompts): dialing EASY to `@low` and HARD to `@max` on one warm model yields
roughly **3–6× fewer reasoning tokens spent** vs max-effort on everything —
and because the model never changes, the prompt cache stays warm turn after
turn. Your mix will differ; the point is the *shape*: most chat is EASY, and
EASY shouldn't burn reasoning tokens or cold cache.

Add free tiers (an `…:free` variant or the `opencode/…-free` models) as your
EASY target and the floor drops to $0.00.

## Quickstart

### Option A — from npm (recommended)

```bash
opencode plug opencode-effort-demux --global
```

This installs the plugin globally (auto-fetched by Bun into OpenCode's plugin
cache). Then configure your dial in `~/.config/opencode/prompt-demux.json`.

### Option B — clone & run

```bash
git clone https://github.com/ajaleelp/prompt-demux
cd prompt-demux
./scripts/setup.sh          # add -y to skip the confirmation prompt
```

### Prerequisites

- **Node 22+** (for the plugin SDK)
- A **[TypeSafe](https://typesafe.ai) API key**, exported as `TYPESAFE_API_KEY`
  in the environment OpenCode runs in. Without it every message dials MEDIUM
  (with a warning) — chat never breaks.
- An **OpenCode** install. A free
  [OpenCode Zen](https://opencode.ai/zen) sign-in unlocks `opencode/…`
  models (the default); the `free-optimal` mode's free models need no billing
  beyond the Zen sign-in. If you prefer OpenRouter, any existing key works
  with `openrouter/…` refs instead.

### One-command setup (recommended)

```bash
git clone https://github.com/ajaleelp/prompt-demux
cd prompt-demux
./scripts/setup.sh          # add -y to skip the confirmation prompt
```

**What it does in the background, before you confirm it:**

1. Runs `npm install` in `opencode-plugin/` (pulls `@opencode-ai/plugin`).
2. Installs the **global** plugin shim + default config at
   `~/.config/opencode/` so routing works in every project.

That's the whole setup. Restart OpenCode (full quit), pick **Prompt Demux Auto**
from the dropdown, and prompts get dialed automatically. Verify from the CLI:

```bash
opencode run -m prompt-demux/auto "thanks" --print-logs | grep -E "dialed|routed"
# ... dialed EASY -> opencode/glm-5.3-flash source=heuristic
```

### Manual, if you prefer

Just the plugin:

```bash
cd opencode-plugin && npm install && cd ..
opencode run --print-logs "thanks"     # in-repo .opencode/plugins/ loads
```

The in-repo shim (`.opencode/plugins/prompt-demux.ts`) imports via a
relative path, so a fresh clone works as-is — no absolute paths to edit.
For routing in *every* project, `./scripts/setup.sh` already did the
[global install](#optional-global-install) for you.

### OpenCode Zen (needed for the default `opencode/…` modes)

The default modes all use the built-in `opencode/` provider — no third-party
gateway. Signing in once (free) unlocks every model, and the free models in
`free-optimal` need no billing on top of that:

1. Run `/connect` in the OpenCode TUI and pick **OpenCode Zen**.
2. A browser tab opens — sign in and copy your API key.
3. Paste it back, then verify with `opencode models | grep opencode/`.

Prefer another provider like OpenRouter? Just swap the `provider/` prefix as
described in [Configuration](#openrouter-just-my-defaults-are-openrouter-make-it-work-either-way).

### Optional: global install

To use routing in **every** project (not just this repo), install the shim
into OpenCode's global plugin directory:

```bash
./scripts/install-global.sh
```

This copies a shim to `~/.config/opencode/plugins/prompt-demux.ts` pointing
at your local clone, and drops a default `prompt-demux.json` at
`~/.config/opencode/prompt-demux.json` if you don't already have one. Your
project-level `prompt-demux.json` (if present) still takes precedence.

## Configuration

**This is the whole point.** `prompt-demux.json` is read on every message (no
restart) and maps the three complexity tiers to whatever effort/models *you*
want. The default mode — `effort` — keeps things cache-friendly; the model-
hopping modes are opt-in. Rip it apart and make it yours.

The default config (one model, effort dialed per tier — the cache-friendly
default):

```jsonc
{
  "activeMode": "effort",
  "modes": {
    "effort": {
      "description": "One model, effort dialed per tier - keeps the prompt cache warm",
      "EASY":   "opencode/gemini-3.8-flash@low",    // low reasoning effort
      "MEDIUM": "opencode/gemini-3.8-flash@high",   // push harder
      "HARD":   "opencode/gemini-3.8-flash@max"     // go all in
    }
  },
  "classifier": { "timeoutMs": 2000 }   // Jev call budget; on timeout -> MEDIUM
}
```

`classifier.url` (or `PROMPT_DEMUX_CLASSIFIER_URL`) overrides the Jev endpoint
— handy for a proxy or a stub in tests. The key is only ever read from
`TYPESAFE_API_KEY`.

**All default refs are `opencode/…`** — the built-in provider, no third-party
gateway. You only need a free [OpenCode Zen](https://opencode.ai/zen) account
(via `/connect` → OpenCode Zen).

**Why effort-first?** Switching reasoning effort on the *same model* preserves
the provider's prompt cache (cache is keyed per model), so you pay for
reasoning tokens, not cold cache misses. Switching *models* invalidates the
cache — powerful, but expensive in warm sessions. So model hopping lives
behind a deliberate choice.

### Model hopping is opt-in

Prefer a different model per tier? Same dial, different knob — just swap the
`provider/model` string. Use it when you care more about capability-spread
across vendors than cache warmth:

```jsonc
{
  "activeMode": "balanced",
  "modes": {
    "balanced": {
      "description": "Cross-provider value picks",
      "EASY":   "opencode/glm-5.3-flash",
      "MEDIUM": "opencode/deepseek-v4-pro",
      "HARD":   "opencode/kimi-k3"
    },
    "frontier-value": {
      "description": "Higher quality per tier",
      "EASY":   "opencode/glm-5.3-flash",
      "MEDIUM": "opencode/gemini-3.8-flash",
      "HARD":   "opencode/claude-fable-5-1"
    }
  }
}
```

Both hops can coexist — mix `provider/model` and `provider/model@variant`
refs freely across modes.

### OpenRouter? Just my defaults are OpenRouter... make it work either way

The choice to use `openrouter/…` refs is purely yours — the router doesn't
care what provider the refs point at. To run through OpenRouter instead:

1. Sign in with OpenRouter (`/connect` → OpenRouter, paste your key).
2. Swap the `provider/` prefix only — the easy part `"opencode/glm-5.3-flash"`
   becomes `"openrouter/z-ai/glm-5.3-flash"`, etc. OpenRouter slugs carry the
   model family after the first segment, e.g. `openrouter/deepseek/deepseek-v4-pro-0813`.

The full OpenRouter variant of the default config:

```jsonc
{
  "activeMode": "effort",
  "modes": {
    "effort": {
      "description": "One model, effort dialed per tier, via OpenRouter",
      "EASY":   "openrouter/z-ai/glm-5.3-flash@low",
      "MEDIUM": "openrouter/z-ai/glm-5.3-flash@high",
      "HARD":   "openrouter/z-ai/glm-5.3-flash@max"
    },
    "balanced": {
      "description": "Cross-provider value picks, via OpenRouter",
      "EASY":   "openrouter/z-ai/glm-5.3-flash",
      "MEDIUM": "openrouter/deepseek/deepseek-v4-pro-0813",
      "HARD":   "openrouter/moonshotai/kimi-k3"
    }
  }
}
```

Model refs are `provider/model` (split on the **first** slash, so OpenRouter
slugs like `openrouter/anthropic/claude-fable-5.1` work as-is).

### Effort hopping (`provider/model@variant`) — how it works

Effort is the first-class dial: a tier maps to *the same model at different
reasoning efforts*, instead of switching models. End a ref with `@variant`
and OpenCode merges that model's named variant (reasoning effort / thinking
budget) into the request for that message:

```json
"effort": {
  "description": "One model, effort dialed per tier",
  "EASY":   "opencode/gemini-3.8-flash@low",
  "MEDIUM": "opencode/gemini-3.8-flash@high",
  "HARD":   "opencode/gemini-3.8-flash@max"
}
```

Variants come from OpenCode's built-in defaults (e.g. Anthropic `high`/`max`,
OpenAI `none`/…/`xhigh`, Google `low`/`high`), or you can define your own per
model in `opencode.json`:

```json
{ "provider": { "opencode": { "models": { "gemini-3.8-flash": {
  "variants": { "low": { "thinkingLevel": "low" }, "high": { "thinkingLevel": "high" } }
} } } } }
```

A plain `provider/model` ref works too (default effort) — the `@variant`
suffix is optional. Verified end-to-end: the chosen variant's options are
merged into both the main and auxiliary (title) requests.

### Configuring your routes (the part that's *yours*)

The config is a plain JSON file — no code involved. A mode is just three
lines:

```json
"my-mode": {
  "EASY":   "opencode/glm-5.3-flash",       // cheap + low effort
  "MEDIUM": "opencode/gemini-3.8-flash@high",
  "HARD":   "opencode/claude-fable-5-1@max" // max effort on the best model
}
```

Rules of thumb:

- **Swap the ref** to change what a tier uses — that's the whole feature.
  Find exact IDs with `opencode models` and paste any model you have access
  to: `opencode/…`, `openrouter/…`, or a local `ollama/…`. Add `@variant`
  to set effort.
- **`activeMode`** picks which mode is used by default. Switch it to
  `"frontier-value"` for higher quality (pricier), or `"free-optimal"` for
  $0 across the board — or set your own.
- **Add a new mode** by copying a block and renaming it; it automatically
  appears in the Prompt Demux dropdown (e.g. `prompt-demux/my-mode`).
- **The config reloads every message** — no restart needed to test a change.
- Keep it valid JSON: no trailing commas, all keys quoted. A parser will
  fail silently to the fallback; run `jq . prompt-demux.json` to check.

Need a free option? The `free-optimal` mode uses `opencode/…` Zen models
(details above). You can also point EASY at an `…:free` variant on whatever
provider you use.

### Overrides (message prefix, stripped before the model sees them)

| Prefix | Effect |
|---|---|
| `!easy` / `!free` | force EASY tier for this message |
| `!medium` | force MEDIUM tier |
| `!hard` / `!premium` | force HARD tier |
| `!mode:<name>` | switch mode; **sticks for the session** |

### The `router` tool

The plugin registers a `router` tool — in chat, just ask:

- *"what routing modes are there?"* → `list`
- *"switch the default to frontier-value"* → `set`
- *"add a mode called reason with o3 for hard"* → `add`

## Architecture

```
prompt-demux/
├── opencode-plugin/
│   ├── src/lib.ts             # pure helpers: parsing, config, heuristics,
│   │                          #   buildSessionState() + jevClassify() + the tier prose
│   ├── src/main.ts            # chat.message hook (dial model+effort) + router tool
│   └── tests/                 # unit tests (node:test), smoke test, jev-bench
├── scripts/
│   ├── setup.sh               # one-command install (deps + shim)
│   └── install-global.sh      # global plugin shim + default config
├── .opencode/plugins/prompt-demux.ts   # shim OpenCode auto-loads
└── prompt-demux.json                    # dialing modes config
```

## Tests

```bash
cd opencode-plugin
npm install
npx tsc --noEmit
node --test tests/lib.test.ts    # 23 unit tests (pure helpers, session-state builder)
node tests/smoke.mjs             # integration against live Jev (needs TYPESAFE_API_KEY)
node tests/jev-bench.mjs         # accuracy benchmark, text-only + context-dependent sets
```

## Benchmarks

**Jev** (`npm run bench`, Sept 2026, from Asia-Pacific):

| Set | Result | Median latency |
|---|---|---|
| 30 text-only prompts (10/tier) | 28–29 / 30 (93–97%; the misses are EASY↔MEDIUM on genuinely ambiguous prompts, conf ≤0.6) | 365 ms |
| 6 context-dependent follow-ups (`fix it`, `continue`, `try again`, `why`) | 6 / 6 | 368 ms |

Of that latency, Jev's own inference is 85–127 ms (`x-envoy-upstream-service-time`);
the rest is distance to their region. Python `urllib` without keep-alive
measured ~900 ms — the plugin runs under Bun, which reuses connections.

**The ModernBERT numbers it replaced** (same 30-prompt set, Intel i7-9750H):
fp32 66.7% @ 31 ms · int8 43.3% @ 17 ms · heuristic-only 56.7%. The int8
export collapsed MEDIUM entirely and sent 7 HARD prompts to EASY. That code
lives in git history up to
[`543f197`](https://github.com/ajaleelp/prompt-demux/tree/543f197/classifier-service).

## Design notes & honest findings

- **The `chat.model` hook doesn't exist.** Most plugin docs/examples
  reference it; OpenCode 1.18.x does not. Dialing is implemented via the
  `chat.message` hook mutating `UserMessage.model` (and its `variant` for
  effort) — verified end-to-end (the dialed model/effort actually generates,
  confirmed against stored sessions).
- **Subagents are better than "inherited"**: child Task-tool sessions flow
  through the same hook, so each subagent gets routed per its own subtask.
- **What Jev sees**: `{message, prior_user_turns (last 3, 300 chars each),
  last_assistant_outcome}` — the last outcome is the most recent tool error
  if there was one, else the assistant's last text. Three questions go in one
  request: the tier (`choice`), `continues_prior_work` and
  `failure_is_environmental` (both `noul`, i.e. calibrated yes/no). The two
  signals are logged, not yet acted on.
- **Jev's MEDIUM is soft.** EASY/HARD come back at ≥0.95; MEDIUM sits at
  0.3–0.7, same as the [independent benchmark](https://dev.classmethod.jp/en/articles/jev-for-llm-model-routing/)
  found. Expect hedging on "explain this briefly"-shaped prompts.
- **Fallback chain**: `!override` → heuristic (0 cost) → cached Jev → Jev →
  MEDIUM on failure/no key. Chat never breaks because the classifier is down.

## Troubleshooting

- **Plugin doesn't load** — the shim must be at `.opencode/plugins/`
  (plural). Run opencode with `--print-logs`; plugin errors appear at startup.
- **Everything routes MEDIUM with a warning** — `TYPESAFE_API_KEY` isn't
  visible to OpenCode (check the log line: it says which), or Jev timed out.
  Export the key in the shell that launches OpenCode, or raise
  `classifier.timeoutMs`.

## Roadmap

- [x] Local ModernBERT classifier service (v0.1, removed)
- [x] OpenCode plugin: `chat.message` routing, multi-mode config, `router` tool
- [x] Prefix stripping, classification cache, greeting heuristics, subagent routing
- [x] Session-state-aware Jev classification; delete the local model (v0.2)
- [ ] Act on the signals: inherit the previous tier when `continues_prior_work` is high; don't inflate on `failure_is_environmental`
- [ ] A larger context-dependent benchmark built from real OpenCode session transcripts
- [ ] Confidence thresholds for the soft MEDIUM tier

## Follow along

Built in public, phase by phase — each phase is a tagged commit:

- `v0.1.0` — local ModernBERT classifier + plugin + modes + tests
- `v0.2.0` — Jev over session state; Python service and model deleted (this release)

Issues and PRs welcome, especially Intel Mac benchmarks from other machines.

## License

MIT
