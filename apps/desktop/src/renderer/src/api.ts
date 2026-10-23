import type { FrontflowApi } from "../../shared/ipc.js";

declare global {
  interface Window {
    frontflow: FrontflowApi;
  }
}

export const api: FrontflowApi = window.frontflow;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
