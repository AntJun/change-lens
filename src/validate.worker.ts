/// <reference lib="webworker" />
import { validateCSV } from "./validate.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
for (const method of ["log", "warn", "error", "info", "debug"] as const) console[method] = () => {};
scope.addEventListener("message", (event: MessageEvent<{ id: number; bytes: Uint8Array; headers: string[] }>) => {
  const { id, bytes, headers } = event.data;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    scope.postMessage({ id, ...validateCSV(text, headers) });
  } catch {
    scope.postMessage({ id, ok: false, code: "csv" });
  }
});
