import { z } from "zod";

export const IpcInvokeChannel = {
  GetAppPaths: "app:get-paths",
  LoadRendererSettings: "app:load-renderer-settings",
  SaveRendererSettings: "app:save-renderer-settings",
  StartJob: "jobs:start",
  CancelJob: "jobs:cancel",
  ListJobs: "jobs:list",
  SelectImportFile: "pipeline:select-import-file",
  SelectExportDirectory: "pipeline:select-export-directory",
  SelectPersonaImageFile: "pipeline:select-persona-image-file",
  ListReviewDirectories: "pipeline:list-review-directories",
  ImportFile: "pipeline:import-file",
  PrepareCache: "pipeline:prepare-cache",
  AnalyzeModels: "pipeline:analyze-models",
  ListProviderModels: "pipeline:list-provider-models",
  ExtractAndGenerate: "pipeline:extract-and-generate",
  RunFidelity: "pipeline:run-fidelity",
  LoadReview: "pipeline:load-review",
  SaveReview: "pipeline:save-review",
} as const;

export type IpcInvokeChannel =
  (typeof IpcInvokeChannel)[keyof typeof IpcInvokeChannel];

export const IpcEventChannel = {
  JobEvent: "jobs:event",
} as const;

export type IpcEventChannel =
  (typeof IpcEventChannel)[keyof typeof IpcEventChannel];

const emptyRequestSchema = z.object({}).strict();

export const bridgeErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().min(1),
  })
  .strict();

export function bridgeResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        data: dataSchema,
      })
      .strict(),
    bridgeErrorSchema,
  ]);
}

export type BridgeResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };

export const jobTypeSchema = z.enum(["extract", "dataset", "generate"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const appPathsSchema = z
  .object({
    userDataDir: z.string().min(1),
    logsDir: z.string().min(1),
    jobsDir: z.string().min(1),
    tempDir: z.string().min(1),
  })
  .strict();
export type AppPaths = z.infer<typeof appPathsSchema>;

export const loadRendererSettingsRequestSchema = emptyRequestSchema;
export type LoadRendererSettingsRequest = z.infer<typeof loadRendererSettingsRequestSchema>;

export const loadRendererSettingsResultSchema = z
  .object({
    settingsJson: z.string().optional(),
    path: z.string().optional(),
  })
  .strict();
export type LoadRendererSettingsResult = z.infer<typeof loadRendererSettingsResultSchema>;

export const saveRendererSettingsRequestSchema = z
  .object({
    settingsJson: z.string().min(2),
  })
  .strict();
export type SaveRendererSettingsRequest = z.infer<typeof saveRendererSettingsRequestSchema>;

export const saveRendererSettingsResultSchema = z
  .object({
    saved: z.literal(true),
    path: z.string().min(1),
  })
  .strict();
export type SaveRendererSettingsResult = z.infer<typeof saveRendererSettingsResultSchema>;

export const startJobRequestSchema = z
  .object({
    jobType: jobTypeSchema,
    inputPath: z.string().min(1),
    options: z.record(z.unknown()).default({}),
  })
  .strict();
export type StartJobRequest = z.input<typeof startJobRequestSchema>;

export const startJobResponseSchema = z
  .object({
    accepted: z.literal(true),
    jobId: z.string().uuid(),
  })
  .strict();
export type StartJobResponse = z.infer<typeof startJobResponseSchema>;

export const cancelJobRequestSchema = z
  .object({
    jobId: z.string().uuid(),
  })
  .strict();
export type CancelJobRequest = z.infer<typeof cancelJobRequestSchema>;

export const cancelJobResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    cancelled: z.boolean(),
  })
  .strict();
export type CancelJobResponse = z.infer<typeof cancelJobResponseSchema>;

export const jobSummarySchema = z
  .object({
    jobId: z.string().uuid(),
    jobType: jobTypeSchema,
    status: jobStatusSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    inputPath: z.string().min(1),
  })
  .strict();
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const listJobsResponseSchema = z
  .object({
    jobs: z.array(jobSummarySchema),
  })
  .strict();
export type ListJobsResponse = z.infer<typeof listJobsResponseSchema>;

export const jobEventSchema = z
  .object({
    jobId: z.string().uuid(),
    jobType: jobTypeSchema,
    status: jobStatusSchema,
    timestamp: z.number().int().nonnegative(),
    message: z.string().min(1).optional(),
    progress: z.number().min(0).max(100).optional(),
    startedCalls: z.number().int().nonnegative().optional(),
    completedCalls: z.number().int().nonnegative().optional(),
    failedCalls: z.number().int().nonnegative().optional(),
    activeCalls: z.number().int().nonnegative().optional(),
    totalCalls: z.number().int().nonnegative().optional(),
  })
  .strict();
export type JobEvent = z.infer<typeof jobEventSchema>;

export const selectImportFileRequestSchema = emptyRequestSchema;
export type SelectImportFileRequest = z.infer<typeof selectImportFileRequestSchema>;

export const selectImportFileResultSchema = z
  .object({
    cancelled: z.boolean(),
    filePath: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SelectImportFileResult = z.infer<typeof selectImportFileResultSchema>;

export const selectExportDirectoryRequestSchema = z
  .object({
    defaultPath: z.string().min(1).optional(),
  })
  .strict();
export type SelectExportDirectoryRequest = z.infer<typeof selectExportDirectoryRequestSchema>;

export const selectExportDirectoryResultSchema = z
  .object({
    cancelled: z.boolean(),
    directoryPath: z.string().min(1).optional(),
  })
  .strict();
export type SelectExportDirectoryResult = z.infer<typeof selectExportDirectoryResultSchema>;

export const selectPersonaImageFileRequestSchema = emptyRequestSchema;
export type SelectPersonaImageFileRequest = z.infer<typeof selectPersonaImageFileRequestSchema>;

export const selectPersonaImageFileResultSchema = z
  .object({
    cancelled: z.boolean(),
    filePath: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    previewDataUrl: z.string().min(1).optional(),
  })
  .strict();
export type SelectPersonaImageFileResult = z.infer<typeof selectPersonaImageFileResultSchema>;

export const listReviewDirectoriesRequestSchema = emptyRequestSchema;
export type ListReviewDirectoriesRequest = z.infer<typeof listReviewDirectoriesRequestSchema>;

export const listReviewDirectoriesResultSchema = z
  .object({
    directories: z.array(z.string().min(1)),
  })
  .strict();
export type ListReviewDirectoriesResult = z.infer<typeof listReviewDirectoriesResultSchema>;

export const importFileRequestSchema = z
  .object({
    filePath: z.string().min(1),
  })
  .strict();
export type ImportFileRequest = z.infer<typeof importFileRequestSchema>;

export const importFileResultSchema = z
  .object({
    filePath: z.string().min(1),
    fileName: z.string().min(1),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    conversationCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ImportFileResult = z.infer<typeof importFileResultSchema>;

export const analyzeModelsRequestSchema = z
  .object({
    filePath: z.string().min(1),
  })
  .strict();
export type AnalyzeModelsRequest = z.infer<typeof analyzeModelsRequestSchema>;

export const prepareCacheRequestSchema = z
  .object({
    filePath: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type PrepareCacheRequest = z.infer<typeof prepareCacheRequestSchema>;

export const prepareCacheResultSchema = z
  .object({
    model: z.string().min(1),
    cacheRoot: z.string().min(1),
    modelDir: z.string().min(1),
    totalExtractedFiles: z.number().int().nonnegative(),
    reusedExtraction: z.boolean(),
    extractedInLastRun: z.number().int().nonnegative(),
  })
  .strict();
export type PrepareCacheResult = z.infer<typeof prepareCacheResultSchema>;

export const modelStatSchema = z
  .object({
    model: z.string().min(1),
    conversations: z.number().int().nonnegative(),
  })
  .strict();
export type ModelStat = z.infer<typeof modelStatSchema>;

export const analyzeModelsResultSchema = z
  .object({
    models: z.array(modelStatSchema),
    totalConversations: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyzeModelsResult = z.infer<typeof analyzeModelsResultSchema>;

export const generateRequestSchema = z
  .object({
    filePath: z.string().min(1),
    model: z.string().min(1),
    companionName: z.string().optional(),
    maxConversations: z.number().int().positive(),
    conversationSampling: z.enum(["weighted-random", "random-uniform", "top"]).optional(),
    samplingSeed: z.number().int().optional(),
    memorySampleConversations: z.number().int().nonnegative().optional(),
    outputDir: z.string().min(1).optional(),
    appendMemories: z.boolean().optional(),
    forceRerun: z.boolean().optional(),
    llmProvider: z.enum(["ollama", "openai", "openrouter", "anthropic"]).optional(),
    llmBaseUrl: z.string().optional(),
    llmModel: z.string().optional(),
    llmApiKey: z.string().optional(),
    llmSiteUrl: z.string().optional(),
    llmAppName: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    requestTimeout: z.number().int().positive().optional(),
    maxMemories: z.number().int().positive().optional(),
    memoryPerChatMax: z.number().int().positive().optional(),
    maxParallelCalls: z.number().int().positive().optional(),
    maxMessagesPerConversation: z.number().int().positive().optional(),
    maxCharsPerConversation: z.number().int().positive().optional(),
    maxTotalChars: z.number().int().positive().optional(),
    modelContextWindow: z.number().int().positive().optional(),
    promptOverrides: z.record(z.string()).optional(),
  })
  .strict();
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const cardDraftSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    personality: z.string(),
    scenario: z.string(),
    firstMessage: z.string(),
  })
  .strict();
export type CardDraft = z.infer<typeof cardDraftSchema>;

export const memoryEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)),
    content: z.string(),
  })
  .strict();
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const generateResultSchema = z
  .object({
    card: cardDraftSchema,
    memories: z.array(memoryEntrySchema),
    outputDir: z.string().optional(),
    report: z.string().optional(),
    personaImagePath: z.string().optional(),
    personaImageDataUrl: z.string().min(1).optional(),
  })
  .strict();
export type GenerateResult = z.infer<typeof generateResultSchema>;

export const saveReviewRequestSchema = z
  .object({
    card: cardDraftSchema,
    memories: z.array(memoryEntrySchema),
    outputDir: z.string().optional(),
    personaImagePath: z.string().optional(),
    creatorName: z.string().min(1).optional(),
  })
  .strict();
export type SaveReviewRequest = z.infer<typeof saveReviewRequestSchema>;

export const loadReviewRequestSchema = z
  .object({
    outputDir: z.string().min(1),
  })
  .strict();
export type LoadReviewRequest = z.infer<typeof loadReviewRequestSchema>;

export const saveReviewResultSchema = z
  .object({
    saved: z.boolean(),
    outputDir: z.string().min(1),
    cardPath: z.string().optional(),
    memoriesPath: z.string().optional(),
    personaImagePath: z.string().optional(),
    personaImageDataUrl: z.string().min(1).optional(),
  })
  .strict();
export type SaveReviewResult = z.infer<typeof saveReviewResultSchema>;

export const listProviderModelsRequestSchema = z
  .object({
    provider: z.enum(["ollama", "openai", "openrouter", "anthropic"]),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    siteUrl: z.string().optional(),
    appName: z.string().optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();
export type ListProviderModelsRequest = z.infer<typeof listProviderModelsRequestSchema>;

export const listProviderModelsResultSchema = z
  .object({
    models: z.array(z.string()),
    contextWindows: z.record(z.number().int().positive()),
  })
  .strict();
export type ListProviderModelsResult = z.infer<typeof listProviderModelsResultSchema>;

export const fidelityRequestSchema = z
  .object({
    card: cardDraftSchema,
    memories: z.array(memoryEntrySchema),
    outputDir: z.string().optional(),
    provider: z.enum(["ollama", "openai", "openrouter", "anthropic"]),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    siteUrl: z.string().optional(),
    appName: z.string().optional(),
    candidateModels: z.array(z.string().min(1)).min(1).max(5),
    testPrompts: z.array(z.string().min(1)).min(1).max(20),
    judgeModel: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();
export type FidelityRequest = z.infer<typeof fidelityRequestSchema>;

export const fidelityModelResultSchema = z
  .object({
    model: z.string().min(1),
    finalScore: z.number(),
    styleScore: z.number(),
    lexicalScore: z.number(),
    judgeScore: z.number(),
    judgeRationale: z.string(),
  })
  .strict();
export type FidelityModelResult = z.infer<typeof fidelityModelResultSchema>;

export const fidelityResultSchema = z
  .object({
    runDir: z.string().min(1),
    reportPath: z.string().min(1),
    summaryPath: z.string().min(1),
    markdownSummary: z.string(),
    results: z.array(fidelityModelResultSchema),
  })
  .strict();
export type FidelityResult = z.infer<typeof fidelityResultSchema>;

export const invokeContract = {
  [IpcInvokeChannel.GetAppPaths]: {
    request: emptyRequestSchema,
    response: appPathsSchema,
  },
  [IpcInvokeChannel.LoadRendererSettings]: {
    request: loadRendererSettingsRequestSchema,
    response: bridgeResultSchema(loadRendererSettingsResultSchema),
  },
  [IpcInvokeChannel.SaveRendererSettings]: {
    request: saveRendererSettingsRequestSchema,
    response: bridgeResultSchema(saveRendererSettingsResultSchema),
  },
  [IpcInvokeChannel.StartJob]: {
    request: startJobRequestSchema,
    response: startJobResponseSchema,
  },
  [IpcInvokeChannel.CancelJob]: {
    request: cancelJobRequestSchema,
    response: cancelJobResponseSchema,
  },
  [IpcInvokeChannel.ListJobs]: {
    request: emptyRequestSchema,
    response: listJobsResponseSchema,
  },
  [IpcInvokeChannel.SelectImportFile]: {
    request: selectImportFileRequestSchema,
    response: bridgeResultSchema(selectImportFileResultSchema),
  },
  [IpcInvokeChannel.SelectExportDirectory]: {
    request: selectExportDirectoryRequestSchema,
    response: bridgeResultSchema(selectExportDirectoryResultSchema),
  },
  [IpcInvokeChannel.SelectPersonaImageFile]: {
    request: selectPersonaImageFileRequestSchema,
    response: bridgeResultSchema(selectPersonaImageFileResultSchema),
  },
  [IpcInvokeChannel.ListReviewDirectories]: {
    request: listReviewDirectoriesRequestSchema,
    response: bridgeResultSchema(listReviewDirectoriesResultSchema),
  },
  [IpcInvokeChannel.ImportFile]: {
    request: importFileRequestSchema,
    response: bridgeResultSchema(importFileResultSchema),
  },
  [IpcInvokeChannel.AnalyzeModels]: {
    request: analyzeModelsRequestSchema,
    response: bridgeResultSchema(analyzeModelsResultSchema),
  },
  [IpcInvokeChannel.ListProviderModels]: {
    request: listProviderModelsRequestSchema,
    response: bridgeResultSchema(listProviderModelsResultSchema),
  },
  [IpcInvokeChannel.PrepareCache]: {
    request: prepareCacheRequestSchema,
    response: bridgeResultSchema(prepareCacheResultSchema),
  },
  [IpcInvokeChannel.ExtractAndGenerate]: {
    request: generateRequestSchema,
    response: bridgeResultSchema(generateResultSchema),
  },
  [IpcInvokeChannel.RunFidelity]: {
    request: fidelityRequestSchema,
    response: bridgeResultSchema(fidelityResultSchema),
  },
  [IpcInvokeChannel.LoadReview]: {
    request: loadReviewRequestSchema,
    response: bridgeResultSchema(generateResultSchema),
  },
  [IpcInvokeChannel.SaveReview]: {
    request: saveReviewRequestSchema,
    response: bridgeResultSchema(saveReviewResultSchema),
  },
} as const;

type InvokeContract = typeof invokeContract;

export type IpcInvokeRequest<C extends IpcInvokeChannel> = z.input<
  InvokeContract[C]["request"]
>;

export type IpcInvokeResponse<C extends IpcInvokeChannel> = z.output<
  InvokeContract[C]["response"]
>;

export function parseIpcInvokeRequest<C extends IpcInvokeChannel>(
  channel: C,
  payload: unknown,
): IpcInvokeRequest<C> {
  return invokeContract[channel].request.parse(payload);
}

export function parseIpcInvokeResponse<C extends IpcInvokeChannel>(
  channel: C,
  payload: unknown,
): IpcInvokeResponse<C> {
  return invokeContract[channel].response.parse(payload);
}

export function parseJobEvent(payload: unknown): JobEvent {
  return jobEventSchema.parse(payload);
}

export function ok<T>(data: T): BridgeResult<T> {
  return {
    ok: true,
    data,
  };
}

export function fail(error: unknown): BridgeResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: message,
  };
}
