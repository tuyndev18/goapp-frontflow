import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { FrontflowApi, IpcChannel, IpcPushChannel, IpcResult } from "../shared/ipc.js";

// Kept as literal lists so the preload never forwards arbitrary channel names.
const INVOKE_PREFIXES = ["app:", "projects:", "clis:", "runs:", "sessions:", "accounts:", "approvals:", "figma:", "skills:", "prompts:", "projectPrompts:", "featurePrompts:","workflows:", "settings:", "terminal:", "flo:"];
const PUSH_CHANNELS = new Set<string>([
  "run:event",
  "run:state",
  "session:event",
  "session:raw",
  "accounts:changed",
  "accounts:login",
  "figma:status",
  "approval:requested",
  "terminal:data",
  "terminal:exit",
  "flo:open",
  "flo:visibility",
]);

const api: FrontflowApi = {
  async invoke(channel: IpcChannel, ...args: unknown[]) {
    if (!INVOKE_PREFIXES.some((p) => channel.startsWith(p))) throw new Error(`Blocked IPC channel ${channel}`);
    const result = (await ipcRenderer.invoke(channel, args[0])) as IpcResult<never>;
    if (!result.ok) {
      const err = new Error(result.error.message);
      (err as Error & { code?: string }).code = result.error.code;
      throw err;
    }
    return result.value;
  },
  on(channel: IpcPushChannel, listener: (payload: never) => void) {
    if (!PUSH_CHANNELS.has(channel)) throw new Error(`Blocked push channel ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
} as FrontflowApi;

contextBridge.exposeInMainWorld("frontflow", api);
