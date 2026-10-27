export type NullMode = "text" | "marker";
export type Kind = "changed" | "added" | "removed" | "unchanged" | "ambiguous" | "unkeyed";
export type Filter = Kind | "changes";
export type Side = "before" | "after";

export const LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  rows: 100_000,
  cells: 1_000_000,
  columns: 64,
  fieldChars: 16_384,
  pageSize: 50,
  keys: 8,
  deadlineMs: 45_000,
});

export interface SnapshotInput {
  name: string;
  bytes: Uint8Array;
  headers: string[];
  sha256: string;
  byteLength: number;
}

export interface Counts {
  beforeRows: number;
  afterRows: number;
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
  ambiguousKeys: number;
  ambiguousBefore: number;
  ambiguousAfter: number;
  unkeyedBefore: number;
  unkeyedAfter: number;
}

export interface ReviewSummary {
  schemaVersion: 1;
  engineVersion: string;
  sources: Record<Side, { sha256: string; rows: number; columns: string[]; bytes: number }>;
  keys: string[];
  nullMode: NullMode;
  counts: Counts;
  schema: { added: string[]; removed: string[]; compared: string[] };
  elapsedMs: number;
  limits: typeof LIMITS;
}

export interface ReviewRow {
  id: string;
  kind: Kind;
  key: (string | null)[];
  beforeRow: number | null;
  afterRow: number | null;
  beforeCount: number;
  afterCount: number;
  groupId?: number;
}

export interface ReviewPage {
  rows: ReviewRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Cell {
  present: boolean;
  value: string | null;
}

export interface ColumnChange {
  name: string;
  before: Cell;
  after: Cell;
  changed: boolean;
  key: boolean;
}

export interface RowDetail {
  row: ReviewRow;
  columns: ColumnChange[];
  members: { side: Side; row: number; cells: { name: string; value: string | null }[] }[];
  memberTotal: number;
  truncated: boolean;
}
