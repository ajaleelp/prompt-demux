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

/**
 * Typed per-session state. Jev is stateless; the plugin holds this and asks Jev to
 * update it every turn, so tier decisions track the whole session, not a window of it.
 */
export type SessionState = {
  /** 0–4, probability-weighted: how hard the current task is as understood so far */
  difficulty: number
  phase: string
  scope: string
  /** 0–3, probability-weighted: consecutive attempts that did not resolve */
  stuck: number
  /** the message that started the current task */
  task_anchor: string
  turns: number
}

/** Deterministic summary of the last assistant turn, built in code. */
export type LastTurn = { tool_calls: number; errors: number; last_error: string; final_text: string }

/** What Jev sees. Never raw history: the shape of the task plus one anchor sentence. */
export type JevInput = { message: string; prior?: SessionState; last_turn?: LastTurn }

export type JevAnswers = {
  /** P(message continues the task `prior.task_anchor` describes) */
  same_task: number
  difficulty: number
  phase: string
  scope: string
  stuck: number
  tier: Tier
  confidence: number
  probabilities: Record<string, number>
}

export type Classification = JevAnswers & { latency_ms: number; cacheHit?: boolean }

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"

/** Everything the dial knows is prose here. Edit to move it; nothing to retrain. */
export const JEV_QUESTIONS = {
  same_task: {
    type: "noul",
    instructions:
      "Does `message` continue the task described by `prior.task_anchor` (and the state in `prior`), " +
      "rather than start something unrelated? If there is no `prior`, answer no.",
  },
  difficulty: {
    type: "score",
    instructions:
      "How hard is the task the user is working on now, given `message`, `prior` (how it looked so far) and `last_turn`? " +
      "Short messages like 'continue' or 'fix it' keep the prior difficulty; a new unrelated task gets its own.",
    criteria: [
      "Greeting, acknowledgement, one-line lookup, or a trivial edit such as a rename or typo.",
      "A small, well-scoped change or explanation: one function, one concept, a config value.",
      "A module-sized task: write or refactor a component, add tests, fix a typed bug across a few files.",
      "Cross-cutting work: a subsystem, tricky debugging across modules, performance work, non-trivial algorithms.",
      "System design, distributed systems, concurrency, consensus, or architecture-level change.",
    ],
  },
  phase: {
    type: "choice",
    instructions: "Which phase of the task is the user in now, given `message`, `prior.phase` and `last_turn`?",
    criteria: {
      exploring: "Reading, asking what something does, orienting.",
      designing: "Deciding an approach, discussing tradeoffs, planning.",
      implementing: "Writing or changing code toward the plan.",
      debugging: "Something failed and the user is trying to make it work.",
      verifying: "Running tests, reviewing, checking results before calling it done.",
      idle: "Chit-chat, thanks, or no task in flight.",
    },
  },
  scope: {
    type: "choice",
    instructions: "How much of the codebase does the current task touch?",
    criteria: {
      "one-line": "A single line or value.",
      function: "One function or a small block.",
      module: "One file or component, possibly with its tests.",
      system: "Many modules, an architecture, or cross-service behaviour.",
    },
  },
  stuck: {
    type: "score",
    instructions:
      "How stuck is the user on the current task? Use `prior.stuck`, `last_turn.errors` and whether `message` is a retry " +
      "('try again', 'still failing', 'fix it') versus new progress.",
    criteria: [
      "Progressing: the last turn succeeded or this is a fresh request.",
      "One attempt failed; the user is retrying or redirecting.",
      "Two attempts at the same thing have failed.",
      "Three or more attempts have failed; the approach itself is in question.",
    ],
  },
  tier: {
    type: "choice",
    instructions:
      "How much reasoning effort should the model apply to answer `message` right now, given `prior`, `last_turn` and " +
      "the task's difficulty? An acknowledgement that tells the assistant to proceed with the task in `prior` " +
      "('ok', 'yes', 'go on', 'continue') needs the effort of that task, not EASY. A trivial aside unrelated to the task is still EASY.",
    criteria: {
      EASY: "No design thinking: greetings, acknowledgements, lookups, trivial edits.",
      MEDIUM: "A well-scoped coding task or explanation: one function or module.",
      HARD: "System design, distributed systems, concurrency, architecture, or continuing such work.",
    },
  },
  // Judged next to a HARD prior, a fresh MEDIUM task reads as EASY by contrast. This question
  // is prior-blind; code uses it when `same_task` says the message starts a new task.
  tier_fresh: {
    type: "choice",
    instructions:
      "Ignore `prior` and `last_turn` completely. Judge `message` on its own, as if it were the first message of a " +
      "new session: how much reasoning effort does answering it require?",
    criteria: {
      EASY: "No design thinking: greetings, acknowledgements, lookups, trivial edits.",
      MEDIUM: "A well-scoped coding task or explanation: one function or module.",
      HARD: "System design, distributed systems, concurrency, architecture.",
    },
  },
} as const

/** Below this, the message starts a new task: state resets and the prior-blind tier is used. */
export const SAME_TASK_THRESHOLD = 0.4

/** Minimal shape of OpenCode's session.messages() rows we read. */
type MessageRow = {
  info: { role: "user" | "assistant"; error?: unknown }
  parts: Array<
    | { type: "text"; text: string }
    | { type: "tool"; tool: string; state: { status: string; error?: string; output?: string } }
    | { type: string }
  >
}

/** Deterministic summary of the last assistant message: counts, last error, final text. Pure; unit-tested. */
export function summarizeLastTurn(rows: MessageRow[]): LastTurn | undefined {
  const last = rows.filter((r) => r.info.role === "assistant").at(-1)
  if (!last) return undefined
  const tools = last.parts.filter((p): p is Extract<MessageRow["parts"][number], { type: "tool" }> => p.type === "tool" && "state" in p)
  const errs = tools.filter((t) => t.state.status === "error")
  const texts = last.parts.filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
  return {
    tool_calls: tools.length,
    errors: errs.length,
    last_error: (errs.at(-1)?.state.error ?? "").slice(0, 300),
    final_text: (texts.at(-1)?.text ?? "").slice(0, 300),
  }
}

/** Reset-or-advance policy: a new task starts when Jev says the message doesn't continue the prior one. */
export function applyAnswers(prior: SessionState | undefined, message: string, a: JevAnswers): SessionState {
  const reset = !prior || a.same_task < SAME_TASK_THRESHOLD
  return {
    difficulty: a.difficulty,
    phase: a.phase,
    scope: a.scope,
    stuck: a.stuck,
    task_anchor: reset ? message.slice(0, 300) : prior.task_anchor,
    turns: reset ? 0 : prior.turns + 1,
  }
}

/** One Jev call: six questions over the same input. Returns null on any failure. */
export async function jevUpdate(
  input: JevInput,
  opts: { apiKey: string; url?: string; timeoutMs?: number; model?: string },
): Promise<Classification | null> {
  const t0 = performance.now()
  try {
    const res = await fetch(opts.url ?? JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ state: input, model: opts.model ?? "jev-latest", questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    })
    if (!res.ok) return null
    const { answers: a } = (await res.json()) as {
      answers: {
        same_task: { noul: number }
        difficulty: { score: number }
        phase: { choice: string }
        scope: { choice: string }
        stuck: { score: number }
        tier: { choice: Tier; confidence: number; probabilities: Record<string, number> }
        tier_fresh: { choice: Tier; confidence: number; probabilities: Record<string, number> }
      }
    }
    const t = input.prior && a.same_task.noul < SAME_TASK_THRESHOLD ? a.tier_fresh : a.tier
    if (!TIERS.includes(t.choice)) return null
    return {
      same_task: a.same_task.noul,
      difficulty: a.difficulty.score,
      phase: a.phase.choice,
      scope: a.scope.choice,
      stuck: a.stuck.score,
      tier: t.choice,
      confidence: t.confidence,
      probabilities: t.probabilities,
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
