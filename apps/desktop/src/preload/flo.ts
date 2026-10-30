import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { FloApi, FloConfigDto, FloStateDto, IpcResult } from "../shared/ipc.js";

// Flo's window gets its own few channels, never the app's full API.
async function invoke<T>(channel: `flo:${string}`, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const flo: FloApi = {
  state: () => invoke<FloStateDto | null>("flo:state"),
  onState(listener) {
    const wrapped = (_e: IpcRendererEvent, state: FloStateDto) => listener(state);
    ipcRenderer.on("flo:state", wrapped);
    return () => ipcRenderer.removeListener("flo:state", wrapped);
  },
  config: () => invoke<FloConfigDto>("flo:config"),
  onConfig(listener) {
    const wrapped = (_e: IpcRendererEvent, config: FloConfigDto) => listener(config);
    ipcRenderer.on("flo:config", wrapped);
    return () => ipcRenderer.removeListener("flo:config", wrapped);
  },
  open: () => invoke<void>("flo:open"),
  moveTo: (x, y) => invoke<void>("flo:moveTo", { x, y }),
  resize: (width, height) => invoke<void>("flo:resize", { width, height }),
  hide: () => invoke<void>("flo:hide"),
};

contextBridge.exposeInMainWorld("flo", flo);
