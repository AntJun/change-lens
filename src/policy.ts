import Papa from "papaparse";
import { LIMITS, type SnapshotInput } from "./types.ts";

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export function validateHeaders(headers: string[]): string[] {
  if (!headers.length || headers.length > LIMITS.columns) {
    throw new ReviewError("Use between 1 and 64 columns per snapshot.");
  }
  if (new Set(headers).size !== headers.length
      || headers.some(name => !name.trim() || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) {
    throw new ReviewError("Headers must be unique, nonempty names of at most 256 characters without control characters.");
  }
  return headers;
}

export function parseHeader(text: string): string[] {
  const boundary = text.search(/[\r\n]/);
  const header = text.slice(0, boundary < 0 ? text.length : boundary);
  if (header.length > 65_536) throw new ReviewError("The raw header exceeds the 64 KiB limit.");
  const result = Papa.parse<string[]>(header, {
    delimiter: ",", quoteChar: '"', escapeChar: '"', header: false,
    dynamicTyping: false, skipEmptyLines: false, preview: 1,
  });
  if (result.errors.length || !result.data[0]) {
    throw new ReviewError("The CSV header could not be read. Use comma-separated UTF-8 CSV.");
  }
  return validateHeaders(result.data[0]);
}

export async function readSnapshot(file: File): Promise<SnapshotInput> {
  if (!file.size || file.size > LIMITS.fileBytes) {
    throw new ReviewError("Choose a nonempty CSV file of at most 8 MiB.");
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new ReviewError("The selected file could not be read.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ReviewError("Use UTF-8 encoded CSV. Invalid byte sequences are rejected.");
  }
  const headers = parseHeader(text);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
  return { name: file.name, bytes: new Uint8Array(buffer), headers, sha256, byteLength: file.size };
}

export function validateKeys(before: string[], after: string[], keys: string[]): void {
  if (!keys.length || keys.length > LIMITS.keys || new Set(keys).size !== keys.length
      || keys.some(key => !before.includes(key) || !after.includes(key))) {
    throw new ReviewError("Choose 1 to 8 distinct key columns present in both snapshots.");
  }
}

export function filterTotal(counts: {
  changed: number; added: number; removed: number; unchanged: number;
  ambiguousKeys: number; unkeyedBefore: number; unkeyedAfter: number;
}, filter: string): number {
  switch (filter) {
    case "changes": return counts.changed + counts.added + counts.removed;
    case "changed": case "added": case "removed": case "unchanged": return counts[filter];
    case "ambiguous": return counts.ambiguousKeys;
    case "unkeyed": return counts.unkeyedBefore + counts.unkeyedAfter;
    default: throw new ReviewError("Choose a valid review filter.");
  }
}
