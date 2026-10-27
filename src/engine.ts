import * as duckdb from "@duckdb/duckdb-wasm";
import { ReviewError, filterTotal, validateKeys } from "./policy.ts";
import { boundedPage, createPlan, rawImport, validateCounts, type Plan } from "./sql.ts";
import {
  LIMITS, type Cell, type Counts, type Filter, type Kind, type NullMode,
  type ReviewPage, type ReviewRow, type ReviewSummary, type RowDetail,
  type Side, type SnapshotInput,
} from "./types.ts";

export { readSnapshot } from "./policy.ts";
type SQLRow = Record<string, unknown>;

function integer(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ReviewError("Review evidence is incomplete.");
  return number;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function valueCell(row: SQLRow | undefined, headers: string[], name: string): Cell {
  const index = headers.indexOf(name);
  return row && index >= 0
    ? { present: true, value: row["c" + index] === null ? null : String(row["c" + index]) }
    : { present: false, value: null };
}

export class ReviewSession {
  private worker?: Worker;
  private db?: duckdb.AsyncDuckDB;
  private connection?: duckdb.AsyncDuckDBConnection;
  private stopped = false;
  private stopError = new ReviewError("Comparison canceled.");
  private rejectStop!: (reason: Error) => void;
  private readonly stoppedPromise: Promise<never>;
  private wholeTimer?: ReturnType<typeof setTimeout>;
  private plan?: Plan;
  private summary?: ReviewSummary;

  constructor(private readonly onProgress: (text: string) => void = () => {}) {
    this.stoppedPromise = new Promise<never>((_, reject) => { this.rejectStop = reject; });
    void this.stoppedPromise.catch(() => {});
  }

  private halt(reason: ReviewError): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopError = reason;
    clearTimeout(this.wholeTimer);
    this.rejectStop(reason);
    this.worker?.terminate();
    if (this.db) void this.db.terminate().catch(() => {});
    this.connection = undefined;
    this.db = undefined;
    this.worker = undefined;
    this.summary = undefined;
    this.plan = undefined;
  }

  dispose(): void {
    this.halt(new ReviewError("Comparison canceled."));
  }

  private async wait<T>(promise: Promise<T>): Promise<T> {
    if (this.stopped) throw this.stopError;
    const timer = setTimeout(() => {
      this.halt(new ReviewError("The 45-second deadline expired. Try a smaller snapshot pair."));
    }, LIMITS.deadlineMs);
    try {
      return await Promise.race([promise, this.stoppedPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async query(sql: string): Promise<SQLRow[]> {
    if (this.stopped) throw this.stopError;
    if (!this.connection) throw new ReviewError("Start a new comparison to inspect results.");
    const table = await this.wait(this.connection.query(sql));
    return table.toArray().map(row => row.toJSON() as SQLRow);
  }

  private async importSnapshot(side: Side, input: SnapshotInput): Promise<number> {
    if (!this.db) throw new ReviewError("The comparison engine is unavailable.");
    if (!input.bytes.byteLength || input.bytes.byteLength > LIMITS.fileBytes) {
      throw new ReviewError("Choose a nonempty CSV file of at most 8 MiB.");
    }
    // The database transfers this buffer; keep the original reusable for another policy.
    await this.wait(this.db.registerFileBuffer(side + ".csv", input.bytes.slice()));
    await this.query(rawImport(side, input.headers.length));
    const fields = input.headers.map((_, i) => "length(c" + i + ")");
    const [facts] = await this.query("SELECT count(*)::INTEGER AS rows, "
      + "coalesce(max(greatest(" + fields.join(", ") + ")),0)::INTEGER AS largest "
      + "FROM raw_" + side + " WHERE rid>0");
    const rows = integer(facts.rows);
    if (rows > LIMITS.rows || rows * input.headers.length > LIMITS.cells
        || integer(facts.largest) > LIMITS.fieldChars) {
      throw new ReviewError("Snapshot limits are 100,000 rows, 1,000,000 cells, and 16,384 characters per field.");
    }
    return rows;
  }

  async compare(before: SnapshotInput, after: SnapshotInput, keys: string[], nullMode: NullMode): Promise<ReviewSummary> {
    if (this.worker || this.stopped) throw new ReviewError("Create a fresh comparison session.");
    validateKeys(before.headers, after.headers, keys);
    if (nullMode !== "text" && nullMode !== "marker") throw new ReviewError("Choose a valid empty/null policy.");
    const started = performance.now();
    this.wholeTimer = setTimeout(() => {
      this.halt(new ReviewError("The 45-second deadline expired. Try a smaller snapshot pair."));
    }, LIMITS.deadlineMs);
    try {
      this.onProgress("Preparing the comparison engine");
      const root = new URL(import.meta.env.BASE_URL, location.href);
      this.worker = new Worker(new URL("vendor/duckdb-browser-mvp.worker.js", root));
      this.worker.addEventListener("error", event => {
        event.preventDefault();
        this.halt(new ReviewError("The comparison engine stopped. Reload the app and try again."));
      });
      this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), this.worker);
      await this.wait(this.db.instantiate(new URL("vendor/duckdb-mvp.wasm", root).href));
      await this.wait(this.db.open({ path: ":memory:", query: { castBigIntToDouble: true } }));
      this.connection = await this.wait(this.db.connect());
      for (const sql of [
        "SET threads=1", "SET memory_limit='256MB'", "SET preserve_insertion_order=true",
        "SET autoinstall_known_extensions=false", "SET autoload_known_extensions=false",
      ]) await this.query(sql);
      const engineVersion = await this.wait(this.db.getVersion());
      this.onProgress("Reading the before snapshot");
      const beforeRows = await this.importSnapshot("before", before);
      this.onProgress("Reading the after snapshot");
      const afterRows = await this.importSnapshot("after", after);
      // All subsequent queries use imported tables and generated identifiers only.
      await this.query("SET enable_external_access=false");
      this.plan = createPlan(before.headers, after.headers, keys, nullMode);
      this.onProgress("Reconciling keys and committed row values");
      for (const sql of this.plan.statements) await this.query(sql);
      const counts: Counts = {
        beforeRows, afterRows, changed: 0, added: 0, removed: 0, unchanged: 0,
        ambiguousKeys: 0, ambiguousBefore: 0, ambiguousAfter: 0, unkeyedBefore: 0, unkeyedAfter: 0,
      };
      for (const row of await this.query("SELECT kind,count(*)::INTEGER AS n FROM delta GROUP BY kind")) {
        const kind = row.kind as "changed" | "added" | "removed" | "unchanged";
        counts[kind] = integer(row.n);
      }
      const [ambiguous] = await this.query("SELECT count(*)::INTEGER AS keys, "
        + "coalesce(sum(n_before),0)::INTEGER AS b, coalesce(sum(n_after),0)::INTEGER AS a "
        + "FROM key_groups WHERE n_before>1 OR n_after>1");
      counts.ambiguousKeys = integer(ambiguous.keys);
      counts.ambiguousBefore = integer(ambiguous.b);
      counts.ambiguousAfter = integer(ambiguous.a);
      for (const side of ["before", "after"] as const) {
        const [row] = await this.query("SELECT ((SELECT count(*) FROM all_" + side
          + ")-(SELECT count(*) FROM keyed_" + side + "))::INTEGER AS n");
        counts[side === "before" ? "unkeyedBefore" : "unkeyedAfter"] = integer(row.n);
      }
      validateCounts(counts);
      this.summary = {
        schemaVersion: 1, engineVersion,
        sources: {
          before: { sha256: before.sha256, rows: beforeRows, columns: [...before.headers], bytes: before.byteLength },
          after: { sha256: after.sha256, rows: afterRows, columns: [...after.headers], bytes: after.byteLength },
        },
        keys: [...keys], nullMode, counts,
        schema: { added: this.plan.added, removed: this.plan.removed, compared: this.plan.compared },
        elapsedMs: Math.round((performance.now() - started) * 10) / 10, limits: LIMITS,
      };
      clearTimeout(this.wholeTimer);
      return this.summary;
    } catch (error) {
      this.dispose();
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("The CSV pair could not be read consistently. Check quoting, record widths, and file limits.");
    }
  }

  private makeRow(raw: SQLRow): ReviewRow {
    const plan = this.plan!;
    const beforeRow = nullableInteger(raw.before_rid);
    const afterRow = nullableInteger(raw.after_rid);
    const groupId = nullableInteger(raw.gid);
    const kind = raw.kind as Kind;
    return {
      id: kind + ":" + (groupId ?? "") + ":" + (beforeRow ?? "") + ":" + (afterRow ?? ""),
      kind,
      key: plan.keyAliases.map(name => raw[name] === null ? null : String(raw[name])),
      beforeRow, afterRow,
      beforeCount: raw.n_before === undefined ? Number(beforeRow !== null) : integer(raw.n_before),
      afterCount: raw.n_after === undefined ? Number(afterRow !== null) : integer(raw.n_after),
      ...(groupId === null ? {} : { groupId }),
    };
  }

  async page(filter: Filter, requestedPage: number): Promise<ReviewPage> {
    try {
      if (!this.plan || !this.summary) throw new ReviewError("Start a new comparison to inspect results.");
      const total = filterTotal(this.summary.counts, filter);
      const page = boundedPage(requestedPage, total);
      const keys = this.plan.keyAliases.join(", ");
      let sql: string;
      if (filter === "ambiguous") {
        sql = "SELECT *, 'ambiguous' AS kind, NULL::INTEGER AS before_rid, NULL::INTEGER AS after_rid "
          + "FROM key_groups WHERE n_before>1 OR n_after>1 ORDER BY " + keys;
      } else if (filter === "unkeyed") {
        const valid = this.plan.keyAliases.map(k => k + " IS NOT NULL AND " + k + "<>''").join(" AND ");
        sql = "SELECT * FROM (SELECT " + keys
          + ", rid AS before_rid, NULL::INTEGER AS after_rid, 'unkeyed' AS kind "
          + "FROM all_before WHERE NOT (" + valid + ") UNION ALL SELECT " + keys
          + ", NULL::INTEGER AS before_rid, rid AS after_rid, 'unkeyed' AS kind "
          + "FROM all_after WHERE NOT (" + valid + ")) ORDER BY before_rid NULLS LAST,after_rid NULLS LAST";
      } else {
        const where = filter === "changes" ? "kind IN ('changed','added','removed')"
          : "kind='" + filter + "'";
        sql = "SELECT * FROM delta WHERE " + where + " ORDER BY " + keys;
      }
      const rows = await this.query(sql + " LIMIT " + LIMITS.pageSize + " OFFSET " + (page * LIMITS.pageSize));
      return { rows: rows.map(row => this.makeRow(row)), total, page, pageSize: LIMITS.pageSize };
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("The result page is unavailable. Start a new comparison.");
    }
  }

  private async sourceRow(side: Side, rid: number | null): Promise<SQLRow | undefined> {
    if (rid === null) return undefined;
    if (!Number.isSafeInteger(rid) || rid < 1 || rid > LIMITS.rows) {
      throw new ReviewError("The source record reference is invalid.");
    }
    const rows = await this.query("SELECT * FROM data_" + side + " WHERE rid=" + rid);
    if (rows.length !== 1) throw new ReviewError("The source record is unavailable.");
    return rows[0];
  }

  async detail(row: ReviewRow): Promise<RowDetail> {
    try {
      if (!this.plan || !this.summary) throw new ReviewError("Start a new comparison to inspect evidence.");
      const plan = this.plan;
      if (row.kind === "ambiguous") {
        const gid = row.groupId;
        if (!Number.isSafeInteger(gid) || gid! < 1) throw new ReviewError("The key group reference is invalid.");
        const [group] = await this.query("SELECT * FROM key_groups WHERE gid=" + gid);
        if (!group || !(integer(group.n_before) > 1 || integer(group.n_after) > 1)) {
          throw new ReviewError("The ambiguous key group is unavailable.");
        }
        const beforeCount = integer(group.n_before), afterCount = integer(group.n_after);
        const beforeLimit = Math.min(beforeCount, Math.max(25, LIMITS.pageSize - Math.min(afterCount, 25)));
        const afterLimit = Math.min(afterCount, LIMITS.pageSize - beforeLimit);
        const members: RowDetail["members"] = [];
        for (const [side, limit, headers] of [
          ["before", beforeLimit, plan.beforeHeaders], ["after", afterLimit, plan.afterHeaders],
        ] as const) {
          const source = await this.query("SELECT s.* FROM keyed_" + side
            + " s JOIN key_groups g USING (" + plan.keyAliases.join(", ") + ") "
            + "WHERE g.gid=" + gid + " ORDER BY s.rid LIMIT " + limit);
          for (const item of source) {
            members.push({ side, row: integer(item.rid), cells: headers.map((name, index) => ({
              name, value: item["c" + index] === null ? null : String(item["c" + index]),
            })) });
          }
        }
        const memberTotal = beforeCount + afterCount;
        return { row, columns: [], members, memberTotal, truncated: members.length < memberTotal };
      }
      const before = await this.sourceRow("before", row.beforeRow);
      const after = await this.sourceRow("after", row.afterRow);
      const headers = [...plan.beforeHeaders, ...plan.added];
      const columns = headers.map(name => {
        const b = valueCell(before, plan.beforeHeaders, name);
        const a = valueCell(after, plan.afterHeaders, name);
        return {
          name, before: b, after: a, key: plan.keys.includes(name),
          changed: b.present !== a.present || b.value !== a.value,
        };
      });
      return { row, columns, members: [], memberTotal: 0, truncated: false };
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("Row evidence is unavailable. Start a new comparison.");
    }
  }
}
