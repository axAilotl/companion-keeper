import type {
  DesktopApi,
  ElectronInvokeApi,
  RendererBridge,
} from "@gptdataexport/shared";

declare global {
  interface Window {
    desktopApi: DesktopApi;
    electronAPI: ElectronInvokeApi;
    rendererBridge: RendererBridge;
  }
}

export {};
