<div align="center">

# prompt-demux

**Dial the right amount of effort for every prompt.**

A local, CPU-only classifier that reads each prompt's complexity, then
**dials the response budget** for it — trivial chats get low effort / a cheap
model, hard problems get maximum effort / a stronger model. ~31 ms, no GPU,
no cloud in the decision.

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
[![Python](https://img.shields.io/badge/python-3.9%2B-blue)](https://www.python.org)
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
| **Routing logic** | Server-side, not inspectable | Local ONNX model + your config, fully auditable |
| **Latency** | adds server-side round trip | ~31 ms on CPU, fully offline |
| **Override / steering** | fallback model list | `!easy` `!hard` `!effort:low` `!mode:` prefixes, session-sticky modes |
| **Setup** | one line | plugin + ~750 MB local model |

The killer feature is **credit runway**: when EASY goes to a free tier and
MEDIUM to a budget model, your premium credits become a *reserve for work
that actually needs them* — instead of the whole system dying when one
wallet hits zero. And because it's your mapping, "cheap" and "premium" are
whatever you define: different providers, different accounts, free tiers,
local models, whatever.

**When auto is the better choice:** if you already pay OpenRouter, don't
want to run anything local, and trust their router's judgment — use it.
This project trades convenience for control.

## What it does

```mermaid
flowchart TD
    A["User message in OpenCode"] --> B{"Leading !override?"}
    B -- "!easy / !hard / !effort:x / !mode:" --> C["Force tier, effort, or mode"]
    B -- no --> D{"Zero-cost heuristics"}
    D -- "greetings, acks" --> E["EASY - 0 ms"]
    D -- "real query" --> F["Local classifier - ModernBERT ONNX - CPU - ~31 ms"]
    F --> G{"tier + confidence"}
    C --> H["Active mode mapping"]
    E --> H
    G --> H
    H --> I["balanced: EASY->glm-5.3-flash / MEDIUM->deepseek-v4-pro / HARD->kimi-k3"]
    H --> I2["effort: gemini-3.8-flash@low / @high / @max (one model, dialed effort)"]
    I --> K["OpenCode calls the dialed model + effort"]
    I2 --> K
    H --> J["Free tier / budget pool / premium - your choice"]
    J --> K
    K --> L["Subagents: dialed per their own subtask"]
```

Every decision is logged (`dialed HARD -> .../kimi-k3@max source=classifier
confidence=0.99`) and cached — repeated queries cost 0 ms.

## Verified behavior (live E2E on OpenCode 1.18.x, with the author's default routes)

| Scenario | Result |
|---|---|
| "thanks" | heuristic → EASY → glm-5.3-flash (0 ms) |
| "Explain closures in JavaScript" | classifier → MEDIUM → deepseek-v4-pro (balanced) / gemini-3.8-flash@high (effort) |
| "Implement a distributed consensus algorithm" | classifier → HARD → kimi-k3 (balanced) / gemini-3.8-flash@max (effort) |
| `!hard ...` prefix | override → HARD model, prefix stripped from model-visible text |
| `!mode:frontier-value ...` | mode override, sticks for the session |
| effort mode (`@low/@high/@max`) | same model, reasoning-effort variant merged into the request (verified live) |
| Task-tool subagent | dialed **per its own task complexity** (child sessions flow through the same hook) |
| plugin off (`--pure`) | nominal model used (control test) |

## The cost math

Using the author's default config on the `opencode/` provider (Zen pricing,
per answer) — effort dialing and model hopping; swap in your own models and
the numbers change, but the *shape* stays:

| Query | Dialed target | Cost | Un-dialed (max effort premium) | Savings |
|---|---|---|---|---|
| "Reply with exactly: OK" (EASY) | glm-5.3-flash | ~$0.00002 | ~$0.50 | **~99%** |
| "Explain closures..." (MEDIUM) | deepseek-v4-pro | ~$0.001 | ~$0.50 | ~99% |
| "Implement distributed consensus" (HARD) | kimi-k3 / claude-fable-5-1@max | premium | premium | by design |

Illustrative session mix (70% EASY / 20% MEDIUM / 10% HARD, ~150-token
prompts): dialing EASY to something cheap/effort-low and keeping HARD at max
effort yields roughly **3–6× more premium budget remaining** vs sending
everything to the max-effort premium model — the difference between topping
up weekly and monthly. Your mix will differ; the point is the *shape*: most
chat is EASY, and EASY shouldn't burn premium credits or reasoning tokens.

Add free tiers (an `…:free` variant or the `opencode/…-free` models) as your
EASY target and the floor drops to $0.00.

## Quickstart

### Prerequisites

- **Python 3.9+** (the classifier runs 100% locally on CPU)
- **Node 22+** (for the plugin SDK)
- An **OpenCode** install. A free
  [OpenCode Zen](https://opencode.ai/zen) sign-in unlocks `opencode/…`
  models (the default); the `free-optimal` mode's free models need no billing
  beyond the Zen sign-in. If you prefer OpenRouter, any existing key works
  with `openrouter/…` refs instead. No Hugging Face account is required —
  the classifier model is served from a public repo.

### One-command setup (recommended)

```bash
git clone https://github.com/ajaleelp/prompt-demux
cd prompt-demux
./scripts/setup.sh          # add -y to skip the confirmation prompt
```

**What it does in the background, before you confirm it:**

1. Creates a Python venv and installs the classifier deps
   (`onnxruntime`, `fastapi`, `uvicorn`, …).
2. **Downloads the classifier model from Hugging Face** (~750 MB fp32 +
   int8 variants, SHA-verified) into `classifier-service/model/`.
3. Runs `npm install` in `opencode-plugin/` (pulls `@opencode-ai/plugin`).
4. Installs the **global** plugin shim + default config at
   `~/.config/opencode/` so routing works in every project.
5. Starts the classifier server on `http://127.0.0.1:8010` (nohup, log at
   `/tmp/prompt-demux-classifier.log`).

That's the whole setup. Restart OpenCode (full quit), pick **Prompt Demux Auto**
from the dropdown, and prompts get dialed automatically. Verify from the CLI:

```bash
opencode run -m prompt-demux/auto "thanks" --print-logs | grep -E "dialed|routed"
# ... dialed EASY -> opencode/glm-5.3-flash source=heuristic
```

### What each piece does (manual, if you prefer the pieces separately)

Prefer to run the classifier service yourself (screen/tmux/launchd)? Then:

```bash
cd classifier-service
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python download_model.py     # ~750 MB, SHA-verified -> ./model/
venv/bin/python server.py             # serves 127.0.0.1:8010
```

Test it:

```bash
curl -s -X POST http://127.0.0.1:8010/classify \
  -H 'Content-Type: application/json' \
  -d '{"query":"Explain closures in JavaScript"}'
# {"tier":"MEDIUM", "confidence":0.84, "latency_ms":29.7, ...}
```

And the plugin separately:

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
restart) and maps the three complexity tiers to whatever models *you* want.
The config below is the author's default (works with a free OpenCode Zen
sign-in) — feel free to rip it apart and make it yours.

```jsonc
{
  "activeMode": "balanced",
  "modes": {
    "balanced": {
      "description": "OpenCode-native value picks: GLM Flash absorbs trivial, DeepSeek moderate, Kimi hard",
      "EASY":   "opencode/glm-5.3-flash",          // all-round entry model, 1.3M ctx
      "MEDIUM": "opencode/deepseek-v4-pro",        // strong agentic coding
      "HARD":   "opencode/kimi-k3"                 // near-frontier reasoning
    },
    "frontier-value": {
      "description": "Best value per tier on tuned/high-end models",
      "EASY":   "opencode/glm-5.3-flash",
      "MEDIUM": "opencode/gemini-3.8-flash",       // fast + strong agentic
      "HARD":   "opencode/claude-fable-5-1"        // top of the intelligence index
    },
    "free-optimal": {
      "description": "Zero-cost via OpenCode Zen free tier",
      "EASY":   "opencode/mimo-v2.5-free",
      "MEDIUM": "opencode/muse-spark-1.2-contributor-free",
      "HARD":   "opencode/muse-spark-1.3-contributor-free"
    }
  },
  "classifier": { "url": "http://127.0.0.1:8010/classify", "timeoutMs": 2000 }
}
```

**All default refs are `opencode/…`** — the built-in provider, no third-party
gateway. You only need a free [OpenCode Zen](https://opencode.ai/zen) account
(via `/connect` → OpenCode Zen). The `free-optimal` mode's models rotate as
OpenCode deprecates them — adjust refs to the current list in
`opencode models`.

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
  "activeMode": "balanced",
  "modes": {
    "balanced": {
      "description": "Cross-provider value picks (OpenRouter)",
      "EASY":   "openrouter/z-ai/glm-5.3-flash",
      "MEDIUM": "openrouter/deepseek/deepseek-v4-pro-0813",
      "HARD":   "openrouter/moonshotai/kimi-k3"
    },
    "frontier-value": {
      "description": "Best value per tier, via OpenRouter",
      "EASY":   "openrouter/z-ai/glm-5.3-flash",
      "MEDIUM": "openrouter/google/gemini-3.8-flash",
      "HARD":   "openrouter/anthropic/claude-fable-5.1"
    }
  }
}
```

Model refs are `provider/model` (split on the **first** slash, so OpenRouter
slugs like `openrouter/anthropic/claude-fable-5.1` work as-is).

### Effort hopping (`provider/model@variant`) — a headline feature

Effort is the first-class dial: a tier can map to *the same model at different
reasoning efforts*, instead of switching models. This is the preferred 2026
pattern for keeping provider prompt caches warm — you pay for reasoning
tokens, not cache misses.

```json
"effort": {
  "description": "One model, effort dialed per tier",
  "EASY":   "opencode/gemini-3.8-flash@low",
  "MEDIUM": "opencode/gemini-3.8-flash@high",
  "HARD":   "opencode/gemini-3.8-flash@max"
}
```

End a ref with `@variant` and OpenCode merges that model's named variant
(reasoning effort / thinking budget) into the request for that message.
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

### Model hopping (`provider/model`) — switch models per tier

Prefer different models per tier (cost / capability split across vendors)?
That's the same dial — just swap the `provider/model` string:

```json
"balanced": {
  "EASY":   "opencode/glm-5.3-flash",   // trivial: greetings, thanks, small questions
  "MEDIUM": "opencode/deepseek-v4-pro", // typical dev tasks
  "HARD":   "opencode/kimi-k3"          // hard problems: architecture, debugging at scale
}
```

Both hops can coexist — mix `provider/model` and `provider/model@variant`
refs freely across modes.

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
├── classifier-service/        # Python side
│   ├── classifier.py          # QueryComplexityClassifier (ONNX CPU)
│   ├── server.py              # FastAPI /classify on 127.0.0.1:8010
│   ├── download_model.py      # fetches ONNX weights (SHA-verified)
│   └── model/                 # downloaded weights (git-ignored)
├── opencode-plugin/           # TypeScript side
│   ├── src/lib.ts             # pure helpers (parsing, config, heuristics)
│   ├── src/main.ts            # chat.message hook + router tool
│   └── tests/                 # unit tests (node:test) + smoke test
├── scripts/
│   ├── setup.sh               # one-command install (venv, model, shim, server)
│   └── install-global.sh      # global plugin shim + default config
├── .opencode/plugins/prompt-demux.ts   # shim OpenCode auto-loads
└── prompt-demux.json                    # dialing modes config
```

## Tests

```bash
cd opencode-plugin
npm install
npx tsc --noEmit
node --test tests/lib.test.ts    # 19 unit tests
node tests/smoke.mjs             # integration (needs classifier running)
```

## Benchmarks (Intel i7-9750H, CPU only)

| Variant | Median latency | Notes |
|---------|---------------|-------|
| ONNX fp32 | ~31 ms | **chosen** — best label quality |
| ONNX int8 | ~17 ms | faster but misclassifies HARD queries |

## Design notes & honest findings

- **The `chat.model` hook doesn't exist.** Most plugin docs/examples
  reference it; OpenCode 1.18.x does not. Dialing is implemented via the
  `chat.message` hook mutating `UserMessage.model` (and its `variant` for
  effort) — verified end-to-end (the dialed model/effort actually generates,
  confirmed against stored sessions).
- **Subagents are better than "inherited"**: child Task-tool sessions flow
  through the same hook, so each subagent gets routed per its own subtask.
- **Classifier quirk**: it rates "**Write** a distributed consensus
  algorithm" as EASY but "**Implement** one" as HARD — verb choice dominates
  its embeddings. Threshold tuning is a Phase 5 candidate.
- **Fallback chain**: heuristic (0 cost) → cached classifier → classifier →
  MEDIUM on failure. Chat never breaks because the classifier is down.

## Troubleshooting

- **Plugin doesn't load** — the shim must be at `.opencode/plugins/`
  (plural). Run opencode with `--print-logs`; plugin errors appear at startup.
- **Everything routes MEDIUM with a warning** — classifier service is down.
  Start it or raise `classifier.timeoutMs`.
- **Port 8010 busy** — `lsof -ti :8010 | xargs kill`, then restart.
- **Python 3.9 wheels** — `onnxruntime` is pinned `<1.20` for cp39
  compatibility; don't bump it on Python 3.9.

## Roadmap

- [x] Local classifier service (Phase 1)
- [x] OpenCode plugin: `chat.message` routing, multi-mode config, `router` tool (Phase 2)
- [x] Prefix stripping, classification cache, greeting heuristics, subagent routing (Phase 3)
- [x] Config polish, unit tests, docs (Phase 4)
- [ ] Confidence thresholds + per-tier calibration
- [ ] Publish to npm as a portable plugin

## Follow along

Built in public, phase by phase — each phase is a tagged commit:

- `v0.1.0` — classifier + plugin + modes + tests (this release)

Issues and PRs welcome, especially Intel Mac benchmarks from other machines.

## License

MIT
