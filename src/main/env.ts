/**
 * Loads LLM-provider API keys from a `.env` file on disk and hands back a filtered,
 * alias-expanded map safe to merge into the `opencode serve` child process's environment.
 *
 * The `.env` file this app reads may also contain live crypto-exchange trading credentials
 * and unrelated data-provider keys — those must NEVER reach the child process. A strict
 * allowlist keeps only known LLM-provider variables; everything else is dropped silently.
 *
 * No third-party dotenv dependency: the parser below is intentionally tiny.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_CATALOG } from './providerCatalog'

export type ProviderEnv = {
  vars: Record<string, string>
  sourcePath: string | null
  count: number
}

/* ------------------------------------------------------------------ */
/* allowlist / aliases                                                 */
/* ------------------------------------------------------------------ */

/** Only these keys may pass through from the `.env` file into the child process. */
export const ALLOWLIST: ReadonlySet<string> = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'COHERE_API_KEY',
  'GITHUB_MODELS_TOKEN',
  'GITHUB_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'NVIDIA_NIM_API_KEY',
  'NVIDIA_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'SCALEWAY_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'SAMBANOVA_API_KEY',
  'HYPERBOLIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY'
])

/**
 * Keys that must NEVER reach the child process even if the user has them set
 * as OS-level environment variables. The allowlist above only guards the `.env`
 * file-read path; this blocklist guards the `process.env` passthrough path.
 */
const BLOCKLIST: ReadonlySet<string> = new Set([
  'KUCOIN_API_KEY', 'KUCOIN_API_SECRET', 'KUCOIN_API_PASSPHRASE',
  'BINANCE_API_KEY', 'BINANCE_API_SECRET',
  'BYBIT_API_KEY', 'BYBIT_API_SECRET',
  'COINBASE_API_KEY', 'COINBASE_API_SECRET',
  'KRAKEN_API_KEY', 'KRAKEN_API_SECRET',
  'OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE',
  'ETHERSCAN_API_KEY', 'ALCHEMY_API_KEY',
  'COINGECKO_API_KEY', 'COINMARKETCAP_API_KEY',
  'COINCAP_API_KEY', 'COINPAPRIKA_API_KEY',
  'CRYPTOCOMPARE_API_KEY', 'MESSARI_API_KEY',
  'COINAPI_KEY', 'COINGLASS_API_KEY',
  'TAVILY_API_KEY',
])

/**
 * opencode's providers read different variable names than the user's `.env` uses in some
 * cases. After allowlist filtering, each source key here also sets its alias target(s),
 * but only when the target was not already set by the file itself. Verified empirically:
 * without the GOOGLE_GENERATIVE_AI_API_KEY alias, opencode reports
 * "Google Generative AI API key is missing".
 */
export const ALIASES: Readonly<Record<string, readonly string[]>> = {
  GEMINI_API_KEY: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  HUGGINGFACE_API_KEY: ['HF_TOKEN'],
  GITHUB_MODELS_TOKEN: ['GITHUB_TOKEN'],
  NVIDIA_NIM_API_KEY: ['NVIDIA_API_KEY']
}

/**
 * Provider IDs whose API-key provenance is known to this app.  This intentionally
 * uses the effective child environment rather than OpenCode's provider list:
 * a discovered provider is not proof that it has a usable key.  Alias targets
 * are checked in both directions so GOOGLE_API_KEY and GEMINI_API_KEY both
 * authorize the Google provider.
 */
export function linkedProviderIDs(env: Record<string, string | undefined>): string[] {
  const linked = new Set<string>()
  for (const entry of PROVIDER_CATALOG) {
    const names = new Set<string>([entry.envVar, ...(ALIASES[entry.envVar] ?? [])])
    for (const [source, targets] of Object.entries(ALIASES)) {
      if (targets.includes(entry.envVar)) names.add(source)
    }
    if ([...names].some((name) => Boolean(env[name]?.trim()))) linked.add(entry.providerID)
  }
  return [...linked].sort()
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/** Strip one matching pair of surrounding single or double quotes from a value. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Tiny `.env` parser: KEY=VALUE lines, `#` comments, optional `export ` prefix, quoted values. */
function parseEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq < 0) continue

    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice('export '.length).trim()
    const value = stripQuotes(line.slice(eq + 1).trim())

    if (!key || !value) continue
    result[key] = value
  }

  return result
}

/* ------------------------------------------------------------------ */
/* file discovery                                                      */
/* ------------------------------------------------------------------ */

/** First-hit-wins search order for the `.env` file to read. */
function candidatePaths(): string[] {
  const explicit = process.env.OPENCODE_DESKTOP_ENV_FILE
  if (explicit) return [explicit]

  return [
    join(process.cwd(), '.env'),
    join(homedir(), 'Desktop', '.env'),
    join(homedir(), '.env')
  ]
}

function findEnvFile(): string | null {
  for (const candidate of candidatePaths()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* unreadable path entry — skip */
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Locate, parse, allowlist-filter, and alias-expand LLM-provider variables from a `.env`
 * file. A missing or unreadable file is not an error — it yields an empty result.
 */
export function loadProviderEnv(): ProviderEnv {
  try {
    const sourcePath = findEnvFile()
    if (!sourcePath) return { vars: {}, sourcePath: null, count: 0 }

    const contents = readFileSync(sourcePath, 'utf8')
    const parsed = parseEnv(contents)

    const vars: Record<string, string> = {}
    for (const key of ALLOWLIST) {
      const value = parsed[key]
      if (value) vars[key] = value
    }


    for (const [source, targets] of Object.entries(ALIASES)) {
      const value = vars[source]
      if (!value) continue
      for (const target of targets) {
        if (!vars[target]) vars[target] = value
      }
    }

    return { vars, sourcePath, count: Object.keys(vars).length }
  } catch {
    return { vars: {}, sourcePath: null, count: 0 }
  }
}

/** Key names only, comma-separated — never a value. Safe to log. */
export function redactedSummary(vars: Record<string, string>): string {
  return Object.keys(vars).join(', ')
}

/**
 * Build the environment for the `opencode serve` child process.
 *
 * This is deliberately an allow-list, not a deny-list: the OpenCode process
 * only needs normal OS/process variables plus provider credentials explicitly
 * linked in this application.  Forwarding the full desktop environment would
 * make unrelated secrets available to prompts, tools, and extensions.
 */
export function buildChildEnv(providerVars: Record<string, string>): Record<string, string> {
  const runtimeKeys = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
    'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROGRAMDATA',
    'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
  ])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!runtimeKeys.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...providerVars }
}
