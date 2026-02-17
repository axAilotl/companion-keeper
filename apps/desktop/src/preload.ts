import { contextBridge, ipcRenderer } from "electron";
import {
  DesktopApi,
  ElectronInvokeApi,
  IpcEventChannel,
  IpcInvokeChannel,
  IpcInvokeRequest,
  IpcInvokeResponse,
  RendererBridge,
  parseIpcInvokeRequest,
  parseIpcInvokeResponse,
  parseJobEvent,
} from "@gptdataexport/shared";

async function invokeIpc<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcInvokeRequest<C>,
): Promise<IpcInvokeResponse<C>> {
  const request = parseIpcInvokeRequest(channel, payload);
  const response = await ipcRenderer.invoke(channel, request);
  return parseIpcInvokeResponse(channel, response);
}

const desktopApi: DesktopApi = {
  getAppPaths: () => invokeIpc(IpcInvokeChannel.GetAppPaths, {}),
  startJob: (request) => invokeIpc(IpcInvokeChannel.StartJob, request),
  cancelJob: (request) => invokeIpc(IpcInvokeChannel.CancelJob, request),
  listJobs: () => invokeIpc(IpcInvokeChannel.ListJobs, {}),
  onJobEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(parseJobEvent(payload));
    };

    ipcRenderer.on(IpcEventChannel.JobEvent, wrapped);

    return () => {
      ipcRenderer.removeListener(IpcEventChannel.JobEvent, wrapped);
    };
  },
};

const electronAPI: ElectronInvokeApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
};

const rendererBridge: RendererBridge = {
  selectImportFile: (request) => invokeIpc(IpcInvokeChannel.SelectImportFile, request),
  selectExportDirectory: (request) => invokeIpc(IpcInvokeChannel.SelectExportDirectory, request),
  selectPersonaImageFile: (request) => invokeIpc(IpcInvokeChannel.SelectPersonaImageFile, request),
  listReviewDirectories: (request) => invokeIpc(IpcInvokeChannel.ListReviewDirectories, request),
  importFile: (request) => invokeIpc(IpcInvokeChannel.ImportFile, request),
  analyzeModels: (request) => invokeIpc(IpcInvokeChannel.AnalyzeModels, request),
  loadRendererSettings: (request) => invokeIpc(IpcInvokeChannel.LoadRendererSettings, request),
  saveRendererSettings: (request) => invokeIpc(IpcInvokeChannel.SaveRendererSettings, request),
  listProviderModels: (request) => invokeIpc(IpcInvokeChannel.ListProviderModels, request),
  prepareCache: (request) => invokeIpc(IpcInvokeChannel.PrepareCache, request),
  extractAndGenerate: (request) =>
    invokeIpc(IpcInvokeChannel.ExtractAndGenerate, request),
  runFidelity: (request) => invokeIpc(IpcInvokeChannel.RunFidelity, request),
  loadReview: (request) => invokeIpc(IpcInvokeChannel.LoadReview, request),
  saveReview: (request) => invokeIpc(IpcInvokeChannel.SaveReview, request),
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
contextBridge.exposeInMainWorld("electronAPI", electronAPI);
contextBridge.exposeInMainWorld("rendererBridge", rendererBridge);
