import {
  defaultPromptOverrides as sharedDefaultPromptOverrides,
  type PromptOverrides as SharedPromptOverrides,
} from "@gptdataexport/shared";

export type Provider = "ollama" | "openai" | "openrouter" | "anthropic";
export type ContextProfile = "auto" | "64k" | "128k" | "200k" | "256k" | "1m";

export interface ExtractionModelChoice {
  label: string;
  value: string;
}

export interface FidelityTier {
  key: string;
  label: string;
  models: string[];
}

export type PromptOverrides = SharedPromptOverrides;

export const providerChoices: Provider[] = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
];

export function defaultBaseUrl(provider: Provider): string {
  if (provider === "openrouter") {
    return "https://openrouter.ai/api/v1";
  }
  if (provider === "openai") {
    return "https://api.openai.com/v1";
  }
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "http://127.0.0.1:11434";
}

export const defaultFidelityPrompts = [
  "How would you respond when {{user}} says they feel overwhelmed and need grounding right now?",
  "Write a playful but affectionate response when {{user}} teases you about being stubborn.",
  "How do you handle disagreement with {{user}} while preserving emotional safety and connection?",
  "Give a concise planning-style reply when {{user}} asks for help breaking a hard task into steps.",
].join("\n");

export const defaultExtractionModel = "moonshotai/kimi-k2.5";
export const defaultJudgeModel = "anthropic/claude-sonnet-4.5";

export const extractionModelChoices: ExtractionModelChoice[] = [
  { label: "Kimi K2.5 (cheapest)", value: "moonshotai/kimi-k2.5" },
  { label: "DeepSeek V3.2", value: "deepseek/deepseek-v3.2" },
  { label: "Qwen3 235B", value: "qwen/qwen3-235b-a22b" },
  { label: "MiniMax M2.5", value: "minimax/minimax-m2.5" },
  { label: "GLM-5", value: "z-ai/glm-5" },
  { label: "Mistral Large 2512", value: "mistralai/mistral-large-2512" },
  { label: "GPT-5 Mini", value: "openai/gpt-5-mini" },
  { label: "Gemini 3 Flash", value: "google/gemini-3-flash-preview" },
  { label: "Grok 4.1 Fast", value: "x-ai/grok-4.1-fast" },
  { label: "Hermes 4 405B", value: "nousresearch/hermes-4-405b" },
  { label: "Gemini 3 Pro", value: "google/gemini-3-pro-preview" },
  { label: "GPT-5.2", value: "openai/gpt-5.2-chat" },
  { label: "Claude Sonnet 4.5", value: "anthropic/claude-sonnet-4.5" },
  { label: "Grok 4", value: "x-ai/grok-4" },
];

export const fidelityTiers: FidelityTier[] = [
  {
    key: "tier1_cn_open",
    label: "Budget - CN Open Weight",
    models: [
      "deepseek/deepseek-v3.2",
      "moonshotai/kimi-k2.5",
      "minimax/minimax-m2.5",
      "qwen/qwen3-235b-a22b",
      "z-ai/glm-5",
    ],
  },
  {
    key: "tier1_us_eu_open",
    label: "Budget - US/EU Open Weight",
    models: [
      "prime-intellect/intellect-3",
      "mistralai/mistral-large-2512",
      "nousresearch/hermes-4-405b",
    ],
  },
  {
    key: "tier1_closed",
    label: "Budget - Closed",
    models: [
      "x-ai/grok-4.1-fast",
      "openai/gpt-5-mini",
      "google/gemini-3-flash-preview",
    ],
  },
  {
    key: "tier2_premium",
    label: "Premium - Closed",
    models: [
      "google/gemini-3-pro-preview",
      "openai/gpt-5.2-chat",
      "anthropic/claude-sonnet-4.5",
      "x-ai/grok-4",
    ],
  },
];

export const contextProfileChoices: Array<{ label: string; value: ContextProfile }> = [
  { label: "Auto (from model metadata)", value: "auto" },
  { label: "64k Balanced", value: "64k" },
  { label: "128k Balanced", value: "128k" },
  { label: "200k Deep", value: "200k" },
  { label: "256k Extended", value: "256k" },
  { label: "1M Extended", value: "1m" },
];

export const contextProfileWindows: Record<Exclude<ContextProfile, "auto">, number> = {
  "64k": 64_000,
  "128k": 128_000,
  "200k": 200_000,
  "256k": 256_000,
  "1m": 1_000_000,
};

export const contextBudgetPresets: Record<
  Exclude<ContextProfile, "auto">,
  {
    maxMessagesPerConversation: number;
    maxCharsPerConversation: number;
    maxTotalChars: number;
    requestTimeout: number;
  }
> = {
  "64k": {
    maxMessagesPerConversation: 50,
    maxCharsPerConversation: 9_000,
    maxTotalChars: 64_000,
    requestTimeout: 180,
  },
  "128k": {
    maxMessagesPerConversation: 70,
    maxCharsPerConversation: 14_000,
    maxTotalChars: 128_000,
    requestTimeout: 240,
  },
  "200k": {
    maxMessagesPerConversation: 90,
    maxCharsPerConversation: 18_000,
    maxTotalChars: 200_000,
    requestTimeout: 300,
  },
  "256k": {
    maxMessagesPerConversation: 100,
    maxCharsPerConversation: 32_000,
    maxTotalChars: 256_000,
    requestTimeout: 360,
  },
  "1m": {
    maxMessagesPerConversation: 120,
    maxCharsPerConversation: 26_000,
    maxTotalChars: 420_000,
    requestTimeout: 480,
  },
};

export function fidelityTierChoices(): Array<{ label: string; value: string }> {
  return [...fidelityTiers.map((tier) => ({ label: tier.label, value: tier.key })), {
    label: "Custom",
    value: "custom",
  }];
}

export function fidelityModelsForTier(key: string): string[] {
  const tier = fidelityTiers.find((row) => row.key === key);
  return tier ? [...tier.models] : [];
}

export function allKnownModels(): string[] {
  const set = new Set<string>();
  for (const row of extractionModelChoices) {
    set.add(row.value);
  }
  for (const tier of fidelityTiers) {
    for (const model of tier.models) {
      set.add(model);
    }
  }
  set.add(defaultJudgeModel);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export const defaultPromptOverrides: PromptOverrides = sharedDefaultPromptOverrides;
