import Papa from "papaparse";
import { LIMITS } from "./types.ts";

export type ValidationCode = "csv" | "width" | "rows" | "cells" | "field" | "header";
export type ValidationResult = { ok: true; rows: number } | { ok: false; code: ValidationCode };

export function validateCSV(text: string, headers: string[]): ValidationResult {
  let rows = 0;
  let cursor = 0;
  let headerSeen = false;
  let failure: ValidationCode | undefined;
  try {
    Papa.parse<string[]>(text, {
      delimiter: ",", quoteChar: '"', escapeChar: '"', header: false,
      dynamicTyping: false, skipEmptyLines: false, fastMode: false,
      step(result, parser) {
        const start = cursor;
        cursor = result.meta.cursor;
        const raw = text.slice(start, cursor);
        const physical = raw.replace(/\r\n$|[\r\n]$/, "");
        const fail = (code: ValidationCode) => { failure = code; parser.abort(); };
        if (result.errors.length) return fail("csv");
        if (!headerSeen) {
          headerSeen = true;
          if (result.data.length !== headers.length
              || result.data.some((value, index) => value !== headers[index])) return fail("header");
          return;
        }
        // Papa emits a terminal empty step; a physical blank record has consumed bytes.
        if (!raw.length && start === text.length) return;
        if (!physical.length && headers.length > 1) return;
        if (result.data.length !== headers.length) return fail("width");
        rows++;
        if (rows > LIMITS.rows) return fail("rows");
        if (rows * headers.length > LIMITS.cells) return fail("cells");
        for (const value of result.data) {
          if (value.length > LIMITS.fieldChars * 2) return fail("field");
          let characters = 0;
          for (const _character of value) {
            if (++characters > LIMITS.fieldChars) return fail("field");
          }
        }
      },
    });
  } catch {
    return { ok: false, code: "csv" };
  }
  if (failure) return { ok: false, code: failure };
  return headerSeen ? { ok: true, rows } : { ok: false, code: "header" };
}
