// Accuracy benchmark for the Jev classifier.
//
// Part 1: the 30-item text-only set the old ModernBERT classifier was scored on
//         (fp32: 66.7%, int8: 43.3% — see README "What we tried").
// Part 2: context-dependent turns. Same message, different session state, different
//         expected tier — the case a text-only classifier structurally cannot get right.
//
// Run:  node tests/jev-bench.mjs     (TYPESAFE_API_KEY from env or ../.env)

import fs from "node:fs"
import { jevClassify } from "../src/lib.ts"

if (!process.env.TYPESAFE_API_KEY) {
  const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8")
  process.env.TYPESAFE_API_KEY = env.match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim()
}
const apiKey = process.env.TYPESAFE_API_KEY

const LABELED = [
  ["Hello", "EASY"], ["thanks!", "EASY"], ["What time is it?", "EASY"], ["ok", "EASY"],
  ["Explain this error briefly", "EASY"], ["summarize this in one line", "EASY"], ["continue", "EASY"],
  ["what does this function do?", "EASY"], ["rename this variable", "EASY"], ["looks good, ship it", "EASY"],
  ["Write a function to parse JSON", "MEDIUM"], ["Explain closures in JavaScript", "MEDIUM"],
  ["Add error handling to this HTTP client", "MEDIUM"], ["Refactor this function to use async/await", "MEDIUM"],
  ["Write a SQL query with a join", "MEDIUM"], ["Fix this TypeScript type error", "MEDIUM"],
  ["Add tests for the login module", "MEDIUM"], ["Optimize this database query", "MEDIUM"],
  ["Implement a simple caching layer", "MEDIUM"], ["What does this regex do?", "MEDIUM"],
  ["Design a microservices architecture", "HARD"], ["Implement a distributed consensus algorithm", "HARD"],
  ["Refactor this legacy monolith into event-driven services with exactly-once guarantees", "HARD"],
  ["Design a system that scales to 10M concurrent users", "HARD"],
  ["Implement a Byzantine-fault-tolerance protocol", "HARD"], ["Build a distributed transaction coordinator", "HARD"],
  ["Design a low-latency trading system with replay", "HARD"],
  ["Implement vector-clock based conflict resolution", "HARD"],
  ["Design a consensus protocol that tolerates partial partitions", "HARD"],
  ["Build an eventually-consistent system across regions", "HARD"],
].map(([message, want]) => ({ message, prior_user_turns: [], last_assistant_outcome: "", want }))

const CONTEXTUAL = [
  { message: "fix it", prior_user_turns: ["thanks"], last_assistant_outcome: "typo fixed in README", want: "EASY" },
  { message: "fix it", prior_user_turns: ["Implement vector-clock based conflict resolution", "tests still fail on concurrent writes"],
    last_assistant_outcome: "tool error: pytest failed, 4 tests, race in merge()", want: "HARD" },
  { message: "continue", prior_user_turns: ["rename this variable"], last_assistant_outcome: "renamed in 2 files", want: "EASY" },
  { message: "continue", prior_user_turns: ["Design a consensus protocol that tolerates partial partitions"],
    last_assistant_outcome: "drafted section 1 of 4", want: "HARD" },
  { message: "try again", prior_user_turns: ["Add tests for the login module"],
    last_assistant_outcome: "tool error: ModuleNotFoundError: pytest", want: "MEDIUM" },
  { message: "why", prior_user_turns: ["Refactor this legacy monolith into event-driven services with exactly-once guarantees"],
    last_assistant_outcome: "proposed outbox pattern", want: "HARD" },
]

async function run(cases) {
  let hits = 0
  const times = []
  for (const { want, ...state } of cases) {
    const r = await jevClassify(state, { apiKey, timeoutMs: 10_000 })
    if (!r) throw new Error("Jev call failed — check TYPESAFE_API_KEY / network")
    times.push(r.latency_ms)
    const ok = r.tier === want
    hits += ok
    const ctx = state.prior_user_turns.length
      ? `  continues=${r.continuesPriorWork.toFixed(2)} env_fail=${r.failureIsEnvironmental.toFixed(2)}`
      : ""
    console.log(`${ok ? "✓" : "✗"} ${state.message.slice(0, 55).padEnd(55)} want=${want.padEnd(6)} got=${r.tier.padEnd(6)} conf=${r.confidence.toFixed(2)}${ctx}`)
  }
  times.sort((a, b) => a - b)
  console.log(`\n${hits}/${cases.length} = ${((hits / cases.length) * 100).toFixed(1)}%   median ${Math.round(times[times.length >> 1])} ms\n`)
}

console.log("== Part 1: text-only LABELED set (ModernBERT fp32 was 66.7%) ==")
await run(LABELED)
console.log("== Part 2: context-dependent turns ==")
await run(CONTEXTUAL)
