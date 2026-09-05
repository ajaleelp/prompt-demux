import { tool, type Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import {
  AUTO_MODEL,
  globalConfigPath,
  PROVIDER_ID,
  PROVIDER_NAME,
  resolveConfigPath,
  loadConfig,
  parseModelRef,
  parseOverrides,
  heuristicTier,
  saveConfig,
  TIERS,
  type Classification,
  type RouterConfig,
  type Tier,
} from "./lib.ts"

const ENV_CLASSIFIER_URL = process.env.PROMPT_DEMUX_CLASSIFIER_URL
const ENV_CLASSIFIER_TIMEOUT = Number(process.env.PROMPT_DEMUX_CLASSIFIER_TIMEOUT_MS ?? "")
const CACHE_MAX = 500

const classificationCache = new Map<string, Classification>()

async function classify(
  query: string,
  url: string,
  timeoutMs: number,
): Promise<Classification | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Classification
    return TIERS.includes(data.tier) ? data : null
  } catch {
    return null
  }
}

async function classifyCached(
  query: string,
  url: string,
  timeoutMs: number,
): Promise<Classification | null> {
  const hit = classificationCache.get(query)
  if (hit) return { ...hit, cacheHit: true }
  const result = await classify(query, url, timeoutMs)
  if (result) {
    if (classificationCache.size >= CACHE_MAX) {
      const oldest = classificationCache.keys().next().value
      if (oldest !== undefined) classificationCache.delete(oldest)
    }
    classificationCache.set(query, result)
  }
  return result
}

export const PromptDemuxPlugin: Plugin = async ({ client, worktree, directory }) => {
  /** sessionID -> mode override (set via !mode: prefix), sticks for the session */
  const sessionModes = new Map<string, string>()

  async function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
    try {
      await client.app.log({ body: { service: "prompt-demux", level, message, extra } })
    } catch {
      /* logging must never break chat */
    }
  }

  return {
    // Inject the virtual Prompt Demux provider so it appears in the model dropdown.
    // Routing activates only when the session's selected model is prompt-demux/*.
    config: async (input) => {
      try {
        const cfg = loadConfig(resolveConfigPath(worktree, directory).file).config

        const models: Record<string, unknown> = {
          [AUTO_MODEL]: {
            name: `${PROVIDER_NAME} Auto (classify & dial)`,
            tool_call: true,
            limit: { context: 1_000_000, output: 32_000 },
            cost: { input: 0, output: 0 },
          },
        }
        for (const modeName of Object.keys(cfg.modes)) {
          models[modeName] = {
            name: `${PROVIDER_NAME} ${modeName} (fixed mode)`,
            tool_call: true,
            limit: { context: 1_000_000, output: 32_000 },
            cost: { input: 0, output: 0 },
          }
        }

        input.provider = input.provider ?? {}
        input.provider[PROVIDER_ID] = {
          name: PROVIDER_NAME,
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9" },
          models: models as never,
        }

        // Background tasks (titles, compaction) must never target the virtual provider.
        // Strip any @variant suffix - small_model is a plain provider/model ref.
        if (input.small_model === undefined) {
          const sm = parseModelRef(cfg.modes[cfg.activeMode][TIERS[0]])
          input.small_model = `${sm.providerID}/${sm.modelID}`
        }
      } catch (e) {
        await log("warn", `provider injection failed: ${String(e)}`)
      }
    },

    "chat.message": async (input, output) => {
      // Routing is opt-in per session: only prompt-demux/* selections are routed.
      if (!input.model || input.model.providerID !== PROVIDER_ID) return

      const { file } = resolveConfigPath(worktree, directory)
      const { config, error } = loadConfig(file)
      if (error) await log("warn", `config fallback: ${error}`, { file })

      const text = output.parts
        .filter((p): p is Extract<(typeof p), { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim()
      if (!text) return

      const overrides = parseOverrides(text)

      // Strip override tokens from what the model ultimately sees
      if (overrides.consumed > 0 && overrides.rest) {
        const firstText = output.parts.find(
          (p): p is Extract<(typeof p), { type: "text" }> => p.type === "text",
        )
        if (firstText) firstText.text = overrides.rest
      }

      // Mode selection precedence: !mode: prefix > forced model (prompt-demux/<mode>)
      // > session sticky override > "auto" uses activeMode.
      let modeName: string
      if (overrides.mode) {
        modeName = overrides.mode
      } else if (input.model.modelID !== AUTO_MODEL) {
        modeName = input.model.modelID
      } else {
        modeName = sessionModes.get(input.sessionID) ?? config.activeMode
      }
      if (!config.modes[modeName]) {
        await log("warn", `mode '${modeName}' not found, using '${config.activeMode}'`)
        modeName = config.activeMode
      }
      const mode = config.modes[modeName]
      if (overrides.mode) sessionModes.set(input.sessionID, modeName)

      const clsUrl =
        ENV_CLASSIFIER_URL ??
        config.classifier?.url ??
        "http://127.0.0.1:8010/classify"
      const clsTimeout =
        Number.isFinite(ENV_CLASSIFIER_TIMEOUT) && ENV_CLASSIFIER_TIMEOUT > 0
          ? ENV_CLASSIFIER_TIMEOUT
          : config.classifier?.timeoutMs ?? 2000

      let tier: Tier
      let confidence = 1
      let source: "override" | "heuristic" | "classifier" | "fallback"
      let latencyMs = 0
      let cacheHit = false

      const heuristic = overrides.tier ? null : heuristicTier(overrides.rest || text)
      if (overrides.tier) {
        tier = overrides.tier
        source = "override"
      } else if (heuristic) {
        tier = heuristic
        source = "heuristic"
        confidence = 1
      } else {
        const result = await classifyCached(overrides.rest || text, clsUrl, clsTimeout)
        if (result) {
          tier = result.tier
          confidence = result.confidence
          latencyMs = result.latency_ms
          cacheHit = result.cacheHit ?? false
          source = "classifier"
        } else {
          tier = "MEDIUM"
          source = "fallback"
          await log("warn", "classifier unavailable, falling back to MEDIUM")
        }
      }

      const routed = parseModelRef(mode[tier])
      output.message.model = routed

      const targetLabel = routed.variant
        ? `${routed.modelID}@${routed.variant}`
        : routed.modelID
      const icon = tier === "HARD" ? "🔺" : tier === "MEDIUM" ? "🔸" : "🔹"
      const summary = `Prompt Demux: ${tier} → ${targetLabel} (${source}${cacheHit ? ", cached" : ""}${latencyMs ? `, ${Math.round(latencyMs)}ms` : ""})`

      if (config.toast ?? true) {
        try {
          await client.tui.showToast({
            body: {
              title: icon + " " + tier,
              message: `→ ${targetLabel} · ${source}${latencyMs ? ` · ${Math.round(latencyMs)}ms` : ""}`,
              variant: tier === "HARD" ? "warning" : tier === "MEDIUM" ? "info" : "success",
              duration: 2500,
            },
            query: { directory },
          })
        } catch {
          /* toast is best-effort (CLI headless runs have no TUI) */
        }
      }

      await log("info", `dialed ${tier} -> ${routed.providerID}/${targetLabel}`, {
        sessionID: input.sessionID,
        mode: modeName,
        tier,
        variant: routed.variant,
        source,
        confidence,
        classifierLatencyMs: latencyMs,
        cacheHit,
        query: (overrides.rest || text).slice(0, 120),
      })
    },

    tool: {
      router: tool({
        description:
          "Manage prompt-demux dialing modes for this project. Modes map complexity tiers (EASY/MEDIUM/HARD) to model+effort targets. " +
          "Use action 'list' to show available modes and the active one, 'set' to make a mode the default for new sessions, " +
          "and 'add' to create a new mode. Model refs use the form provider/model[@variant], e.g. 'opencode/gemini-3.8-flash@high'.",
        args: {
          action: tool.schema.enum(["list", "set", "add"]).describe("What to do"),
          mode: tool.schema.string().optional().describe("Mode name (for 'set' and 'add')"),
          description: tool.schema.string().optional().describe("Human-readable description (for 'add')"),
          easy: tool.schema.string().optional().describe("Model ref for EASY queries (for 'add')"),
          medium: tool.schema.string().optional().describe("Model ref for MEDIUM queries (for 'add')"),
          hard: tool.schema.string().optional().describe("Model ref for HARD queries (for 'add')"),
          overwrite: tool.schema.boolean().optional().describe("Allow replacing an existing mode in 'add'"),
        },
        async execute(args, context) {
          const { file, scope } = resolveConfigPath(worktree, directory)
          const { config, error } = loadConfig(file)
          if (error) return `Warning: config fallback in use (${error}).`

          if (args.action === "list") {
            const lines = [`config: ${file} (${scope})`, `activeMode: ${config.activeMode}`, ""]
            for (const [name, m] of Object.entries(config.modes)) {
              lines.push(
                `${name === config.activeMode ? "* " : "  "}${name}${m.description ? ` - ${m.description}` : ""}`,
              )
              lines.push(`    EASY:   ${m.EASY}`)
              lines.push(`    MEDIUM: ${m.MEDIUM}`)
              lines.push(`    HARD:   ${m.HARD}`)
            }
            const session = sessionModes.get(context.sessionID)
            if (session) lines.push("", `session override: ${session}`)
            return lines.join("\n")
          }

          if (args.action === "set") {
            if (!args.mode) return "Error: 'mode' is required for action 'set'."
            if (!config.modes[args.mode])
              return `Error: mode '${args.mode}' does not exist. Available: ${Object.keys(config.modes).join(", ")}`
            config.activeMode = args.mode
            saveConfig(file, config)
            return `Active mode set to '${args.mode}' (persisted to ${file}). New sessions picking '${PROVIDER_ID}/${AUTO_MODEL}' will use it.`
          }

          // add
          if (!args.mode) return "Error: 'mode' is required for action 'add'."
          const missing = (["easy", "medium", "hard"] as const).filter((k) => !args[k])
          if (missing.length)
            return `Error: missing model refs for: ${missing.join(", ")}. Provide easy/medium/hard as 'provider/model' refs.`
          if (config.modes[args.mode] && !args.overwrite)
            return `Error: mode '${args.mode}' already exists. Pass overwrite=true to replace it.`

          config.modes[args.mode] = {
            description: args.description,
            EASY: args.easy!,
            MEDIUM: args.medium!,
            HARD: args.hard!,
          }
          if (Object.keys(config.modes).length === 1) config.activeMode = args.mode
          saveConfig(file, config)
          return `Mode '${args.mode}' added${config.activeMode === args.mode ? " (and activated)" : ""}. Restart OpenCode to see it in the model dropdown.`
        },
      }),
    },
  }
}
