import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import type { Counts, NullMode, ReviewSummary, RowDetail } from "../src/types";

interface Case {
  name?: string;
  before: string;
  after: string;
  keys: string[];
  nullMode: NullMode;
  expected: Counts;
  schema: ReviewSummary["schema"];
}
interface Payload { cases: Case[]; benchmark: Case }
interface Monitor { requests: number; networkViolations: string[]; console: string[]; pageErrors: string[] }

const payload = JSON.parse(readFileSync("artifacts/cases.json", "utf8")) as Payload;
if (payload.cases.length !== 15) throw new Error("Generate the 15 independent correctness cases before browser validation.");

const origin = "http://127.0.0.1:4173";
const basePath = "/change-lens/";
const monitors = new WeakMap<Page, Monitor>();
const format = new Intl.NumberFormat("en-US");
const demoCounts: Counts = {
  beforeRows: 10, afterRows: 10, changed: 3, added: 2, removed: 1, unchanged: 3,
  ambiguousKeys: 1, ambiguousBefore: 2, ambiguousAfter: 1, unkeyedBefore: 1, unkeyedAfter: 1,
};

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function csv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map(row => row.map(value => '"' + value.replaceAll('"', '""') + '"').join(",")).join("\n") + "\n";
}

async function installNetworkBoundary(context: BrowserContext, page: Page) {
  const monitor: Monitor = { requests: 0, networkViolations: [], console: [], pageErrors: [] };
  monitors.set(page, monitor);
  context.on("request", () => { monitor.requests++; });
  context.on("console", message => { monitor.console.push(message.text()); });
  page.on("pageerror", error => { monitor.pageErrors.push(error.message); });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const staticPath = url.pathname === basePath
      || url.pathname === basePath + "duckdb-worker.js"
      || url.pathname.startsWith(basePath + "assets/")
      || url.pathname.startsWith(basePath + "vendor/")
      || url.pathname === "/favicon.ico";
    if (url.origin !== origin || request.method() !== "GET" || url.search || !staticPath) {
      // Record fixed classifications so a failed privacy assertion cannot print input data.
      monitor.networkViolations.push(url.origin !== origin ? "foreign request"
        : request.method() !== "GET" ? "non-GET request" : "non-static request");
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return monitor;
}

test.beforeEach(async ({ context, page }) => {
  await installNetworkBoundary(context, page);
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Understand what changed.", exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  const monitor = monitors.get(page)!;
  expect(monitor.networkViolations, "Only same-origin static GET requests are permitted.").toEqual([]);
  expect(monitor.pageErrors.length, "The page must not emit uncaught errors.").toBe(0);
});

async function importPair(page: Page, before: string, after: string, keys: string[], nullMode: NullMode = "text") {
  await page.getByLabel("Choose before CSV", { exact: true }).setInputFiles({
    name: "before-fixture.csv", mimeType: "text/csv", buffer: Buffer.from(before, "utf8"),
  });
  await page.getByLabel("Choose after CSV", { exact: true }).setInputFiles({
    name: "after-fixture.csv", mimeType: "text/csv", buffer: Buffer.from(after, "utf8"),
  });
  await expect(page.getByRole("checkbox", { name: keys[0], exact: true })).toBeVisible();
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
  for (const key of keys) await page.getByRole("checkbox", { name: key, exact: true }).check();
  await page.getByLabel("Null handling", { exact: true }).selectOption(nullMode);
  await expect(page.getByRole("button", { name: "Compare snapshots", exact: true })).toBeEnabled();
}

async function runComparison(page: Page) {
  await page.getByRole("button", { name: "Compare snapshots", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeEnabled({ timeout: 60_000 });
}

async function downloadJSON<T>(page: Page, button: string): Promise<T> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: button, exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(button === "Export summary"
    ? "change-lens-summary.json" : "change-lens-row-evidence.json");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The constructed evidence download is unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function checkSummary(summary: ReviewSummary, item: Case) {
  expect(summary.counts).toEqual(item.expected);
  expect(summary.schema).toEqual(item.schema);
  expect(summary.keys).toEqual(item.keys);
  expect(summary.nullMode).toBe(item.nullMode);
  expect(summary.schemaVersion).toBe(1);
  expect(summary.engineVersion).toMatch(/1\.4\.3/);
  expect(summary.sources.before.sha256).toBe(sha256(item.before));
  expect(summary.sources.after.sha256).toBe(sha256(item.after));
  expect(summary.sources.before.bytes).toBe(Buffer.byteLength(item.before, "utf8"));
  expect(summary.sources.after.bytes).toBe(Buffer.byteLength(item.after, "utf8"));
  expect(summary.sources.before.rows).toBe(item.expected.beforeRows);
  expect(summary.sources.after.rows).toBe(item.expected.afterRows);
  expect(Object.keys(summary).sort()).toEqual([
    "counts", "elapsedMs", "engineVersion", "keys", "limits", "nullMode", "schema", "schemaVersion", "sources",
  ]);
  for (const side of ["before", "after"] as const) {
    expect(Object.keys(summary.sources[side]).sort()).toEqual(["bytes", "columns", "rows", "sha256"]);
  }
  const text = JSON.stringify(summary);
  expect(text.includes("before-fixture.csv") || text.includes("after-fixture.csv")).toBe(false);
  expect(Number.isFinite(summary.elapsedMs) && summary.elapsedMs >= 0).toBe(true);
}

for (const item of payload.cases) {
  test("independent oracle: " + item.name, async ({ page }) => {
    await importPair(page, item.before, item.after, item.keys, item.nullMode);
    await runComparison(page);
    const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
    checkSummary(summary, item);
    for (const kind of ["changed", "added", "removed", "unchanged"] as const) {
      await expect(page.getByTestId("count-" + kind)).toHaveText(format.format(item.expected[kind]));
    }
  });
}

test("constructed example exposes exact changes and separate identity findings", async ({ page }) => {
  await page.getByRole("button", { name: "Load example", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "SKU", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "region", exact: true })).toBeChecked();
  await runComparison(page);
  const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(summary.counts).toEqual(demoCounts);
  await expect(page.locator(".reconciled-label")).toBeVisible();

  await page.getByLabel("Show", { exact: true }).selectOption("changed");
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: '["A-100","west"]', exact: true }) });
  await row.getByRole("button", { name: /Inspect changed key/ }).click();
  const detail = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(detail.row.beforeRow).toBe(2);
  expect(detail.row.afterRow).toBe(2);
  expect(detail.columns.find(column => column.name === "quantity")).toMatchObject({
    before: { present: true, value: "12" }, after: { present: true, value: "14" }, changed: true,
  });
  expect(detail.columns.find(column => column.name === "note")?.after.value).toBe("Restock\narrived");
  await expect(page.locator(".detail-table .cell-value").filter({ hasText: "Restock" })).toHaveText("Restock\narrived");

  await page.getByLabel("Show", { exact: true }).selectOption("ambiguous");
  await page.getByRole("button", { name: /Inspect ambiguous key \["DUP-500"/ }).click();
  const ambiguous = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(ambiguous.columns).toEqual([]);
  expect(ambiguous.memberTotal).toBe(3);
  expect(ambiguous.truncated).toBe(false);
  expect(ambiguous.members.filter(member => member.side === "before")).toHaveLength(2);
  expect(ambiguous.members.filter(member => member.side === "after")).toHaveLength(1);
  await expect(page.locator(".member-record")).toHaveCount(3);
  await expect(page.locator(".detail-table")).toHaveCount(0);

  await page.getByLabel("Show", { exact: true }).selectOption("unkeyed");
  await page.getByRole("button", { name: /Inspect unkeyed key/ }).first().click();
  const unkeyed = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(unkeyed.row.beforeRow).toBe(8);
  expect(unkeyed.row.afterRow).toBeNull();
  expect(unkeyed.columns.every(column => column.after.present === false)).toBe(true);
});

test("row evidence distinguishes missing fields, null, empty text, and whitespace", async ({ page }) => {
  const before = csv(["id", "value", "removed", "spaces"], [["a", "\\N", "before only", " padded "]]);
  const after = csv(["id", "value", "added", "spaces"], [["a", "", "after only", "padded"]]);
  await importPair(page, before, after, ["id"], "marker");
  await runComparison(page);
  await page.getByRole("button", { name: /Inspect changed key \["a"\]$/ }).click();
  const table = page.locator(".detail-table");
  const value = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "value", exact: true }) });
  await expect(value.getByRole("cell")).toHaveText(["NULL", "Empty text"]);
  const removed = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "removed", exact: true }) });
  await expect(removed.getByRole("cell")).toHaveText(["before only", "Missing field"]);
  const added = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "added", exact: true }) });
  await expect(added.getByRole("cell")).toHaveText(["Missing field", "after only"]);
  const spaces = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "spaces", exact: true }) });
  expect(await spaces.getByRole("cell").first().textContent()).toBe(" padded ");
  const evidence = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(evidence.columns.find(column => column.name === "value")?.before).toEqual({ present: true, value: null });
  expect(evidence.columns.find(column => column.name === "value")?.after).toEqual({ present: true, value: "" });
  expect(evidence.columns.find(column => column.name === "added")?.before).toEqual({ present: false, value: null });
});

test("repeated policies reuse intact input bytes and invalidate prior results", async ({ page }) => {
  const before = csv(["id", "value"], [["a", "\\N"], ["\\N", "same"]]);
  const after = csv(["id", "value"], [["a", "\\N"], ["\\N", "updated"]]);
  await importPair(page, before, after, ["id"]);
  await runComparison(page);
  const first = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(first.counts.changed).toBe(1);
  expect(first.counts.unchanged).toBe(1);

  await page.getByLabel("Null handling", { exact: true }).selectOption("marker");
  await expect(page.getByTestId("count-changed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
  await runComparison(page);
  const second = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(second.counts.changed).toBe(0);
  expect(second.counts.unchanged).toBe(1);
  expect(second.counts.unkeyedBefore).toBe(1);
  expect(second.counts.unkeyedAfter).toBe(1);
  expect(second.sources).toEqual(first.sources);

  await page.getByLabel("Null handling", { exact: true }).selectOption("text");
  await runComparison(page);
  const third = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(third.counts).toEqual(first.counts);
  expect(third.sources).toEqual(first.sources);
});

test("a replacement input clears old results before the next comparison", async ({ page }) => {
  await importPair(page, "id,value\na,old\n", "id,value\na,new\n", ["id"]);
  await runComparison(page);
  await expect(page.getByTestId("count-changed")).toHaveText("1");
  await page.getByLabel("Choose before CSV", { exact: true }).setInputFiles({
    name: "replacement.csv", mimeType: "text/csv", buffer: Buffer.from("id,value\na,new\n"),
  });
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
  await expect(page.getByTestId("count-changed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compare snapshots", exact: true })).toBeEnabled();
  await runComparison(page);
  const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(summary.counts.changed).toBe(0);
  expect(summary.counts.unchanged).toBe(1);
  expect(summary.sources.before.sha256).toBe(sha256("id,value\na,new\n"));
});

test("clear invalidates a pending file read", async ({ page }) => {
  await page.addInitScript(() => {
    const native = File.prototype.arrayBuffer;
    const state = window as unknown as {
      releaseConstructedRead?: () => void; constructedReadHeld?: boolean;
      constructedReadReleased?: boolean; constructedDigestCompleted?: boolean;
    };
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, data) => {
      const result = await nativeDigest(algorithm, data);
      if (state.constructedReadReleased) state.constructedDigestCompleted = true;
      return result;
    };
    File.prototype.arrayBuffer = async function (this: File) {
      const bytes = await native.call(this);
      if (this.name === "delayed-before.csv") {
        state.constructedReadHeld = true;
        await new Promise<void>(resolve => { state.releaseConstructedRead = () => { state.constructedReadReleased = true; resolve(); }; });
      }
      return bytes;
    };
  });
  await page.reload();
  await page.getByLabel("Choose before CSV", { exact: true }).setInputFiles({
    name: "delayed-before.csv", mimeType: "text/csv", buffer: Buffer.from("id,value\na,constructed\n"),
  });
  await page.waitForFunction(() => (window as unknown as { constructedReadHeld?: boolean }).constructedReadHeld === true);
  await page.getByRole("button", { name: "Clear workspace", exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseConstructedRead?: () => void }).releaseConstructedRead?.());
  await page.waitForFunction(() => (window as unknown as { constructedDigestCompleted?: boolean }).constructedDigestCompleted === true);
  await expect(page.getByRole("status").first()).toHaveText(/Workspace cleared/);
  await expect(page.getByLabel("Choose before CSV", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Choose after CSV", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("delayed-before.csv", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compare snapshots", exact: true })).toBeDisabled();
});

test("cancellation and a newer example cannot restore an older comparison", async ({ context, page }) => {
  let release!: () => void;
  let signalHeld!: () => void;
  let intercepted = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { signalHeld = resolve; });
  await context.route("**/duckdb-mvp.wasm", async route => {
    if (!intercepted) {
      intercepted = true;
      signalHeld();
      await released;
    }
    try { await route.fallback(); } catch { /* A canceled worker may already have closed this request. */ }
  });
  try {
    await importPair(page, "id,value\nold,one\n", "id,value\nold,two\n", ["id"]);
    await page.getByRole("button", { name: "Compare snapshots", exact: true }).click();
    await held;
    await page.getByRole("button", { name: "Cancel comparison", exact: true }).click();
    await expect(page.getByRole("status").first()).toHaveText(/Comparison canceled/);
    await page.getByRole("button", { name: "Load example", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "SKU", exact: true })).toBeChecked();
    release();
    await runComparison(page);
    const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
    expect(summary.counts).toEqual(demoCounts);
    expect(summary.keys).toEqual(["SKU", "region"]);
    await expect(page.getByTestId("count-changed")).toHaveText("3");
    await expect(page.getByRole("status").first()).not.toHaveText(/could not|canceled/i);
  } finally { release(); }
});

test("malformed inputs keep cell contents out of errors, console, and requests", async ({ page }) => {
  const sentinel = "constructed-cell-privacy-sentinel";
  await importPair(page, 'id,value\na,"' + sentinel + "\n", "id,value\na,safe\n", ["id"]);
  await page.getByRole("button", { name: "Compare snapshots", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
  expect((await page.locator("body").innerText()).includes(sentinel)).toBe(false);
  const monitor = monitors.get(page)!;
  expect(monitor.console.some(message => message.includes(sentinel)), "Cell contents must stay out of console messages.").toBe(false);
  expect(monitor.pageErrors.some(message => message.includes(sentinel)), "Cell contents must stay out of page errors.").toBe(false);
  expect(monitor.networkViolations).toEqual([]);
});

test("summary excludes cell values and hostile markup remains text", async ({ page }) => {
  const value = '<img src="https://example.invalid/constructed" onerror="window.cellExecuted=true"><script>window.cellExecuted=true</script>';
  await page.evaluate(() => { (window as unknown as { cellExecuted?: boolean }).cellExecuted = false; });
  await importPair(page, csv(["id", "value"], [["a", "safe"]]), csv(["id", "value"], [["a", value]]), ["id"]);
  await runComparison(page);
  const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(JSON.stringify(summary).includes(value)).toBe(false);
  await page.getByRole("button", { name: /Inspect changed key \["a"\]$/ }).click();
  const content = page.locator(".detail-table .cell-value").filter({ hasText: value });
  await expect(content).toHaveText(value);
  await expect(page.locator(".detail-table img, .detail-table script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { cellExecuted?: boolean }).cellExecuted)).toBe(false);
});

for (const item of [
  { name: "duplicate headers", body: "id,id\na,b\n" },
  { name: "empty header", body: "id,\na,b\n" },
  { name: "multiline header", body: '"id","line\nheader"\n"a","b"\n' },
]) {
  test("invalid header: " + item.name, async ({ page }) => {
    await page.getByLabel("Choose before CSV", { exact: true }).setInputFiles({
      name: "invalid-header.csv", mimeType: "text/csv", buffer: Buffer.from(item.body),
    });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare snapshots", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });
}

test("record widths are strict and malformed rows cannot disappear", async ({ page }) => {
  await importPair(page, "id,value\na,one,extra\n", "id,value\na,one\n", ["id"]);
  await page.getByRole("button", { name: "Compare snapshots", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("count-unchanged")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
});

test("keyboard operation reaches controls and restores row inspection focus", async ({ page }) => {
  const before = page.getByLabel("Choose before CSV", { exact: true });
  await before.focus();
  await expect(before).toBeFocused();
  await page.getByRole("button", { name: "Load example", exact: true }).focus();
  await page.keyboard.press("Enter");
  const key = page.getByRole("checkbox", { name: "SKU", exact: true });
  await expect(key).toBeChecked();
  await key.focus();
  await page.keyboard.press("Space");
  await expect(key).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(key).toBeChecked();
  const compare = page.getByRole("button", { name: "Compare snapshots", exact: true });
  await compare.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeEnabled({ timeout: 60_000 });
  const filter = page.getByLabel("Show", { exact: true });
  await filter.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(filter).toHaveValue("changed");
  const inspect = page.getByRole("button", { name: /Inspect changed key/ }).first();
  await inspect.focus();
  await page.keyboard.press("Enter");
  const pane = page.getByRole("complementary", { name: "Inspect the source records", exact: true });
  await expect(pane).toBeFocused();
  await expect(pane).toBeInViewport({ ratio: 0.5 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#row-evidence")).toHaveCount(0);
  await expect(inspect).toBeFocused();
});

test("result pages are bounded and preserve deterministic ordering", async ({ page }) => {
  const rows = Array.from({ length: 125 }, (_, index) => ["id" + String(index).padStart(3, "0"), "old"]);
  const updated = rows.map(([id]) => [id, "new"]);
  await importPair(page, csv(["id", "value"], rows), csv(["id", "value"], updated), ["id"]);
  await runComparison(page);
  const body = page.locator(".review-table tbody");
  await expect(body.locator("tr")).toHaveCount(50);
  await expect(body.getByRole("rowheader").first()).toHaveText('["id000"]');
  await expect(body.getByRole("rowheader").last()).toHaveText('["id049"]');
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(body.getByRole("rowheader").first()).toHaveText('["id050"]');
  await expect(body.getByRole("rowheader").last()).toHaveText('["id099"]');
  await expect(body.locator("tr")).toHaveCount(50);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(body.getByRole("rowheader").first()).toHaveText('["id100"]');
  await expect(body.locator("tr")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(body.getByRole("rowheader").first()).toHaveText('["id050"]');
});

for (const item of [
  { name: "multi-column blank lines are ignored", text: "id,value\na,one\n\nb,two\n", rows: 2, ordinal: 2, unkeyed: 0 },
  { name: "one-column blank lines are unkeyed records", text: "id\na\n\nb\n", rows: 3, ordinal: 3, unkeyed: 1 },
]) {
  test(item.name, async ({ page }) => {
    await importPair(page, item.text, item.text, ["id"]);
    await runComparison(page);
    const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
    expect(summary.counts).toEqual({
      beforeRows: item.rows, afterRows: item.rows, changed: 0, added: 0, removed: 0, unchanged: 2,
      ambiguousKeys: 0, ambiguousBefore: 0, ambiguousAfter: 0,
      unkeyedBefore: item.unkeyed, unkeyedAfter: item.unkeyed,
    });
    await page.getByLabel("Show", { exact: true }).selectOption("unchanged");
    await page.getByRole("button", { name: /Inspect unchanged key \["b"\]$/ }).click();
    const evidence = await downloadJSON<RowDetail>(page, "Export row evidence");
    expect(evidence.row.beforeRow).toBe(item.ordinal);
    expect(evidence.row.afterRow).toBe(item.ordinal);
  });
}

test("ambiguous member evidence stays bounded and includes both sources", async ({ page }) => {
  const before = Array.from({ length: 80 }, (_, index) => ["duplicate", "before-" + index]);
  const after = Array.from({ length: 70 }, (_, index) => ["duplicate", "after-" + index]);
  await importPair(page, csv(["id", "value"], before), csv(["id", "value"], after), ["id"]);
  await runComparison(page);
  await page.getByLabel("Show", { exact: true }).selectOption("ambiguous");
  await page.getByRole("button", { name: /Inspect ambiguous key \["duplicate"\]$/ }).click();
  const evidence = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(evidence.memberTotal).toBe(150);
  expect(evidence.members).toHaveLength(50);
  expect(evidence.truncated).toBe(true);
  expect(evidence.columns).toEqual([]);
  expect(evidence.members.some(member => member.side === "before")).toBe(true);
  expect(evidence.members.some(member => member.side === "after")).toBe(true);
  await expect(page.getByText("Showing 50 of 150 source records.", { exact: true })).toBeVisible();
  await expect(page.locator(".member-record")).toHaveCount(50);
});

test("an oversized file is rejected before comparison", async ({ page }) => {
  await page.getByLabel("Choose before CSV", { exact: true }).setInputFiles({
    name: "oversized-fixture.csv", mimeType: "text/csv", buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 120),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare snapshots", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
});

test("50,000-row browser benchmark records actual results and responsiveness", async ({ browserName, browser, page }) => {
  test.skip(browserName !== "chromium", "The published measurement uses Chromium.");
  // Complete one small comparison before measuring the larger constructed pair.
  await page.getByRole("button", { name: "Load example", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "SKU", exact: true })).toBeChecked();
  await runComparison(page);
  await page.getByRole("button", { name: "Clear workspace", exact: true }).click();
  await page.evaluate(() => {
    const state = window as unknown as { constructedHeartbeat?: { ticks: number; maxGapMs: number; last: number; timer: number } };
    const heartbeat = { ticks: 0, maxGapMs: 0, last: performance.now(), timer: 0 };
    heartbeat.timer = window.setInterval(() => {
      const now = performance.now();
      heartbeat.maxGapMs = Math.max(heartbeat.maxGapMs, now - heartbeat.last);
      heartbeat.last = now;
      heartbeat.ticks++;
    }, 20);
    state.constructedHeartbeat = heartbeat;
  });
  const started = performance.now();
  await importPair(page, payload.benchmark.before, payload.benchmark.after, payload.benchmark.keys, payload.benchmark.nullMode);
  await runComparison(page);
  const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
  const inputToSummaryMs = performance.now() - started;
  const heartbeat = await page.evaluate(() => {
    const state = window as unknown as { constructedHeartbeat?: { ticks: number; maxGapMs: number; last: number; timer: number } };
    const heartbeat = state.constructedHeartbeat!;
    heartbeat.maxGapMs = Math.max(heartbeat.maxGapMs, performance.now() - heartbeat.last);
    clearInterval(heartbeat.timer);
    return { ticks: heartbeat.ticks, maxGapMs: Math.round(heartbeat.maxGapMs * 10) / 10 };
  });
  checkSummary(summary, payload.benchmark);
  expect(heartbeat.ticks, "The main-thread heartbeat must advance during the measurement.").toBeGreaterThan(0);
  expect(inputToSummaryMs).toBeLessThan(90_000);
  const rendered = page.locator(".review-table tbody").getByRole("rowheader");
  await expect(rendered).toHaveCount(50);
  const renderedRows = await rendered.count();
  const commit = /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null;
  const run = /^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : null;
  const evidence = {
    schemaVersion: 1,
    method: "Public UI import, key selection, comparison, and summary export after one constructed warm-up comparison.",
    browser: { name: browserName, version: browser.version() },
    engineVersion: summary.engineVersion,
    environment: { platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model ?? "unavailable", memoryMiB: Math.round(totalmem() / (1024 * 1024)) },
    gitCommit: commit,
    ciRun: run ? "https://github.com/AntJun/change-lens/actions/runs/" + run : null,
    sources: summary.sources,
    counts: summary.counts,
    engineComparisonMs: summary.elapsedMs,
    inputToSummaryMs: Math.round(inputToSummaryMs * 10) / 10,
    heartbeatIntervalMs: 20,
    heartbeat,
    renderedRows,
    pageSizeLimit: summary.limits.pageSize,
    limits: summary.limits,
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/benchmark.json", JSON.stringify(evidence, null, 2) + "\n", "utf8");
});

test("composite key previews preserve tuple boundaries", async ({ page }) => {
  const text = csv(["first", "second", "value"], [
    ["a / b", "c", "same"], ["a", "b / c", "same"],
  ]);
  await importPair(page, text, text, ["first", "second"]);
  await runComparison(page);
  await page.getByLabel("Show", { exact: true }).selectOption("unchanged");
  const headers = page.locator(".review-table tbody").getByRole("rowheader");
  await expect(headers).toHaveCount(2);
  const keys = await headers.allTextContents();
  expect(new Set(keys).size).toBe(2);
  expect(keys).toContain('["a / b","c"]');
  expect(keys).toContain('["a","b / c"]');
});

test("parser disagreement rejects ambiguous whitespace before a quote", async ({ page }) => {
  const text = 'id,value\na, "padded"\n';
  await importPair(page, text, text, ["id"]);
  await page.getByRole("button", { name: "Compare snapshots", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("consistently quoted CSV");
  await expect(page.getByRole("button", { name: "Export summary", exact: true })).toBeDisabled();
});

test("fully quoted whitespace and supplementary Unicode retain exact values", async ({ page }) => {
  const before = csv(["id", "value"], [["a", ' "padded"'], ["b", "\ud83e\uddea:2"]]);
  const after = csv(["id", "value"], [["a", ' "updated"'], ["b", "\ud83e\uddea:2"]]);
  await importPair(page, before, after, ["id"]);
  await runComparison(page);
  const summary = await downloadJSON<ReviewSummary>(page, "Export summary");
  expect(summary.counts.changed).toBe(1);
  expect(summary.counts.unchanged).toBe(1);
  await page.getByRole("button", { name: /Inspect changed key \["a"\]$/ }).click();
  const evidence = await downloadJSON<RowDetail>(page, "Export row evidence");
  expect(evidence.columns.find(column => column.name === "value")?.before.value).toBe(' "padded"');
  expect(evidence.columns.find(column => column.name === "value")?.after.value).toBe(' "updated"');
});
