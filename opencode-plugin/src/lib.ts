import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Virtual provider injected into the model dropdown. Pick prompt-demux/* to enable dialing. */
export const PROVIDER_ID = "prompt-demux"
export const PROVIDER_NAME = "Prompt Demux"
export const AUTO_MODEL = "auto"

export type Tier = "EASY" | "MEDIUM" | "HARD"
export type ModelRef = { providerID: string; modelID: string; variant?: string }

export type RouterMode = { description?: string } & Record<Tier, string>
export type RouterConfig = {
  activeMode: string
  modes: Record<string, RouterMode>
  classifier?: { url?: string; timeoutMs?: number }
  /** Show a toast per routed message (TUI; Desktop apps may ignore TUI toasts) */
  toast?: boolean
}

export type Classification = {
  tier: Tier
  confidence: number
  probabilities: Record<string, number>
  /** P(this message continues the work in progress rather than starting something new) */
  continuesPriorWork: number
  /** P(the last failure was environmental — missing dep, flaky test — not task difficulty) */
  failureIsEnvironmental: number
  latency_ms: number
  cacheHit?: boolean
}

/** What Jev sees. The message alone is a weak signal ("fix it"); the session state is the point. */
export type SessionState = {
  message: string
  prior_user_turns: string[]
  last_assistant_outcome: string
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"

/** Tier definitions are prose — edit these to move the dial, no retraining. */
export const JEV_QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "How much reasoning effort does answering `message` require, given the session context? " +
      "Short messages like 'fix it' or 'continue' inherit the difficulty of the work in progress.",
    criteria: {
      EASY: "Greetings, acknowledgements, one-line lookups, trivial edits (rename, typo). No design thinking.",
      MEDIUM: "A well-scoped coding task: write/refactor/test one function or module, explain a concept.",
      HARD: "System design, distributed systems, concurrency, architecture, or continuing such work.",
    },
  },
  continues_prior_work: {
    type: "noul",
    instructions:
      "Does `message` refer to or continue the work described in `prior_user_turns` / `last_assistant_outcome`, " +
      "rather than starting something new?",
  },
  failure_is_environmental: {
    type: "noul",
    instructions:
      "Is `last_assistant_outcome` a failure caused by the environment (missing dependency, flaky test, tooling) " +
      "rather than by the difficulty of the task itself?",
  },
} as const

/** Minimal shape of OpenCode's session.messages() rows we read. */
type MessageRow = {
  info: { role: "user" | "assistant"; error?: unknown }
  parts: Array<
    | { type: "text"; text: string }
    | { type: "tool"; tool: string; state: { status: string; error?: string; output?: string } }
    | { type: string }
  >
}

/** Distill the last few turns into the state Jev judges. Pure; unit-tested. */
export function buildSessionState(message: string, rows: MessageRow[], turns = 3): SessionState {
  const textOf = (r: MessageRow) =>
    r.parts.map((p) => ("text" in p && p.type === "text" ? p.text : "")).join(" ").trim()

  const users = rows.filter((r) => r.info.role === "user").map(textOf).filter(Boolean)
  // The hook may fire after the current message is persisted; don't feed it back as "prior".
  if (users.at(-1) === message) users.pop()

  const last = rows.filter((r) => r.info.role === "assistant").at(-1)
  let outcome = ""
  if (last) {
    const err = last.parts.find((p) => p.type === "tool" && "state" in p && p.state.status === "error")
    if (err && "state" in err) outcome = `tool error: ${err.tool}: ${err.state.error ?? ""}`
    else if (last.info.error) outcome = `error: ${JSON.stringify(last.info.error)}`
    else outcome = textOf(last)
  }
  return {
    message,
    prior_user_turns: users.slice(-turns).map((t) => t.slice(0, 300)),
    last_assistant_outcome: outcome.slice(0, 300),
  }
}

/** One Jev call: all three questions in parallel over the same state. Returns null on any failure. */
export async function jevClassify(
  state: SessionState,
  opts: { apiKey: string; url?: string; timeoutMs?: number; model?: string },
): Promise<Classification | null> {
  const t0 = performance.now()
  try {
    const res = await fetch(opts.url ?? JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ state, model: opts.model ?? "jev-latest", questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    })
    if (!res.ok) return null
    const { answers: a } = (await res.json()) as {
      answers: {
        tier: { choice: Tier; confidence: number; probabilities: Record<string, number> }
        continues_prior_work: { noul: number }
        failure_is_environmental: { noul: number }
      }
    }
    if (!TIERS.includes(a.tier.choice)) return null
    return {
      tier: a.tier.choice,
      confidence: a.tier.confidence,
      probabilities: a.tier.probabilities,
      continuesPriorWork: a.continues_prior_work.noul,
      failureIsEnvironmental: a.failure_is_environmental.noul,
      latency_ms: performance.now() - t0,
    }
  } catch {
    return null
  }
}

export const TIERS: Tier[] = ["EASY", "MEDIUM", "HARD"]

export const DEFAULT_CONFIG: RouterConfig = {
  activeMode: "effort",
  modes: {
    effort: {
      description:
        "One model, effort dialed per tier (@low/@high/@max) - keeps the prompt cache warm",
      EASY: "opencode/gemini-3.8-flash@low",
      MEDIUM: "opencode/gemini-3.8-flash@high",
      HARD: "opencode/gemini-3.8-flash@max",
    },
    balanced: {
      description:
        "OpenCode-native value picks: GLM Flash absorbs trivial, DeepSeek moderate, Kimi hard",
      EASY: "opencode/glm-5.3-flash",
      MEDIUM: "opencode/deepseek-v4-pro",
      HARD: "opencode/kimi-k3",
    },
    "frontier-value": {
      description: "Best value per tier on tuned/high-end models (OpenCode-native)",
      EASY: "opencode/glm-5.3-flash",
      MEDIUM: "opencode/gemini-3.8-flash",
      HARD: "opencode/claude-fable-5-1",
    },
    "free-optimal": {
      description: "Zero-cost via OpenCode Zen free tier",
      EASY: "opencode/mimo-v2.5-free",
      MEDIUM: "opencode/muse-spark-1.2-contributor-free",
      HARD: "opencode/muse-spark-1.3-contributor-free",
    },
  },
}

/**
 * Parse a tier ref into a ModelRef. A ref is `provider/model[@variant]`.
 * Examples:
 *   "openrouter/anthropic/claude-sonnet-4"      -> providerID "openrouter", modelID "anthropic/claude-sonnet-4"
 *   "opencode/glm-5.3-flash@high"               -> providerID "opencode", modelID "glm-5.3-flash", variant "high"
 * The @variant suffix is an *effort hop*: OpenCode merges the named variant
 * (reasoning effort / thinking budget) into the request for that message.
 */
export function parseModelRef(s: string): ModelRef {
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) throw new Error(`invalid model ref: ${s}`)
  let modelID = s.slice(i + 1)
  let variant: string | undefined
  const at = modelID.lastIndexOf("@")
  if (at > 0) {
    variant = modelID.slice(at + 1)
    modelID = modelID.slice(0, at)
  }
  if (!variant) return { providerID: s.slice(0, i), modelID }
  return { providerID: s.slice(0, i), modelID, variant }
}

/** Parse leading !override tokens off the message text. */
export function parseOverrides(
  text: string,
): { tier?: Tier; mode?: string; rest: string; consumed: number } {
  let tier: Tier | undefined
  let mode: string | undefined
  const tokens = text.trimStart().split(/\s+/)
  let consumed = 0
  for (const t of tokens) {
    // tolerate a leading quote (e.g. `opencode run "!hard ..."` shell-quotes args)
    const lower = t.replace(/^["']+/, "").toLowerCase()
    if (lower === "!easy") tier = "EASY"
    else if (lower === "!medium") tier = "MEDIUM"
    else if (lower === "!hard" || lower === "!premium") tier = "HARD"
    else if (lower === "!free") tier = "EASY"
    else if (lower.startsWith("!mode:")) mode = lower.slice(6)
    else break
    consumed++
  }
  return { tier, mode, rest: tokens.slice(consumed).join(" "), consumed }
}

const GREETING_RE =
  /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ty|ok|okay|yes|yeah|yep|yup|no|nope|bye|goodbye|continue|go on|go ahead|sounds good|sounds great|lgtm|nice|cool|great|perfect)\W{0,3}$/i

/** Zero-cost fast path: obvious non-work messages skip the classifier entirely. */
export function heuristicTier(text: string): Tier | null {
  if (process.env.PROMPT_DEMUX_DISABLE_HEURISTICS === "1") return null
  if (text.length <= 40 && GREETING_RE.test(text.trim())) return "EASY"
  return null
}

export function configPath(worktree: string, directory: string): string {
  const root = worktree || directory
  return `${root}/prompt-demux.json`
}

/** Global fallback config: ~/.config/opencode/prompt-demux.json */
export function globalConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "prompt-demux.json")
}

/** Prefer project config; fall back to global. */
export function resolveConfigPath(worktree: string, directory: string): {
  file: string
  scope: "project" | "global"
} {
  const project = configPath(worktree, directory)
  if (fs.existsSync(project)) return { file: project, scope: "project" }
  return { file: globalConfigPath(), scope: "global" }
}

export function loadConfig(file: string): { config: RouterConfig; error?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RouterConfig
    if (!raw.modes || !Object.keys(raw.modes).length)
      return { config: DEFAULT_CONFIG, error: "no modes defined" }
    if (!raw.modes[raw.activeMode]) raw.activeMode = Object.keys(raw.modes)[0]
    for (const [name, mode] of Object.entries(raw.modes)) {
      for (const t of TIERS)
        if (typeof mode[t] !== "string")
          return { config: DEFAULT_CONFIG, error: `mode '${name}' missing ${t}` }
    }
    if (raw.classifier?.url && !/^https?:\/\//.test(raw.classifier.url))
      return { config: DEFAULT_CONFIG, error: "classifier.url must start with http(s)://" }
    if (raw.classifier?.timeoutMs !== undefined && raw.classifier.timeoutMs <= 0)
      return { config: DEFAULT_CONFIG, error: "classifier.timeoutMs must be positive" }
    return { config: raw }
  } catch (e) {
    return { config: DEFAULT_CONFIG, error: String(e) }
  }
}

export function saveConfig(file: string, config: RouterConfig): void {
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
}
