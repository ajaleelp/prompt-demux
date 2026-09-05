import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_CONFIG,
  heuristicTier,
  loadConfig,
  parseModelRef,
  parseOverrides,
  saveConfig,
} from "../src/lib.ts"

// ---------- parseModelRef ----------

test("parseModelRef splits on the first slash only", () => {
  assert.deepStrictEqual(parseModelRef("openrouter/anthropic/claude-sonnet-4"), {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4",
  })
  assert.deepStrictEqual(parseModelRef("anthropic/claude-sonnet-4"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
  })
})

test("parseModelRef parses an @variant effort suffix", () => {
  assert.deepStrictEqual(parseModelRef("opencode/gemini-3.8-flash@low"), {
    providerID: "opencode",
    modelID: "gemini-3.8-flash",
    variant: "low",
  })
  assert.deepStrictEqual(parseModelRef("openrouter/deepseek/deepseek-v4-pro@xhigh"), {
    providerID: "openrouter",
    modelID: "deepseek/deepseek-v4-pro",
    variant: "xhigh",
  })
  assert.deepStrictEqual(parseModelRef("opencode/glm-5.3-flash"), {
    providerID: "opencode",
    modelID: "glm-5.3-flash",
  })
})

test("parseModelRef rejects malformed refs", () => {
  for (const bad of ["gpt-4o", "/leading", "trailing/", ""])
    assert.throws(() => parseModelRef(bad), /invalid model ref/)
})

// ---------- parseOverrides ----------

test("parseOverrides recognizes tier prefixes", () => {
  assert.equal(parseOverrides("!hard refactor this").tier, "HARD")
  assert.equal(parseOverrides("!premium refactor this").tier, "HARD")
  assert.equal(parseOverrides("!free hi").tier, "EASY")
  assert.equal(parseOverrides("!medium explain closures").tier, "MEDIUM")
  assert.equal(parseOverrides("!easy hello").tier, "EASY")
})

test("parseOverrides strips consumed tokens from rest", () => {
  const r = parseOverrides("!hard refactor this now")
  assert.equal(r.rest, "refactor this now")
  assert.equal(r.consumed, 1)
})

test("parseOverrides stops at the first non-override token", () => {
  const r = parseOverrides("please !hard refactor")
  assert.equal(r.consumed, 0)
  assert.equal(r.tier, undefined)
  assert.equal(r.rest, "please !hard refactor")
})

test("parseOverrides handles a lone prefix", () => {
  const r = parseOverrides("!hard")
  assert.equal(r.tier, "HARD")
  assert.equal(r.rest, "")
})

test("parseOverrides reads !mode:<name>", () => {
  const r = parseOverrides("!mode:reason-max hello there")
  assert.equal(r.mode, "reason-max")
  assert.equal(r.rest, "hello there")
  assert.equal(r.consumed, 1)
})

test("parseOverrides tolerates a leading quote (opencode run quoting)", () => {
  const r = parseOverrides('"!hard Reply with exactly: PONG"')
  assert.equal(r.tier, "HARD")
  assert.equal(r.consumed, 1)
  assert.equal(r.rest, 'Reply with exactly: PONG"')
})

test("parseOverrides is case-insensitive", () => {
  assert.equal(parseOverrides("!HARD Go").tier, "HARD")
  assert.equal(parseOverrides("!Mode:Reason-Max x").mode, "reason-max")
})

// ---------- heuristicTier ----------

test("heuristicTier routes greetings/affirmations to EASY", () => {
  for (const t of ["hi", "Hello.", "thanks!", "THANK YOU", "go on", "sounds good...", "continue"])
    assert.equal(heuristicTier(t), "EASY", t)
})

test("heuristicTier returns null for real work", () => {
  for (const t of ["Write a parser for INI files", "refactor the auth module please", "hi, and also write a compiler"])
    assert.equal(heuristicTier(t), null, t)
})

test("heuristicTier ignores greetings buried in longer text", () => {
  assert.equal(heuristicTier("hi " + "x".repeat(50)), null)
})

test("heuristicTier can be disabled via env", () => {
  process.env.PROMPT_DEMUX_DISABLE_HEURISTICS = "1"
  try {
    assert.equal(heuristicTier("hello"), null)
  } finally {
    delete process.env.PROMPT_DEMUX_DISABLE_HEURISTICS
  }
})

// ---------- loadConfig / saveConfig ----------

function tmpConfig(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"))
  const file = path.join(dir, "prompt-demux.json")
  if (contents !== null) fs.writeFileSync(file, contents)
  return file
}

test("loadConfig accepts a valid multi-mode file", () => {
  const file = tmpConfig(
    JSON.stringify({
      activeMode: "b",
      modes: {
        a: { EASY: "p/a1", MEDIUM: "p/a2", HARD: "p/a3" },
        b: { description: "B", EASY: "p/b1", MEDIUM: "p/b2", HARD: "p/b3" },
      },
      classifier: { url: "http://localhost:9999/classify", timeoutMs: 500 },
    }),
  )
  const { config, error } = loadConfig(file)
  assert.equal(error, undefined)
  assert.equal(config.activeMode, "b")
  assert.equal(config.modes.b.MEDIUM, "p/b2")
  assert.equal(config.classifier?.timeoutMs, 500)
})

test("loadConfig falls back to defaults on broken JSON", () => {
  const { config, error } = loadConfig(tmpConfig("{not json"))
  assert.ok(error)
  assert.deepEqual(config, DEFAULT_CONFIG)
})

test("loadConfig falls back when a tier is missing", () => {
  const { config, error } = loadConfig(
    tmpConfig(JSON.stringify({ activeMode: "x", modes: { x: { EASY: "p/x" } } })),
  )
  assert.match(error!, /missing MEDIUM/)
  assert.deepEqual(config, DEFAULT_CONFIG)
})

test("loadConfig repairs an unknown activeMode", () => {
  const { config, error } = loadConfig(
    tmpConfig(
      JSON.stringify({
        activeMode: "nope",
        modes: { a: { EASY: "p/1", MEDIUM: "p/2", HARD: "p/3" } },
      }),
    ),
  )
  assert.equal(error, undefined)
  assert.equal(config.activeMode, "a")
})

test("loadConfig rejects a non-http classifier url", () => {
  const { error } = loadConfig(
    tmpConfig(
      JSON.stringify({
        activeMode: "a",
        modes: { a: { EASY: "p/1", MEDIUM: "p/2", HARD: "p/3" } },
        classifier: { url: "ftp://nope" },
      }),
    ),
  )
  assert.match(error!, /classifier\.url/)
})

test("saveConfig round-trips through loadConfig", () => {
  const file = tmpConfig(null)
  saveConfig(file, {
    activeMode: "m",
    modes: { m: { EASY: "p/1", MEDIUM: "p/2", HARD: "p/3" } },
  })
  const { config, error } = loadConfig(file)
  assert.equal(error, undefined)
  assert.equal(config.activeMode, "m")
})
