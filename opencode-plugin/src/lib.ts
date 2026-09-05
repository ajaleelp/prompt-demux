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
  raw_scores: Record<string, number>
  latency_ms: number
  cacheHit?: boolean
}

export const TIERS: Tier[] = ["EASY", "MEDIUM", "HARD"]

export const DEFAULT_CONFIG: RouterConfig = {
  activeMode: "balanced",
  modes: {
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
    effort: {
      description:
        "One model, effort dialed per tier (@low/@high/@max) - keeps the prompt cache warm",
      EASY: "opencode/gemini-3.8-flash@low",
      MEDIUM: "opencode/gemini-3.8-flash@high",
      HARD: "opencode/gemini-3.8-flash@max",
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
