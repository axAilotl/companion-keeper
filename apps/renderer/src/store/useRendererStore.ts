import { create } from "zustand";
import type { CardDraft, JobEvent, MemoryEntry, ModelStat } from "@gptdataexport/shared";
import { createRendererClient, type ClientMode } from "@/ipc/client";
import {
  contextBudgetPresets,
  contextProfileWindows,
  defaultExtractionModel,
  defaultBaseUrl,
  defaultFidelityPrompts,
  defaultJudgeModel,
  defaultPromptOverrides,
  fidelityModelsForTier,
  type PromptOverrides,
  type ContextProfile,
  type Provider,
} from "@/store/runtimeDefaults";

type AsyncPhase = "idle" | "loading" | "success" | "error";

type AsyncStepKey =
  | "importData"
  | "prepareCache"
  | "recover"
  | "append"
  | "load"
  | "save"
  | "export"
  | "fidelity"
  | "models";

export interface AsyncStepState {
  phase: AsyncPhase;
  progress: number;
  message: string;
  error: string | null;
}

interface AsyncSteps {
  importData: AsyncStepState;
  prepareCache: AsyncStepState;
  recover: AsyncStepState;
  append: AsyncStepState;
  load: AsyncStepState;
  save: AsyncStepState;
  export: AsyncStepState;
  fidelity: AsyncStepState;
  models: AsyncStepState;
}

export type AppTab =
  | "import_data"
  | "recover_persona"
  | "edit_persona"
  | "fidelity_test"
  | "settings";
export type EditSubTab = "persona_edit" | "lore_edit";

export interface FidelityRow {
  model: string;
  score: number;
  notes: string;
}

export interface ProviderPreset {
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
}

export interface RendererSettings {
  defaultModelSlug: string;
  recentOutputDirs: string[];
  recoverMaxConversations: number;
  forceRerun: boolean;
  contextProfile: ContextProfile;
  conversationSampling: "weighted-random" | "random-uniform" | "top";
  memoryPerChatMax: number;
  maxParallelCalls: number;
  maxMessagesPerConversation: number;
  maxCharsPerConversation: number;
  maxTotalChars: number;
  modelContextWindow: number;
  llmProvider: Provider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  temperature: number;
  requestTimeout: number;
  fidelityTier: string;
  fidelityModelsCsv: string;
  fidelityPromptsText: string;
  judgeModel: string;
  selectedPresetName: string;
  presets: ProviderPreset[];
  promptOverrides: PromptOverrides;
}

interface RendererState {
  mode: ClientMode;
  appTab: AppTab;
  editSubTab: EditSubTab;
  settings: RendererSettings;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  conversationCount: number;
  models: ModelStat[];
  selectedModel: string;
  outputDir: string;
  report: string;
  personaName: string;
  userName: string;
  hardcodeNames: boolean;
  personaImagePath: string;
  personaImagePreviewDataUrl: string;
  card: CardDraft;
  memories: MemoryEntry[];
  activeMemoryId: string | null;
  activeGenerateJobId: string | null;
  recoverEstimatedCalls: number;
  recoverCompletedCalls: number;
  fidelityResults: FidelityRow[];
  fidelitySummaryMarkdown: string;
  providerModels: string[];
  providerModelWindows: Record<string, number>;
  steps: AsyncSteps;
  pickImportFile: () => Promise<{ filePath: string; fileName: string } | null>;
  runImportStage: (filePath: string) => Promise<void>;
  prepareSelectedModelCache: () => Promise<void>;
  recoverPersona: () => Promise<void>;
  stopRecoverPersona: () => Promise<void>;
  appendMemories: () => Promise<void>;
  loadReview: () => Promise<void>;
  saveReview: () => Promise<void>;
  runExportPersona: () => Promise<void>;
  runFidelityTest: () => Promise<void>;
  fetchProviderModels: () => Promise<void>;
  hydrateSettings: () => Promise<void>;
  setAppTab: (value: AppTab) => void;
  setEditSubTab: (value: EditSubTab) => void;
  setPersonaName: (value: string) => void;
  setUserName: (value: string) => void;
  setHardcodeNames: (value: boolean) => void;
  pickPersonaImageFile: () => Promise<void>;
  setPersonaImagePath: (value: string) => void;
  setSelectedModel: (value: string) => void;
  setOutputDir: (value: string) => void;
  setSettingsField: <K extends keyof RendererSettings>(
    field: K,
    value: RendererSettings[K],
  ) => void;
  setPromptOverrideField: <K extends keyof PromptOverrides>(
    field: K,
    value: PromptOverrides[K],
  ) => void;
  applyPreset: (name: string) => void;
  saveCurrentPreset: (name: string) => void;
  deletePreset: (name: string) => void;
  setCardField: (field: keyof CardDraft, value: string) => void;
  setActiveMemory: (id: string | null) => void;
  updateMemoryTitle: (id: string, title: string) => void;
  updateMemoryKeys: (id: string, csvKeys: string) => void;
  updateMemoryContent: (id: string, content: string) => void;
  addMemory: () => void;
  removeMemory: (id: string) => void;
  resetStepError: (step: AsyncStepKey) => void;
  applyJobEvent: (event: JobEvent) => void;
}

const client = createRendererClient();
const SETTINGS_STORAGE_KEY = "gptdataexport.renderer.settings.v3";

const emptyCard = (): CardDraft => ({
  name: "",
  description: "",
  personality: "",
  scenario: "",
  firstMessage: "",
});

const defaultStepState = (): AsyncStepState => ({
  phase: "idle",
  progress: 0,
  message: "",
  error: null,
});

const defaultSteps = (): AsyncSteps => ({
  importData: defaultStepState(),
  prepareCache: defaultStepState(),
  recover: defaultStepState(),
  append: defaultStepState(),
  load: defaultStepState(),
  save: defaultStepState(),
  export: defaultStepState(),
  fidelity: defaultStepState(),
  models: defaultStepState(),
});

const defaultPresets: ProviderPreset[] = [
  {
    name: "openrouter-env",
    provider: "openrouter",
    baseUrl: defaultBaseUrl("openrouter"),
    apiKey: "",
  },
  {
    name: "ollama-local",
    provider: "ollama",
    baseUrl: defaultBaseUrl("ollama"),
    apiKey: "",
  },
];

const defaultSettings: RendererSettings = {
  defaultModelSlug: "gpt-4o",
  recentOutputDirs: [],
  recoverMaxConversations: 25,
  forceRerun: false,
  contextProfile: "auto",
  conversationSampling: "weighted-random",
  memoryPerChatMax: 6,
  maxParallelCalls: 4,
  maxMessagesPerConversation: 140,
  maxCharsPerConversation: 18000,
  maxTotalChars: 120000,
  modelContextWindow: 128000,
  llmProvider: "openrouter",
  llmBaseUrl: defaultBaseUrl("openrouter"),
  llmModel: defaultExtractionModel,
  llmApiKey: "",
  temperature: 0.2,
  requestTimeout: 300,
  fidelityTier: "tier1_cn_open",
  fidelityModelsCsv: fidelityModelsForTier("tier1_cn_open").join(","),
  fidelityPromptsText: defaultFidelityPrompts,
  judgeModel: defaultJudgeModel,
  selectedPresetName: "openrouter-env",
  presets: defaultPresets,
  promptOverrides: defaultPromptOverrides,
};

function clampPositiveInt(value: number, defaultValue: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.floor(value);
}

function sanitizeContextLimits(settings: RendererSettings): RendererSettings {
  const modelContextWindow = clampPositiveInt(
    settings.modelContextWindow,
    defaultSettings.modelContextWindow,
  );
  const maxTotalChars = Math.max(
    1,
    Math.min(
      clampPositiveInt(settings.maxTotalChars, defaultSettings.maxTotalChars),
      modelContextWindow,
    ),
  );
  const maxCharsPerConversation = Math.max(
    1,
    Math.min(
      clampPositiveInt(settings.maxCharsPerConversation, defaultSettings.maxCharsPerConversation),
      maxTotalChars,
    ),
  );

  if (
    modelContextWindow === settings.modelContextWindow &&
    maxTotalChars === settings.maxTotalChars &&
    maxCharsPerConversation === settings.maxCharsPerConversation
  ) {
    return settings;
  }

  return {
    ...settings,
    modelContextWindow,
    maxTotalChars,
    maxCharsPerConversation,
  };
}

function toProvider(value: unknown, defaultValue: Provider): Provider {
  const cleaned = typeof value === "string" ? value.trim() : "";
  if (cleaned === "ollama" || cleaned === "openai" || cleaned === "openrouter" || cleaned === "anthropic") {
    return cleaned;
  }
  return defaultValue;
}

function toContextProfile(value: unknown): ContextProfile {
  if (value === "64k" || value === "128k" || value === "200k" || value === "256k" || value === "1m") {
    return value;
  }
  return "auto";
}

function normalizePromptOverrides(input: unknown): PromptOverrides {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<PromptOverrides>;
  return {
    personaObservationSystem:
      typeof raw.personaObservationSystem === "string"
        ? raw.personaObservationSystem
        : defaultPromptOverrides.personaObservationSystem,
    personaObservationUser:
      typeof raw.personaObservationUser === "string"
        ? raw.personaObservationUser
        : defaultPromptOverrides.personaObservationUser,
    personaSynthesisSystem:
      typeof raw.personaSynthesisSystem === "string"
        ? raw.personaSynthesisSystem
        : defaultPromptOverrides.personaSynthesisSystem,
    personaSynthesisUser:
      typeof raw.personaSynthesisUser === "string"
        ? raw.personaSynthesisUser
        : defaultPromptOverrides.personaSynthesisUser,
    memorySystem:
      typeof raw.memorySystem === "string"
        ? raw.memorySystem
        : defaultPromptOverrides.memorySystem,
    memoryUser:
      typeof raw.memoryUser === "string"
        ? raw.memoryUser
        : defaultPromptOverrides.memoryUser,
    memorySynthesisSystem:
      typeof raw.memorySynthesisSystem === "string"
        ? raw.memorySynthesisSystem
        : defaultPromptOverrides.memorySynthesisSystem,
    memorySynthesisUser:
      typeof raw.memorySynthesisUser === "string"
        ? raw.memorySynthesisUser
        : defaultPromptOverrides.memorySynthesisUser,
  };
}

function normalizePresets(input: unknown): ProviderPreset[] {
  if (!Array.isArray(input)) {
    return defaultPresets;
  }

  const out: ProviderPreset[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const raw = row as Partial<ProviderPreset>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) {
      continue;
    }
    const provider = toProvider(raw.provider, "openrouter");
    out.push({
      name,
      provider,
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim().length > 0 ? raw.baseUrl.trim() : defaultBaseUrl(provider),
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    });
  }

  return out.length > 0 ? out : defaultPresets;
}

function normalizeRecentOutputDirs(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of input) {
    if (typeof row !== "string") {
      continue;
    }
    const cleaned = row.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 40) {
      break;
    }
  }
  return out;
}

function mergeRecentOutputDirs(existing: string[], incoming: string[]): string[] {
  return normalizeRecentOutputDirs([...incoming, ...existing]).slice(0, 40);
}

function withRememberedOutputDir(settings: RendererSettings, outputDir: string): RendererSettings {
  const cleaned = outputDir.trim();
  if (!cleaned) {
    return settings;
  }
  const nextRecent = mergeRecentOutputDirs(settings.recentOutputDirs, [cleaned]);
  if (
    nextRecent.length === settings.recentOutputDirs.length &&
    nextRecent.every((value, index) => settings.recentOutputDirs[index] === value)
  ) {
    return settings;
  }
  return {
    ...settings,
    recentOutputDirs: nextRecent,
  };
}

function readSettings(): RendererSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return defaultSettings;
    }

    const parsed = JSON.parse(raw) as Partial<RendererSettings> & {
      apiKey?: string;
      defaultModelSlug?: string;
      recoverMaxConversations?: number;
      fidelityModelsCsv?: string;
    };

    const presets = normalizePresets(parsed.presets);
    const provider = toProvider(parsed.llmProvider, "openrouter");

    // Backward-compatible support for v2 key names.
    const legacyApiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";

    const parsedSettings: RendererSettings = {
      defaultModelSlug:
        typeof parsed.defaultModelSlug === "string" && parsed.defaultModelSlug.trim().length > 0
          ? parsed.defaultModelSlug.trim()
          : defaultSettings.defaultModelSlug,
      recentOutputDirs: normalizeRecentOutputDirs(parsed.recentOutputDirs),
      recoverMaxConversations: clampPositiveInt(
        typeof parsed.recoverMaxConversations === "number"
          ? parsed.recoverMaxConversations
          : defaultSettings.recoverMaxConversations,
        defaultSettings.recoverMaxConversations,
      ),
      forceRerun: parsed.forceRerun === true,
      contextProfile: toContextProfile(parsed.contextProfile),
      conversationSampling:
        parsed.conversationSampling === "random-uniform" || parsed.conversationSampling === "top"
          ? parsed.conversationSampling
          : "weighted-random",
      memoryPerChatMax: clampPositiveInt(parsed.memoryPerChatMax ?? defaultSettings.memoryPerChatMax, defaultSettings.memoryPerChatMax),
      maxParallelCalls: clampPositiveInt(parsed.maxParallelCalls ?? defaultSettings.maxParallelCalls, defaultSettings.maxParallelCalls),
      maxMessagesPerConversation: clampPositiveInt(parsed.maxMessagesPerConversation ?? defaultSettings.maxMessagesPerConversation, defaultSettings.maxMessagesPerConversation),
      maxCharsPerConversation: clampPositiveInt(parsed.maxCharsPerConversation ?? defaultSettings.maxCharsPerConversation, defaultSettings.maxCharsPerConversation),
      maxTotalChars: clampPositiveInt(parsed.maxTotalChars ?? defaultSettings.maxTotalChars, defaultSettings.maxTotalChars),
      modelContextWindow: clampPositiveInt(parsed.modelContextWindow ?? defaultSettings.modelContextWindow, defaultSettings.modelContextWindow),
      llmProvider: provider,
      llmBaseUrl:
        typeof parsed.llmBaseUrl === "string" && parsed.llmBaseUrl.trim().length > 0
          ? parsed.llmBaseUrl.trim()
          : defaultBaseUrl(provider),
      llmModel:
        typeof parsed.llmModel === "string" && parsed.llmModel.trim().length > 0
          ? parsed.llmModel
          : defaultSettings.llmModel,
      llmApiKey:
        typeof parsed.llmApiKey === "string"
          ? parsed.llmApiKey
          : legacyApiKey,
      temperature:
        typeof parsed.temperature === "number" && Number.isFinite(parsed.temperature)
          ? Math.min(2, Math.max(0, parsed.temperature))
          : defaultSettings.temperature,
      requestTimeout: clampPositiveInt(parsed.requestTimeout ?? defaultSettings.requestTimeout, defaultSettings.requestTimeout),
      fidelityTier:
        typeof parsed.fidelityTier === "string" && parsed.fidelityTier.trim().length > 0
          ? parsed.fidelityTier.trim()
          : defaultSettings.fidelityTier,
      fidelityModelsCsv:
        typeof parsed.fidelityModelsCsv === "string"
          ? parsed.fidelityModelsCsv
          : defaultSettings.fidelityModelsCsv,
      fidelityPromptsText:
        typeof parsed.fidelityPromptsText === "string" && parsed.fidelityPromptsText.trim().length > 0
          ? parsed.fidelityPromptsText
          : defaultSettings.fidelityPromptsText,
      judgeModel:
        typeof parsed.judgeModel === "string" && parsed.judgeModel.trim().length > 0
          ? parsed.judgeModel
          : defaultSettings.judgeModel,
      selectedPresetName:
        typeof parsed.selectedPresetName === "string" && parsed.selectedPresetName.trim().length > 0
          ? parsed.selectedPresetName.trim()
          : presets[0]?.name ?? defaultSettings.selectedPresetName,
      presets,
      promptOverrides: normalizePromptOverrides(parsed.promptOverrides),
    };
    return sanitizeContextLimits(parsedSettings);
  } catch {
    return defaultSettings;
  }
}

function writeSettings(settings: RendererSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures.
  }
}

async function persistSettingsToDesktop(settings: RendererSettings): Promise<void> {
  try {
    const result = await client.saveRendererSettings({
      settingsJson: JSON.stringify(settings),
    });
    if (!result.ok) {
      console.error("Failed to persist renderer settings:", result.error);
    }
  } catch (error) {
    console.error("Failed to persist renderer settings:", error);
  }
}

function persistRememberedOutputDir(
  set: (partial: Partial<RendererState> | ((state: RendererState) => Partial<RendererState>)) => void,
  outputDir: string,
): void {
  const cleaned = outputDir.trim();
  if (!cleaned) {
    return;
  }
  set((state) => {
    const nextSettings = withRememberedOutputDir(state.settings, cleaned);
    if (nextSettings === state.settings) {
      return {};
    }
    writeSettings(nextSettings);
    void persistSettingsToDesktop(nextSettings);
    return {
      settings: nextSettings,
    };
  });
}

const setStep = (
  set: (partial: Partial<RendererState> | ((state: RendererState) => Partial<RendererState>)) => void,
  step: AsyncStepKey,
  patch: Partial<AsyncStepState>,
): void => {
  set((state) => ({
    steps: {
      ...state.steps,
      [step]: {
        ...state.steps[step],
        ...patch,
      },
    },
  }));
};

function pickInitialModel(models: ModelStat[], preferred: string): string {
  const trimmedPreferred = preferred.trim().toLowerCase();
  if (trimmedPreferred.length > 0) {
    const found = models.find((model) => model.model.toLowerCase() === trimmedPreferred);
    if (found) {
      return found.model;
    }
  }

  return models[0]?.model ?? "";
}

function parseCsvList(value: string, max = 16): string[] {
  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function parseLineList(value: string, max = 20): string[] {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function promptOverridesToRecord(value: PromptOverrides): Record<string, string> {
  return {
    personaObservationSystem: value.personaObservationSystem,
    personaObservationUser: value.personaObservationUser,
    personaSynthesisSystem: value.personaSynthesisSystem,
    personaSynthesisUser: value.personaSynthesisUser,
    memorySystem: value.memorySystem,
    memoryUser: value.memoryUser,
    memorySynthesisSystem: value.memorySynthesisSystem,
    memorySynthesisUser: value.memorySynthesisUser,
  };
}

function normalizeMultilineText(value: string): string {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\r\n/g, "\n");
  if (!normalized.includes("\n") && normalized.includes("\\n")) {
    return normalized.replace(/\\n/g, "\n");
  }
  return normalized;
}

function normalizeCardDraftContent(card: CardDraft): CardDraft {
  return {
    name: card.name,
    description: normalizeMultilineText(card.description),
    personality: normalizeMultilineText(card.personality),
    scenario: normalizeMultilineText(card.scenario),
    firstMessage: normalizeMultilineText(card.firstMessage),
  };
}

function normalizeMemoryEntries(memories: MemoryEntry[]): MemoryEntry[] {
  return memories.map((memory) => ({
    ...memory,
    name: typeof memory.name === "string" && memory.name.trim().length > 0
      ? memory.name.trim()
      : memory.id,
    content: normalizeMultilineText(memory.content),
  }));
}

function hardcodeTemplateNames(
  value: string,
  userName: string,
  companionName: string,
): string {
  return value
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, companionName);
}

function applyOutputNamePolicy(
  card: CardDraft,
  memories: MemoryEntry[],
  input: {
    hardcodeNames: boolean;
    userName: string;
    companionName: string;
  },
): { card: CardDraft; memories: MemoryEntry[] } {
  const normalizedCard = normalizeCardDraftContent(card);
  const normalizedMemories = normalizeMemoryEntries(memories);
  if (!input.hardcodeNames) {
    return {
      card: normalizedCard,
      memories: normalizedMemories,
    };
  }

  const userName = input.userName.trim() || "User";
  const companionName = input.companionName.trim() || normalizedCard.name.trim() || "Companion";

  return {
    card: {
      ...normalizedCard,
      name: companionName,
      description: hardcodeTemplateNames(normalizedCard.description, userName, companionName),
      personality: hardcodeTemplateNames(normalizedCard.personality, userName, companionName),
      scenario: hardcodeTemplateNames(normalizedCard.scenario, userName, companionName),
      firstMessage: hardcodeTemplateNames(normalizedCard.firstMessage, userName, companionName),
    },
    memories: normalizedMemories.map((memory) => ({
      ...memory,
      name: hardcodeTemplateNames(memory.name ?? memory.id, userName, companionName),
      keys: memory.keys.map((key) => hardcodeTemplateNames(key, userName, companionName)),
      content: hardcodeTemplateNames(memory.content, userName, companionName),
    })),
  };
}

const initialSettings = readSettings();

export const useRendererStore = create<RendererState>((set, get) => ({
  mode: client.getMode(),
  appTab: "import_data",
  editSubTab: "persona_edit",
  settings: initialSettings,
  filePath: "",
  fileName: "",
  fileSizeBytes: 0,
  conversationCount: 0,
  models: [],
  selectedModel: "",
  outputDir: initialSettings.recentOutputDirs[0] ?? "",
  report: "",
  personaName: "Companion",
  userName: "User",
  hardcodeNames: false,
  personaImagePath: "",
  personaImagePreviewDataUrl: "",
  card: emptyCard(),
  memories: [],
  activeMemoryId: null,
  activeGenerateJobId: null,
  recoverEstimatedCalls: 0,
  recoverCompletedCalls: 0,
  fidelityResults: [],
  fidelitySummaryMarkdown: "",
  providerModels: [],
  providerModelWindows: {},
  steps: defaultSteps(),

  pickImportFile: async () => {
    const result = await client.selectImportFile({});
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "importData", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return null;
    }

    const filePath = result.data.filePath?.trim() ?? "";
    if (result.data.cancelled || !filePath) {
      return null;
    }

    return {
      filePath,
      fileName:
        result.data.fileName?.trim() ||
        filePath.split(/[\\/]/).pop() ||
        filePath,
    };
  },

  runImportStage: async (filePath) => {
    const cleaned = filePath.trim();
    if (!cleaned) {
      setStep(set, "importData", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Choose a file first.",
      });
      return;
    }

    setStep(set, "importData", {
      phase: "loading",
      progress: 10,
      message: "Importing export file...",
      error: null,
    });

    const importResult = await client.importFile({ filePath: cleaned });
    set({ mode: client.getMode() });

    if (!importResult.ok) {
      setStep(set, "importData", {
        phase: "error",
        progress: 0,
        message: "",
        error: importResult.error,
      });
      return;
    }

    setStep(set, "importData", {
      progress: 36,
      message: "Discovering model slugs...",
    });

    const analyzeResult = await client.analyzeModels({
      filePath: importResult.data.filePath,
    });
    set({ mode: client.getMode() });

    if (!analyzeResult.ok) {
      setStep(set, "importData", {
        phase: "error",
        progress: 0,
        message: "",
        error: analyzeResult.error,
      });
      return;
    }

    const models = analyzeResult.data.models
      .slice()
      .sort((a, b) => b.conversations - a.conversations || a.model.localeCompare(b.model));
    const selectedModel = pickInitialModel(models, get().settings.defaultModelSlug);

    set({
      filePath: importResult.data.filePath,
      fileName: importResult.data.fileName,
      fileSizeBytes: importResult.data.fileSizeBytes ?? 0,
      conversationCount: analyzeResult.data.totalConversations,
      models,
      selectedModel,
      outputDir: "",
      report: "",
      personaImagePath: "",
      personaImagePreviewDataUrl: "",
      card: emptyCard(),
      memories: [],
      activeMemoryId: null,
      activeGenerateJobId: null,
      fidelityResults: [],
      fidelitySummaryMarkdown: "",
      recoverCompletedCalls: 0,
      recoverEstimatedCalls: 0,
    });

    setStep(set, "importData", {
      progress: 68,
      message: "Splitting selected model into conversation JSONL files...",
    });

    if (selectedModel) {
      const cacheResult = await client.prepareCache({
        filePath: importResult.data.filePath,
        model: selectedModel,
      });
      set({ mode: client.getMode() });

      if (!cacheResult.ok) {
        setStep(set, "importData", {
          phase: "error",
          progress: 0,
          message: "",
          error: cacheResult.error,
        });
        return;
      }

      set({
        report:
          `Cache ready for ${selectedModel}: ${cacheResult.data.totalExtractedFiles} files ` +
          `(${cacheResult.data.reusedExtraction ? "reused" : "new extraction"}).`,
      });
    }

    setStep(set, "importData", {
      phase: "success",
      progress: 100,
      message: "Import complete.",
      error: null,
    });
    setStep(set, "recover", defaultStepState());
    setStep(set, "append", defaultStepState());
    setStep(set, "load", defaultStepState());
    setStep(set, "save", defaultStepState());
    setStep(set, "export", defaultStepState());
    setStep(set, "fidelity", defaultStepState());
    set({ appTab: "recover_persona" });
  },

  prepareSelectedModelCache: async () => {
    const { filePath, selectedModel } = get();
    if (!filePath || !selectedModel) {
      setStep(set, "prepareCache", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Import data and select a model first.",
      });
      return;
    }

    setStep(set, "prepareCache", {
      phase: "loading",
      progress: 35,
      message: "Preparing extracted JSONL cache...",
      error: null,
    });

    const result = await client.prepareCache({ filePath, model: selectedModel });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "prepareCache", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    set({
      report:
        `Cache ready for ${result.data.model}: ${result.data.totalExtractedFiles} files ` +
        `(${result.data.reusedExtraction ? "reused" : "new extraction"}).`,
    });

    setStep(set, "prepareCache", {
      phase: "success",
      progress: 100,
      message: "Cache ready.",
      error: null,
    });
  },

  recoverPersona: async () => {
    const {
      filePath,
      selectedModel,
      settings,
      personaName,
      userName,
      hardcodeNames,
    } = get();

    if (!filePath) {
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Import data first.",
      });
      return;
    }

    if (!selectedModel) {
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Select a model first.",
      });
      return;
    }

    if (!settings.llmModel.trim()) {
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Set an LLM model in Settings first.",
      });
      return;
    }

    set({
      recoverEstimatedCalls: 0,
      recoverCompletedCalls: 0,
      activeGenerateJobId: null,
    });

    setStep(set, "recover", {
      phase: "loading",
      progress: 12,
      message: "Recovering persona and lorebook from extracted files...",
      error: null,
    });

    const result = await client.extractAndGenerate({
      filePath,
      model: selectedModel,
      companionName: personaName.trim() || "Companion",
      maxConversations: settings.recoverMaxConversations,
      conversationSampling: settings.conversationSampling,
      appendMemories: false,
      forceRerun: settings.forceRerun,
      llmProvider: settings.llmProvider,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey: settings.llmApiKey,
      temperature: settings.temperature,
      requestTimeout: settings.requestTimeout,
      maxMemories: Math.max(1, settings.recoverMaxConversations * 2),
      memoryPerChatMax: settings.memoryPerChatMax,
      maxParallelCalls: settings.maxParallelCalls,
      maxMessagesPerConversation: settings.maxMessagesPerConversation,
      maxCharsPerConversation: settings.maxCharsPerConversation,
      maxTotalChars: settings.maxTotalChars,
      modelContextWindow: settings.modelContextWindow,
      promptOverrides: promptOverridesToRecord(settings.promptOverrides),
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      if (/cancelled|stopped/i.test(result.error)) {
        setStep(set, "recover", {
          phase: "idle",
          progress: 0,
          message: "Recovery stopped.",
          error: null,
        });
        set({ activeGenerateJobId: null });
        return;
      }
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const nextCard = {
      ...result.data.card,
      name: personaName.trim().length > 0 ? personaName.trim() : result.data.card.name,
    };
    const output = applyOutputNamePolicy(nextCard, result.data.memories, {
      hardcodeNames,
      userName,
      companionName: nextCard.name || personaName.trim() || "Companion",
    });
    const resolvedOutputDir = result.data.outputDir ?? "";

    set({
      card: output.card,
      memories: output.memories,
      activeMemoryId: output.memories[0]?.id ?? null,
      outputDir: resolvedOutputDir,
      report: result.data.report ?? "",
      personaImagePath: result.data.personaImagePath ?? "",
      personaImagePreviewDataUrl: result.data.personaImageDataUrl ?? "",
      activeGenerateJobId: null,
      appTab: "recover_persona",
    });

    setStep(set, "recover", {
      phase: "success",
      progress: 100,
      message: "Persona recovered.",
      error: null,
    });
    setStep(set, "append", defaultStepState());
    setStep(set, "save", defaultStepState());
    setStep(set, "export", defaultStepState());
    persistRememberedOutputDir(set, resolvedOutputDir);
  },

  stopRecoverPersona: async () => {
    const state = get();
    if (state.steps.recover.phase !== "loading") {
      return;
    }

    const jobId = state.activeGenerateJobId?.trim();
    if (!jobId || !window.desktopApi?.cancelJob) {
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: "No active recover job is available to stop.",
      });
      return;
    }

    setStep(set, "recover", {
      phase: "loading",
      progress: state.steps.recover.progress,
      message: "Stopping recovery...",
      error: null,
    });

    try {
      const response = await window.desktopApi.cancelJob({ jobId });
      if (!response.cancelled) {
        setStep(set, "recover", {
          phase: "error",
          progress: 0,
          message: "",
          error: "Recover stop request was rejected.",
        });
      }
    } catch (error) {
      setStep(set, "recover", {
        phase: "error",
        progress: 0,
        message: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  appendMemories: async () => {
    const {
      filePath,
      selectedModel,
      settings,
      outputDir,
      userName,
      hardcodeNames,
      personaName,
    } = get();

    if (!filePath || !selectedModel || !outputDir) {
      setStep(set, "append", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Import data, recover persona, and ensure output directory exists first.",
      });
      return;
    }

    setStep(set, "append", {
      phase: "loading",
      progress: 25,
      message: "Appending memories from extracted JSONL files...",
      error: null,
    });
    set({ activeGenerateJobId: null });

    const result = await client.extractAndGenerate({
      filePath,
      model: selectedModel,
      companionName: get().card.name || get().personaName.trim() || "Companion",
      maxConversations: settings.recoverMaxConversations,
      conversationSampling: settings.conversationSampling,
      outputDir,
      appendMemories: true,
      forceRerun: settings.forceRerun,
      llmProvider: settings.llmProvider,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey: settings.llmApiKey,
      temperature: settings.temperature,
      requestTimeout: settings.requestTimeout,
      maxMemories: Math.max(1, settings.recoverMaxConversations * 2),
      memoryPerChatMax: settings.memoryPerChatMax,
      maxParallelCalls: settings.maxParallelCalls,
      maxMessagesPerConversation: settings.maxMessagesPerConversation,
      maxCharsPerConversation: settings.maxCharsPerConversation,
      maxTotalChars: settings.maxTotalChars,
      modelContextWindow: settings.modelContextWindow,
      promptOverrides: promptOverridesToRecord(settings.promptOverrides),
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      if (/cancelled|stopped/i.test(result.error)) {
        setStep(set, "append", {
          phase: "idle",
          progress: 0,
          message: "Append stopped.",
          error: null,
        });
        set({ activeGenerateJobId: null });
        return;
      }
      setStep(set, "append", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const output = applyOutputNamePolicy(result.data.card, result.data.memories, {
      hardcodeNames,
      userName,
      companionName:
        result.data.card.name || get().card.name || personaName.trim() || "Companion",
    });

    const resolvedOutputDir = result.data.outputDir ?? outputDir;

    set({
      card: output.card,
      memories: output.memories,
      activeMemoryId: output.memories[0]?.id ?? null,
      outputDir: resolvedOutputDir,
      report: result.data.report ?? "",
      personaImagePath: result.data.personaImagePath ?? get().personaImagePath,
      personaImagePreviewDataUrl:
        result.data.personaImageDataUrl ?? get().personaImagePreviewDataUrl,
    });

    setStep(set, "append", {
      phase: "success",
      progress: 100,
      message: "Memories appended.",
      error: null,
    });
    persistRememberedOutputDir(set, resolvedOutputDir);
  },

  loadReview: async () => {
    const state = get();
    const outputDir = state.outputDir.trim();

    if (!outputDir) {
      setStep(set, "load", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Set an output directory first.",
      });
      return;
    }

    setStep(set, "load", {
      phase: "loading",
      progress: 35,
      message: "Loading existing card + lorebook...",
      error: null,
    });

    const result = await client.loadReview({ outputDir });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "load", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const output = applyOutputNamePolicy(result.data.card, result.data.memories, {
      hardcodeNames: state.hardcodeNames,
      userName: state.userName,
      companionName:
        result.data.card.name || state.card.name || state.personaName.trim() || "Companion",
    });

    const resolvedOutputDir = result.data.outputDir ?? outputDir;

    set({
      card: output.card,
      memories: output.memories,
      activeMemoryId: output.memories[0]?.id ?? null,
      outputDir: resolvedOutputDir,
      report: result.data.report ?? "",
      personaImagePath: result.data.personaImagePath ?? "",
      personaImagePreviewDataUrl: result.data.personaImageDataUrl ?? "",
    });

    setStep(set, "load", {
      phase: "success",
      progress: 100,
      message: "Existing output loaded.",
      error: null,
    });
    setStep(set, "append", defaultStepState());
    setStep(set, "export", defaultStepState());
    persistRememberedOutputDir(set, resolvedOutputDir);
  },

  saveReview: async () => {
    const {
      card,
      memories,
      outputDir,
      personaImagePath,
      personaImagePreviewDataUrl,
      userName,
      hardcodeNames,
      personaName,
    } = get();
    const output = applyOutputNamePolicy(card, memories, {
      hardcodeNames,
      userName,
      companionName: card.name || personaName.trim() || "Companion",
    });

    setStep(set, "save", {
      phase: "loading",
      progress: 25,
      message: "Saving edits...",
      error: null,
    });

    const result = await client.saveReview({
      card: output.card,
      memories: output.memories,
      outputDir: outputDir.trim().length > 0 ? outputDir : undefined,
      personaImagePath,
      creatorName: userName.trim() || "User",
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "save", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const resolvedOutputDir = result.data.outputDir;

    set({
      card: output.card,
      memories: output.memories,
      outputDir: resolvedOutputDir,
      personaImagePath: result.data.personaImagePath ?? personaImagePath,
      personaImagePreviewDataUrl:
        result.data.personaImageDataUrl ?? personaImagePreviewDataUrl,
      report: `Saved card and lorebook to ${resolvedOutputDir}.`,
    });

    setStep(set, "save", {
      phase: "success",
      progress: 100,
      message: "Saved.",
      error: null,
    });
    persistRememberedOutputDir(set, resolvedOutputDir);
  },

  runExportPersona: async () => {
    const {
      card,
      memories,
      personaImagePath,
      personaImagePreviewDataUrl,
      outputDir,
      userName,
      hardcodeNames,
      personaName,
    } = get();
    const output = applyOutputNamePolicy(card, memories, {
      hardcodeNames,
      userName,
      companionName: card.name || personaName.trim() || "Companion",
    });

    setStep(set, "export", {
      phase: "loading",
      progress: 10,
      message: "Choose destination folder...",
      error: null,
    });

    const destinationResult = await client.selectExportDirectory({
      defaultPath: outputDir.trim() || undefined,
    });
    set({ mode: client.getMode() });

    if (!destinationResult.ok) {
      setStep(set, "export", {
        phase: "error",
        progress: 0,
        message: "",
        error: destinationResult.error,
      });
      return;
    }

    if (destinationResult.data.cancelled || !destinationResult.data.directoryPath?.trim()) {
      setStep(set, "export", {
        phase: "idle",
        progress: 0,
        message: "Export cancelled.",
        error: null,
      });
      return;
    }

    const selectedOutputDir = destinationResult.data.directoryPath.trim();

    setStep(set, "export", {
      phase: "loading",
      progress: 28,
      message: "Exporting persona package...",
      error: null,
    });

    const result = await client.saveReview({
      card: output.card,
      memories: output.memories,
      outputDir: selectedOutputDir,
      personaImagePath,
      creatorName: userName.trim() || "User",
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "export", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const resolvedOutputDir = result.data.outputDir || selectedOutputDir;

    set({
      card: output.card,
      memories: output.memories,
      outputDir: resolvedOutputDir,
      personaImagePath: result.data.personaImagePath ?? personaImagePath,
      personaImagePreviewDataUrl:
        result.data.personaImageDataUrl ?? personaImagePreviewDataUrl,
      report:
        `Exported persona card: ${result.data.cardPath ?? resolvedOutputDir}. ` +
        "Embedded PNG is SillyTavern-compatible.",
    });

    setStep(set, "export", {
      phase: "success",
      progress: 100,
      message: "Persona export complete.",
      error: null,
    });
    persistRememberedOutputDir(set, resolvedOutputDir);
  },

  runFidelityTest: async () => {
    const { settings, card, memories, outputDir } = get();
    const candidateModels = parseCsvList(settings.fidelityModelsCsv, 5);
    const prompts = parseLineList(settings.fidelityPromptsText, 20);

    if (candidateModels.length === 0) {
      setStep(set, "fidelity", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Add at least one candidate model in Settings.",
      });
      return;
    }

    if (!settings.llmProvider || !settings.llmModel) {
      setStep(set, "fidelity", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Configure provider and primary model in Settings first.",
      });
      return;
    }

    if (prompts.length === 0) {
      setStep(set, "fidelity", {
        phase: "error",
        progress: 0,
        message: "",
        error: "Add at least one fidelity prompt in Settings.",
      });
      return;
    }

    setStep(set, "fidelity", {
      phase: "loading",
      progress: 10,
      message: "Running live fidelity benchmark...",
      error: null,
    });
    set({ fidelityResults: [], fidelitySummaryMarkdown: "" });

    const result = await client.runFidelity({
      card,
      memories,
      outputDir: outputDir || undefined,
      provider: settings.llmProvider,
      baseUrl: settings.llmBaseUrl,
      apiKey: settings.llmApiKey,
      candidateModels,
      testPrompts: prompts,
      judgeModel: settings.judgeModel.trim() || undefined,
      temperature: settings.temperature,
      timeout: settings.requestTimeout,
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "fidelity", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const rows = result.data.results.map((row) => ({
      model: row.model,
      score: row.finalScore,
      notes: row.judgeRationale || `Style ${row.styleScore}, lexical ${row.lexicalScore}`,
    }));

    set({
      fidelityResults: rows,
      fidelitySummaryMarkdown: result.data.markdownSummary,
      report: `Fidelity report written to ${result.data.runDir}.`,
    });

    setStep(set, "fidelity", {
      phase: "success",
      progress: 100,
      message: "Fidelity scoring complete.",
      error: null,
    });
  },

  fetchProviderModels: async () => {
    const settings = get().settings;

    setStep(set, "models", {
      phase: "loading",
      progress: 20,
      message: "Fetching provider model list...",
      error: null,
    });

    const result = await client.listProviderModels({
      provider: settings.llmProvider,
      baseUrl: settings.llmBaseUrl,
      apiKey: settings.llmApiKey,
      timeout: Math.min(120, settings.requestTimeout),
    });
    set({ mode: client.getMode() });

    if (!result.ok) {
      setStep(set, "models", {
        phase: "error",
        progress: 0,
        message: "",
        error: result.error,
      });
      return;
    }

    const models = result.data.models;
    set((state) => {
      const nextSettings = sanitizeContextLimits({
        ...state.settings,
        llmModel: state.settings.llmModel || models[0] || state.settings.llmModel,
      });
      writeSettings(nextSettings);
      void persistSettingsToDesktop(nextSettings);
      return {
        settings: nextSettings,
        providerModels: models,
        providerModelWindows: result.data.contextWindows,
      };
    });

    setStep(set, "models", {
      phase: "success",
      progress: 100,
      message: `Fetched ${models.length} models.`,
      error: null,
    });
  },

  hydrateSettings: async () => {
    const result = await client.loadRendererSettings({});
    set({ mode: client.getMode() });

    if (!result.ok) {
      console.error("Failed to load persisted renderer settings:", result.error);
      return;
    }

    const settingsJson = result.data.settingsJson?.trim();
    if (!settingsJson) {
      await persistSettingsToDesktop(get().settings);
    } else {
      try {
        globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, settingsJson);
      } catch {
        // Ignore local storage write failures.
      }
    }

    const desktopReviewDirsResult = await client.listReviewDirectories({});
    set({ mode: client.getMode() });

    const baseSettings = readSettings();
    const mergedRecentDirs =
      desktopReviewDirsResult.ok
        ? mergeRecentOutputDirs(baseSettings.recentOutputDirs, desktopReviewDirsResult.data.directories)
        : baseSettings.recentOutputDirs;
    const nextSettings: RendererSettings = {
      ...baseSettings,
      recentOutputDirs: mergedRecentDirs,
    };

    writeSettings(nextSettings);
    void persistSettingsToDesktop(nextSettings);

    set((state) => ({
      settings: nextSettings,
      outputDir:
        state.outputDir.trim().length > 0
          ? state.outputDir
          : nextSettings.recentOutputDirs[0] ?? "",
    }));
  },

  setAppTab: (value) => {
    set({ appTab: value });
  },

  setEditSubTab: (value) => {
    set({ editSubTab: value });
  },

  setPersonaName: (value) => {
    set({ personaName: value });
  },

  setUserName: (value) => {
    set({ userName: value });
  },

  setHardcodeNames: (value) => {
    set((state) => {
      if (!value) {
        return { hardcodeNames: false };
      }
      const output = applyOutputNamePolicy(state.card, state.memories, {
        hardcodeNames: true,
        userName: state.userName,
        companionName: state.card.name || state.personaName.trim() || "Companion",
      });
      return {
        hardcodeNames: true,
        card: output.card,
        memories: output.memories,
      };
    });
  },

  pickPersonaImageFile: async () => {
    const result = await client.selectPersonaImageFile({});
    set({ mode: client.getMode() });

    if (!result.ok) {
      set({
        report: `Failed to select image: ${result.error}`,
      });
      return;
    }

    if (result.data.cancelled || !result.data.filePath?.trim()) {
      return;
    }

    set({
      personaImagePath: result.data.filePath.trim(),
      personaImagePreviewDataUrl: result.data.previewDataUrl ?? "",
      report: `Selected persona image: ${result.data.fileName || result.data.filePath}`,
    });
  },

  setPersonaImagePath: (value) => {
    set((state) => ({
      personaImagePath: value,
      personaImagePreviewDataUrl:
        value.trim().length === 0 || state.personaImagePath !== value
          ? ""
          : state.personaImagePreviewDataUrl,
    }));
  },

  setSelectedModel: (value) => {
    set({ selectedModel: value });
  },

  setOutputDir: (value) => {
    const cleaned = value.trim();
    set((state) => {
      const nextSettings = withRememberedOutputDir(state.settings, cleaned);
      if (nextSettings !== state.settings) {
        writeSettings(nextSettings);
        void persistSettingsToDesktop(nextSettings);
      }
      return {
        outputDir: cleaned,
        ...(nextSettings !== state.settings ? { settings: nextSettings } : {}),
      };
    });
  },

  setSettingsField: (field, value) => {
    set((state) => {
      const nextSettings: RendererSettings = {
        ...state.settings,
        [field]: value,
      };
      if (field === "llmProvider") {
        const provider = toProvider(value, state.settings.llmProvider);
        nextSettings.llmProvider = provider;
        if (state.settings.llmBaseUrl === defaultBaseUrl(state.settings.llmProvider)) {
          nextSettings.llmBaseUrl = defaultBaseUrl(provider);
        }
      }
      if (field === "contextProfile") {
        const profile = toContextProfile(value);
        nextSettings.contextProfile = profile;
        if (profile !== "auto") {
          const budget = contextBudgetPresets[profile];
          const contextWindow = contextProfileWindows[profile];
          nextSettings.maxMessagesPerConversation = budget.maxMessagesPerConversation;
          nextSettings.maxCharsPerConversation = budget.maxCharsPerConversation;
          nextSettings.maxTotalChars = budget.maxTotalChars;
          nextSettings.requestTimeout = budget.requestTimeout;
          nextSettings.modelContextWindow = contextWindow;
        }
      }
      if (field === "fidelityTier") {
        const tier = typeof value === "string" ? value : "";
        nextSettings.fidelityTier = tier;
        if (tier !== "custom") {
          const models = fidelityModelsForTier(tier);
          if (models.length > 0) {
            nextSettings.fidelityModelsCsv = models.join(",");
          }
        }
      }
      const sanitizedSettings = sanitizeContextLimits(nextSettings);
      writeSettings(sanitizedSettings);
      void persistSettingsToDesktop(sanitizedSettings);
      return {
        settings: sanitizedSettings,
      };
    });
  },

  setPromptOverrideField: (field, value) => {
    set((state) => {
      const nextSettings: RendererSettings = {
        ...state.settings,
        promptOverrides: {
          ...state.settings.promptOverrides,
          [field]: value,
        },
      };
      writeSettings(nextSettings);
      void persistSettingsToDesktop(nextSettings);
      return { settings: nextSettings };
    });
  },

  applyPreset: (name) => {
    set((state) => {
      const preset = state.settings.presets.find((row) => row.name === name);
      if (!preset) {
        return {};
      }

      const nextSettings: RendererSettings = {
        ...state.settings,
        selectedPresetName: preset.name,
        llmProvider: preset.provider,
        llmBaseUrl: preset.baseUrl,
        llmApiKey: preset.apiKey,
      };
      writeSettings(nextSettings);
      void persistSettingsToDesktop(nextSettings);
      return { settings: nextSettings };
    });
  },

  saveCurrentPreset: (name) => {
    const cleaned = name.trim();
    if (!cleaned) {
      return;
    }

    set((state) => {
      const current: ProviderPreset = {
        name: cleaned,
        provider: state.settings.llmProvider,
        baseUrl: state.settings.llmBaseUrl,
        apiKey: state.settings.llmApiKey,
      };
      const existing = state.settings.presets.filter((row) => row.name !== cleaned);
      const nextSettings: RendererSettings = {
        ...state.settings,
        selectedPresetName: cleaned,
        presets: [current, ...existing].slice(0, 24),
      };
      writeSettings(nextSettings);
      void persistSettingsToDesktop(nextSettings);
      return { settings: nextSettings };
    });
  },

  deletePreset: (name) => {
    const cleaned = name.trim();
    if (!cleaned) {
      return;
    }

    set((state) => {
      const remaining = state.settings.presets.filter((row) => row.name !== cleaned);
      const nextPresets = remaining.length > 0 ? remaining : defaultPresets;
      const nextSelected =
        state.settings.selectedPresetName === cleaned
          ? nextPresets[0]?.name ?? ""
          : state.settings.selectedPresetName;
      const nextSettings: RendererSettings = {
        ...state.settings,
        selectedPresetName: nextSelected,
        presets: nextPresets,
      };
      writeSettings(nextSettings);
      void persistSettingsToDesktop(nextSettings);
      return { settings: nextSettings };
    });
  },

  setCardField: (field, value) => {
    set((state) => ({
      card: {
        ...state.card,
        [field]: value,
      },
    }));
  },

  setActiveMemory: (id) => {
    set({ activeMemoryId: id });
  },

  updateMemoryTitle: (id, title) => {
    const cleaned = title.trim();
    if (!cleaned) {
      return;
    }

    set((state) => ({
      memories: state.memories.map((memory) =>
        memory.id === id
          ? {
              ...memory,
              name: cleaned,
            }
          : memory,
      ),
    }));
  },

  updateMemoryKeys: (id, csvKeys) => {
    const keys = csvKeys
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);

    set((state) => ({
      memories: state.memories.map((memory) =>
        memory.id === id
          ? {
              ...memory,
              keys,
            }
          : memory,
      ),
    }));
  },

  updateMemoryContent: (id, content) => {
    set((state) => ({
      memories: state.memories.map((memory) =>
        memory.id === id
          ? {
              ...memory,
              content,
            }
          : memory,
      ),
    }));
  },

  addMemory: () => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `memory-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    set((state) => ({
      memories: [
        ...state.memories,
        {
          id,
          name: "New Memory",
          keys: ["new-memory"],
          content: "",
        },
      ],
      activeMemoryId: id,
    }));
  },

  removeMemory: (id) => {
    set((state) => {
      const nextMemories = state.memories.filter((memory) => memory.id !== id);
      return {
        memories: nextMemories,
        activeMemoryId:
          state.activeMemoryId === id ? nextMemories[0]?.id ?? null : state.activeMemoryId,
      };
    });
  },

  resetStepError: (step) => {
    setStep(set, step, {
      error: null,
      phase: "idle",
      progress: 0,
      message: "",
    });
  },

  applyJobEvent: (event) => {
    if (event.jobType !== "generate") {
      return;
    }

    set((state) => {
      const targetStep: AsyncStepKey | null =
        state.steps.recover.phase === "loading"
          ? "recover"
          : state.steps.append.phase === "loading"
            ? "append"
            : null;

      if (!targetStep) {
        if (
          (event.status === "completed" || event.status === "failed" || event.status === "cancelled") &&
          state.activeGenerateJobId === event.jobId
        ) {
          return { activeGenerateJobId: null };
        }
        return {};
      }

      const current = state.steps[targetStep];
      const next: AsyncStepState = {
        ...current,
      };

      if (typeof event.progress === "number") {
        next.progress = Math.max(0, Math.min(100, event.progress));
      }
      if (event.message) {
        next.message = event.message;
      }

      if (event.status === "failed") {
        next.phase = "error";
        next.error = event.message || "Generation failed.";
      } else if (event.status === "completed") {
        next.phase = "success";
        next.error = null;
      } else if (event.status === "cancelled") {
        next.phase = "idle";
        next.error = null;
      } else if (event.status === "queued" || event.status === "running") {
        next.phase = "loading";
        next.error = null;
      }

      let recoverCompletedCalls = state.recoverCompletedCalls;
      let recoverEstimatedCalls = state.recoverEstimatedCalls;
      if (targetStep === "recover") {
        if (typeof event.completedCalls === "number" && Number.isFinite(event.completedCalls)) {
          recoverCompletedCalls = Math.max(0, Math.floor(event.completedCalls));
        }
        if (typeof event.totalCalls === "number" && Number.isFinite(event.totalCalls) && event.totalCalls > 0) {
          recoverEstimatedCalls = Math.floor(event.totalCalls);
        }
      }

      return {
        steps: {
          ...state.steps,
          [targetStep]: next,
        },
        activeGenerateJobId:
          event.status === "queued" || event.status === "running"
            ? event.jobId
            : (state.activeGenerateJobId === event.jobId ? null : state.activeGenerateJobId),
        recoverCompletedCalls,
        recoverEstimatedCalls,
      };
    });
  },
}));
