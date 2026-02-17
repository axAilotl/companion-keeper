import type { DesktopApi, ElectronInvokeApi, RendererBridge } from "@gptdataexport/shared";

declare global {
  interface Window {
    desktopApi?: DesktopApi;
    rendererBridge?: RendererBridge;
    electronAPI?: ElectronInvokeApi;
  }
}

export {};
