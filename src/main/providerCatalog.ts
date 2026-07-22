/**
 * Catalog of LLM providers supported by BYOK (bring-your-own-key) key management.
 * Each entry maps a provider ID to its canonical environment variable, documentation,
 * and optional test endpoint configuration.
 *
 * The catalog is static, owned by Stream 3C, and imported by keys.ts (Stream 3A).
 */

export type ProviderCatalogEntry = {
  providerID: string
  envVar: string
  label: string
  docsUrl: string
  test?: { url: string; authHeader: string; authScheme?: string }
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    providerID: 'google',
    envVar: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    test: { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=', authHeader: 'X-Goog-Api-Key' }
  },
  {
    providerID: 'groq',
    envVar: 'GROQ_API_KEY',
    label: 'Groq',
    docsUrl: 'https://console.groq.com/docs/quickstart',
    test: { url: 'https://api.groq.com/openai/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'cerebras',
    envVar: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    docsUrl: 'https://inference-docs.cerebras.ai/',
    test: { url: 'https://api.cerebras.ai/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    label: 'Mistral',
    docsUrl: 'https://docs.mistral.ai/',
    test: { url: 'https://api.mistral.ai/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'cohere',
    envVar: 'COHERE_API_KEY',
    label: 'Cohere',
    docsUrl: 'https://docs.cohere.com/',
    test: { url: 'https://api.cohere.com/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    test: { url: 'https://openrouter.ai/api/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'huggingface',
    envVar: 'HUGGINGFACE_API_KEY',
    label: 'Hugging Face',
    docsUrl: 'https://huggingface.co/docs/inference-providers',
    test: { url: 'https://huggingface.co/api/whoami-v2', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'together',
    envVar: 'TOGETHER_API_KEY',
    label: 'Together AI',
    docsUrl: 'https://docs.together.ai/',
    test: { url: 'https://api.together.xyz/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'fireworks',
    envVar: 'FIREWORKS_API_KEY',
    label: 'Fireworks',
    docsUrl: 'https://docs.fireworks.ai/',
    test: { url: 'https://api.fireworks.ai/inference/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'nvidia',
    envVar: 'NVIDIA_NIM_API_KEY',
    label: 'NVIDIA NIM',
    docsUrl: 'https://docs.nvidia.com/nim/',
    test: { url: 'https://integrate.api.nvidia.com/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    docsUrl: 'https://api-docs.deepseek.com/',
    test: { url: 'https://api.deepseek.com/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'xai',
    envVar: 'XAI_API_KEY',
    label: 'xAI',
    docsUrl: 'https://docs.x.ai/',
    test: { url: 'https://api.x.ai/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'openai',
    envVar: 'OPENAI_API_KEY',
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/docs/overview',
    test: { url: 'https://api.openai.com/v1/models', authHeader: 'Authorization', authScheme: 'Bearer' }
  },
  {
    providerID: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    docsUrl: 'https://docs.claude.com/'
    // Omit test: Anthropic requires both x-api-key and anthropic-version headers; our test config supports only one.
  }
]

/**
 * Look up a provider catalog entry by providerID (case-sensitive, exact match).
 * Returns undefined if not found.
 */
export function catalogByProvider(providerID: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.providerID === providerID)
}

/**
 * Look up a provider catalog entry by envVar (case-sensitive, exact match).
 * Returns undefined if not found.
 */
export function catalogByEnvVar(envVar: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.envVar === envVar)
}
