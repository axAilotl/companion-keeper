import type {
  AnalyzeModelsRequest,
  AnalyzeModelsResult,
  BridgeResult,
  FidelityRequest,
  FidelityResult,
  GenerateRequest,
  GenerateResult,
  ImportFileRequest,
  ImportFileResult,
  LoadRendererSettingsRequest,
  LoadRendererSettingsResult,
  ListReviewDirectoriesRequest,
  ListReviewDirectoriesResult,
  ListProviderModelsRequest,
  ListProviderModelsResult,
  LoadReviewRequest,
  PrepareCacheRequest,
  PrepareCacheResult,
  SelectExportDirectoryRequest,
  SelectExportDirectoryResult,
  SelectPersonaImageFileRequest,
  SelectPersonaImageFileResult,
  RendererBridge,
  SaveRendererSettingsRequest,
  SaveRendererSettingsResult,
  SaveReviewRequest,
  SaveReviewResult,
  SelectImportFileRequest,
  SelectImportFileResult
} from "@gptdataexport/shared";

export type ClientMode = "ipc";

const CHANNELS = {
  selectImportFile: "pipeline:select-import-file",
  selectExportDirectory: "pipeline:select-export-directory",
  selectPersonaImageFile: "pipeline:select-persona-image-file",
  listReviewDirectories: "pipeline:list-review-directories",
  importFile: "pipeline:import-file",
  analyzeModels: "pipeline:analyze-models",
  loadRendererSettings: "app:load-renderer-settings",
  saveRendererSettings: "app:save-renderer-settings",
  listProviderModels: "pipeline:list-provider-models",
  prepareCache: "pipeline:prepare-cache",
  extractAndGenerate: "pipeline:extract-and-generate",
  runFidelity: "pipeline:run-fidelity",
  loadReview: "pipeline:load-review",
  saveReview: "pipeline:save-review"
} as const;

const normalizeBridgeResult = <T>(raw: unknown): BridgeResult<T> => {
  if (raw && typeof raw === "object" && "ok" in raw) {
    return raw as BridgeResult<T>;
  }

  return {
    ok: true,
    data: raw as T
  };
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const getBridge = (): RendererBridge | undefined => window.rendererBridge;

const getInvoke = (): ((channel: string, payload?: unknown) => Promise<unknown>) | undefined =>
  window.electronAPI?.invoke;

export interface RendererClient {
  getMode: () => ClientMode;
  selectImportFile: (
    request: SelectImportFileRequest
  ) => Promise<BridgeResult<SelectImportFileResult>>;
  selectExportDirectory: (
    request: SelectExportDirectoryRequest
  ) => Promise<BridgeResult<SelectExportDirectoryResult>>;
  selectPersonaImageFile: (
    request: SelectPersonaImageFileRequest
  ) => Promise<BridgeResult<SelectPersonaImageFileResult>>;
  listReviewDirectories: (
    request: ListReviewDirectoriesRequest
  ) => Promise<BridgeResult<ListReviewDirectoriesResult>>;
  importFile: (request: ImportFileRequest) => Promise<BridgeResult<ImportFileResult>>;
  analyzeModels: (request: AnalyzeModelsRequest) => Promise<BridgeResult<AnalyzeModelsResult>>;
  loadRendererSettings: (
    request: LoadRendererSettingsRequest
  ) => Promise<BridgeResult<LoadRendererSettingsResult>>;
  saveRendererSettings: (
    request: SaveRendererSettingsRequest
  ) => Promise<BridgeResult<SaveRendererSettingsResult>>;
  listProviderModels: (request: ListProviderModelsRequest) => Promise<BridgeResult<ListProviderModelsResult>>;
  prepareCache: (request: PrepareCacheRequest) => Promise<BridgeResult<PrepareCacheResult>>;
  extractAndGenerate: (request: GenerateRequest) => Promise<BridgeResult<GenerateResult>>;
  runFidelity: (request: FidelityRequest) => Promise<BridgeResult<FidelityResult>>;
  loadReview: (request: LoadReviewRequest) => Promise<BridgeResult<GenerateResult>>;
  saveReview: (request: SaveReviewRequest) => Promise<BridgeResult<SaveReviewResult>>;
}

export const createRendererClient = (): RendererClient => {
  const mode: ClientMode = "ipc";

  const call = async <TRequest, TResult>(
    method: keyof RendererBridge,
    channel: string,
    request: TRequest
  ): Promise<BridgeResult<TResult>> => {
    const bridge = getBridge();
    if (bridge && typeof bridge[method] === "function") {
      try {
        const result = await (bridge[method] as (req: TRequest) => Promise<unknown>)(request);
        return normalizeBridgeResult<TResult>(result);
      } catch (error) {
        return {
          ok: false,
          error: toErrorMessage(error)
        };
      }
    }

    const invoke = getInvoke();
    if (invoke) {
      try {
        const result = await invoke(channel, request);
        return normalizeBridgeResult<TResult>(result);
      } catch (error) {
        return {
          ok: false,
          error: toErrorMessage(error)
        };
      }
    }

    return {
      ok: false,
      error: "Desktop IPC bridge unavailable. Start the Electron desktop shell."
    };
  };

  return {
    getMode: () => mode,
    selectImportFile: async (request) =>
      await call<SelectImportFileRequest, SelectImportFileResult>(
        "selectImportFile",
        CHANNELS.selectImportFile,
        request
      ),
    selectExportDirectory: async (request) =>
      await call<SelectExportDirectoryRequest, SelectExportDirectoryResult>(
        "selectExportDirectory",
        CHANNELS.selectExportDirectory,
        request
      ),
    selectPersonaImageFile: async (request) =>
      await call<SelectPersonaImageFileRequest, SelectPersonaImageFileResult>(
        "selectPersonaImageFile",
        CHANNELS.selectPersonaImageFile,
        request
      ),
    listReviewDirectories: async (request) =>
      await call<ListReviewDirectoriesRequest, ListReviewDirectoriesResult>(
        "listReviewDirectories",
        CHANNELS.listReviewDirectories,
        request
      ),
    importFile: async (request) =>
      await call<ImportFileRequest, ImportFileResult>(
        "importFile",
        CHANNELS.importFile,
        request
      ),
    analyzeModels: async (request) =>
      await call<AnalyzeModelsRequest, AnalyzeModelsResult>(
        "analyzeModels",
        CHANNELS.analyzeModels,
        request
      ),
    loadRendererSettings: async (request) =>
      await call<LoadRendererSettingsRequest, LoadRendererSettingsResult>(
        "loadRendererSettings",
        CHANNELS.loadRendererSettings,
        request
      ),
    saveRendererSettings: async (request) =>
      await call<SaveRendererSettingsRequest, SaveRendererSettingsResult>(
        "saveRendererSettings",
        CHANNELS.saveRendererSettings,
        request
      ),
    listProviderModels: async (request) =>
      await call<ListProviderModelsRequest, ListProviderModelsResult>(
        "listProviderModels",
        CHANNELS.listProviderModels,
        request
      ),
    prepareCache: async (request) =>
      await call<PrepareCacheRequest, PrepareCacheResult>(
        "prepareCache",
        CHANNELS.prepareCache,
        request
      ),
    extractAndGenerate: async (request) =>
      await call<GenerateRequest, GenerateResult>(
        "extractAndGenerate",
        CHANNELS.extractAndGenerate,
        request
      ),
    runFidelity: async (request) =>
      await call<FidelityRequest, FidelityResult>(
        "runFidelity",
        CHANNELS.runFidelity,
        request
      ),
    loadReview: async (request) =>
      await call<LoadReviewRequest, GenerateResult>(
        "loadReview",
        CHANNELS.loadReview,
        request
      ),
    saveReview: async (request) =>
      await call<SaveReviewRequest, SaveReviewResult>(
        "saveReview",
        CHANNELS.saveReview,
        request
      )
  };
};
