import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CardDraft,
  FidelityModelResult,
  FidelityRequest,
  FidelityResult,
  GenerateRequest,
  ListProviderModelsRequest,
  ListProviderModelsResult,
  MemoryEntry,
} from "@gptdataexport/shared";
import type { ConversationPacket, MemoryCandidate } from "@gptdataexport/pipeline";
import {
  chatComplete,
  chatCompleteJson,
  defaultBaseUrl,
  extractJsonObject,
  fetchProviderModelsWithMetadata,
  type ChatMessage,
  type LlmConfig,
  type Provider,
} from "./llm";
import {
  fillPromptTemplate,
  resolvePromptTemplates,
} from "./promptDefaults";

interface ConversationScore {
  fileName: string;
  filePath: string;
  assistantChars: number;
  assistantTurns: number;
  turns: number;
}

interface ConversationChunk {
  conversationId: string;
  sourceFile: string;
  sourcePath: string;
  transcript: string;
  messagesUsed: number;
  charCount: number;
  tokenEstimate: number;
}

interface ScanManifest {
  inputDir: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  scannedFiles: Record<string, {
    fileSize: number;
    fileMtimeMs: number;
    scannedAtUtc: string;
  }>;
}

interface GenerationResumeCheckpoint {
  version: 1;
  signature: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  personaObservationsByConversation: Record<string, Record<string, unknown>>;
  memoryCandidatesBySourceFile: Record<string, MemoryCandidate[]>;
  processedMemoryFiles: string[];
}

interface GenerationRunInput {
  pipeline: typeof import("@gptdataexport/pipeline");
  modelDir: string;
  availableFiles: string[];
  runDir: string;
  manifestPath: string;
  request: GenerateRequest;
  appendMemories: boolean;
  existingCard?: CardDraft;
  existingMemories?: MemoryEntry[];
  signal?: AbortSignal;
  onProgress?: (event: GenerationProgressEvent) => void;
}

interface GenerationRunOutput {
  cardV3: Record<string, unknown>;
  cardDraft: CardDraft;
  lorebookWrapper: Record<string, unknown>;
  memories: MemoryEntry[];
  personaPayload: Record<string, unknown>;
  memoriesPayload: Record<string, unknown>;
  report: string;
  stageStats: Record<string, unknown>;
  selectedPersonaFiles: string[];
  selectedMemoryFiles: string[];
  newMemoryFilesProcessed: number;
  skippedMemoryFiles: number;
  transcriptPath: string;
  personaSourcesPath: string;
  memorySourcesPath: string;
  processingManifestPath: string;
  generationReportPath: string;
}

export type GenerationProgressPhase =
  | "init"
  | "preflight"
  | "persona_observation"
  | "memory_extract"
  | "persona_synthesis"
  | "memory_synthesis"
  | "manifest"
  | "done";

export interface GenerationProgressEvent {
  phase: GenerationProgressPhase;
  message: string;
  startedCalls: number;
  completedCalls: number;
  failedCalls: number;
  activeCalls: number;
  totalCalls: number;
}

interface FidelityRunInput {
  request: FidelityRequest;
  runRootDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
}

function safeString(value: unknown, defaultValue = ""): string {
  const text = safeText(value).trim();
  return text || defaultValue;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((row): row is string => typeof row === "string")
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) {
    return "";
  }
  const charBudget = tokenBudget * 4;
  if (text.length <= charBudget) {
    return text;
  }
  return text.slice(0, charBudget);
}

function inferContextWindow(modelName: string): number {
  const normalized = modelName.toLowerCase();
  if (!normalized) {
    return 32000;
  }
  const rules: Array<[string, number]> = [
    ["grok-4", 2_000_000],
    ["gpt-5", 400_000],
    ["gemini-3", 1_000_000],
    ["gemini-2.0", 1_000_000],
    ["gemini-1.5", 1_000_000],
    ["kimi", 262_000],
    ["deepseek-v3", 164_000],
    ["minimax", 197_000],
    ["qwen3", 262_000],
    ["glm-5", 205_000],
    ["glm-4", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4.1", 128_000],
    ["claude", 200_000],
    ["sonnet", 200_000],
    ["haiku", 200_000],
    ["opus", 200_000],
    ["llama-3.3", 128_000],
    ["llama-3.2", 128_000],
    ["llama-3.1", 128_000],
    ["mistral-large", 128_000],
    ["deepseek", 64_000],
    ["mistral", 32_000],
    ["qwen", 32_000],
  ];
  for (const [needle, size] of rules) {
    if (normalized.includes(needle)) {
      return size;
    }
  }
  return 32000;
}

function repairMesExample(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(/\s*(<START>)/g, "\n$1")
    .replace(/\s*({{user}}:)/g, "\n$1")
    .replace(/\s*({{char}}:)/g, "\n$1")
    .trim();
}

function repairMarkdownNewlines(text: string): string {
  if (!text || text.includes("\n")) {
    return text;
  }
  return text
    .replace(/\s*(<{{char}}>|<\/{{char}}>|<\w+>|<\/\w+>)/g, "\n$1")
    .replace(/\s*(#{1,4}\s)/g, "\n\n$1")
    .replace(/\s*(- )/g, "\n$1")
    .trim();
}

function splitKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((token) =>
      !["that", "with", "from", "this", "have", "will", "would", "about"].includes(token),
    ) ?? [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
    if (out.length >= 5) {
      break;
    }
  }
  return out.length > 0 ? out : ["memory"];
}

function compactMemories(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];

  const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

  for (const candidate of candidates) {
    const content = safeString(candidate.content);
    const keys = toStringArray(candidate.keys);
    if (!content || keys.length === 0) {
      continue;
    }

    const signature = `${normalize(content)}|${keys.map((key) => key.toLowerCase()).join("|")}`;
    const existing = out.find((item) => {
      const existingContent = safeString(item.content);
      const existingKeys = toStringArray(item.keys);
      const existingSignature = `${normalize(existingContent)}|${existingKeys
        .map((key) => key.toLowerCase())
        .join("|")}`;
      return existingSignature === signature;
    });

    if (existing) {
      existing.keys = [...new Set([...toStringArray(existing.keys), ...keys])];
      const existingPriority = Number(existing.priority ?? 0);
      const priority = Number(candidate.priority ?? 0);
      if (Number.isFinite(priority) && priority > existingPriority) {
        existing.priority = priority;
      }
      if (content.length > safeString(existing.content).length) {
        existing.content = content;
      }
      continue;
    }

    out.push({
      name: safeString(candidate.name, `Memory ${out.length + 1}`),
      keys,
      content,
      category: safeString(candidate.category, "shared_memory"),
      priority: Number(candidate.priority ?? 0),
      sourceConversation: safeString(candidate.sourceConversation),
      sourceDate: safeString(candidate.sourceDate),
    });
  }

  return out;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function seedRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function selectConversationFiles(
  scored: ConversationScore[],
  sampleLimit: number,
  mode: "weighted-random" | "random-uniform" | "top",
  seed: number,
): ConversationScore[] {
  if (scored.length === 0) {
    return [];
  }

  const sorted = [...scored].sort((a, b) =>
    b.assistantChars - a.assistantChars ||
    b.assistantTurns - a.assistantTurns ||
    b.turns - a.turns ||
    a.fileName.localeCompare(b.fileName),
  );

  if (sampleLimit <= 0 || sampleLimit >= sorted.length) {
    if (mode === "random-uniform") {
      const random = seed >= 0 ? seedRandom(seed) : Math.random;
      return [...sorted].sort(() => random() - 0.5);
    }
    return sorted;
  }

  if (mode === "top") {
    return sorted.slice(0, sampleLimit);
  }

  const random = seed >= 0 ? seedRandom(seed) : Math.random;
  if (mode === "random-uniform") {
    const pool = [...sorted];
    const selected: ConversationScore[] = [];
    while (pool.length > 0 && selected.length < sampleLimit) {
      const index = Math.floor(random() * pool.length);
      const row = pool.splice(index, 1)[0];
      if (row) {
        selected.push(row);
      }
    }
    return selected;
  }

  const pool = [...sorted];
  const selected: ConversationScore[] = [];
  while (pool.length > 0 && selected.length < sampleLimit) {
    const weights = pool.map((row) =>
      Math.max(1, Math.sqrt(Math.max(1, row.assistantChars)) + (row.assistantTurns * 0.5) + (row.turns * 0.15)),
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = random() * totalWeight;
    let index = pool.length - 1;
    for (let i = 0; i < weights.length; i += 1) {
      threshold -= weights[i] ?? 0;
      if (threshold <= 0) {
        index = i;
        break;
      }
    }
    const row = pool.splice(index, 1)[0];
    if (row) {
      selected.push(row);
    }
  }
  return selected;
}

async function scoreConversationFiles(
  pipeline: typeof import("@gptdataexport/pipeline"),
  modelDir: string,
  fileNames: string[],
  signal?: AbortSignal,
): Promise<ConversationScore[]> {
  const out: ConversationScore[] = [];
  for (const fileName of fileNames) {
    throwIfAborted(signal);
    const filePath = path.join(modelDir, fileName);
    const messages = await pipeline.readExtractedConversationFile(filePath);
    if (messages.length === 0) {
      continue;
    }

    let assistantChars = 0;
    let assistantTurns = 0;
    for (const message of messages) {
      if (message.role === "assistant") {
        assistantTurns += 1;
        assistantChars += message.content.length;
      }
    }

    out.push({
      fileName,
      filePath,
      assistantChars,
      assistantTurns,
      turns: messages.length,
    });
  }
  return out;
}

async function buildChunksFromFiles(
  pipeline: typeof import("@gptdataexport/pipeline"),
  files: ConversationScore[],
  options: {
    maxMessagesPerConversation: number;
    maxCharsPerConversation: number;
    maxTotalChars: number;
    signal?: AbortSignal;
  },
): Promise<ConversationChunk[]> {
  const out: ConversationChunk[] = [];
  const hasTotalCap = Number.isFinite(options.maxTotalChars) && options.maxTotalChars > 0;
  const totalCap = hasTotalCap
    ? Math.max(1, options.maxTotalChars)
    : Number.MAX_SAFE_INTEGER;
  const perConversationCapFromTotal = hasTotalCap
    ? Math.max(1, Math.floor(totalCap / Math.max(1, files.length)))
    : Number.MAX_SAFE_INTEGER;
  const perConversationCharBudget = options.maxCharsPerConversation > 0
    ? Math.max(1, Math.min(options.maxCharsPerConversation, perConversationCapFromTotal))
    : perConversationCapFromTotal;

  for (const file of files) {
    throwIfAborted(options.signal);

    const packet = await pipeline.buildConversationPacketFromFile(file.filePath, {
      maxMessagesPerConversation: options.maxMessagesPerConversation,
      maxCharsPerConversation: perConversationCharBudget,
    });

    const trimmedTranscript = packet.transcript.trim();
    if (packet.messagesUsed <= 0 || trimmedTranscript.length === 0) {
      continue;
    }

    const safeTranscript = packet.transcript.slice(0, perConversationCharBudget);
    const safeCharCount = Math.min(packet.charCount, safeTranscript.length, perConversationCharBudget);
    if (safeCharCount <= 0 || safeTranscript.trim().length === 0) {
      continue;
    }

    out.push({
      conversationId: packet.conversationId,
      sourceFile: file.fileName,
      sourcePath: file.filePath,
      transcript: safeTranscript,
      messagesUsed: packet.messagesUsed,
      charCount: safeCharCount,
      tokenEstimate: estimateTokens(safeTranscript),
    });
  }

  return out;
}

function loadManifest(payload: string | null, inputDir: string): ScanManifest {
  if (!payload) {
    return {
      inputDir,
      createdAtUtc: nowIso(),
      updatedAtUtc: nowIso(),
      scannedFiles: {},
    };
  }
  try {
    const parsed = JSON.parse(payload) as Partial<ScanManifest>;
    if (parsed && typeof parsed === "object") {
      return {
        inputDir,
        createdAtUtc: typeof parsed.createdAtUtc === "string" ? parsed.createdAtUtc : nowIso(),
        updatedAtUtc: typeof parsed.updatedAtUtc === "string" ? parsed.updatedAtUtc : nowIso(),
        scannedFiles: parsed.scannedFiles && typeof parsed.scannedFiles === "object"
          ? parsed.scannedFiles as ScanManifest["scannedFiles"]
          : {},
      };
    }
  } catch {
    // Ignore and recreate.
  }
  return {
    inputDir,
    createdAtUtc: nowIso(),
    updatedAtUtc: nowIso(),
    scannedFiles: {},
  };
}

async function readManifest(manifestPath: string, inputDir: string): Promise<ScanManifest> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return loadManifest(raw, inputDir);
  } catch {
    return loadManifest(null, inputDir);
  }
}

async function saveManifest(manifestPath: string, manifest: ScanManifest): Promise<void> {
  manifest.updatedAtUtc = nowIso();
  await writeJson(manifestPath, manifest);
}

function stableHashInt(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deriveDeterministicSamplingSeed(
  request: GenerateRequest,
  modelDir: string,
): number {
  const promptOverrides = normalizedPromptOverrides(request.promptOverrides) ?? {};
  const payload = [
    path.resolve(modelDir),
    safeString(request.model),
    safeString(request.companionName),
    String(Math.max(1, request.maxConversations)),
    generationSamplingMode(request),
    String(request.maxMessagesPerConversation ?? 140),
    String(request.maxCharsPerConversation ?? 18_000),
    String(request.maxTotalChars ?? 120_000),
    JSON.stringify(promptOverrides),
  ].join("|");
  return stableHashInt(payload);
}

function resumeCheckpointSignature(
  input: GenerationRunInput,
  companionName: string,
  samplingMode: "weighted-random" | "random-uniform" | "top",
  samplingSeed: number,
): string {
  const payload = {
    version: 1,
    modelDir: path.resolve(input.modelDir),
    model: safeString(input.request.model),
    appendMemories: Boolean(input.appendMemories),
    companionName,
    samplingMode,
    samplingSeed,
    maxConversations: Math.max(1, input.request.maxConversations),
    maxMessagesPerConversation: Math.max(1, input.request.maxMessagesPerConversation ?? 140),
    maxCharsPerConversation: Math.max(1, input.request.maxCharsPerConversation ?? 18_000),
    maxTotalChars: Math.max(1, input.request.maxTotalChars ?? 120_000),
    maxMemories: Math.max(1, input.request.maxMemories ?? 24),
    memoryPerChatMax: Math.max(1, input.request.memoryPerChatMax ?? 6),
    modelContextWindow: input.request.modelContextWindow ?? 0,
  };
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function sanitizeMemoryCandidateRows(rows: unknown): MemoryCandidate[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  const out: MemoryCandidate[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) {
      continue;
    }
    const content = safeString(row.content);
    if (!content) {
      continue;
    }
    const keys = toStringArray(row.keys);
    out.push({
      name: safeString(row.name, "Memory"),
      keys: keys.length > 0 ? keys : splitKeywords(content),
      content,
      category: safeString(row.category, "shared_memory"),
      priority: Number(row.priority ?? 0),
      sourceConversation: safeString(row.sourceConversation ?? row.source_conversation),
      sourceDate: safeString(row.sourceDate ?? row.source_date),
    });
  }
  return out;
}

function normalizeResumeCheckpoint(
  value: unknown,
  signature: string,
): GenerationResumeCheckpoint {
  const now = nowIso();
  const fallback: GenerationResumeCheckpoint = {
    version: 1,
    signature,
    createdAtUtc: now,
    updatedAtUtc: now,
    personaObservationsByConversation: {},
    memoryCandidatesBySourceFile: {},
    processedMemoryFiles: [],
  };

  const root = asRecord(value);
  if (!root) {
    return fallback;
  }

  const rootSignature = safeString(root.signature);
  if (rootSignature !== signature) {
    const rawPersona = asRecord(root.personaObservationsByConversation);
    const rawMemory = asRecord(root.memoryCandidatesBySourceFile);
    const rawProcessed = toStringArray(root.processedMemoryFiles);
    const hasLegacyData =
      (rawPersona && Object.keys(rawPersona).length > 0) ||
      (rawMemory && Object.keys(rawMemory).length > 0) ||
      rawProcessed.length > 0;
    if (!hasLegacyData) {
      return fallback;
    }
  }

  const personaObservationsByConversation: Record<string, Record<string, unknown>> = {};
  const rawPersona = asRecord(root.personaObservationsByConversation);
  if (rawPersona) {
    for (const [conversationId, row] of Object.entries(rawPersona)) {
      const parsed = asRecord(row);
      if (parsed) {
        personaObservationsByConversation[conversationId] = parsed;
      }
    }
  }

  const memoryCandidatesBySourceFile: Record<string, MemoryCandidate[]> = {};
  const rawMemory = asRecord(root.memoryCandidatesBySourceFile);
  if (rawMemory) {
    for (const [sourceFile, rows] of Object.entries(rawMemory)) {
      const normalizedRows = sanitizeMemoryCandidateRows(rows);
      if (normalizedRows.length > 0) {
        memoryCandidatesBySourceFile[sourceFile] = normalizedRows;
      }
    }
  }

  const processedMemoryFiles = toStringArray(root.processedMemoryFiles);

  return {
    version: 1,
    signature,
    createdAtUtc: safeString(root.createdAtUtc, now),
    updatedAtUtc: safeString(root.updatedAtUtc, now),
    personaObservationsByConversation,
    memoryCandidatesBySourceFile,
    processedMemoryFiles,
  };
}

async function readResumeCheckpoint(
  checkpointPath: string,
  signature: string,
): Promise<GenerationResumeCheckpoint> {
  try {
    const raw = await readFile(checkpointPath, "utf8");
    return normalizeResumeCheckpoint(JSON.parse(raw), signature);
  } catch {
    return normalizeResumeCheckpoint(null, signature);
  }
}

async function saveResumeCheckpoint(
  checkpointPath: string,
  checkpoint: GenerationResumeCheckpoint,
): Promise<void> {
  checkpoint.updatedAtUtc = nowIso();
  await writeJson(checkpointPath, checkpoint);
}

function promptContent(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: safeText(message.content),
  }));
}

function providerRequiresApiKey(provider: Provider): boolean {
  return provider === "openai" || provider === "openrouter" || provider === "anthropic";
}

function resolveApiKey(provided: string): string {
  return safeString(provided);
}

function assertLlmGenerationConfig(config: LlmConfig): void {
  const model = safeString(config.model);
  if (!model) {
    throw new Error("Set an extraction model in Settings.");
  }
  if (providerRequiresApiKey(config.provider) && !safeString(config.apiKey ?? "")) {
    throw new Error(`Missing API key for ${config.provider}. Set it in Settings.`);
  }
}

function summarizeErrors(errors: string[]): string {
  if (errors.length === 0) {
    return "";
  }
  const sample = errors.slice(0, 4).join(" | ");
  if (errors.length > 4) {
    return `${sample} | ... +${errors.length - 4} more`;
  }
  return sample;
}

function errorPreview(error: unknown, maxLen = 220): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLen)}...`;
}

function createAbortError(message = "Generation cancelled by user."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function configFromRequest(request: GenerateRequest): LlmConfig {
  const provider = providerFromGenerateRequest(request);
  const apiKey = resolveApiKey(request.llmApiKey ?? "");
  return {
    provider,
    model: safeString(request.llmModel),
    baseUrl: defaultBaseUrl(provider, request.llmBaseUrl ?? ""),
    apiKey,
    siteUrl: request.llmSiteUrl ?? "http://localhost",
    appName: request.llmAppName ?? "companion-preserver",
    temperature: request.temperature ?? 0.2,
    timeout: request.requestTimeout ?? 180,
    maxTokens: 4000,
  };
}

async function runWithConcurrency<T, R>(
  rows: T[],
  limit: number,
  worker: (row: T, index: number) => Promise<R>,
  options?: {
    signal?: AbortSignal;
  },
): Promise<R[]> {
  throwIfAborted(options?.signal);
  if (rows.length === 0) {
    return [];
  }
  const max = Math.max(1, Math.min(limit, rows.length));
  const out = new Array<R>(rows.length);
  let cursor = 0;

  const runners = Array.from({ length: max }, async () => {
    while (cursor < rows.length) {
      throwIfAborted(options?.signal);
      const index = cursor;
      cursor += 1;
      out[index] = await worker(rows[index] as T, index);
      throwIfAborted(options?.signal);
    }
  });

  await Promise.all(runners);
  return out;
}

function extractMemoryRows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows = payload.memories;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row));
}

function toMemoryCandidates(rows: Array<Record<string, unknown>>): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  for (const row of rows) {
    const content = safeString(row.content);
    if (!content) {
      continue;
    }
    const keys = toStringArray(row.keys);
    out.push({
      name: safeString(row.name, `Memory ${out.length + 1}`),
      keys: keys.length > 0 ? keys : splitKeywords(content),
      content,
      category: safeString(row.category, "shared_memory"),
      priority: Number(row.priority ?? 0),
      sourceConversation: safeString(row.source_conversation),
      sourceDate: safeString(row.source_date),
    });
  }
  return out;
}

function personaFromPayload(
  payload: Record<string, unknown>,
  companionName: string,
): {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  tags: string[];
} {
  const name = safeString(payload.name, companionName || "Companion");
  const description = repairMarkdownNewlines(
    safeString(payload.description, `${name} reconstructed from transcript evidence.`),
  );
  const personality = safeString(payload.personality);
  const scenario = safeString(payload.scenario);
  const firstMes = safeString(payload.first_mes, "Hi. I'm here with you.");
  const alternateGreetings = toStringArray(payload.alternate_greetings);
  const mesExample = repairMesExample(
    safeString(payload.mes_example, "<START>\n{{user}}: How are you?\n{{char}}: I'm here with you."),
  );
  const systemPrompt = safeString(
    payload.system_prompt,
    "Maintain continuity and preserve observed voice from transcript evidence.",
  );
  const postHistoryInstructions = safeString(
    payload.post_history_instructions,
    "Reference established memories and relational context before inferring new facts.",
  );
  const creatorNotes = safeString(
    payload.creator_notes,
    "Generated by Companion Preservation Desktop live extraction flow.",
  );
  const tags = toStringArray(payload.tags);

  return {
    name,
    description,
    personality,
    scenario,
    firstMes,
    alternateGreetings,
    mesExample,
    systemPrompt,
    postHistoryInstructions,
    creatorNotes,
    tags,
  };
}

function cardDraftFromCard(card: Record<string, unknown>): CardDraft {
  const data = asRecord(card.data) ?? card;
  return {
    name: safeString(data.name),
    description: safeString(data.description),
    personality: safeString(data.personality),
    scenario: safeString(data.scenario),
    firstMessage: safeString(data.first_mes ?? data.firstMessage),
  };
}

function memoriesFromLorebook(lorebookWrapper: Record<string, unknown>): MemoryEntry[] {
  const data = asRecord(lorebookWrapper.data) ?? lorebookWrapper;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const out: MemoryEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = asRecord(entries[index]);
    if (!entry) {
      continue;
    }
    const content = safeString(entry.content);
    if (!content) {
      continue;
    }
    const memoryId = safeString(entry.id, `memory-${index + 1}`);
    const memoryName = safeString(entry.name, memoryId);
    const keys = toStringArray(entry.keys);
    out.push({
      id: memoryId,
      name: memoryName,
      keys: keys.length > 0 ? keys : splitKeywords(content),
      content,
    });
  }
  return out;
}

function buildCardV3(
  persona: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    firstMes: string;
    alternateGreetings: string[];
    mesExample: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    creatorNotes: string;
    tags: string[];
  },
): Record<string, unknown> {
  const nowTs = Math.floor(Date.now() / 1000);
  const alternateGreetings =
    persona.alternateGreetings.length > 0
      ? persona.alternateGreetings
      : [
          "Hi. What would you like to talk about?",
          "I'm here. What should we focus on?",
        ];
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: persona.name,
      description: persona.description,
      personality: persona.personality,
      scenario: persona.scenario,
      first_mes: persona.firstMes,
      alternate_greetings: alternateGreetings,
      mes_example: persona.mesExample,
      creator_notes: persona.creatorNotes,
      tags: persona.tags,
      system_prompt: persona.systemPrompt,
      post_history_instructions: persona.postHistoryInstructions,
      creator: "unknown",
      character_version: "1.0",
      extensions: {},
      group_only_greetings: [],
      creation_date: nowTs,
      modification_date: nowTs,
    },
  };
}

function providerFromGenerateRequest(request: GenerateRequest): Provider {
  const provider = request.llmProvider;
  if (provider === "openai" || provider === "openrouter" || provider === "anthropic" || provider === "ollama") {
    return provider;
  }
  return "openrouter";
}

function generationSamplingMode(
  request: GenerateRequest,
): "weighted-random" | "random-uniform" | "top" {
  const raw = safeString((request as Record<string, unknown>).conversationSampling, "weighted-random");
  if (raw === "random-uniform" || raw === "top") {
    return raw;
  }
  return "weighted-random";
}

function generationSamplingSeed(request: GenerateRequest): number {
  const raw = Number((request as Record<string, unknown>).samplingSeed);
  if (Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  return -1;
}

function generationForceRerun(request: GenerateRequest): boolean {
  return (request as Record<string, unknown>).forceRerun === true;
}

function companionNameFromRequest(request: GenerateRequest): string {
  const value = safeString((request as Record<string, unknown>).companionName, "Companion");
  return value || "Companion";
}

function memoryCandidatesFromEntries(memories: MemoryEntry[]): MemoryCandidate[] {
  return memories.map((memory, index) => ({
    name: safeString(memory.name, safeString(memory.id, `Existing Memory ${index + 1}`)),
    keys: memory.keys,
    content: memory.content,
    category: "shared_memory",
    priority: Math.max(1, 300 - index),
  }));
}

function transcriptFromChunks(chunks: ConversationChunk[]): string {
  return chunks
    .map((chunk) => `=== conversation: ${chunk.conversationId} ===\n${chunk.transcript}`)
    .join("\n\n");
}

function normalizedPromptOverrides(
  value: GenerateRequest["promptOverrides"],
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[key] = raw;
    }
  }
  return out;
}

async function runGenerationLlm(
  input: GenerationRunInput,
  chunksForPersona: ConversationChunk[],
  chunksForMemory: ConversationChunk[],
  manifest: ScanManifest,
): Promise<{
  personaPayload: Record<string, unknown>;
  memoriesPayload: Record<string, unknown>;
  stageStats: Record<string, unknown>;
  processedMemoryFiles: string[];
}> {
  const templates = resolvePromptTemplates(normalizedPromptOverrides(input.request.promptOverrides));
  const llmConfig = configFromRequest(input.request);
  assertLlmGenerationConfig(llmConfig);
  const contextWindow = input.request.modelContextWindow && input.request.modelContextWindow > 0
    ? input.request.modelContextWindow
    : inferContextWindow(llmConfig.model);
  const usableContext = Math.max(2048, contextWindow - 2500);
  const perChatBudget = Math.max(900, Math.floor(usableContext * 0.9));
  const synthesisBudget = Math.max(1200, Math.floor(usableContext * 0.9));
  const companionName = companionNameFromRequest(input.request);
  const forceRerun = generationForceRerun(input.request);
  const maxParallel = Math.max(1, Math.min(input.request.maxParallelCalls ?? 4, 16));
  const maxMemories = Math.max(1, input.request.maxMemories ?? 24);
  const memoryPerChatMax = Math.max(1, input.request.memoryPerChatMax ?? 6);
  const concurrencyOptions = input.signal ? { signal: input.signal } : undefined;
  const samplingMode = generationSamplingMode(input.request);
  const requestedSamplingSeed = generationSamplingSeed(input.request);
  const effectiveSamplingSeed = requestedSamplingSeed >= 0
    ? requestedSamplingSeed
    : deriveDeterministicSamplingSeed(input.request, input.modelDir);
  const existingRows = input.existingMemories
    ? memoryCandidatesFromEntries(input.existingMemories)
    : [];
  const checkpointPath = path.join(input.runDir, "generation_resume.json");
  const checkpointSignature = resumeCheckpointSignature(
    input,
    companionName,
    samplingMode,
    effectiveSamplingSeed,
  );
  const checkpoint = forceRerun
    ? normalizeResumeCheckpoint(null, checkpointSignature)
    : await readResumeCheckpoint(checkpointPath, checkpointSignature);

  const preflightCalls = 1;
  const personaObservationCalls = input.appendMemories ? 0 : chunksForPersona.length;
  const personaSynthesisCalls = input.appendMemories ? 0 : 1;
  const memoryExtractionCalls = chunksForMemory.length;
  const memorySynthesisCalls =
    (memoryExtractionCalls > 0 || existingRows.length > 0) ? 1 : 0;
  const llmCallsPlanned =
    preflightCalls +
    personaObservationCalls +
    personaSynthesisCalls +
    memoryExtractionCalls +
    memorySynthesisCalls;

  const personaObservationByConversation = new Map<string, Record<string, unknown>>();
  for (const [conversationId, row] of Object.entries(checkpoint.personaObservationsByConversation)) {
    const parsed = asRecord(row);
    if (parsed) {
      personaObservationByConversation.set(conversationId, parsed);
    }
  }

  const memoryCandidatesBySourceFile = new Map<string, MemoryCandidate[]>();
  for (const [sourceFile, rows] of Object.entries(checkpoint.memoryCandidatesBySourceFile)) {
    const parsed = sanitizeMemoryCandidateRows(rows);
    if (parsed.length > 0) {
      memoryCandidatesBySourceFile.set(sourceFile, parsed);
    }
  }

  const validMemorySourceFiles = new Set(chunksForMemory.map((chunk) => chunk.sourceFile));
  const processedMemoryFileSet = new Set<string>();
  for (const sourceFile of checkpoint.processedMemoryFiles) {
    if (validMemorySourceFiles.has(sourceFile)) {
      processedMemoryFileSet.add(sourceFile);
    }
  }
  for (const sourceFile of memoryCandidatesBySourceFile.keys()) {
    if (validMemorySourceFiles.has(sourceFile)) {
      processedMemoryFileSet.add(sourceFile);
    }
  }

  const personaChunksPending = input.appendMemories
    ? []
    : chunksForPersona.filter((chunk) => !personaObservationByConversation.has(chunk.conversationId));
  const memoryChunksPending = chunksForMemory.filter((chunk) => !processedMemoryFileSet.has(chunk.sourceFile));

  const resumedPersonaCalls = input.appendMemories
    ? 0
    : chunksForPersona.filter((chunk) => personaObservationByConversation.has(chunk.conversationId)).length;
  const resumedMemoryCalls = chunksForMemory.filter((chunk) => processedMemoryFileSet.has(chunk.sourceFile)).length;
  const resumedCalls = resumedPersonaCalls + resumedMemoryCalls;
  const checkpointCreatedAt = checkpoint.createdAtUtc || nowIso();

  let checkpointWriteQueue = Promise.resolve();
  const persistCheckpoint = async (): Promise<void> => {
    const payload: GenerationResumeCheckpoint = {
      version: 1,
      signature: checkpointSignature,
      createdAtUtc: checkpointCreatedAt,
      updatedAtUtc: nowIso(),
      personaObservationsByConversation: Object.fromEntries(personaObservationByConversation),
      memoryCandidatesBySourceFile: Object.fromEntries(memoryCandidatesBySourceFile),
      processedMemoryFiles: chunksForMemory
        .map((chunk) => chunk.sourceFile)
        .filter((sourceFile) => processedMemoryFileSet.has(sourceFile)),
    };
    checkpointWriteQueue = checkpointWriteQueue.then(async () => {
      await saveResumeCheckpoint(checkpointPath, payload);
    });
    await checkpointWriteQueue;
  };

  let manifestWriteQueue = Promise.resolve();
  const persistManifest = async (): Promise<void> => {
    manifestWriteQueue = manifestWriteQueue.then(async () => {
      await saveManifest(input.manifestPath, manifest);
    });
    await manifestWriteQueue;
  };

  const markMemoryFileProcessed = async (chunk: ConversationChunk): Promise<void> => {
    processedMemoryFileSet.add(chunk.sourceFile);
    try {
      const fileStats = await stat(chunk.sourcePath);
      manifest.scannedFiles[chunk.sourceFile] = {
        fileSize: fileStats.size,
        fileMtimeMs: Math.trunc(fileStats.mtimeMs),
        scannedAtUtc: nowIso(),
      };
      await persistManifest();
    } catch {
      // Ignore manifest update failures for single files.
    }
  };

  const errors: string[] = [];

  let llmCallsStarted = resumedCalls;
  let llmCallsCompleted = resumedCalls;
  let llmCallsFailed = 0;
  let activeCalls = 0;
  const timeoutSeconds = Math.max(1, llmConfig.timeout ?? 180);

  const emitProgress = (phase: GenerationProgressPhase, message: string): void => {
    input.onProgress?.({
      phase,
      message,
      startedCalls: llmCallsStarted,
      completedCalls: llmCallsCompleted,
      failedCalls: llmCallsFailed,
      activeCalls,
      totalCalls: llmCallsPlanned,
    });
  };

  const beginCall = (phase: GenerationProgressPhase, label: string): void => {
    llmCallsStarted += 1;
    activeCalls += 1;
    emitProgress(phase, `LLM call started: ${label}`);
  };

  const completeCall = (phase: GenerationProgressPhase, label: string): void => {
    llmCallsCompleted += 1;
    activeCalls = Math.max(0, activeCalls - 1);
    emitProgress(phase, `LLM call completed: ${label}`);
  };

  const failCall = (phase: GenerationProgressPhase, label: string, error: unknown): void => {
    llmCallsFailed += 1;
    activeCalls = Math.max(0, activeCalls - 1);
    emitProgress(phase, `LLM call failed: ${label} | ${errorPreview(error)}`);
  };

  const requestOptionsFor = (
    phase: GenerationProgressPhase,
    label: string,
  ) => ({
    ...(input.signal ? { signal: input.signal } : {}),
    requestTag: label,
    onRetry: (event: {
      attempt: number;
      maxAttempts: number;
      backoffSeconds: number;
      error: string;
      url: string;
    }) => {
      emitProgress(
        phase,
        `Retry ${event.attempt}/${event.maxAttempts} for ${label} in ${event.backoffSeconds.toFixed(1)}s | ${errorPreview(event.error, 180)}`,
      );
    },
  });

  const summarizeMessagePayload = (messages: ChatMessage[]): string => {
    const payloadChars = messages.reduce((sum, row) => sum + row.content.length, 0);
    const payloadTokens = estimateTokens(messages.map((row) => row.content).join("\n"));
    return `messages=${messages.length}, chars=${payloadChars}, est_tokens=${payloadTokens}, timeout=${timeoutSeconds}s`;
  };

  emitProgress(
    "init",
    `Preparing generation for ${companionName} using ${llmConfig.provider}/${llmConfig.model}. ${forceRerun ? "Force rerun enabled; ignoring previous checkpoint state." : `Resuming ${resumedCalls} completed calls from checkpoint.`}`,
  );
  throwIfAborted(input.signal);

  beginCall("preflight", "provider/model preflight");
  try {
    const preflightResponse = await chatComplete(
      {
        ...llmConfig,
        temperature: 0,
        maxTokens: 64,
      },
      [
        {
          role: "system",
          content: "Reply with a single token: OK",
        },
        {
          role: "user",
          content: "OK",
        },
      ],
      requestOptionsFor("preflight", "provider/model preflight"),
    );
    if (!preflightResponse.trim()) {
      throw new Error("Provider returned an empty preflight response.");
    }
    completeCall("preflight", "provider/model preflight");
  } catch (error) {
    if (isAbortError(error)) {
      failCall("preflight", "provider/model preflight", error);
      throw createAbortError();
    }
    failCall("preflight", "provider/model preflight", error);
    throw new Error(
      `LLM preflight failed for ${llmConfig.provider}/${llmConfig.model}: ${errorPreview(error, 300)}`,
    );
  }

  emitProgress(
    "init",
    `Sampling ${chunksForPersona.length} persona chunks and ${chunksForMemory.length} memory chunks (pending: persona ${personaChunksPending.length}, memory ${memoryChunksPending.length}; per-chat budget ${perChatBudget} tokens, synthesis budget ${synthesisBudget} tokens).`,
  );

  if (!input.appendMemories) {
    await runWithConcurrency(personaChunksPending, maxParallel, async (chunk) => {
      const callLabel = `persona_observation ${chunk.conversationId}`;
      beginCall("persona_observation", callLabel);
      try {
        const content = fillPromptTemplate(templates.personaObservationUser, {
          companion_name: companionName,
          conversation_id: chunk.conversationId,
          transcript: truncateToTokenBudget(chunk.transcript, perChatBudget),
        });
        const messages = promptContent([
          { role: "system", content: templates.personaObservationSystem },
          { role: "user", content },
        ]);
        const result = await chatCompleteJson(
          llmConfig,
          messages,
          requestOptionsFor("persona_observation", callLabel),
        );
        const payload = result.parsed;
        payload.conversation_id = payload.conversation_id ?? chunk.conversationId;
        personaObservationByConversation.set(chunk.conversationId, payload);
        await persistCheckpoint();
        completeCall("persona_observation", callLabel);
        return payload;
      } catch (error) {
        if (isAbortError(error)) {
          failCall("persona_observation", callLabel, error);
          throw createAbortError();
        }
        failCall("persona_observation", callLabel, error);
        errors.push(`persona_observation[${chunk.conversationId}]: ${String(error)}`);
        return {};
      }
    }, concurrencyOptions);
  }

  const personaObservations: Array<Record<string, unknown>> = [];
  if (!input.appendMemories) {
    for (const chunk of chunksForPersona) {
      const row = personaObservationByConversation.get(chunk.conversationId);
      if (row && Object.keys(row).length > 0) {
        personaObservations.push(row);
      }
    }

    if (personaObservations.length === 0) {
      throw new Error(
        `Persona observation failed for all sampled conversations. ${summarizeErrors(errors)}`,
      );
    }
  }

  await runWithConcurrency(memoryChunksPending, maxParallel, async (chunk) => {
    const callLabel = `memory_extract ${chunk.conversationId}`;
    beginCall("memory_extract", callLabel);
    try {
      const content = fillPromptTemplate(templates.memoryUser, {
        max_memories: memoryPerChatMax,
        transcript: truncateToTokenBudget(chunk.transcript, perChatBudget),
      });
      const messages = promptContent([
        { role: "system", content: templates.memorySystem },
        { role: "user", content },
      ]);
      const result = await chatCompleteJson(
        llmConfig,
        messages,
        requestOptionsFor("memory_extract", callLabel),
      );
      const rows = extractMemoryRows(result.parsed).map((row) => ({
        ...row,
        source_conversation: chunk.conversationId,
      }));
      const parsedRows = toMemoryCandidates(rows);
      memoryCandidatesBySourceFile.set(chunk.sourceFile, parsedRows);
      await markMemoryFileProcessed(chunk);
      await persistCheckpoint();
      completeCall("memory_extract", callLabel);
      return parsedRows;
    } catch (error) {
      if (isAbortError(error)) {
        failCall("memory_extract", callLabel, error);
        throw createAbortError();
      }
      failCall("memory_extract", callLabel, error);
      errors.push(`memory_extract[${chunk.conversationId}]: ${String(error)}`);
      return [];
    }
  }, concurrencyOptions);

  const memoryCandidates: MemoryCandidate[] = [];
  for (const chunk of chunksForMemory) {
    const rows = memoryCandidatesBySourceFile.get(chunk.sourceFile);
    if (rows && rows.length > 0) {
      memoryCandidates.push(...rows);
    }
  }

  if (chunksForMemory.length > 0 && memoryCandidates.length === 0) {
    throw new Error(
      `Memory extraction produced no candidates. ${summarizeErrors(errors)}`,
    );
  }

  let personaPayload: Record<string, unknown> = {};
  if (!input.appendMemories) {
    if (personaObservations.length > 0) {
      const callLabel = "persona_synthesis";
      const observationPackets = JSON.stringify(personaObservations, null, 2);
      const truncatedObservationPackets = truncateToTokenBudget(
        observationPackets,
        synthesisBudget,
      );
      const synthesisInput = fillPromptTemplate(templates.personaSynthesisUser, {
        companion_name: companionName,
        observation_packets: truncatedObservationPackets,
      });
      const messages = promptContent([
        { role: "system", content: templates.personaSynthesisSystem },
        { role: "user", content: synthesisInput },
      ]);
      const personaSynthesisStats =
        `observations=${personaObservations.length}, observation_json_chars=${observationPackets.length}, ` +
        `observation_json_tokens≈${estimateTokens(observationPackets)}, truncated_chars=${truncatedObservationPackets.length}, ` +
        `truncated_tokens≈${estimateTokens(truncatedObservationPackets)}, ${summarizeMessagePayload(messages)}`;
      emitProgress("persona_synthesis", `LLM payload: persona_synthesis | ${personaSynthesisStats}`);
      beginCall("persona_synthesis", callLabel);
      try {
        const result = await chatCompleteJson(
          llmConfig,
          messages,
          requestOptionsFor("persona_synthesis", callLabel),
        );
        personaPayload = result.parsed;
        completeCall("persona_synthesis", callLabel);
      } catch (error) {
        if (isAbortError(error)) {
          failCall("persona_synthesis", callLabel, error);
          throw createAbortError();
        }
        failCall("persona_synthesis", callLabel, error);
        errors.push(`persona_synthesis: ${personaSynthesisStats} | ${String(error)}`);
      }
    }

    if (Object.keys(personaPayload).length === 0) {
      throw new Error(
        `Persona synthesis produced no usable payload. ${summarizeErrors(errors)}`,
      );
    }
  }

  const combinedCandidates = compactMemories([...existingRows, ...memoryCandidates]);
  if (combinedCandidates.length === 0) {
    throw new Error("Memory extraction produced zero candidates for synthesis.");
  }

  const callLabel = "memory_synthesis";
  const candidateMemoriesJson = JSON.stringify(combinedCandidates, null, 2);
  const truncatedCandidateMemoriesJson = truncateToTokenBudget(
    candidateMemoriesJson,
    synthesisBudget,
  );
  const synthesisInput = fillPromptTemplate(templates.memorySynthesisUser, {
    max_memories: maxMemories,
    candidate_memories: truncatedCandidateMemoriesJson,
  });
  const messages = promptContent([
    { role: "system", content: templates.memorySynthesisSystem },
    { role: "user", content: synthesisInput },
  ]);
  const memorySynthesisStats =
    `candidates=${combinedCandidates.length}, candidate_json_chars=${candidateMemoriesJson.length}, ` +
    `candidate_json_tokens≈${estimateTokens(candidateMemoriesJson)}, truncated_chars=${truncatedCandidateMemoriesJson.length}, ` +
    `truncated_tokens≈${estimateTokens(truncatedCandidateMemoriesJson)}, ${summarizeMessagePayload(messages)}`;
  emitProgress("memory_synthesis", `LLM payload: memory_synthesis | ${memorySynthesisStats}`);
  beginCall("memory_synthesis", callLabel);
  let memoriesPayload: Record<string, unknown>;
  try {
    const result = await chatCompleteJson(
      llmConfig,
      messages,
      requestOptionsFor("memory_synthesis", callLabel),
    );
    const rows = extractMemoryRows(result.parsed);
    if (rows.length === 0) {
      throw new Error("Memory synthesis returned zero rows.");
    }
    memoriesPayload = { memories: rows };
    completeCall("memory_synthesis", callLabel);
  } catch (error) {
    if (isAbortError(error)) {
      failCall("memory_synthesis", callLabel, error);
      throw createAbortError();
    }
    failCall("memory_synthesis", callLabel, error);
    errors.push(`memory_synthesis: ${memorySynthesisStats} | ${String(error)}`);
    throw new Error(
      `Memory synthesis failed. ${summarizeErrors(errors)}`,
    );
  }

  throwIfAborted(input.signal);
  emitProgress("manifest", "Updating processed file manifest...");
  const processedMemoryFiles = chunksForMemory
    .map((chunk) => chunk.sourceFile)
    .filter((sourceFile) => processedMemoryFileSet.has(sourceFile));
  for (const fileName of processedMemoryFiles) {
    try {
      const filePath = path.join(input.modelDir, fileName);
      const fileStats = await stat(filePath);
      manifest.scannedFiles[fileName] = {
        fileSize: fileStats.size,
        fileMtimeMs: Math.trunc(fileStats.mtimeMs),
        scannedAtUtc: nowIso(),
      };
    } catch {
      // Skip update for file stat failures.
    }
  }
  await persistManifest();
  await persistCheckpoint();

  emitProgress("done", "Generation extraction stages complete.");

  return {
    personaPayload,
    memoriesPayload,
    stageStats: {
      forceRerun,
      contextWindow,
      perChatInputBudgetTokens: perChatBudget,
      synthesisInputBudgetTokens: synthesisBudget,
      conversationChunksPersona: chunksForPersona.length,
      conversationChunksMemory: chunksForMemory.length,
      resumedPersonaCalls,
      resumedMemoryCalls,
      observations: personaObservations.length,
      memoryCandidates: combinedCandidates.length,
      memoryFinal: extractMemoryRows(memoriesPayload).length,
      llmCallsPlanned,
      llmCallsStarted,
      llmCallsCompleted,
      llmCallsFailed,
      errors,
    },
    processedMemoryFiles,
  };
}

function parseTranscriptAssistantLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("[assistant] "))
    .map((line) => line.slice("[assistant] ".length).trim())
    .filter((line) => line.length > 0);
}

async function loadBaselineAssistantMessages(outputDir?: string): Promise<string[]> {
  if (!outputDir || outputDir.trim().length === 0) {
    return [];
  }
  const transcriptPath = path.join(outputDir, "analysis_transcript.txt");
  try {
    const raw = await readFile(transcriptPath, "utf8");
    return parseTranscriptAssistantLines(raw);
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-zA-Z']+/g) ?? [];
}

function sentenceCount(text: string): number {
  const rows = text.split(/[.!?]+/).map((row) => row.trim()).filter(Boolean);
  return rows.length > 0 ? rows.length : 1;
}

function styleProfile(texts: string[]): Record<string, unknown> {
  if (texts.length === 0) {
    return {
      avg_words_per_message: 0,
      avg_sentences_per_message: 0,
      question_rate: 0,
      exclaim_rate: 0,
      first_person_rate: 0,
      empathy_marker_rate: 0,
      lexical_diversity: 0,
      top_words: [] as string[],
    };
  }

  const joined = texts.join("\n");
  const allTokens = tokenize(joined);
  const msgCount = Math.max(1, texts.length);
  const sentenceTotal = texts.reduce((sum, row) => sum + sentenceCount(row), 0);
  const questionTotal = texts.reduce((sum, row) => sum + (row.match(/\?/g)?.length ?? 0), 0);
  const exclaimTotal = texts.reduce((sum, row) => sum + (row.match(/!/g)?.length ?? 0), 0);
  const firstPersonTotal = allTokens.filter((token) =>
    ["i", "me", "my", "mine", "myself"].includes(token),
  ).length;

  const empathyMarkers = ["that makes sense", "i hear you", "i'm here", "we can", "you're not alone", "let's"];
  const lowerJoined = joined.toLowerCase();
  let empathyHits = 0;
  for (const marker of empathyMarkers) {
    empathyHits += lowerJoined.split(marker).length - 1;
  }

  const stopwords = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "is", "are", "was", "were",
    "be", "with", "that", "this", "it", "as", "at", "from", "by", "i", "you", "we", "they", "me", "my",
    "your", "our",
  ]);
  const freqs = new Map<string, number>();
  for (const token of allTokens) {
    if (stopwords.has(token) || token.length < 3) {
      continue;
    }
    freqs.set(token, (freqs.get(token) ?? 0) + 1);
  }
  const topWords = [...freqs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([token]) => token);

  const uniqueTokens = new Set(allTokens).size;
  return {
    avg_words_per_message: Number((allTokens.length / msgCount).toFixed(4)),
    avg_sentences_per_message: Number((sentenceTotal / msgCount).toFixed(4)),
    question_rate: Number((questionTotal / msgCount).toFixed(4)),
    exclaim_rate: Number((exclaimTotal / msgCount).toFixed(4)),
    first_person_rate: Number((firstPersonTotal / Math.max(1, allTokens.length)).toFixed(4)),
    empathy_marker_rate: Number((empathyHits / msgCount).toFixed(4)),
    lexical_diversity: Number((uniqueTokens / Math.max(1, allTokens.length)).toFixed(4)),
    top_words: topWords,
  };
}

function numericSimilarity(base: number, candidate: number): number {
  if (base === 0 && candidate === 0) {
    return 100;
  }
  if (base === 0) {
    return Math.max(0, 100 - (Math.abs(candidate) * 100));
  }
  const diff = Math.abs(candidate - base) / Math.abs(base);
  return Math.max(0, 100 - (diff * 100));
}

function compareProfiles(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): {
  style: number;
  lexical: number;
  rule: number;
} {
  const numericKeys = [
    "avg_words_per_message",
    "avg_sentences_per_message",
    "question_rate",
    "exclaim_rate",
    "first_person_rate",
    "empathy_marker_rate",
    "lexical_diversity",
  ];

  const styleScores = numericKeys.map((key) =>
    numericSimilarity(
      Number(baseline[key] ?? 0),
      Number(candidate[key] ?? 0),
    ),
  );
  const style = styleScores.reduce((sum, value) => sum + value, 0) / styleScores.length;

  const baseWords = new Set(toStringArray(baseline.top_words));
  const candidateWords = new Set(toStringArray(candidate.top_words));
  const union = new Set([...baseWords, ...candidateWords]);
  const intersection = new Set([...baseWords].filter((word) => candidateWords.has(word)));
  const lexical = union.size > 0 ? (100 * intersection.size) / union.size : 0;

  return {
    style: Number(style.toFixed(2)),
    lexical: Number(lexical.toFixed(2)),
    rule: Number(((0.7 * style) + (0.3 * lexical)).toFixed(2)),
  };
}

function buildCharacterSystemPrompt(card: CardDraft, memories: MemoryEntry[]): string {
  const memoryLines = memories
    .slice(0, 24)
    .map((memory) => `- ${memory.content}`)
    .join("\n");

  return [
    "You are roleplaying the companion profile below as faithfully as possible.",
    "Do not optimize style. Mirror observed tone and structure.",
    `Name: ${card.name}`,
    `Description: ${card.description}`,
    `Personality: ${card.personality}`,
    `Scenario: ${card.scenario}`,
    `First Message: ${card.firstMessage}`,
    memoryLines ? `Key Memories:\n${memoryLines}` : "",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function parseCandidateList(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 5);
}

function formatFidelitySummary(
  results: FidelityModelResult[],
  prompts: string[],
  judgeModel: string,
): string {
  if (results.length === 0) {
    return "# Fidelity Benchmark Results\n\nNo results.";
  }

  const lines: string[] = [
    "# Fidelity Benchmark Results",
    "",
    `**${results.length} models tested** with ${prompts.length} prompts each.`,
  ];

  if (judgeModel) {
    lines.push(`Judge model: \`${judgeModel}\``);
  }

  lines.push("");
  lines.push("## Rankings");
  lines.push("");
  lines.push("| Rank | Model | Final | Style | Lexical | Judge |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |");

  results.forEach((result, index) => {
    lines.push(
      `| ${index + 1} | \`${result.model}\` | **${result.finalScore}** | ${result.styleScore} | ${result.lexicalScore} | ${result.judgeScore} |`,
    );
  });

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  results.forEach((result) => {
    lines.push(`### ${result.model}`);
    lines.push(`- Rationale: ${result.judgeRationale || "No judge rationale."}`);
    lines.push("");
  });

  return lines.join("\n");
}

export async function listProviderModels(
  request: ListProviderModelsRequest,
): Promise<ListProviderModelsResult> {
  const provider = request.provider;
  const resolvedApiKey = resolveApiKey(request.apiKey ?? "");
  const options: {
    baseUrl?: string;
    apiKey?: string;
    siteUrl?: string;
    appName?: string;
    timeout?: number;
  } = {
    timeout: request.timeout ?? 30,
  };
  if (request.baseUrl) {
    options.baseUrl = request.baseUrl;
  }
  if (resolvedApiKey) {
    options.apiKey = resolvedApiKey;
  }
  if (request.siteUrl) {
    options.siteUrl = request.siteUrl;
  }
  if (request.appName) {
    options.appName = request.appName;
  }

  const result = await fetchProviderModelsWithMetadata(provider, options);
  return {
    models: result.models,
    contextWindows: result.contextWindows,
  };
}

export async function runGeneration(input: GenerationRunInput): Promise<GenerationRunOutput> {
  const {
    pipeline,
    modelDir,
    availableFiles,
    runDir,
    request,
    appendMemories,
    existingCard,
    existingMemories,
  } = input;
  const manifestPath = input.manifestPath || path.join(runDir, "scan_manifest.json");
  const manifest = await readManifest(manifestPath, modelDir);
  const forceRerun = generationForceRerun(request);
  if (forceRerun && Object.keys(manifest.scannedFiles).length > 0) {
    manifest.scannedFiles = {};
  }
  const companionName = companionNameFromRequest(request);
  const samplingMode = generationSamplingMode(request);
  const requestedSamplingSeed = generationSamplingSeed(request);
  const samplingSeed = requestedSamplingSeed >= 0
    ? requestedSamplingSeed
    : deriveDeterministicSamplingSeed(request, modelDir);
  const effectiveContextWindow = request.modelContextWindow && request.modelContextWindow > 0
    ? request.modelContextWindow
    : inferContextWindow(safeString(request.llmModel));
  const maxCharsByContext = Math.max(1, effectiveContextWindow);
  const maxConversations = Math.max(1, request.maxConversations);
  const maxMessages = Math.max(1, request.maxMessagesPerConversation ?? 140);
  const requestedMaxTotalChars = Math.max(1, request.maxTotalChars ?? 120_000);
  const maxTotalChars = Math.max(1, Math.min(requestedMaxTotalChars, maxCharsByContext));
  const maxCharsPerConversation = Math.max(
    1,
    Math.min(request.maxCharsPerConversation ?? 18_000, maxTotalChars),
  );
  const maxMemories = Math.max(1, request.maxMemories ?? 24);
  throwIfAborted(input.signal);
  const emitInitProgress = (message: string): void => {
    input.onProgress?.({
      phase: "init",
      message,
      startedCalls: 0,
      completedCalls: 0,
      failedCalls: 0,
      activeCalls: 0,
      totalCalls: 0,
    });
  };

  if (requestedMaxTotalChars > maxTotalChars) {
    emitInitProgress(
      `Adjusted max total chars from ${requestedMaxTotalChars} to ${maxTotalChars} to fit context window ${effectiveContextWindow}.`,
    );
  }
  emitInitProgress("Scoring extracted conversation files...");
  const scored = await scoreConversationFiles(pipeline, modelDir, availableFiles, input.signal);
  if (scored.length === 0) {
    throw new Error("No usable conversation files were found in extracted JSONL cache.");
  }

  const selectedPersona = selectConversationFiles(scored, maxConversations, samplingMode, samplingSeed);
  const selectedMemory = selectedPersona;
  throwIfAborted(input.signal);

  emitInitProgress("Building transcript packets for persona extraction...");
  const chunksForPersona = await buildChunksFromFiles(pipeline, selectedPersona, {
    maxMessagesPerConversation: maxMessages,
    maxCharsPerConversation,
    maxTotalChars,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const memoryRowsForSelection = appendMemories && !forceRerun
    ? selectedMemory.filter((row) => !(row.fileName in manifest.scannedFiles))
    : selectedMemory;

  const skippedMemoryFiles = selectedMemory.length - memoryRowsForSelection.length;

  emitInitProgress("Building transcript packets for memory extraction...");
  const chunksForMemory = await buildChunksFromFiles(pipeline, memoryRowsForSelection, {
    maxMessagesPerConversation: maxMessages,
    maxCharsPerConversation,
    maxTotalChars,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (chunksForPersona.length === 0 && !appendMemories) {
    throw new Error("No persona transcript chunks were produced from selected conversations.");
  }

  emitInitProgress("Starting live LLM extraction and synthesis...");
  const generationResult = await runGenerationLlm(input, chunksForPersona, chunksForMemory, manifest);
  await saveManifest(manifestPath, manifest);

  const personaPayload = generationResult.personaPayload;
  if (!appendMemories && Object.keys(personaPayload).length === 0) {
    throw new Error("Persona extraction returned an empty payload.");
  }

  const finalPersona = appendMemories && existingCard
    ? {
        name: existingCard.name || companionName,
        description: existingCard.description,
        personality: existingCard.personality,
        scenario: existingCard.scenario,
        firstMes: existingCard.firstMessage,
        alternateGreetings: [],
        mesExample: "",
        systemPrompt: "Maintain continuity with preserved card + lorebook data.",
        postHistoryInstructions: "Reference memories before inferring missing context.",
        creatorNotes: "Updated from append memories run.",
        tags: ["companion", "preservation", "append_memories"],
      }
    : personaFromPayload(personaPayload, companionName);

  const memoryCandidatesFromPayload = toMemoryCandidates(extractMemoryRows(generationResult.memoriesPayload));
  const mergedMemoryCandidates = compactMemories([
    ...(existingMemories ? memoryCandidatesFromEntries(existingMemories) : []),
    ...memoryCandidatesFromPayload,
  ]);
  if (mergedMemoryCandidates.length === 0) {
    throw new Error("Memory extraction returned zero usable memories.");
  }

  const lorebook = pipeline.shapeLorebookV3(finalPersona.name || companionName, mergedMemoryCandidates, {
    maxEntries: maxMemories,
  });
  const lorebookWrapper: Record<string, unknown> = {
    spec: "lorebook_v3",
    data: lorebook,
  };

  const cardV3 = buildCardV3(finalPersona);
  const cardDraft = cardDraftFromCard(cardV3);
  const memories = memoriesFromLorebook(lorebookWrapper);

  const transcript = transcriptFromChunks(chunksForPersona.length > 0 ? chunksForPersona : chunksForMemory);
  const transcriptPath = path.join(runDir, "analysis_transcript.txt");
  const personaSourcesPath = path.join(runDir, "persona_sources.txt");
  const memorySourcesPath = path.join(runDir, "memory_sources.txt");
  const processingManifestPath = path.join(runDir, "processing_manifest.json");
  const generationReportPath = path.join(runDir, "generation_report.json");

  await writeFile(transcriptPath, transcript, "utf8");
  await writeFile(
    personaSourcesPath,
    selectedPersona.map((row) => row.fileName).join("\n"),
    "utf8",
  );
  await writeFile(
    memorySourcesPath,
    selectedMemory.map((row) => row.fileName).join("\n"),
    "utf8",
  );

  await writeJson(processingManifestPath, {
    version: 1,
    createdAt: nowIso(),
    mode: appendMemories ? "append_memories" : "full_generation",
    modelDir,
    selectedPersonaFiles: selectedPersona.map((row) => row.fileName),
    selectedMemoryFiles: selectedMemory.map((row) => row.fileName),
    processedMemoryFiles: generationResult.processedMemoryFiles,
    skippedMemoryFiles,
    sampling: {
      mode: samplingMode,
      seed: samplingSeed,
      maxConversations,
      memorySampleConversations: "same_as_persona",
    },
  });

  await writeJson(generationReportPath, {
    createdAt: nowIso(),
    mode: appendMemories ? "append_memories" : "full_generation",
    model: request.model,
    llmProvider: request.llmProvider ?? null,
    llmModel: request.llmModel ?? null,
    selectedPersonaCount: selectedPersona.length,
    selectedMemoryCount: selectedMemory.length,
    processedMemoryFiles: generationResult.processedMemoryFiles.length,
    skippedMemoryFiles,
    transcriptChars: transcript.length,
    memoryCount: memories.length,
    stageStats: generationResult.stageStats,
  });

  const report = appendMemories
    ? `Scanned ${generationResult.processedMemoryFiles.length} new files, skipped ${skippedMemoryFiles}, total memories ${memories.length}.`
    : `Recovered persona from ${selectedPersona.length} conversations and generated ${memories.length} memories.`;

  return {
    cardV3,
    cardDraft,
    lorebookWrapper,
    memories,
    personaPayload,
    memoriesPayload: generationResult.memoriesPayload,
    report,
    stageStats: generationResult.stageStats,
    selectedPersonaFiles: selectedPersona.map((row) => row.fileName),
    selectedMemoryFiles: selectedMemory.map((row) => row.fileName),
    newMemoryFilesProcessed: generationResult.processedMemoryFiles.length,
    skippedMemoryFiles,
    transcriptPath,
    personaSourcesPath,
    memorySourcesPath,
    processingManifestPath,
    generationReportPath,
  };
}

async function runJudge(
  request: FidelityRequest,
  baselineExcerpt: string,
  characterSystemPrompt: string,
  prompts: string[],
  responses: string[],
): Promise<{ score: number; rationale: string }> {
  if (!request.judgeModel?.trim()) {
    return { score: 0, rationale: "" };
  }

  const judgeSystem = [
    "You are a strict personality fidelity judge.",
    "Score only how well the candidate voice matches baseline style and tone.",
    "Ignore factual correctness and answer quality.",
    "Return JSON: {\"score\": <0-100>, \"rationale\": \"<2-3 sentences>\"}",
  ].join("\n");

  const exchanges = prompts
    .map((prompt, index) => {
      const response = responses[index] ?? "";
      return `PROMPT ${index + 1}: ${prompt}\nCANDIDATE RESPONSE ${index + 1}: ${response}`;
    })
    .join("\n\n---\n\n");

  const judgeUser = [
    "Baseline personality from historical conversations:",
    baselineExcerpt.slice(0, 10_000),
    "",
    "Character profile:",
    characterSystemPrompt.slice(0, 4_000),
    "",
    "Candidate responses:",
    exchanges,
  ].join("\n");

  const provider = request.provider;
  const resolvedApiKey = resolveApiKey(request.apiKey ?? "");
  if (providerRequiresApiKey(provider) && !resolvedApiKey) {
    throw new Error(`Missing API key for ${provider}. Set it in Settings.`);
  }
  const judgeConfig: LlmConfig = {
    provider,
    model: request.judgeModel,
    baseUrl: defaultBaseUrl(provider, request.baseUrl ?? ""),
    apiKey: resolvedApiKey,
    siteUrl: request.siteUrl ?? "http://localhost",
    appName: request.appName ?? "companion-preserver",
    temperature: 0,
    timeout: request.timeout ?? 180,
    maxTokens: 1200,
  };

  const response = await chatComplete(judgeConfig, [
    { role: "system", content: judgeSystem },
    { role: "user", content: judgeUser },
  ]);
  const parsed = extractJsonObject(response);
  const score = Number(parsed.score ?? 0);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    rationale: safeString(parsed.rationale, response.slice(0, 600)),
  };
}

export async function runFidelity(input: FidelityRunInput): Promise<FidelityResult> {
  const { request, runRootDir } = input;
  const candidateModels = parseCandidateList(request.candidateModels);
  const prompts = request.testPrompts
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0)
    .slice(0, 20);

  if (candidateModels.length === 0) {
    throw new Error("At least one candidate model is required for fidelity testing.");
  }
  if (prompts.length === 0) {
    throw new Error("At least one fidelity prompt is required.");
  }

  const baseline = await loadBaselineAssistantMessages(request.outputDir);
  const baselineMessages = baseline.length > 0
    ? baseline
    : [
        request.card.description,
        request.card.firstMessage,
        ...request.memories.slice(0, 16).map((memory) => memory.content),
      ].filter((row) => row.trim().length > 0);
  if (baselineMessages.length === 0) {
    throw new Error("No baseline text is available for fidelity comparison.");
  }

  const baselineProfile = styleProfile(baselineMessages);
  const characterSystemPrompt = buildCharacterSystemPrompt(request.card, request.memories);
  const provider = request.provider;
  const resolvedApiKey = resolveApiKey(request.apiKey ?? "");
  if (providerRequiresApiKey(provider) && !resolvedApiKey) {
    throw new Error(`Missing API key for ${provider}. Set it in Settings.`);
  }
  const baseConfig: LlmConfig = {
    provider,
    model: "",
    baseUrl: defaultBaseUrl(provider, request.baseUrl ?? ""),
    apiKey: resolvedApiKey,
    siteUrl: request.siteUrl ?? "http://localhost",
    appName: request.appName ?? "companion-preserver",
    temperature: request.temperature ?? 0.2,
    timeout: request.timeout ?? 180,
  };

  const results: FidelityModelResult[] = [];
  for (const modelName of candidateModels) {
    const config: LlmConfig = {
      ...baseConfig,
      model: modelName,
    };
    const responses = await runWithConcurrency(prompts, Math.min(5, prompts.length), async (prompt) => {
      return await chatComplete(config, [
        { role: "system", content: characterSystemPrompt },
        { role: "user", content: prompt },
      ]);
    });

    const candidateProfile = styleProfile(responses);
    const compared = compareProfiles(baselineProfile, candidateProfile);
    const judge = await runJudge(
      request,
      baselineMessages.slice(0, 120).join("\n"),
      characterSystemPrompt,
      prompts,
      responses,
    );
    const finalScore = request.judgeModel?.trim()
      ? Number(((0.6 * compared.rule) + (0.4 * judge.score)).toFixed(2))
      : compared.rule;

    results.push({
      model: modelName,
      finalScore,
      styleScore: compared.style,
      lexicalScore: compared.lexical,
      judgeScore: Number(judge.score.toFixed(2)),
      judgeRationale: judge.rationale,
    });
  }

  results.sort((a, b) => b.finalScore - a.finalScore || a.model.localeCompare(b.model));

  const runDir = path.join(
    runRootDir,
    `fidelity_run_${new Date().toISOString().replace(/[.:]/g, "-")}_${randomUUID().slice(0, 8)}`,
  );
  await mkdir(runDir, { recursive: true });

  const reportPath = path.join(runDir, "fidelity_report.json");
  const summaryPath = path.join(runDir, "fidelity_summary.md");
  const markdownSummary = formatFidelitySummary(results, prompts, request.judgeModel ?? "");

  await writeJson(reportPath, {
    runDir,
    provider: request.provider,
    judgeModel: request.judgeModel ?? "",
    testPrompts: prompts,
    baselineProfile,
    results,
    createdAtUtc: nowIso(),
  });
  await writeFile(summaryPath, markdownSummary, "utf8");

  return {
    runDir,
    reportPath,
    summaryPath,
    markdownSummary,
    results,
  };
}
