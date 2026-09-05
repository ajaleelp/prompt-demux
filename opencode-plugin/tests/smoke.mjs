// Standalone smoke test: exercises the plugin without opencode (plain Node).
// Requires the classifier server on 127.0.0.1:8010 for classifier-path tests.

import assert from "node:assert"
import { PromptDemuxPlugin } from "../src/main.ts"

const repoRoot = new URL("../../", import.meta.url).pathname

const logs = []
const ctx = {
  client: {
    app: {
      log: async ({ body }) => {
        logs.push({ level: body.level, message: body.message, extra: body.extra })
        if (process.env.VERBOSE)
          console.log("  [log]", body.level, body.message, JSON.stringify(body.extra ?? {}))
      },
    },
  },
  worktree: repoRoot,
  directory: repoRoot,
}

const hooks = await PromptDemuxPlugin(ctx)

// config hook: provider injection happens on the passed config object
const fakeConfig = { provider: {} }
await hooks.config(fakeConfig)
const injected = fakeConfig.provider?.["prompt-demux"]
assert.ok(injected, "config hook must inject the prompt-demux provider")
assert.ok(injected.models.auto, "prompt-demux/auto model must exist")
assert.ok(injected.models["balanced"], "per-mode models must exist")
assert.ok(injected.models["frontier-value"], "per-mode models must exist")
assert.ok(injected.models["free-optimal"], "per-mode models must exist")
assert.ok(fakeConfig.small_model, "small_model must be redirected away from prompt-demux")

function makeIO(text) {
  return {
    input: {
      sessionID: "smoke-session",
      agent: "build",
      model: { providerID: "prompt-demux", modelID: "auto" },
    },
    output: {
      message: { model: { providerID: "prompt-demux", modelID: "auto" } },
      parts: [{ type: "text", text }],
    },
  }
}

async function route(text) {
  const { input, output } = makeIO(text)
  await hooks["chat.message"](input, output)
  return { model: output.message.model, visibleText: output.parts[0].text }
}

const ref = (s) => {
  const i = s.indexOf("/")
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}
const lastExtra = () => logs[logs.length - 1].extra

// 1. classifier path: closures -> MEDIUM -> balanced MEDIUM (opencode/deepseek-v4-pro)
let r = await route("Explain closures in JavaScript")
assert.deepStrictEqual(r.model, ref("opencode/deepseek-v4-pro"))
assert.strictEqual(lastExtra().source, "classifier")
assert.strictEqual(lastExtra().cacheHit, false)

// 2. cache: same query again -> cacheHit, same result
r = await route("Explain closures in JavaScript")
assert.deepStrictEqual(r.model, ref("opencode/deepseek-v4-pro"))
assert.strictEqual(lastExtra().cacheHit, true, "second identical query should hit cache")

// 3. tier override + prefix stripping (no classifier call)
r = await route("!hard refactor this monolith now")
assert.deepStrictEqual(r.model, ref("opencode/kimi-k3"))
assert.strictEqual(r.visibleText, "refactor this monolith now", "override prefix must be stripped from model-visible text")
assert.strictEqual(lastExtra().source, "override")

// 4. zero-cost heuristic: greeting skips classifier
r = await route("thanks!")
assert.deepStrictEqual(r.model, ref("opencode/glm-5.3-flash"))
assert.strictEqual(lastExtra().source, "heuristic")
assert.strictEqual(r.visibleText, "thanks!")

// 5. router tool: list shows all modes
const toolCtx = {
  sessionID: "smoke-session", messageID: "m1", agent: "build",
  directory: repoRoot, worktree: repoRoot, abort: new AbortController().signal,
  metadata: () => {}, ask: async () => {},
}
const listResult = await hooks.tool.router.execute({ action: "list" }, toolCtx)
assert.match(listResult, /balanced/)
assert.match(listResult, /frontier-value/)
assert.match(listResult, /free-optimal/)
assert.match(listResult, /activeMode: balanced/)

// 5b. free-optimal mode routes through the opencode/ (Zen) provider, no openrouter
r = await route("!mode:free-optimal Explain closures in JavaScript")
assert.strictEqual(lastExtra().mode, "free-optimal")
assert.deepStrictEqual(r.model, ref("opencode/muse-spark-1.2-contributor-free"))

// 6. session mode override: !mode:frontier-value sticks for the session
r = await route("!mode:frontier-value What time is it?")
assert.deepStrictEqual(r.model, ref("opencode/glm-5.3-flash"))
r = await route("Explain closures in JavaScript") // cached MEDIUM -> frontier-value MEDIUM
assert.deepStrictEqual(r.model, ref("opencode/gemini-3.8-flash"), "session mode override should stick")

// 7. bad mode name falls back to the config's activeMode (balanced)
r = await route("!mode:does-not-exist Implement a distributed consensus algorithm")
assert.deepStrictEqual(r.model, ref("opencode/kimi-k3"), "bad mode -> activeMode (balanced); query classifies HARD")

// 7b. effort mode: same model, variant hops per tier (@low/@high/@max)
r = await route("!mode:effort thanks!")
assert.deepStrictEqual(r.model, { providerID: "opencode", modelID: "gemini-3.8-flash", variant: "low" }, "effort EASY -> gemini@low")
r = await route("!mode:effort Explain closures in JavaScript")
assert.deepStrictEqual(r.model, { providerID: "opencode", modelID: "gemini-3.8-flash", variant: "high" }, "effort MEDIUM -> gemini@high")
r = await route("!mode:effort Implement a distributed consensus algorithm")
assert.deepStrictEqual(r.model, { providerID: "opencode", modelID: "gemini-3.8-flash", variant: "max" }, "effort HARD -> gemini@max")

// 8. non-prompt-demux selection = routing OFF (plugin must not touch the model)
{
  const { input, output } = makeIO("Explain closures in JavaScript")
  input.model = { providerID: "openrouter", modelID: "openai/gpt-4o" }
  output.message.model = { ...input.model } // session starts on the real model
  await hooks["chat.message"](input, output)
  assert.deepStrictEqual(
    output.message.model,
    { providerID: "openrouter", modelID: "openai/gpt-4o" },
    "non-prompt-demux session must pass through untouched",
  )
}

// 9. prompt-demux/<mode> fixed-model selection forces that mode
{
  const { input, output } = makeIO("Explain closures in JavaScript")
  input.model = { providerID: "prompt-demux", modelID: "frontier-value" }
  await hooks["chat.message"](input, output)
  assert.deepStrictEqual(
    output.message.model,
    ref("opencode/gemini-3.8-flash"),
    "prompt-demux/frontier-value must force frontier-value mode",
  )
}

// Guard: the classifier path must have been exercised (no fallback warns)
assert.ok(
  !logs.some((l) => l.message.includes("classifier unavailable")),
  "classifier server unreachable - this test exercised the FALLBACK path; start server.py first",
)

console.log("SMOKE TEST PASSED (classifier, cache, heuristics, stripping, modes all verified).")
