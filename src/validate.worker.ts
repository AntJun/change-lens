/// <reference lib="webworker" />
import { validateCSV } from "./validate.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
for (const method of ["log", "warn", "error", "info", "debug"] as const) console[method] = () => {};
scope.addEventListener("message", async (event: MessageEvent<{ id: number; bytes: Uint8Array; headers: string[] }>) => {
  const { id, bytes, headers } = event.data;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const frames: string[] = [];
    const result = validateCSV(text, headers, (values, lengths) => {
      frames.push(values.map((value, index) => lengths[index] + ":" + value).join(""));
    });
    if (!result.ok) {
      scope.postMessage({ id, ...result });
      return;
    }
    // Length framing preserves cell boundaries without returning plaintext evidence.
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(frames.join("")));
    const digest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
    scope.postMessage({ id, ...result, digest });
  } catch {
    scope.postMessage({ id, ok: false, code: "csv" });
  }
});
