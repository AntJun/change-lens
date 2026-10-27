import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { createHash } from "node:crypto";
import { parseHeader, readSnapshot, validateHeaders, validateKeys, filterTotal } from "../src/policy.ts";
import { rawImport, createPlan, validateCounts, boundedPage } from "../src/sql.ts";
import { LIMITS } from "../src/types.ts";

test("CSV headers preserve quoted punctuation and case-distinct names", () => {
  assert.deepEqual(parseHeader('"Foo","foo","odd, ""name"""\r\n001,1,value\r\n'), ["Foo", "foo", 'odd, "name"']);
});

test("duplicate, empty, control, excessive and oversized headers are rejected", () => {
  for (const input of ["id,id\n", "id,\n", '"line\nbreak",id\n', "id,\x00bad\n"]) {
    assert.throws(() => parseHeader(input));
  }
  assert.throws(() => validateHeaders(Array.from({ length: 65 }, (_, i) => "c" + i)));
  assert.throws(() => validateHeaders(["x".repeat(257)]));
  assert.throws(() => parseHeader("x".repeat(65_537)));
});

test("header preview bounds the parser input before a large body is examined", () => {
  const original = Papa.parse;
  let length = 0;
  const method = mock.method(Papa, "parse", (...args: unknown[]) => {
    length = String(args[0]).length;
    return Reflect.apply(original, Papa, args);
  });
  try {
    assert.deepEqual(parseHeader("id,value\n" + "a,b\n".repeat(1_000_000)), ["id", "value"]);
    assert.equal(length, 8);
  } finally {
    method.mock.restore();
  }
});

test("snapshot identity hashes the original UTF-8 bytes", async () => {
  const text = "\ufeffid,value\r\n001,snowman-\u2603\r\n";
  const file = new File([text], "constructed.csv", { type: "text/csv" });
  const snapshot = await readSnapshot(file);
  assert.deepEqual(snapshot.headers, ["id", "value"]);
  assert.equal(snapshot.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(snapshot.byteLength, Buffer.byteLength(text));
});

test("invalid UTF-8 and file byte limits fail before comparison", async () => {
  await assert.rejects(readSnapshot(new File([new Uint8Array([0xff])], "invalid.csv")));
  await assert.rejects(readSnapshot(new File([], "empty.csv")));
  await assert.rejects(readSnapshot(new File([new Uint8Array(LIMITS.fileBytes + 1)], "oversized.csv")));
});

test("composite key validation uses exact shared column names", () => {
  validateKeys(["id", "region"], ["region", "id"], ["id", "region"]);
  for (const keys of [[], ["ID"], ["id", "id"], ["missing"]]) {
    assert.throws(() => validateKeys(["id"], ["id"], keys));
  }
});

test("external names never enter generated SQL", () => {
  const headers = ["id", "x'); DROP TABLE anything; --", "Foo", "foo"];
  const plan = createPlan(headers, headers, ["id"], "text");
  const sql = plan.statements.join("\n");
  assert.equal(sql.includes(headers[1]), false);
  assert.match(sql, /b\.c2 IS DISTINCT FROM a\.c2/);
  assert.match(sql, /b\.c3 IS DISTINCT FROM a\.c3/);
  assert.match(sql, /FULL OUTER JOIN/);
});

test("imports set strict text and width rules without inferring identifiers", () => {
  const sql = rawImport("before", 3);
  assert.match(sql, /auto_detect=false/);
  assert.match(sql, /force_not_null=\['c0', 'c1', 'c2'\]/);
  assert.match(sql, /strict_mode=true/);
  assert.match(sql, /ignore_errors=false/);
  assert.match(sql, /null_padding=false/);
});

test("schema changes remain distinct from shared non-key field comparison", () => {
  const plan = createPlan(["id", "old", "same"], ["same", "new", "id"], ["id"], "text");
  assert.deepEqual(plan.removed, ["old"]);
  assert.deepEqual(plan.added, ["new"]);
  assert.deepEqual(plan.compared, ["same"]);
});

test("marker mode maps exact literal markers in data views", () => {
  const plan = createPlan(["id", "value"], ["id", "value"], ["id"], "marker");
  assert.match(plan.statements[0], /CASE WHEN c0 = '\\N' THEN NULL/);
  assert.match(plan.statements[0], /WHERE rid > 0/);
});

test("row conservation includes every ambiguity and unkeyed row", () => {
  const counts = {
    beforeRows: 10, afterRows: 10, changed: 3, added: 2, removed: 1, unchanged: 3,
    ambiguousBefore: 2, ambiguousAfter: 1, unkeyedBefore: 1, unkeyedAfter: 1,
  };
  validateCounts(counts);
  assert.throws(() => validateCounts({ ...counts, ambiguousBefore: 1 }));
  assert.throws(() => validateCounts({ ...counts, changed: -1 }));
});

test("page filters and bounds preserve the complete result total", () => {
  const counts = { changed: 3, added: 2, removed: 1, unchanged: 3, ambiguousKeys: 1, unkeyedBefore: 1, unkeyedAfter: 1 };
  assert.equal(filterTotal(counts, "changes"), 6);
  assert.equal(filterTotal(counts, "ambiguous"), 1);
  assert.equal(filterTotal(counts, "unkeyed"), 2);
  assert.equal(boundedPage(100, 101), 2);
  assert.equal(boundedPage(0, 0), 0);
  assert.throws(() => boundedPage(-1, 100));
  assert.throws(() => filterTotal(counts, "invalid"));
});
