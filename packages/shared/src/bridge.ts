import type {
  AnalyzeModelsRequest,
  AnalyzeModelsResult,
  AppPaths,
  BridgeResult,
  CancelJobRequest,
  CancelJobResponse,
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
  SelectExportDirectoryRequest,
  SelectExportDirectoryResult,
  SelectPersonaImageFileRequest,
  SelectPersonaImageFileResult,
  SelectImportFileRequest,
  SelectImportFileResult,
  LoadReviewRequest,
  PrepareCacheRequest,
  PrepareCacheResult,
  SaveRendererSettingsRequest,
  SaveRendererSettingsResult,
  JobEvent,
  ListJobsResponse,
  SaveReviewRequest,
  SaveReviewResult,
  StartJobRequest,
  StartJobResponse,
} from "./ipc";

export interface DesktopApi {
  getAppPaths: () => Promise<AppPaths>;
  startJob: (request: StartJobRequest) => Promise<StartJobResponse>;
  cancelJob: (request: CancelJobRequest) => Promise<CancelJobResponse>;
  listJobs: () => Promise<ListJobsResponse>;
  onJobEvent: (listener: (event: JobEvent) => void) => () => void;
}

export interface RendererBridge {
  selectImportFile: (
    request: SelectImportFileRequest,
  ) => Promise<BridgeResult<SelectImportFileResult>>;
  selectExportDirectory: (
    request: SelectExportDirectoryRequest,
  ) => Promise<BridgeResult<SelectExportDirectoryResult>>;
  selectPersonaImageFile: (
    request: SelectPersonaImageFileRequest,
  ) => Promise<BridgeResult<SelectPersonaImageFileResult>>;
  listReviewDirectories: (
    request: ListReviewDirectoriesRequest,
  ) => Promise<BridgeResult<ListReviewDirectoriesResult>>;
  importFile: (request: ImportFileRequest) => Promise<BridgeResult<ImportFileResult>>;
  analyzeModels: (
    request: AnalyzeModelsRequest,
  ) => Promise<BridgeResult<AnalyzeModelsResult>>;
  loadRendererSettings: (
    request: LoadRendererSettingsRequest,
  ) => Promise<BridgeResult<LoadRendererSettingsResult>>;
  saveRendererSettings: (
    request: SaveRendererSettingsRequest,
  ) => Promise<BridgeResult<SaveRendererSettingsResult>>;
  listProviderModels: (
    request: ListProviderModelsRequest,
  ) => Promise<BridgeResult<ListProviderModelsResult>>;
  prepareCache: (
    request: PrepareCacheRequest,
  ) => Promise<BridgeResult<PrepareCacheResult>>;
  extractAndGenerate: (
    request: GenerateRequest,
  ) => Promise<BridgeResult<GenerateResult>>;
  runFidelity: (
    request: FidelityRequest,
  ) => Promise<BridgeResult<FidelityResult>>;
  loadReview: (
    request: LoadReviewRequest,
  ) => Promise<BridgeResult<GenerateResult>>;
  saveReview: (request: SaveReviewRequest) => Promise<BridgeResult<SaveReviewResult>>;
}

export interface ElectronInvokeApi {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
}
