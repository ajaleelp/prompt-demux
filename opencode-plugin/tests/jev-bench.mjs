// Accuracy benchmark for the Jev session-state classifier.
//
// Part 1: 30 single prompts, 10 per tier (the set the old ModernBERT scored 66.7% on).
// Part 2: 6 short follow-ups with a synthesised last_turn, no prior state.
// Part 3: scripted multi-turn sessions replayed through the real update loop
//         (applyAnswers), scoring every turn. This is where a window of raw
//         messages fails: ack chains, retry loops, task switches.
//
// Run:  node tests/jev-bench.mjs [--no-state]
//   --no-state  sends prior=undefined on every turn (ablation: what the state adds)
//   TYPESAFE_API_KEY from env or ../.env

import fs from "node:fs"
import { applyAnswers, jevUpdate } from "../src/lib.ts"

if (!process.env.TYPESAFE_API_KEY) {
  const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8")
  process.env.TYPESAFE_API_KEY = env.match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim()
}
const apiKey = process.env.TYPESAFE_API_KEY
const NO_STATE = process.argv.includes("--no-state")

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
].map(([message, want]) => ({ message, want }))

const turn = (tool_calls, errors, last_error, final_text) => ({ tool_calls, errors, last_error, final_text })
const ok = (text) => turn(1, 0, "", text)

// Follow-ups with only a last_turn: what a text-only classifier can never see.
const FOLLOWUPS = [
  { message: "fix it", last_turn: ok("Fixed the typo in README.md"), want: "EASY" },
  { message: "fix it", last_turn: turn(9, 4, "pytest: 4 failed, race in merge() under concurrent writes", "The vector-clock merge still races."), want: "HARD" },
  { message: "continue", last_turn: ok("Renamed `cnt` to `count` in 2 files"), want: "EASY" },
  { message: "continue", last_turn: ok("Drafted section 1 of 4 of the partition-tolerant consensus design"), want: "HARD" },
  { message: "try again", last_turn: turn(2, 1, "ModuleNotFoundError: No module named 'pytest'", "pytest isn't installed"), want: "MEDIUM" },
  { message: "why", last_turn: ok("Proposed the outbox pattern to split the monolith with exactly-once delivery"), want: "HARD" },
]

// Scripted sessions. Each turn: message, last_turn (what the assistant did before it), want.
const SESSIONS = {
  "ack chain after a HARD task": [
    { message: "Implement vector-clock based conflict resolution for the sync engine", want: "HARD" },
    { message: "ok", last_turn: ok("Plan: 1) clock type 2) merge 3) tests. Proceed?"), want: "HARD" },
    { message: "yes", last_turn: ok("Added VectorClock type."), want: "HARD" },
    { message: "go on", last_turn: ok("Implemented merge()."), want: "HARD" },
    { message: "continue", last_turn: ok("Writing property tests for merge()."), want: "HARD" },
    { message: "continue", last_turn: ok("Property tests in place, 2 of 3 pass."), want: "HARD" },
    { message: "and then?", last_turn: ok("Third test fails: concurrent writes."), want: "HARD" },
    { message: "continue", last_turn: turn(6, 1, "AssertionError: clocks diverged on concurrent write", "Investigating."), want: "HARD" },
  ],
  "retry loop, stuck should rise": [
    { message: "Implement a distributed transaction coordinator with two-phase commit", want: "HARD" },
    { message: "try again", last_turn: turn(8, 2, "coordinator_test: participant timeout not handled", "2 tests fail."), want: "HARD" },
    { message: "still failing, fix it", last_turn: turn(11, 2, "coordinator_test: participant timeout not handled", "Same 2 tests fail."), want: "HARD" },
    { message: "fix it", last_turn: turn(14, 3, "coordinator_test: participant timeout not handled; prepare phase deadlock", "Now 3 fail."), want: "HARD" },
  ],
  "task switch mid-HARD": [
    { message: "Design a consensus protocol that tolerates partial partitions", want: "HARD" },
    { message: "continue", last_turn: ok("Section 1: failure model written."), want: "HARD" },
    { message: "fix the typo in the README title", last_turn: ok("Section 2: leader election drafted."), want: "EASY" },
    { message: "thanks, now explain closures in JavaScript", last_turn: ok("Fixed the README title."), want: "MEDIUM" },
  ],
  "environmental failure on a MEDIUM task": [
    { message: "Add tests for the login module", want: "MEDIUM" },
    { message: "try again", last_turn: turn(2, 1, "ModuleNotFoundError: No module named 'pytest'", "pytest isn't installed."), want: "MEDIUM" },
    { message: "ok run them", last_turn: ok("Installed pytest."), want: "MEDIUM" },
  ],
  "EASY chat, then HARD": [
    { message: "hi, what does this function do?", want: "EASY" },
    { message: "cool", last_turn: ok("It parses the config file."), want: "EASY" },
    { message: "now design a system that scales this to 10M concurrent users", last_turn: ok("Glad it helps."), want: "HARD" },
    { message: "continue", last_turn: ok("Sharding plan drafted."), want: "HARD" },
  ],
}

const times = []
async function ask(input) {
  const r = await jevUpdate(input, { apiKey, timeoutMs: 10_000 })
  if (!r) throw new Error("Jev call failed — check TYPESAFE_API_KEY / network")
  times.push(r.latency_ms)
  return r
}
const mark = (got, want) => (got === want ? "✓" : "✗")
const pct = (h, n) => `${h}/${n} = ${((h / n) * 100).toFixed(1)}%`

async function runSingles(title, cases) {
  console.log(`== ${title} ==`)
  let hits = 0
  for (const { want, ...input } of cases) {
    const r = await ask(input)
    hits += r.tier === want
    console.log(`${mark(r.tier, want)} ${input.message.slice(0, 55).padEnd(55)} want=${want.padEnd(6)} got=${r.tier.padEnd(6)} conf=${r.confidence.toFixed(2)}`)
  }
  console.log(`\n${pct(hits, cases.length)}\n`)
  return [hits, cases.length]
}

async function runSessions() {
  console.log(`== Part 3: scripted sessions${NO_STATE ? " (--no-state ablation)" : ""} ==`)
  let hits = 0, n = 0
  for (const [name, turns] of Object.entries(SESSIONS)) {
    console.log(`\n-- ${name}`)
    let prior
    for (const { message, last_turn, want } of turns) {
      const r = await ask({ message, prior: NO_STATE ? undefined : prior, last_turn })
      prior = applyAnswers(prior, message, r)
      hits += r.tier === want
      n++
      console.log(
        `${mark(r.tier, want)} ${message.slice(0, 40).padEnd(40)} want=${want.padEnd(6)} got=${r.tier.padEnd(6)} conf=${r.confidence.toFixed(2)}` +
        `  same=${r.same_task.toFixed(2)} diff=${r.difficulty.toFixed(1)} stuck=${r.stuck.toFixed(1)} ${r.phase}/${r.scope} t=${prior.turns}`,
      )
    }
  }
  console.log(`\n${pct(hits, n)}\n`)
  return [hits, n]
}

const totals = []
if (!NO_STATE) {
  totals.push(await runSingles("Part 1: single prompts (ModernBERT fp32 was 66.7%)", LABELED))
  totals.push(await runSingles("Part 2: follow-ups with last_turn only", FOLLOWUPS))
}
totals.push(await runSessions())
times.sort((a, b) => a - b)
const [h, n] = totals.reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
console.log(`overall ${pct(h, n)}   median ${Math.round(times[times.length >> 1])} ms over ${times.length} calls`)
