import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { redact } from "@frontflow/event-schema";
import { requestSchemas, type IpcChannel, type IpcPushChannel, type IpcPushEvents, type IpcResponses, type IpcResult } from "../shared/ipc.js";

type Handler<C extends IpcChannel> = (payload: import("zod").infer<(typeof requestSchemas)[C]>) => Promise<IpcResponses[C]> | IpcResponses[C];
export type IpcHandlers = { [C in IpcChannel]: Handler<C> };

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Typed IPC gateway (spec §9.2): every payload is schema-validated, only the
 * app's own renderer may call, and errors are returned as data, never thrown
 * across the bridge with stack traces.
 */
export function registerIpcHandlers(handlers: IpcHandlers, isTrustedSender: (sender: WebContents, frameUrl: string) => boolean): void {
  for (const channel of Object.keys(requestSchemas) as IpcChannel[]) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event.sender, event.senderFrame?.url ?? "")) {
        return { ok: false, error: { code: "FORBIDDEN", message: "Untrusted IPC sender" } };
      }
      const schema = requestSchemas[channel];
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { code: "INVALID_PAYLOAD", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
      }
      try {
        const value = await (handlers[channel] as Handler<IpcChannel>)(parsed.data as never);
        return { ok: true, value };
      } catch (err) {
        const code = err instanceof AppError ? err.code : ((err as { code?: string }).code ?? "INTERNAL_ERROR");
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ipc] ${channel} failed:`, redact(message));
        return { ok: false, error: { code: String(code), message: redact(message) } };
      }
    });
  }
}

export class PushBus {
  private targets = new Set<WebContents>();

  attach(contents: WebContents): void {
    this.targets.add(contents);
    contents.once("destroyed", () => this.targets.delete(contents));
  }

  send<C extends IpcPushChannel>(channel: C, payload: IpcPushEvents[C]): void {
    const safe = redact(payload);
    for (const target of this.targets) {
      if (!target.isDestroyed()) target.send(channel, safe);
    }
  }
}
