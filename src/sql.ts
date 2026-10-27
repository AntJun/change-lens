import { LIMITS, type NullMode, type Side } from "./types.ts";
import { validateKeys } from "./policy.ts";

export interface Plan {
  keys: string[];
  keyAliases: string[];
  compared: string[];
  added: string[];
  removed: string[];
  beforeHeaders: string[];
  afterHeaders: string[];
  statements: string[];
}

export function rawImport(side: Side, columns: number): string {
  const names = Array.from({ length: columns }, (_, i) => "c" + i);
  const schema = names.map(name => name + ": 'VARCHAR'").join(", ");
  const force = names.map(name => "'" + name + "'").join(", ");
  const projected = names.map(name => "coalesce(" + name + ", '') AS " + name).join(", ");
  return "CREATE TABLE raw_" + side + " AS SELECT "
    + "(row_number() OVER () - 1)::INTEGER AS rid, " + projected
    + " FROM read_csv('" + side + ".csv', auto_detect=false, header=false, skip=0, "
    + "columns={" + schema + "}, force_not_null=[" + force + "], "
    + "delim=',', quote='\"', escape='\"', strict_mode=true, null_padding=false, "
    + "ignore_errors=false, parallel=false, max_line_size=2097152)";
}

export function createPlan(before: string[], after: string[], keys: string[], nullMode: NullMode): Plan {
  validateKeys(before, after, keys);
  const keyAliases = keys.map((_, i) => "k" + i);
  const join = keyAliases.join(", ");
  const valid = keyAliases.map(name => name + " IS NOT NULL AND " + name + " <> ''").join(" AND ");
  const statements: string[] = [];
  for (const [side, headers] of [["before", before], ["after", after]] as const) {
    const cells = headers.map((_, i) => nullMode === "marker"
      ? "CASE WHEN c" + i + " = '\\N' THEN NULL ELSE c" + i + " END AS c" + i
      : "c" + i);
    const aliases = keys.map((key, i) => "c" + headers.indexOf(key) + " AS k" + i);
    statements.push("CREATE VIEW data_" + side + " AS SELECT rid, " + cells.join(", ")
      + " FROM raw_" + side + " WHERE rid > 0");
    statements.push("CREATE VIEW all_" + side + " AS SELECT *, " + aliases.join(", ")
      + " FROM data_" + side);
    statements.push("CREATE VIEW keyed_" + side + " AS SELECT * FROM all_" + side + " WHERE " + valid);
  }
  statements.push("CREATE TABLE key_groups AS SELECT (row_number() OVER (ORDER BY " + join
    + "))::INTEGER AS gid, * FROM (SELECT " + join
    + ", count(*) FILTER (WHERE source_side=0)::INTEGER AS n_before"
    + ", count(*) FILTER (WHERE source_side=1)::INTEGER AS n_after"
    + " FROM (SELECT " + join + ", 0 AS source_side FROM keyed_before UNION ALL SELECT "
    + join + ", 1 AS source_side FROM keyed_after) GROUP BY " + join + ")");
  for (const side of ["before", "after"]) {
    statements.push("CREATE VIEW unique_" + side + " AS SELECT a.* FROM keyed_" + side
      + " a JOIN key_groups g USING (" + join + ") WHERE g.n_before<=1 AND g.n_after<=1");
  }
  const compared = before.filter(name => after.includes(name) && !keys.includes(name));
  const differences = compared.map(name => "b.c" + before.indexOf(name)
    + " IS DISTINCT FROM a.c" + after.indexOf(name)).join(" OR ") || "false";
  statements.push("CREATE TABLE delta AS SELECT " + keyAliases.map(k => "coalesce(b." + k + ",a." + k + ") AS " + k).join(", ")
    + ", b.rid AS before_rid, a.rid AS after_rid, CASE WHEN b.rid IS NULL THEN 'added'"
    + " WHEN a.rid IS NULL THEN 'removed' WHEN (" + differences + ") THEN 'changed'"
    + " ELSE 'unchanged' END AS kind FROM unique_before b FULL OUTER JOIN unique_after a USING (" + join + ")");
  return {
    keys: [...keys], keyAliases, compared,
    added: after.filter(name => !before.includes(name)),
    removed: before.filter(name => !after.includes(name)),
    beforeHeaders: [...before], afterHeaders: [...after], statements,
  };
}

export function validateCounts(c: {
  beforeRows: number; afterRows: number; changed: number; added: number; removed: number;
  unchanged: number; ambiguousBefore: number; ambiguousAfter: number;
  unkeyedBefore: number; unkeyedAfter: number;
}): void {
  const before = c.changed + c.unchanged + c.removed + c.ambiguousBefore + c.unkeyedBefore;
  const after = c.changed + c.unchanged + c.added + c.ambiguousAfter + c.unkeyedAfter;
  if (before !== c.beforeRows || after !== c.afterRows
      || Object.values(c).some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error("Reconciliation conservation check failed.");
  }
}

export function boundedPage(page: number, total: number): number {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("Invalid result page.");
  return Math.min(page, Math.max(0, Math.ceil(total / LIMITS.pageSize) - 1));
}
