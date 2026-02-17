import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import type { OpenDialogOptions } from "electron";
import {
  IpcEventChannel,
  IpcInvokeChannel,
  JobSummary,
  JobStatus,
  JobType,
  fail,
  ok,
  parseIpcInvokeRequest,
  parseIpcInvokeResponse,
  parseJobEvent,
  type AppPaths,
  type BridgeResult,
  type CardDraft,
  type FidelityRequest,
  type GenerateRequest,
  type ImportFileRequest,
  type ListReviewDirectoriesRequest,
  type LoadRendererSettingsRequest,
  type ListProviderModelsRequest,
  type LoadReviewRequest,
  type MemoryEntry,
  type PrepareCacheRequest,
  type SelectExportDirectoryRequest,
  type SelectPersonaImageFileRequest,
  type SaveRendererSettingsRequest,
  type SelectImportFileResult,
  type SaveReviewRequest,
} from "@gptdataexport/shared";
import type {
  CharacterCardV3Draft,
  DiscoverModelsResult,
  LorebookEntry,
  LorebookV3,
  MemoryCandidate,
} from "@gptdataexport/pipeline";
import {
  type GenerationProgressEvent,
  listProviderModels as fetchProviderModelsLive,
  runFidelity as runLiveFidelity,
  runGeneration as runLiveGeneration,
} from "./livePipeline";

type ManagedJob = JobSummary;
interface JobCallStats {
  startedCalls?: number;
  completedCalls?: number;
  failedCalls?: number;
  activeCalls?: number;
  totalCalls?: number;
}

const jobStore = new Map<string, ManagedJob>();
const generationAbortControllers = new Map<string, AbortController>();
const logWriteQueues = new Map<string, Promise<void>>();
let appPaths: AppPaths | null = null;
let ipcRegistered = false;
let runtimeLogPath = "";
let pipelineModulePromise: Promise<typeof import("@gptdataexport/pipeline")> | null = null;
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;
const discoverModelsCache = new Map<
  string,
  {
    fileSizeBytes: number;
    fileMtimeMs: number;
    result: DiscoverModelsResult;
  }
>();

const EXTRACTION_CACHE_DIR = "extraction_cache";
const EXTRACTION_MANIFEST_FILE = "extraction_manifest.json";
const PROCESSING_MANIFEST_FILE = "processing_manifest.json";
const MEMORY_APPEND_HISTORY_FILE = "memory_append_history.jsonl";
const RUNTIME_LOG_FILE = "desktop-runtime.log";
const PERSONA_ASSETS_FILE = "persona_assets.json";
const PERSONA_IMAGE_FILE = "persona_image.png";
const RENDERER_SETTINGS_FILE = "renderer_settings.json";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PLACEHOLDER_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

interface ExtractionCacheInfo {
  cacheRoot: string;
  modelExportsDir: string;
  modelDir: string;
  sourceFingerprint: string;
  sourceFilePath: string;
  sourceFileSizeBytes: number;
  sourceFileMtimeMs: number;
  fileNames: string[];
  reusedExtraction: boolean;
  extractedInLastRun: number;
}

function errorToLogLine(error: unknown): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack : "";
    return stack.trim().length > 0 ? stack : error.message;
  }
  return String(error);
}

function queueLogWrite(filePath: string, line: string): void {
  if (!filePath.trim()) {
    return;
  }
  const entry = `${new Date().toISOString()} ${line}\n`;
  const previous = logWriteQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await appendFile(filePath, entry, "utf8");
    })
    .catch(() => undefined);
  logWriteQueues.set(filePath, next);
}

function appendRuntimeLog(line: string): void {
  if (!runtimeLogPath.trim()) {
    return;
  }
  queueLogWrite(runtimeLogPath, line);
}

function appendFileLog(filePath: string, line: string): void {
  queueLogWrite(filePath, line);
}

function logIpcError(channel: string, error: unknown): BridgeResult<never> {
  appendRuntimeLog(`[IPC ${channel}] ${errorToLogLine(error)}`);
  console.error(`[IPC ${channel}]`, error);
  return fail(error);
}

function nowTs(): number {
  return Date.now();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function getPipelineModule(): Promise<typeof import("@gptdataexport/pipeline")> {
  if (!pipelineModulePromise) {
    pipelineModulePromise = dynamicImport("@gptdataexport/pipeline") as Promise<
      typeof import("@gptdataexport/pipeline")
    >;
  }

  return pipelineModulePromise;
}

function sanitizeFileStem(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

function toLocalDateStamp(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function exportBaseName(companionName: string): string {
  const safeName = sanitizeFileStem(companionName.trim().toLowerCase() || "companion").replace(/_+/g, "_");
  return `${safeName}_${toLocalDateStamp()}`;
}

function toDisplayText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\u0000/g, "").trim();
}

function toDisplayTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const tag = toDisplayText(item);
    if (tag.length > 0) {
      out.push(tag);
    }
  }
  return out;
}

function normalizeLorebookEntries(entries: LorebookEntry[]): Array<Record<string, unknown>> {
  return entries
    .filter((entry) => toDisplayText(entry.content).length > 0)
    .map((entry, index) => {
      const keys = Array.isArray(entry.keys)
        ? entry.keys
            .map((key) => toDisplayText(key))
            .filter((key) => key.length > 0)
        : [];
      return {
        keys,
        content: toDisplayText(entry.content),
        enabled: true,
        insertion_order: index,
        name: toDisplayText(entry.name) || `Memory ${index + 1}`,
        priority: Number.isFinite(entry.priority) ? Math.trunc(entry.priority) : Math.max(0, 100 - index),
        position: "before_char",
        extensions: {},
      } satisfies Record<string, unknown>;
    });
}

function toSillyTavernCardPayload(
  card: CharacterCardV3Draft,
  lorebook: LorebookV3,
  creatorName?: string,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const data = asRecord(card.data) ?? {};
  const name = toDisplayText(data.name) || "Companion";
  const description = toDisplayText(data.description);
  const personality = toDisplayText(data.personality);
  const scenario = toDisplayText(data.scenario);
  const firstMes = toDisplayText(data.first_mes);
  const mesExample = toDisplayText(data.mes_example);
  const creatorNotes = toDisplayText(data.creator_notes);
  const systemPrompt = toDisplayText(data.system_prompt);
  const postHistoryInstructions = toDisplayText(data.post_history_instructions);
  const tags = toDisplayTags(data.tags);
  const creator = toDisplayText(creatorName) || toDisplayText(data.creator) || "unknown";
  const characterBookEntries = normalizeLorebookEntries(lorebook.entries);

  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name,
      description,
      personality,
      scenario,
      first_mes: firstMes,
      mes_example: mesExample,
      creator,
      character_version: "1.0",
      tags,
      creator_notes: creatorNotes,
      system_prompt: systemPrompt,
      post_history_instructions: postHistoryInstructions,
      group_only_greetings: [],
      alternate_greetings: [],
      extensions: {},
      creation_date: now,
      modification_date: now,
      character_book: {
        name: toDisplayText(lorebook.name) || `${name} Memory Lorebook`,
        description: toDisplayText(lorebook.description),
        entries: characterBookEntries,
      },
    },
  } satisfies Record<string, unknown>;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & 1) === 1) {
        value = 0xedb88320 ^ (value >>> 1);
      } else {
        value >>>= 1;
      }
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const tableValue = CRC32_TABLE[(value ^ byte) & 0xff] ?? 0;
    value = tableValue ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function stripTextChunks(pngBuffer: Buffer): Buffer {
  if (!isPngBuffer(pngBuffer)) {
    throw new Error("Invalid PNG image buffer.");
  }

  const chunks: Buffer[] = [pngBuffer.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= pngBuffer.length) {
    const chunkStart = offset;
    const dataLength = pngBuffer.readUInt32BE(offset);
    offset += 4;
    const chunkType = pngBuffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const chunkEnd = offset + dataLength + 4;
    if (chunkEnd > pngBuffer.length) {
      throw new Error("PNG chunk is truncated.");
    }

    if (chunkType !== "tEXt" && chunkType !== "zTXt") {
      chunks.push(pngBuffer.subarray(chunkStart, chunkEnd));
    }
    offset = chunkEnd;

    if (chunkType === "IEND") {
      break;
    }
  }

  return Buffer.concat(chunks);
}

function findIendOffset(pngBuffer: Buffer): number {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= pngBuffer.length) {
    const chunkStart = offset;
    const dataLength = pngBuffer.readUInt32BE(offset);
    offset += 4;
    const chunkType = pngBuffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const chunkEnd = offset + dataLength + 4;
    if (chunkEnd > pngBuffer.length) {
      return -1;
    }
    if (chunkType === "IEND") {
      return chunkStart;
    }
    offset = chunkEnd;
  }
  return -1;
}

function createTextChunk(keyword: string, text: string): Buffer {
  const keywordBuffer = Buffer.from(keyword, "latin1");
  const textBuffer = Buffer.from(text, "utf8");
  const chunkData = Buffer.concat([keywordBuffer, Buffer.from([0]), textBuffer]);
  const chunkType = Buffer.from("tEXt", "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(chunkData.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([chunkType, chunkData])), 0);
  return Buffer.concat([lengthBuffer, chunkType, chunkData, crcBuffer]);
}

function embedCardInPng(pngBuffer: Buffer, cardPayload: Record<string, unknown>): Buffer {
  const cleanPng = stripTextChunks(pngBuffer);
  const iendOffset = findIendOffset(cleanPng);
  if (iendOffset < 0) {
    throw new Error("PNG image is missing IEND chunk.");
  }
  const encodedCard = Buffer.from(JSON.stringify(cardPayload), "utf8").toString("base64");
  const textChunk = createTextChunk("chara", encodedCard);
  return Buffer.concat([cleanPng.subarray(0, iendOffset), textChunk, cleanPng.subarray(iendOffset)]);
}

function toPersonaImageDataUrl(imagePath: string | undefined): string | undefined {
  if (!imagePath || imagePath.trim().length === 0) {
    return undefined;
  }
  const image = nativeImage.createFromPath(path.resolve(imagePath));
  if (image.isEmpty()) {
    return undefined;
  }
  return image.toDataURL();
}

function makeRunDirName(prefix = "run"): string {
  const iso = new Date().toISOString().replace(/[.:]/g, "-");
  return `${sanitizeFileStem(prefix)}_${iso}`;
}

function deriveRecoveryRunDir(
  jobsDir: string,
  request: GenerateRequest,
  sourceFingerprint: string,
): string {
  const companion = (request.companionName?.trim() || "companion").toLowerCase();
  const payload = {
    sourceFingerprint,
    model: request.model,
    companion,
    maxConversations: request.maxConversations,
    conversationSampling: request.conversationSampling ?? "weighted-random",
  };
  const digest = createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
  const modelPart = sanitizeFileStem(request.model);
  const companionPart = sanitizeFileStem(companion);
  return path.join(jobsDir, `ccv3_run_${modelPart}_${companionPart}_${digest}`);
}

function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

async function loadDotEnvFromWorkspace(): Promise<void> {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
  ];

  for (const envPath of candidates) {
    try {
      const raw = await readFile(envPath, "utf8");
      const parsed = parseDotEnv(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
      return;
    } catch {
      // Try next candidate.
    }
  }
}

async function initAppPaths(): Promise<AppPaths> {
  const userDataDir = app.getPath("userData");
  const logsDir = path.join(userDataDir, "logs");
  const jobsDir = path.join(userDataDir, "jobs");
  const tempDir = path.join(userDataDir, "temp");

  await Promise.all([
    mkdir(logsDir, { recursive: true }),
    mkdir(jobsDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);

  app.setAppLogsPath(logsDir);
  runtimeLogPath = path.join(logsDir, RUNTIME_LOG_FILE);
  appendRuntimeLog(`Desktop runtime initialized | userDataDir=${userDataDir}`);

  return parseIpcInvokeResponse(IpcInvokeChannel.GetAppPaths, {
    userDataDir,
    logsDir,
    jobsDir,
    tempDir,
  });
}

function emitJobEvent(
  jobId: string,
  jobType: JobType,
  status: JobStatus,
  message?: string,
  progress?: number,
  callStats?: JobCallStats,
): void {
  const normalizedCallStats = normalizeCallStats(callStats);
  const event = parseJobEvent({
    jobId,
    jobType,
    status,
    timestamp: nowTs(),
    message,
    progress,
    ...normalizedCallStats,
  });

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcEventChannel.JobEvent, event);
  }
}

function createTrackedJob(jobType: JobType, inputPath: string): ManagedJob {
  const timestamp = nowTs();
  const job: ManagedJob = {
    jobId: randomUUID(),
    jobType,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    inputPath,
  };
  jobStore.set(job.jobId, job);
  return job;
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function clampCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeCallStats(callStats: JobCallStats | undefined): JobCallStats {
  if (!callStats) {
    return {};
  }

  const normalized: JobCallStats = {};
  const startedCalls = clampCount(callStats.startedCalls);
  const completedCalls = clampCount(callStats.completedCalls);
  const failedCalls = clampCount(callStats.failedCalls);
  const activeCalls = clampCount(callStats.activeCalls);
  const totalCalls = clampCount(callStats.totalCalls);

  if (startedCalls !== undefined) {
    normalized.startedCalls = startedCalls;
  }
  if (completedCalls !== undefined) {
    normalized.completedCalls = completedCalls;
  }
  if (failedCalls !== undefined) {
    normalized.failedCalls = failedCalls;
  }
  if (activeCalls !== undefined) {
    normalized.activeCalls = activeCalls;
  }
  if (totalCalls !== undefined) {
    normalized.totalCalls = totalCalls;
  }

  return normalized;
}

function updateTrackedJob(
  job: ManagedJob,
  status: JobStatus,
  message?: string,
  progress?: number,
  callStats?: JobCallStats,
): void {
  job.status = status;
  job.updatedAt = nowTs();
  jobStore.set(job.jobId, job);
  const normalizedProgress = clampProgress(progress);
  emitJobEvent(job.jobId, job.jobType, status, message, normalizedProgress, callStats);

  const progressSuffix = normalizedProgress !== undefined ? ` (${normalizedProgress}%)` : "";
  const stats = normalizeCallStats(callStats);
  const statsSuffix =
    stats.totalCalls !== undefined
      ? ` | calls ${stats.completedCalls ?? 0}/${stats.totalCalls} active=${stats.activeCalls ?? 0} failed=${stats.failedCalls ?? 0}`
      : "";
  if (message) {
    console.log(`[${job.jobType}:${job.jobId.slice(0, 8)}] ${status}${progressSuffix} ${message}`);
    appendRuntimeLog(
      `[${job.jobType}:${job.jobId.slice(0, 8)}] ${status}${progressSuffix}${statsSuffix} ${message}`,
    );
  } else {
    console.log(`[${job.jobType}:${job.jobId.slice(0, 8)}] ${status}${progressSuffix}`);
    appendRuntimeLog(
      `[${job.jobType}:${job.jobId.slice(0, 8)}] ${status}${progressSuffix}${statsSuffix}`,
    );
  }
}

function getRendererEntry(): string {
  const explicitUrl =
    process.env.ELECTRON_RENDERER_URL?.trim() ??
    process.env.DESKTOP_RENDERER_URL?.trim() ??
    "";
  if (explicitUrl.length > 0) {
    return explicitUrl;
  }

  const bundledCandidates = [
    path.resolve(__dirname, "..", "..", "renderer", "dist", "index.html"),
    path.resolve(process.cwd(), "apps", "renderer", "dist", "index.html"),
    path.resolve(process.resourcesPath, "app.asar", "apps", "renderer", "dist", "index.html"),
    path.resolve(process.resourcesPath, "app.asar.unpacked", "apps", "renderer", "dist", "index.html"),
  ];
  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).toString();
    }
  }

  return (
    "data:text/html;charset=UTF-8," +
    encodeURIComponent(`
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>Companion Preservation Desktop</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; }
      code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Desktop shell is running</h1>
    <p>Start renderer with <code>pnpm dev:renderer</code> and launch desktop with <code>pnpm dev:desktop</code>.</p>
  </body>
</html>
`)
  );
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      devTools: process.env.NODE_ENV !== "production",
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  await win.loadURL(getRendererEntry());
  return win;
}

function splitIntoKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((token) => !["that", "with", "from", "this", "have", "will", "would", "about"].includes(token)) ?? [];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
    if (unique.length >= 4) {
      break;
    }
  }

  return unique.length > 0 ? unique : ["memory"];
}

async function findExtractedModelDir(baseDir: string, model: string): Promise<string | null> {
  const safeModel = sanitizeFileStem(model);
  const candidates = [path.join(baseDir, safeModel), path.join(baseDir, model)];

  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) {
        return candidate;
      }
    } catch {
      // continue searching
    }
  }
  return null;
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function rendererSettingsPath(): string {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }
  return path.join(appPaths.userDataDir, RENDERER_SETTINGS_FILE);
}

async function loadRendererSettings(): Promise<BridgeResult<import("@gptdataexport/shared").LoadRendererSettingsResult>> {
  const settingsPath = rendererSettingsPath();
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("Renderer settings file must contain a JSON object.");
    }
    return ok({
      settingsJson: JSON.stringify(parsed),
      path: settingsPath,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return ok({
        path: settingsPath,
      });
    }
    return fail(error);
  }
}

async function saveRendererSettings(
  request: SaveRendererSettingsRequest,
): Promise<BridgeResult<import("@gptdataexport/shared").SaveRendererSettingsResult>> {
  const settingsPath = rendererSettingsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.settingsJson);
  } catch {
    return fail("Invalid settings JSON payload.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("Renderer settings must be a JSON object.");
  }

  await writeJsonFile(settingsPath, parsed);
  return ok({
    saved: true,
    path: settingsPath,
  });
}

function sourceFingerprint(
  inputFilePath: string,
  fileSizeBytes: number,
  fileMtimeMs: number,
): string {
  return createHash("sha1")
    .update(path.resolve(inputFilePath))
    .update(":")
    .update(String(fileSizeBytes))
    .update(":")
    .update(String(Math.trunc(fileMtimeMs)))
    .digest("hex");
}

async function listJsonlFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function ensureExtractionCache(
  pipeline: typeof import("@gptdataexport/pipeline"),
  jobsDir: string,
  inputFilePath: string,
  model: string,
): Promise<ExtractionCacheInfo> {
  const normalizedInputPath = path.resolve(inputFilePath);
  const fileStats = await stat(normalizedInputPath);
  const fingerprint = sourceFingerprint(
    normalizedInputPath,
    fileStats.size,
    fileStats.mtimeMs,
  );

  const cacheRoot = path.join(jobsDir, EXTRACTION_CACHE_DIR, fingerprint);
  const modelExportsDir = path.join(cacheRoot, "model_exports");

  await mkdir(modelExportsDir, { recursive: true });

  let modelDir = await findExtractedModelDir(modelExportsDir, model);
  let fileNames = modelDir ? await listJsonlFiles(modelDir) : [];
  let reusedExtraction = Boolean(modelDir && fileNames.length > 0);
  let extractedInLastRun = 0;

  if (!modelDir || fileNames.length === 0) {
    const extraction = await pipeline.extractByModels({
      inputPath: normalizedInputPath,
      models: [model],
      outputDir: modelExportsDir,
      format: "jsonl",
      maxConversations: 0,
    });

    extractedInLastRun = extraction.extracted;
    modelDir = await findExtractedModelDir(modelExportsDir, model);
    if (!modelDir) {
      throw new Error("Extraction completed but no model directory was created in cache.");
    }

    fileNames = await listJsonlFiles(modelDir);
    if (fileNames.length === 0) {
      throw new Error(`No extracted JSONL files found for model '${model}'.`);
    }

    reusedExtraction = false;
  }

  const manifestPath = path.join(cacheRoot, EXTRACTION_MANIFEST_FILE);
  let previousModels: Record<string, unknown> = {};

  if (await fileExists(manifestPath)) {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      const parsedRecord = asRecord(parsed);
      if (parsedRecord && asRecord(parsedRecord.models)) {
        previousModels = asRecord(parsedRecord.models) ?? {};
      }
    } catch {
      previousModels = {};
    }
  }

  const modelKey = sanitizeFileStem(model);
  previousModels[modelKey] = {
    model,
    modelDir,
    fileCount: fileNames.length,
    reusedExtraction,
    extractedInLastRun,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFile(manifestPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: {
      filePath: normalizedInputPath,
      fileName: path.basename(normalizedInputPath),
      fileSizeBytes: fileStats.size,
      fileMtimeMs: Math.trunc(fileStats.mtimeMs),
      sourceFingerprint: fingerprint,
    },
    cacheRoot,
    modelExportsDir,
    models: previousModels,
  });

  return {
    cacheRoot,
    modelExportsDir,
    modelDir,
    sourceFingerprint: fingerprint,
    sourceFilePath: normalizedInputPath,
    sourceFileSizeBytes: fileStats.size,
    sourceFileMtimeMs: Math.trunc(fileStats.mtimeMs),
    fileNames,
    reusedExtraction,
    extractedInLastRun,
  };
}

async function writeProcessingManifest(
  runDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(path.join(runDir, PROCESSING_MANIFEST_FILE), payload);
}

async function discoverModelsCached(
  pipeline: typeof import("@gptdataexport/pipeline"),
  inputFilePath: string,
): Promise<DiscoverModelsResult> {
  const normalizedInputPath = path.resolve(inputFilePath);
  const fileStats = await stat(normalizedInputPath);
  const cached = discoverModelsCache.get(normalizedInputPath);

  if (
    cached &&
    cached.fileSizeBytes === fileStats.size &&
    cached.fileMtimeMs === Math.trunc(fileStats.mtimeMs)
  ) {
    return cached.result;
  }

  const result = await pipeline.discoverModels(normalizedInputPath);
  discoverModelsCache.set(normalizedInputPath, {
    fileSizeBytes: fileStats.size,
    fileMtimeMs: Math.trunc(fileStats.mtimeMs),
    result,
  });
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseCardDraft(payload: unknown): CardDraft {
  const root = asRecord(payload);
  if (!root) {
    throw new Error("Invalid character card JSON.");
  }

  const data = asRecord(root.data) ?? root;

  return {
    name: toStringValue(data.name),
    description: toStringValue(data.description),
    personality: toStringValue(data.personality),
    scenario: toStringValue(data.scenario),
    firstMessage: toStringValue(data.firstMessage ?? data.first_mes),
  };
}

function parseMemories(payload: unknown): MemoryEntry[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const data = asRecord(root.data) ?? root;
  const rawEntries = Array.isArray(data.entries) ? data.entries : [];
  const out: MemoryEntry[] = [];

  for (let index = 0; index < rawEntries.length; index += 1) {
    const rawEntry = asRecord(rawEntries[index]);
    if (!rawEntry) {
      continue;
    }

    const content = toStringValue(rawEntry.content).trim();
    if (!content) {
      continue;
    }

    const memoryId = toStringValue(rawEntry.id) || `memory-${index + 1}`;
    const memoryName = toStringValue(rawEntry.name).trim() || memoryId;
    const keys = toStringArray(rawEntry.keys);
    out.push({
      id: memoryId,
      name: memoryName,
      keys: keys.length > 0 ? keys : splitIntoKeywords(content),
      content,
    });
  }

  return out;
}

async function readPersonaImagePath(outputDir: string): Promise<string | undefined> {
  const assetsPath = path.join(outputDir, PERSONA_ASSETS_FILE);
  if (!(await fileExists(assetsPath))) {
    return undefined;
  }

  try {
    const raw = await readFile(assetsPath, "utf8");
    const parsed = asRecord(JSON.parse(raw));
    const imageFile = toStringValue(parsed?.imageFile);
    if (!imageFile) {
      return undefined;
    }

    const resolvedPath = path.resolve(outputDir, imageFile);
    if (await fileExists(resolvedPath)) {
      return resolvedPath;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function removePersonaImageFiles(outputDir: string): Promise<void> {
  try {
    const entries = await readdir(outputDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^persona_image\.[a-z0-9]{1,8}$/i.test(entry.name))
        .map((entry) => unlink(path.join(outputDir, entry.name)).catch(() => undefined)),
    );
  } catch {
    // Ignore cleanup failures.
  }
}

async function persistPersonaImage(
  outputDir: string,
  sourcePath: string | undefined,
): Promise<string | undefined> {
  const assetsPath = path.join(outputDir, PERSONA_ASSETS_FILE);
  const cleanedPath = sourcePath?.trim() ?? "";

  if (!cleanedPath) {
    await removePersonaImageFiles(outputDir);
    try {
      await unlink(assetsPath);
    } catch {
      // Ignore when no prior asset metadata exists.
    }
    return undefined;
  }

  const resolvedSourcePath = path.resolve(cleanedPath);
  const sourceStats = await stat(resolvedSourcePath);
  if (!sourceStats.isFile()) {
    throw new Error("Persona image path must point to a file.");
  }

  const image = nativeImage.createFromPath(resolvedSourcePath);
  if (image.isEmpty()) {
    throw new Error("Selected persona image could not be decoded.");
  }

  await removePersonaImageFiles(outputDir);

  const targetFileName = PERSONA_IMAGE_FILE;
  const targetPath = path.join(outputDir, targetFileName);
  await writeFile(targetPath, image.toPNG());

  await writeJsonFile(assetsPath, {
    imageFile: targetFileName,
    sourceFileName: path.basename(resolvedSourcePath),
    updatedAt: new Date().toISOString(),
  });

  return targetPath;
}

async function importFile(request: ImportFileRequest): Promise<BridgeResult<import("@gptdataexport/shared").ImportFileResult>> {
  const pipeline = await getPipelineModule();
  const normalizedFilePath = path.resolve(request.filePath);
  const fileStats = await stat(normalizedFilePath);
  const discover = await discoverModelsCached(pipeline, normalizedFilePath);

  return ok({
    filePath: normalizedFilePath,
    fileName: path.basename(normalizedFilePath),
    fileSizeBytes: fileStats.size,
    conversationCount: discover.totalConversations,
  });
}

async function selectImportFile(): Promise<BridgeResult<SelectImportFileResult>> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const dialogOptions: OpenDialogOptions = {
    title: "Import OpenAI Export",
    properties: ["openFile"],
    filters: [
      { name: "OpenAI export", extensions: ["zip", "json"] },
      { name: "JSON", extensions: ["json"] },
      { name: "ZIP", extensions: ["zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const picked = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (picked.canceled || picked.filePaths.length === 0) {
    return ok({
      cancelled: true,
    });
  }

  const normalizedFilePath = path.resolve(picked.filePaths[0] ?? "");
  if (!normalizedFilePath) {
    return ok({
      cancelled: true,
    });
  }

  const fileStats = await stat(normalizedFilePath);
  return ok({
    cancelled: false,
    filePath: normalizedFilePath,
    fileName: path.basename(normalizedFilePath),
    fileSizeBytes: fileStats.size,
  });
}

async function selectExportDirectory(
  request: SelectExportDirectoryRequest,
): Promise<
  BridgeResult<import("@gptdataexport/shared").SelectExportDirectoryResult>
> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const defaultPath = request.defaultPath?.trim();
  const dialogOptions: OpenDialogOptions = {
    title: "Choose Export Directory",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const picked = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (picked.canceled || picked.filePaths.length === 0) {
    return ok({
      cancelled: true,
    });
  }

  const directoryPath = path.resolve(picked.filePaths[0] ?? "");
  if (!directoryPath) {
    return ok({
      cancelled: true,
    });
  }

  return ok({
    cancelled: false,
    directoryPath,
  });
}

async function selectPersonaImageFile(
  _request: SelectPersonaImageFileRequest,
): Promise<
  BridgeResult<import("@gptdataexport/shared").SelectPersonaImageFileResult>
> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const dialogOptions: OpenDialogOptions = {
    title: "Select Persona Image",
    properties: ["openFile"],
  };
  const picked = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (picked.canceled || picked.filePaths.length === 0) {
    return ok({
      cancelled: true,
    });
  }

  const filePath = path.resolve(picked.filePaths[0] ?? "");
  if (!filePath) {
    return ok({
      cancelled: true,
    });
  }

  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    return fail("Selected file is not a supported image.");
  }

  return ok({
    cancelled: false,
    filePath,
    fileName: path.basename(filePath),
    previewDataUrl: image.toDataURL(),
  });
}

async function listReviewDirectories(
  _request: ListReviewDirectoriesRequest,
): Promise<
  BridgeResult<import("@gptdataexport/shared").ListReviewDirectoriesResult>
> {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }

  const entries = await readdir(appPaths.jobsDir, { withFileTypes: true });
  const rows: Array<{ directoryPath: string; newestMtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === EXTRACTION_CACHE_DIR) {
      continue;
    }
    const directoryPath = path.join(appPaths.jobsDir, entry.name);
    const cardPath = path.join(directoryPath, "character_card_v3.json");
    const lorebookPath = path.join(directoryPath, "lorebook_v3.json");

    if (!(await fileExists(cardPath)) || !(await fileExists(lorebookPath))) {
      continue;
    }

    const [cardStats, lorebookStats] = await Promise.all([stat(cardPath), stat(lorebookPath)]);
    rows.push({
      directoryPath,
      newestMtimeMs: Math.max(cardStats.mtimeMs, lorebookStats.mtimeMs),
    });
  }

  rows.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs || a.directoryPath.localeCompare(b.directoryPath));

  return ok({
    directories: rows.map((row) => row.directoryPath),
  });
}

async function analyzeModels(request: import("@gptdataexport/shared").AnalyzeModelsRequest): Promise<BridgeResult<import("@gptdataexport/shared").AnalyzeModelsResult>> {
  const pipeline = await getPipelineModule();
  const normalizedFilePath = path.resolve(request.filePath);
  const discovered = await discoverModelsCached(pipeline, normalizedFilePath);

  const models = Object.entries(discovered.conversationCounts)
    .map(([model, conversations]) => ({
      model,
      conversations,
    }))
    .sort((a, b) => b.conversations - a.conversations || a.model.localeCompare(b.model));

  return ok({
    models,
    totalConversations: discovered.totalConversations,
  });
}

async function prepareCache(
  request: PrepareCacheRequest,
): Promise<BridgeResult<import("@gptdataexport/shared").PrepareCacheResult>> {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }
  const pipeline = await getPipelineModule();
  const normalizedFilePath = path.resolve(request.filePath);

  const cache = await ensureExtractionCache(
    pipeline,
    appPaths.jobsDir,
    normalizedFilePath,
    request.model,
  );

  return ok({
    model: request.model,
    cacheRoot: cache.cacheRoot,
    modelDir: cache.modelDir,
    totalExtractedFiles: cache.fileNames.length,
    reusedExtraction: cache.reusedExtraction,
    extractedInLastRun: cache.extractedInLastRun,
  });
}

async function listProviderModels(
  request: ListProviderModelsRequest,
): Promise<BridgeResult<import("@gptdataexport/shared").ListProviderModelsResult>> {
  const data = await fetchProviderModelsLive(request);
  return ok(data);
}

async function runFidelity(
  request: FidelityRequest,
): Promise<BridgeResult<import("@gptdataexport/shared").FidelityResult>> {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }

  const runRootDir = request.outputDir?.trim().length
    ? request.outputDir.trim()
    : path.join(appPaths.jobsDir, "fidelity_runs");

  const result = await runLiveFidelity({
    request,
    runRootDir,
  });
  return ok(result);
}

async function extractAndGenerate(request: GenerateRequest): Promise<BridgeResult<import("@gptdataexport/shared").GenerateResult>> {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }
  const trackedJob = createTrackedJob("generate", request.filePath);
  const generationAbort = new AbortController();
  generationAbortControllers.set(trackedJob.jobId, generationAbort);
  let runLogPath = "";
  updateTrackedJob(
    trackedJob,
    "queued",
    request.appendMemories ? "Queued memory append run." : "Queued persona recovery run.",
    0,
  );

  const publishGenerationProgress = (event: GenerationProgressEvent): void => {
    let progress = 10;
    if (event.phase === "init") {
      progress = 12;
    } else if (event.phase === "preflight") {
      progress = 20;
    } else if (event.phase === "manifest") {
      progress = 96;
    } else if (event.phase === "done") {
      progress = 98;
    } else if (event.totalCalls > 0) {
      const ratio = event.completedCalls / event.totalCalls;
      progress = Math.max(22, Math.min(95, Math.floor(22 + ratio * 72)));
    }

    const statsSuffix =
      event.totalCalls > 0
        ? ` | calls ${event.completedCalls}/${event.totalCalls}, active ${event.activeCalls}, failed ${event.failedCalls}`
        : "";
    updateTrackedJob(
      trackedJob,
      "running",
      `${event.message}${statsSuffix}`,
      progress,
      {
        startedCalls: event.startedCalls,
        completedCalls: event.completedCalls,
        failedCalls: event.failedCalls,
        activeCalls: event.activeCalls,
        totalCalls: event.totalCalls,
      },
    );
    if (runLogPath) {
      const statsSuffix =
        event.totalCalls > 0
          ? ` | started=${event.startedCalls} completed=${event.completedCalls} failed=${event.failedCalls} active=${event.activeCalls} total=${event.totalCalls}`
          : "";
      appendFileLog(
        runLogPath,
        `[progress:${event.phase}] ${event.message}${statsSuffix}`,
      );
    }
  };

  const pipeline = await getPipelineModule();
  const appendMemories = Boolean(request.appendMemories);
  const requestedOutputDir = request.outputDir?.trim() ?? "";

  if (appendMemories && !requestedOutputDir) {
    updateTrackedJob(trackedJob, "failed", "Append mode requires an existing output directory.", 100);
    return fail("Append mode requires an existing output directory.");
  }

  try {
    updateTrackedJob(trackedJob, "running", "Preparing extracted JSONL cache...", 6);
    const cache = await ensureExtractionCache(
      pipeline,
      appPaths.jobsDir,
      request.filePath,
      request.model,
    );

    const runDir = appendMemories
      ? requestedOutputDir
      : requestedOutputDir || deriveRecoveryRunDir(appPaths.jobsDir, request, cache.sourceFingerprint);
    const manifestPath = path.join(runDir, "scan_manifest.json");

    updateTrackedJob(trackedJob, "running", "Preparing output directory...", 8);
    await mkdir(runDir, { recursive: true });
    runLogPath = path.join(runDir, "generation_debug.log");
    appendFileLog(
      runLogPath,
      `[start] jobId=${trackedJob.jobId} mode=${appendMemories ? "append_memories" : "full_generation"} model=${request.model} llmProvider=${request.llmProvider ?? ""} llmModel=${request.llmModel ?? ""}`,
    );
    appendFileLog(
      runLogPath,
      `[input] filePath=${path.resolve(request.filePath)} maxConversations=${request.maxConversations} maxMemories=${request.maxMemories ?? ""} maxMessagesPerConversation=${request.maxMessagesPerConversation ?? ""} maxCharsPerConversation=${request.maxCharsPerConversation ?? ""} maxTotalChars=${request.maxTotalChars ?? ""} requestTimeout=${request.requestTimeout ?? ""}`,
    );

    const cardPath = path.join(runDir, "character_card_v3.json");
    const lorePath = path.join(runDir, "lorebook_v3.json");
    const personaPayloadPath = path.join(runDir, "persona_payload.json");
    const memoriesPayloadPath = path.join(runDir, "memories_payload.json");

    let existingCard: CardDraft | undefined;
    let existingMemories: MemoryEntry[] | undefined;

    if (appendMemories) {
      updateTrackedJob(trackedJob, "running", "Loading existing persona outputs for append mode...", 10);
      if (await fileExists(cardPath)) {
        existingCard = parseCardDraft(JSON.parse(await readFile(cardPath, "utf8")));
      }
      if (await fileExists(lorePath)) {
        existingMemories = parseMemories(JSON.parse(await readFile(lorePath, "utf8")));
      } else {
        existingMemories = [];
      }
    }

    updateTrackedJob(trackedJob, "running", "Starting live LLM extraction...", 12);
    const generation = await runLiveGeneration({
      pipeline,
      modelDir: cache.modelDir,
      availableFiles: cache.fileNames,
      runDir,
      manifestPath,
      request,
      appendMemories,
      signal: generationAbort.signal,
      onProgress: publishGenerationProgress,
      ...(existingCard ? { existingCard } : {}),
      ...(existingMemories ? { existingMemories } : {}),
    });

    updateTrackedJob(trackedJob, "running", "Writing generation artifacts...", 98);
    await writeJsonFile(cardPath, generation.cardV3);
    await writeJsonFile(lorePath, generation.lorebookWrapper);
    await writeJsonFile(personaPayloadPath, generation.personaPayload);
    await writeJsonFile(memoriesPayloadPath, generation.memoriesPayload);

    const processingManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      mode: appendMemories ? "append_memories" : "full_generation",
      source: {
        inputPath: cache.sourceFilePath,
        sourceFingerprint: cache.sourceFingerprint,
        fileSizeBytes: cache.sourceFileSizeBytes,
        fileMtimeMs: cache.sourceFileMtimeMs,
      },
      model: request.model,
      extractionCache: {
        cacheRoot: cache.cacheRoot,
        modelDir: cache.modelDir,
        reusedExtraction: cache.reusedExtraction,
        extractedInLastRun: cache.extractedInLastRun,
        totalExtractedFiles: cache.fileNames.length,
      },
      scan: {
        requestedMaxConversations: request.maxConversations,
        selectedPersonaFiles: generation.selectedPersonaFiles,
        selectedMemoryFiles: generation.selectedMemoryFiles,
        processedMemoryFiles: generation.newMemoryFilesProcessed,
        skippedMemoryFiles: generation.skippedMemoryFiles,
        totalAvailableFiles: cache.fileNames.length,
      },
      outputs: {
        outputDir: runDir,
        cardPath,
        lorebookPath: lorePath,
        personaPayloadPath,
        memoriesPayloadPath,
        transcriptPath: generation.transcriptPath,
        personaSourcesPath: generation.personaSourcesPath,
        memorySourcesPath: generation.memorySourcesPath,
        processingManifestPath: generation.processingManifestPath,
        generationReportPath: generation.generationReportPath,
      },
    } satisfies Record<string, unknown>;

    await writeProcessingManifest(runDir, processingManifest);

    if (appendMemories) {
      await appendFile(
        path.join(runDir, MEMORY_APPEND_HISTORY_FILE),
        `${JSON.stringify(processingManifest)}\n`,
        "utf8",
      );
    }

    const personaImagePath = await readPersonaImagePath(runDir);

    appendFileLog(runLogPath, `[done] ${generation.report}`);
    updateTrackedJob(trackedJob, "completed", generation.report, 100);
    return ok({
      card: generation.cardDraft,
      memories: generation.memories,
      outputDir: runDir,
      personaImagePath,
      personaImageDataUrl: toPersonaImageDataUrl(personaImagePath),
      report:
        `Used cached extraction (${cache.reusedExtraction ? "cache hit" : "cache refresh"}). ` +
        generation.report,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (generationAbort.signal.aborted) {
        if (runLogPath) {
          appendFileLog(runLogPath, "[cancelled] Generation cancelled by user.");
        }
        updateTrackedJob(trackedJob, "cancelled", "Generation stopped.", 100);
        return fail("Generation cancelled.");
      }
      const message = error instanceof Error ? error.message : String(error);
      appendRuntimeLog(`[generate:${trackedJob.jobId.slice(0, 8)}] failed ${errorToLogLine(error)}`);
      if (runLogPath) {
        appendFileLog(runLogPath, `[error] ${errorToLogLine(error)}`);
      }
      updateTrackedJob(trackedJob, "failed", message, 100);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    appendRuntimeLog(`[generate:${trackedJob.jobId.slice(0, 8)}] failed ${errorToLogLine(error)}`);
    if (runLogPath) {
      appendFileLog(runLogPath, `[error] ${errorToLogLine(error)}`);
    }
    updateTrackedJob(trackedJob, "failed", message, 100);
    throw error;
  } finally {
    generationAbortControllers.delete(trackedJob.jobId);
  }
}

async function loadReview(request: LoadReviewRequest): Promise<BridgeResult<import("@gptdataexport/shared").GenerateResult>> {
  const outputDir = request.outputDir.trim();
  if (!outputDir) {
    return fail("Output directory is required.");
  }

  const cardPath = path.join(outputDir, "character_card_v3.json");
  const lorebookPath = path.join(outputDir, "lorebook_v3.json");

  await access(cardPath);
  await access(lorebookPath);

  const [rawCard, rawLorebook] = await Promise.all([
    readFile(cardPath, "utf8"),
    readFile(lorebookPath, "utf8"),
  ]);

  const card = parseCardDraft(JSON.parse(rawCard));
  const memories = parseMemories(JSON.parse(rawLorebook));
  const personaImagePath = await readPersonaImagePath(outputDir);

  return ok({
    card,
    memories,
    outputDir,
    personaImagePath,
    personaImageDataUrl: toPersonaImageDataUrl(personaImagePath),
    report: `Loaded ${memories.length} memories from existing output files.`,
  });
}

async function saveReview(request: SaveReviewRequest): Promise<BridgeResult<import("@gptdataexport/shared").SaveReviewResult>> {
  if (!appPaths) {
    throw new Error("App paths are not initialized");
  }
  const pipeline = await getPipelineModule();

  const outputDir = request.outputDir?.trim().length
    ? request.outputDir.trim()
    : path.join(appPaths.jobsDir, makeRunDirName("review"));

  try {
    await access(outputDir);
  } catch {
    await mkdir(outputDir, { recursive: true });
  }

  const cardV3 = pipeline.shapeCharacterCardV3Draft({
    name: request.card.name,
    description: request.card.description,
    personality: request.card.personality,
    scenario: request.card.scenario,
    firstMessage: request.card.firstMessage,
    messageExample: "",
    creatorNotes: "Saved from desktop review editor.",
    tags: ["companion", "reviewed"],
    systemPrompt: "Maintain continuity with preserved card + lorebook data.",
    postHistoryInstructions: "Reference memories before inferring missing context.",
  });

  const memoryCandidates: MemoryCandidate[] = request.memories.map((memory, index) => ({
    name: toStringValue(memory.name).trim() || toStringValue(memory.id).trim() || `Memory ${index + 1}`,
    keys: memory.keys,
    content: memory.content,
    category: "shared_memory",
    priority: Math.max(1, 100 - index),
  }));

  const lorebook = pipeline.shapeLorebookV3(request.card.name || "Companion", memoryCandidates, {
    maxEntries: 200,
  });
  const lorebookWrapper = {
    spec: "lorebook_v3",
    data: lorebook,
  } satisfies Record<string, unknown>;

  const cardPath = path.join(outputDir, "character_card_v3.json");
  const memoriesPath = path.join(outputDir, "lorebook_v3.json");

  await writeJsonFile(cardPath, cardV3);
  await writeJsonFile(memoriesPath, lorebookWrapper);

  const sourcePersonaImagePath =
    request.personaImagePath !== undefined
      ? request.personaImagePath
      : await readPersonaImagePath(outputDir);
  const personaImagePath = await persistPersonaImage(outputDir, sourcePersonaImagePath);
  const personaImageDataUrl = toPersonaImageDataUrl(personaImagePath);

  const exportFileBase = exportBaseName(request.card.name || cardV3.data.name || "companion");
  const exportedPngPath = path.join(outputDir, `${exportFileBase}.png`);
  const exportedCardJsonPath = path.join(outputDir, `${exportFileBase}.json`);
  const exportedLorebookPath = path.join(outputDir, `${exportFileBase}.lorebook.json`);

  const cardPayload = toSillyTavernCardPayload(cardV3, lorebook, request.creatorName);
  const pngSourceBuffer = personaImagePath ? await readFile(personaImagePath) : PLACEHOLDER_PNG;
  const exportedPng = embedCardInPng(Buffer.from(pngSourceBuffer), cardPayload);

  await writeFile(exportedPngPath, exportedPng);
  await writeJsonFile(exportedCardJsonPath, cardPayload);
  await writeJsonFile(exportedLorebookPath, lorebookWrapper);

  return ok({
    saved: true,
    outputDir,
    cardPath: exportedPngPath,
    memoriesPath: exportedLorebookPath,
    personaImagePath,
    personaImageDataUrl,
  });
}

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }

  ipcMain.handle(IpcInvokeChannel.GetAppPaths, (_event, payload: unknown) => {
    parseIpcInvokeRequest(IpcInvokeChannel.GetAppPaths, payload);
    if (!appPaths) {
      throw new Error("App paths not initialized");
    }

    return parseIpcInvokeResponse(IpcInvokeChannel.GetAppPaths, appPaths);
  });

  ipcMain.handle(IpcInvokeChannel.LoadRendererSettings, async (_event, payload: unknown) => {
    parseIpcInvokeRequest(IpcInvokeChannel.LoadRendererSettings, payload);
    const result = await loadRendererSettings().catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.LoadRendererSettings, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.LoadRendererSettings, result);
  });

  ipcMain.handle(IpcInvokeChannel.SaveRendererSettings, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.SaveRendererSettings, payload);
    const result = await saveRendererSettings(request as SaveRendererSettingsRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.SaveRendererSettings, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.SaveRendererSettings, result);
  });

  ipcMain.handle(IpcInvokeChannel.StartJob, (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.StartJob, payload);

    const jobId = randomUUID();
    const timestamp = nowTs();
    const job: ManagedJob = {
      jobId,
      jobType: request.jobType,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      inputPath: request.inputPath,
    };

    jobStore.set(jobId, job);
    emitJobEvent(jobId, job.jobType, job.status, "Job queued", 0);

    return parseIpcInvokeResponse(IpcInvokeChannel.StartJob, {
      accepted: true,
      jobId,
    });
  });

  ipcMain.handle(IpcInvokeChannel.CancelJob, (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.CancelJob, payload);
    const job = jobStore.get(request.jobId);
    const generationAbort = generationAbortControllers.get(request.jobId);

    if (!job && !generationAbort) {
      return parseIpcInvokeResponse(IpcInvokeChannel.CancelJob, {
        jobId: request.jobId,
        cancelled: false,
      });
    }

    if (generationAbort) {
      generationAbort.abort();
    }

    if (!job) {
      return parseIpcInvokeResponse(IpcInvokeChannel.CancelJob, {
        jobId: request.jobId,
        cancelled: true,
      });
    }

    if (["completed", "failed", "cancelled"].includes(job.status) && !generationAbort) {
      return parseIpcInvokeResponse(IpcInvokeChannel.CancelJob, {
        jobId: request.jobId,
        cancelled: false,
      });
    }

    job.status = "cancelled";
    job.updatedAt = nowTs();
    emitJobEvent(job.jobId, job.jobType, job.status, "Job cancelled", 0);

    return parseIpcInvokeResponse(IpcInvokeChannel.CancelJob, {
      jobId: request.jobId,
      cancelled: true,
    });
  });

  ipcMain.handle(IpcInvokeChannel.ListJobs, (_event, payload: unknown) => {
    parseIpcInvokeRequest(IpcInvokeChannel.ListJobs, payload);

    const jobs = [...jobStore.values()].sort((a, b) => b.createdAt - a.createdAt);

    return parseIpcInvokeResponse(IpcInvokeChannel.ListJobs, {
      jobs,
    });
  });

  ipcMain.handle(IpcInvokeChannel.SelectImportFile, async (_event, payload: unknown) => {
    parseIpcInvokeRequest(IpcInvokeChannel.SelectImportFile, payload);
    const result = await selectImportFile().catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.SelectImportFile, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.SelectImportFile, result);
  });

  ipcMain.handle(IpcInvokeChannel.SelectExportDirectory, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.SelectExportDirectory, payload);
    const result = await selectExportDirectory(request as SelectExportDirectoryRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.SelectExportDirectory, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.SelectExportDirectory, result);
  });

  ipcMain.handle(IpcInvokeChannel.SelectPersonaImageFile, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.SelectPersonaImageFile, payload);
    const result = await selectPersonaImageFile(request as SelectPersonaImageFileRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.SelectPersonaImageFile, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.SelectPersonaImageFile, result);
  });

  ipcMain.handle(IpcInvokeChannel.ListReviewDirectories, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.ListReviewDirectories, payload);
    const result = await listReviewDirectories(request as ListReviewDirectoriesRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.ListReviewDirectories, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.ListReviewDirectories, result);
  });

  ipcMain.handle(IpcInvokeChannel.ImportFile, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.ImportFile, payload);
    const result = await importFile(request as ImportFileRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.ImportFile, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.ImportFile, result);
  });

  ipcMain.handle(IpcInvokeChannel.AnalyzeModels, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.AnalyzeModels, payload);
    const result = await analyzeModels(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.AnalyzeModels, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.AnalyzeModels, result);
  });

  ipcMain.handle(IpcInvokeChannel.ListProviderModels, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.ListProviderModels, payload);
    const result = await listProviderModels(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.ListProviderModels, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.ListProviderModels, result);
  });

  ipcMain.handle(IpcInvokeChannel.PrepareCache, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.PrepareCache, payload);
    const result = await prepareCache(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.PrepareCache, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.PrepareCache, result);
  });

  ipcMain.handle(IpcInvokeChannel.ExtractAndGenerate, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.ExtractAndGenerate, payload);
    const result = await extractAndGenerate(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.ExtractAndGenerate, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.ExtractAndGenerate, result);
  });

  ipcMain.handle(IpcInvokeChannel.RunFidelity, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.RunFidelity, payload);
    const result = await runFidelity(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.RunFidelity, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.RunFidelity, result);
  });

  ipcMain.handle(IpcInvokeChannel.LoadReview, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.LoadReview, payload);
    const result = await loadReview(request).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.LoadReview, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.LoadReview, result);
  });

  ipcMain.handle(IpcInvokeChannel.SaveReview, async (_event, payload: unknown) => {
    const request = parseIpcInvokeRequest(IpcInvokeChannel.SaveReview, payload);
    const result = await saveReview(request as SaveReviewRequest).catch((error: unknown) =>
      logIpcError(IpcInvokeChannel.SaveReview, error),
    );
    return parseIpcInvokeResponse(IpcInvokeChannel.SaveReview, result);
  });

  ipcRegistered = true;
}

async function bootstrap(): Promise<void> {
  await loadDotEnvFromWorkspace();
  appPaths = await initAppPaths();
  appendRuntimeLog("Bootstrapping desktop shell...");
  registerIpcHandlers();
  await createMainWindow();
  appendRuntimeLog("Desktop shell window ready.");
}

app.whenReady().then(() => {
  process.on("unhandledRejection", (reason) => {
    appendRuntimeLog(`[unhandledRejection] ${errorToLogLine(reason)}`);
    console.error("Unhandled rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    appendRuntimeLog(`[uncaughtException] ${errorToLogLine(error)}`);
    console.error("Uncaught exception", error);
  });

  bootstrap().catch((error) => {
    appendRuntimeLog(`[bootstrap-failed] ${errorToLogLine(error)}`);
    console.error("Failed to bootstrap desktop shell", error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
