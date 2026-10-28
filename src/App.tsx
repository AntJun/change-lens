import { useEffect, useMemo, useRef, useState } from "react";
import { readSnapshot, ReviewSession } from "./engine";
import { ReviewError } from "./policy";
import { LIMITS } from "./types";
import type { Cell, Filter, NullMode, ReviewPage, ReviewRow, ReviewSummary, RowDetail, Side, SnapshotInput } from "./types";

type Inputs = Record<Side, SnapshotInput | null>;
const number = new Intl.NumberFormat("en-US");

const beforeRows = [
  ["A-100", "east", "10", "active", "Ready, stocked"],
  ["A-100", "west", "12", "active", "West rack"],
  ["B-200", "east", "5", "hold", "Inspection"],
  ["C-300", "north", "8", "active", "Stable"],
  ["D-400", "south", "2", "active", "Prior"],
  ["DUP-500", "east", "1", "active", "First"],
  ["DUP-500", "east", "2", "active", "Second"],
  ["", "east", "7", "active", "Missing key"],
  ["Z-900", "east", "3", "active", "Zero"],
  ["F-600", "west", "001", "active", "Leading zero"],
];
const afterRows = [
  ["A-100", "east", "10", "active", "Ready, stocked"],
  ["A-100", "west", "14", "active", "Restock\narrived"],
  ["C-300", "north", "8", "active", "Stable"],
  ["D-400", "south", "2", "hold", "Review"],
  ["DUP-500", "east", "1", "active", "First"],
  ["", "east", "7", "active", "Missing key"],
  ["Z-900", "east", "3", "active", "Zero"],
  ["F-600", "west", "1", "active", "Leading zero"],
  ["NEW-700", "south", "4", "active", "New"],
  ["C-300", "south", "1", "active", "New region"],
];

function csv(rows: string[][]): string {
  return [["SKU", "region", "quantity", "status", "note"], ...rows]
    .map((row) => row.map((value) => '"' + value.replaceAll('"', '""') + '"').join(","))
    .join("\r\n") + "\r\n";
}

function download(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function valueCell(cell: Cell) {
  if (!cell.present) return <span className="cell-placeholder">Missing field</span>;
  if (cell.value === null) return <span className="null-value">NULL</span>;
  if (cell.value === "") return <span className="cell-placeholder">Empty text</span>;
  return <span className="cell-value">{cell.value}</span>;
}

function keyPreview(row: ReviewRow): string {
  return JSON.stringify(row.key);
}

function rowReference(row: ReviewRow, side: Side): string {
  const count = side === "before" ? row.beforeCount : row.afterCount;
  const ordinal = side === "before" ? row.beforeRow : row.afterRow;
  if (!count) return "-";
  return ordinal !== null ? "#" + ordinal : number.format(count) + " records";
}

function BrandMark() {
  return <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
    <rect x="2" y="4" width="19" height="23" rx="4" fill="currentColor" opacity=".28" />
    <rect x="11" y="7" width="19" height="23" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M16 14h9M16 19h9M16 24h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

export default function App() {
  const [inputs, setInputs] = useState<Inputs>({ before: null, after: null });
  const [reading, setReading] = useState<Record<Side, boolean>>({ before: false, after: false });
  const [keys, setKeys] = useState<string[]>([]);
  const [nullMode, setNullMode] = useState<NullMode>("text");
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [reviewPage, setReviewPage] = useState<ReviewPage | null>(null);
  const [filter, setFilter] = useState<Filter>("changes");
  const [busy, setBusy] = useState(false);
  const [paging, setPaging] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RowDetail | null>(null);
  const [status, setStatus] = useState("Choose two snapshots or load the example to begin.");
  const [error, setError] = useState("");
  const session = useRef<ReviewSession | null>(null);
  const revision = useRef(0);
  const imports = useRef<Record<Side, number>>({ before: 0, after: 0 });
  const pages = useRef(0);
  const details = useRef(0);
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);
  const evidencePane = useRef<HTMLElement>(null);
  const evidenceOpener = useRef<HTMLButtonElement>(null);
  const shared = useMemo(() => inputs.before?.headers.filter((name) => inputs.after?.headers.includes(name)) ?? [], [inputs]);

  useEffect(() => {
    setKeys((current) => {
      const available = current.filter((key) => shared.includes(key));
      return available.length ? available : shared.slice(0, 1);
    });
  }, [shared]);

  useEffect(() => () => {
    revision.current++;
    imports.current.before++;
    imports.current.after++;
    session.current?.dispose();
  }, []);

  function invalidate(message = "Ready to compare with the selected policy.") {
    revision.current++;
    pages.current++;
    details.current++;
    session.current?.dispose();
    session.current = null;
    setSummary(null);
    setReviewPage(null);
    setSelectedId(null);
    setDetail(null);
    setBusy(false);
    setPaging(false);
    setDetailBusy(false);
    setError("");
    setStatus(message);
  }

  async function importFile(side: Side, file: File | undefined) {
    if (!file) return;
    const token = ++imports.current[side];
    invalidate("Reading selected snapshots...");
    setReading((current) => ({ ...current, [side]: true }));
    setInputs((current) => ({ ...current, [side]: null }));
    try {
      const input = await readSnapshot(file);
      if (imports.current[side] !== token) return;
      setInputs((current) => ({ ...current, [side]: input }));
      setStatus("Snapshot loaded. Check the matching key, then compare.");
    } catch (error) {
      if (imports.current[side] === token) {
        setError(error instanceof ReviewError ? error.message : "This snapshot could not be read. Use a UTF-8, comma-separated CSV with unique, nonempty headers and check the size limits.");
        setStatus("A snapshot needs attention.");
      }
    } finally {
      if (imports.current[side] === token) setReading((current) => ({ ...current, [side]: false }));
    }
  }

  async function loadExample() {
    const beforeToken = ++imports.current.before;
    const afterToken = ++imports.current.after;
    invalidate("Loading the constructed example...");
    if (beforeInput.current) beforeInput.current.value = "";
    if (afterInput.current) afterInput.current.value = "";
    setInputs({ before: null, after: null });
    setReading({ before: true, after: true });
    try {
      const [before, after] = await Promise.all([
        readSnapshot(new File([csv(beforeRows)], "inventory-before.csv", { type: "text/csv" })),
        readSnapshot(new File([csv(afterRows)], "inventory-after.csv", { type: "text/csv" })),
      ]);
      const acceptBefore = imports.current.before === beforeToken;
      const acceptAfter = imports.current.after === afterToken;
      if (!acceptBefore && !acceptAfter) return;
      setInputs((current) => ({ before: acceptBefore ? before : current.before, after: acceptAfter ? after : current.after }));
      if (acceptBefore && acceptAfter) setKeys(["SKU", "region"]);
      setStatus("Example loaded: check the matching key, then compare the snapshots.");
    } catch {
      if (imports.current.before === beforeToken && imports.current.after === afterToken) {
        setError("The example could not be loaded. Try loading it again.");
      }
    } finally {
      if (imports.current.before === beforeToken) setReading((current) => ({ ...current, before: false }));
      if (imports.current.after === afterToken) setReading((current) => ({ ...current, after: false }));
    }
  }

  function clear() {
    imports.current.before++;
    imports.current.after++;
    invalidate("Workspace cleared. Choose two snapshots or load the example.");
    setInputs({ before: null, after: null });
    setReading({ before: false, after: false });
    setKeys([]);
    setNullMode("text");
    setFilter("changes");
    if (beforeInput.current) beforeInput.current.value = "";
    if (afterInput.current) afterInput.current.value = "";
  }

  async function loadPage(nextFilter: Filter, index: number, active = session.current, token = revision.current) {
    if (!active) return;
    const query = ++pages.current;
    details.current++;
    setFilter(nextFilter);
    setReviewPage(null);
    setSelectedId(null);
    setDetail(null);
    setDetailBusy(false);
    setPaging(true);
    setError("");
    try {
      const result = await active.page(nextFilter, index);
      if (session.current !== active || revision.current !== token || pages.current !== query) return;
      setReviewPage(result);
      setStatus("Review ready. Inspect a row to see its evidence.");
    } catch {
      if (session.current === active && revision.current === token && pages.current === query) {
        setError("This result page could not be read. Select a result filter to try again.");
      }
    } finally {
      if (session.current === active && revision.current === token && pages.current === query) setPaging(false);
    }
  }

  async function compare() {
    if (!inputs.before || !inputs.after || !keys.length || busy || reading.before || reading.after) return;
    invalidate("Preparing the comparison...");
    const token = revision.current;
    const active = new ReviewSession((message) => {
      if (revision.current === token) setStatus(message);
    });
    session.current = active;
    setBusy(true);
    try {
      const result = await active.compare(inputs.before, inputs.after, [...keys], nullMode);
      if (session.current !== active || revision.current !== token) return;
      setSummary(result);
      await loadPage("changes", 0, active, token);
    } catch (error) {
      if (session.current === active && revision.current === token) {
        invalidate("Comparison stopped. Your snapshots are ready to review again.");
        setError(error instanceof ReviewError ? error.message : "The comparison could not finish. Check the CSV structure and limits, then try again.");
      }
    } finally {
      if (revision.current === token) setBusy(false);
    }
  }

  async function inspect(row: ReviewRow) {
    const active = session.current;
    if (!active) return;
    const token = revision.current;
    const query = ++details.current;
    setSelectedId(row.id);
    setDetail(null);
    setDetailBusy(true);
    setError("");
    try {
      const result = await active.detail(row);
      if (session.current !== active || revision.current !== token || details.current !== query) return;
      setDetail(result);
      setStatus("Row evidence ready.");
      window.requestAnimationFrame(() => {
        if (revision.current === token && details.current === query) evidencePane.current?.focus();
      });
    } catch {
      if (session.current === active && revision.current === token && details.current === query) {
        setError("This row's evidence could not be read. Select the row to try again.");
      }
    } finally {
      if (session.current === active && revision.current === token && details.current === query) setDetailBusy(false);
    }
  }

  function closeEvidence() {
    details.current++;
    setSelectedId(null);
    setDetail(null);
    setDetailBusy(false);
    if (evidenceOpener.current?.isConnected) evidenceOpener.current.focus();
  }

  const loadingInput = reading.before || reading.after;
  const canCompare = !!inputs.before && !!inputs.after && keys.length > 0 && !busy && !loadingInput;
  const counts = summary?.counts;
  const unkeyed = counts ? counts.unkeyedBefore + counts.unkeyedAfter : 0;
  const changeCount = counts ? counts.changed + counts.added + counts.removed : 0;
  const conserved = counts && counts.beforeRows === counts.changed + counts.unchanged + counts.removed + counts.ambiguousBefore + counts.unkeyedBefore
    && counts.afterRows === counts.changed + counts.unchanged + counts.added + counts.ambiguousAfter + counts.unkeyedAfter;
  const pageCount = reviewPage ? Math.max(1, Math.ceil(reviewPage.total / reviewPage.pageSize)) : 1;
  const filterOptions: { value: Filter; label: string; count?: number }[] = [
    { value: "changes", label: "All changes", count: changeCount },
    { value: "changed", label: "Changed", count: counts?.changed },
    { value: "added", label: "Added", count: counts?.added },
    { value: "removed", label: "Removed", count: counts?.removed },
    { value: "unchanged", label: "Unchanged", count: counts?.unchanged },
    { value: "ambiguous", label: "Ambiguous keys", count: counts?.ambiguousKeys },
    { value: "unkeyed", label: "Unkeyed rows", count: unkeyed },
  ];

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="ChangeLens home"><BrandMark /><span>ChangeLens</span></a>
      <div className="topbar-right"><span className="privacy-pill"><span className="privacy-dot" />In your browser</span>
        <a href="https://github.com/AntJun/change-lens" target="_blank" rel="noreferrer">Source <span aria-hidden="true">{"\u2197"}</span></a></div>
    </header>
    <main id="main-content">
      <section className="page-intro" aria-labelledby="page-title">
        <div><p className="eyebrow">SNAPSHOT RECONCILIATION</p><h1 id="page-title">Understand what changed.</h1>
          <p className="intro-copy">Compare two CSV exports with explicit row identity and evidence you can inspect.</p></div>
        <p className="privacy-note"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 2 3 5v5c0 4 7 8 7 8s7-4 7-8V5l-7-3Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m7 10 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          <span>Files stay in this tab.<br />No upload or saved history.</span></p>
      </section>
      <div className="workbench">
        <aside className="setup-panel" aria-label="Comparison setup">
          <div className="panel-heading"><div><p className="eyebrow">START HERE</p><h2>Your snapshots</h2></div>
            <button className="button button-quiet" onClick={loadExample}>Load example</button></div>
          <div className="source-stack">
            {(["before", "after"] as const).map((side, index) => <section className={"source-card " + (inputs[side] ? "source-loaded" : "")} key={side} aria-labelledby={side + "-heading"}>
              <div className="source-card-top"><span className="step-number">0{index + 1}</span><h3 id={side + "-heading"}>{side === "before" ? "Before snapshot" : "After snapshot"}</h3>
                {inputs[side] && <span className="loaded-label">Loaded</span>}</div>
              <label className="file-label" htmlFor={side + "-file"}>{side === "before" ? "Choose before CSV" : "Choose after CSV"}</label>
              <input className="file-input" id={side + "-file"} type="file" accept=".csv,text/csv" ref={side === "before" ? beforeInput : afterInput}
                onChange={(event) => void importFile(side, event.target.files?.[0])} aria-describedby={side + "-meta"} />
              <div className="source-meta" id={side + "-meta"}>
                {reading[side] ? <p>Reading snapshot...</p> : inputs[side] ? <>
                  <p className="source-name">{inputs[side]!.name}</p>
                  <p>{number.format(inputs[side]!.headers.length)} columns <span aria-hidden="true">/</span> {(inputs[side]!.byteLength / 1024).toFixed(1)} KiB</p>
                  <p className="hash" title={inputs[side]!.sha256}>SHA-256 {inputs[side]!.sha256.slice(0, 14)}...</p>
                </> : <p>UTF-8 CSV, up to 8 MiB.</p>}
              </div>
            </section>)}
          </div>

          <section className="policy-section" aria-labelledby="identity-heading">
            <div className="section-label"><span className="step-number">03</span><h3 id="identity-heading">Define row identity</h3></div>
            <fieldset className="key-fieldset"><legend>Match rows using</legend><p className="field-hint" id="key-hint">Select up to {LIMITS.keys} shared columns. Names match exactly.</p>
              <div className="key-options">
                {shared.length ? shared.map((name) => <label className={"key-chip " + (keys.includes(name) ? "key-selected" : "")} key={name}>
                  <input type="checkbox" checked={keys.includes(name)} aria-describedby="key-hint"
                    disabled={!keys.includes(name) && keys.length >= LIMITS.keys}
                    onChange={(event) => { invalidate(); setKeys((current) => event.target.checked ? [...current, name] : current.filter((key) => key !== name)); }} />
                  <span>{name}</span></label>) : <p className="empty-hint">{inputs.before && inputs.after ? "Both snapshots need a shared column to define a key." : "Shared columns appear after both snapshots load."}</p>}
              </div>
            </fieldset>
            <label className="field-label" htmlFor="null-policy">Null handling</label>
            <select id="null-policy" value={nullMode} onChange={(event) => { invalidate(); setNullMode(event.target.value as NullMode); }}>
              <option value="text">All values are text</option><option value="marker">{"Use \\N as null"}</option>
            </select>
            <p className="field-hint">{nullMode === "text" ? "Empty cells stay empty text. Numbers, spaces, and case stay exact." : "The exact \\N marker becomes null, including inside quotes. Empty cells stay empty text."}</p>
            <p className="identity-note">Empty or null key values are unkeyed. Repeated keys are grouped for separate review.</p>
          </section>
          <div className="run-actions"><button className="button button-primary" onClick={() => void compare()} disabled={!canCompare}>{busy ? "Comparing..." : "Compare snapshots"}<span aria-hidden="true">{"\u2192"}</span></button>
            {busy && <button className="button button-secondary" onClick={() => invalidate("Comparison canceled. Your snapshots are ready to compare again.")}>Cancel comparison</button>}
            <button className="button button-text" onClick={clear}>Clear workspace</button>
          </div>
          <details className="limits-disclosure"><summary>Supported CSV and limits</summary><p>Comma-separated UTF-8 CSV with one header record and consistent row widths. Headers must be unique and nonempty.</p>
            <dl><div><dt>File size</dt><dd>8 MiB each</dd></div><div><dt>Data rows</dt><dd>100,000 each</dd></div><div><dt>Columns</dt><dd>64 each</dd></div><div><dt>Cells</dt><dd>1,000,000 each</dd></div><div><dt>Cell text</dt><dd>16,384 characters</dd></div></dl>
          </details>
        </aside>

        <section className="results-panel" aria-labelledby="review-heading">
          <div className="review-heading"><div><p className="eyebrow">REVIEW WORKSPACE</p><h2 id="review-heading">Reconciliation</h2></div>
            <button className="button button-secondary export-button" disabled={!summary || busy || loadingInput}
              onClick={() => { if (summary) { download(summary, "change-lens-summary.json"); setStatus("Summary exported with schemas and source hashes."); } }}>Export summary<span aria-hidden="true">{"\u2193"}</span></button></div>
          <div className={"status-line " + (busy || loadingInput ? "status-running" : "")} role="status" aria-live="polite" aria-atomic="true">
            <span className="status-dot" aria-hidden="true" />{loadingInput ? "Reading selected snapshots..." : status}
          </div>
          {error && <div className="error-notice" role="alert"><strong>Something needs attention.</strong><p>{error}</p></div>}

          {!summary ? <div className="empty-workspace" aria-label="No comparison results">
            <svg className="empty-illustration" viewBox="0 0 264 150" width="264" height="150" aria-hidden="true">
              <rect x="18" y="19" width="101" height="104" rx="8" fill="#fff" stroke="#cad5d5" />
              <rect x="145" y="32" width="101" height="104" rx="8" fill="#fff" stroke="#cad5d5" />
              <path d="M18 46h101M145 59h101" stroke="#cad5d5" />
              <path d="M33 33h30M160 46h30" stroke="#8d9da1" strokeWidth="3" strokeLinecap="round" />
              <path d="M33 62h69M33 80h48M33 98h58M160 76h69M160 112h58" stroke="#dae2e1" strokeWidth="5" strokeLinecap="round" />
              <path d="M160 94h48" stroke="#0b766e" strokeWidth="5" strokeLinecap="round" />
              <circle cx="132" cy="73" r="19" fill="#e5f3ed" stroke="#9bc9bb" />
              <path d="m124 73 5 5 11-11" fill="none" stroke="#0b766e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3>{busy ? "Building your comparison" : "Two snapshots. One clear review."}</h3>
            <p>{busy ? "You can cancel or choose a newer snapshot while the comparison runs." : "Load a before and after export, choose the fields that identify each row, and inspect the evidence behind every change."}</p>
            {!busy && <button className="button button-secondary" onClick={loadExample}>Try the constructed example<span aria-hidden="true">{"\u2192"}</span></button>}
            <div className="workflow-notes"><span><b>01</b> Choose snapshots</span><span><b>02</b> Select a key</span><span><b>03</b> Inspect changes</span></div>
          </div> : <>
            <div className="result-context"><p><strong>{number.format(summary.counts.beforeRows)}</strong> before rows<span aria-hidden="true">{"\u2192"}</span><strong>{number.format(summary.counts.afterRows)}</strong> after rows</p>
              {conserved && <span className="reconciled-label"><span aria-hidden="true">{"\u2713"}</span> Counts reconciled</span>}</div>
            <div className="stats-grid">
              {(["changed", "added", "removed", "unchanged"] as const).map((kind) => <button className={"stat-card stat-" + kind + (filter === kind ? " stat-active" : "")} key={kind}
                onClick={() => void loadPage(kind, 0)} aria-label={"Show " + kind + " rows"}><span className="stat-label">{kind}</span><strong data-testid={"count-" + kind}>{number.format(summary.counts[kind])}</strong><span className="stat-foot">Inspect rows<span aria-hidden="true">{"\u2197"}</span></span></button>)}
            </div>
            {(counts!.ambiguousKeys > 0 || unkeyed > 0) && <div className="attention-strip"><div><span className="attention-icon" aria-hidden="true">!</span><p><strong>Identity needs review</strong><span>Ambiguous groups and unkeyed rows are kept separate from unique matches.</span></p></div>
              <div className="attention-actions">{counts!.ambiguousKeys > 0 && <button onClick={() => void loadPage("ambiguous", 0)}>{number.format(counts!.ambiguousKeys)} ambiguous {counts!.ambiguousKeys === 1 ? "key" : "keys"}</button>}
                {unkeyed > 0 && <button onClick={() => void loadPage("unkeyed", 0)}>{number.format(unkeyed)} unkeyed rows</button>}</div></div>}
            <div className="schema-notice"><p><strong>Compared fields:</strong> {summary.schema.compared.length ? summary.schema.compared.join(", ") : "Key identity only; no shared non-key fields."}</p>
              {(summary.schema.added.length > 0 || summary.schema.removed.length > 0) && <p><strong>Schema changes:</strong> {summary.schema.added.length} added, {summary.schema.removed.length} removed. Row-change counts use shared non-key fields.</p>}
              {(summary.schema.added.length > 0 || summary.schema.removed.length > 0) && <details><summary>Inspect schema changes</summary><p>Added: {summary.schema.added.join(", ") || "None"}</p><p>Removed: {summary.schema.removed.join(", ") || "None"}</p></details>}
            </div>
            <div className="table-toolbar"><div><label htmlFor="result-filter">Show</label><select id="result-filter" value={filter} onChange={(event) => void loadPage(event.target.value as Filter, 0)}>
              {filterOptions.map((option) => <option value={option.value} key={option.value}>{option.label} ({number.format(option.count ?? 0)})</option>)}</select></div>
              <span className="result-total">{paging ? "Reading rows..." : number.format(reviewPage?.total ?? 0) + " results"}</span></div>
            <div className="table-scroll" aria-busy={paging}>
              <table className="review-table"><caption>Row reconciliation results. Key fields: {summary.keys.join(" + ")}. Row references are parsed data-record ordinals after the header.</caption>
                <thead><tr><th scope="col">Key</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Result</th><th scope="col"><span className="sr-only">Evidence</span></th></tr></thead>
                <tbody>{reviewPage?.rows.map((row) => <tr key={row.id} className={selectedId === row.id ? "selected-row" : ""}>
                  <th scope="row"><span className="key-display" title={keyPreview(row)}>{keyPreview(row).slice(0, 140) || "(empty key)"}</span></th>
                  <td className="row-reference">{rowReference(row, "before")}</td><td className="row-reference">{rowReference(row, "after")}</td>
                  <td><span className={"result-badge badge-" + row.kind}>{row.kind}</span></td>
                  <td><button className="inspect-button" onClick={(event) => { evidenceOpener.current = event.currentTarget; void inspect(row); }} aria-label={"Inspect " + row.kind + " key " + keyPreview(row).slice(0, 140)}
                    aria-expanded={selectedId === row.id} aria-controls={selectedId === row.id ? "row-evidence" : undefined}>Inspect<span aria-hidden="true">{"\u2192"}</span></button></td></tr>)}
                  {!paging && (!reviewPage || reviewPage.rows.length === 0) && <tr><td colSpan={5} className="no-results">No rows in this view. Choose another result filter to continue the review.</td></tr>}
                  {paging && <tr><td colSpan={5} className="no-results">Reading this result page...</td></tr>}
                </tbody></table></div>
            <div className="pagination"><p>{reviewPage && reviewPage.total > 0 ? "Page " + (reviewPage.page + 1) + " of " + pageCount : "No result pages"} <span>Up to {LIMITS.pageSize} rows per page</span></p>
              <div><button className="button button-secondary button-small" disabled={paging || !reviewPage || reviewPage.page === 0} onClick={() => void loadPage(filter, (reviewPage?.page ?? 0) - 1)}>Previous</button>
                <button className="button button-secondary button-small" disabled={paging || !reviewPage || reviewPage.page + 1 >= pageCount} onClick={() => void loadPage(filter, (reviewPage?.page ?? 0) + 1)}>Next</button></div></div>
            <div className="review-method"><span>Exact text comparison<span aria-hidden="true"> / </span>{summary.nullMode === "text" ? "Empty cells stay text" : "\\N is null"}</span>
              <span>DuckDB {summary.engineVersion}<span aria-hidden="true"> / </span>{(summary.elapsedMs / 1000).toFixed(2)} s</span></div>
            <p className="export-note">Summary exports include schemas and source hashes. Row evidence exports include cell values.</p>
          </>}

          {selectedId !== null && <aside className="evidence-panel" id="row-evidence" aria-labelledby="evidence-title" ref={evidencePane} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeEvidence(); } }}>
            <div className="evidence-heading"><div><p className="eyebrow">ROW EVIDENCE</p><h3 id="evidence-title">{detail?.row.kind === "ambiguous" ? "An ambiguous key group" : "Inspect the source records"}</h3></div>
              <button className="button button-text" onClick={closeEvidence} aria-label="Close row evidence">Close <span aria-hidden="true">{"\u00d7"}</span></button></div>
            {detailBusy && <p role="status">Reading row evidence...</p>}
            {detail && <>
              <div className="evidence-context"><p className="evidence-key">{keyPreview(detail.row)}</p>
                <button className="button button-secondary button-small" onClick={() => { download(detail, "change-lens-row-evidence.json"); setStatus("Selected row evidence exported with cell values."); }}>Export row evidence<span aria-hidden="true">{"\u2193"}</span></button></div>
              {detail.row.kind === "ambiguous" ? <div className="ambiguous-evidence"><p className="evidence-explanation">This key has repeated records. Review its source members individually.</p>
                <p className="member-count">{detail.truncated ? "Showing " + detail.members.length + " of " + number.format(detail.memberTotal) + " source records." : number.format(detail.memberTotal) + " source records in this group."}</p>
                {detail.members.map((member, index) => <details className="member-record" key={member.side + "-" + member.row} open={index === 0}>
                  <summary><span className={"side-label side-" + member.side}>{member.side}</span> Record #{member.row}</summary>
                  <dl>{member.cells.map((cell) => <div key={cell.name}><dt>{cell.name}</dt><dd>{valueCell({ present: true, value: cell.value })}</dd></div>)}</dl></details>)}
              </div> : <div className="detail-table-scroll"><table className="detail-table"><caption>Source field values for the selected row. Missing fields, null, and empty text have separate labels.</caption>
                <thead><tr><th scope="col">Field</th><th scope="col">Before {detail.row.beforeRow !== null ? "#" + detail.row.beforeRow : ""}</th><th scope="col">After {detail.row.afterRow !== null ? "#" + detail.row.afterRow : ""}</th></tr></thead>
                <tbody>{detail.columns.map((column) => <tr key={column.name} className={column.changed ? "field-changed" : ""} data-changed={column.changed}>
                  <th scope="row">{column.name}{column.key && <span className="key-label">key</span>}</th><td>{valueCell(column.before)}</td><td>{valueCell(column.after)}</td></tr>)}</tbody>
              </table></div>}
            </>}
          </aside>}
        </section>
      </div>
      <footer className="footer"><span>ChangeLens <span aria-hidden="true">/</span> Maintained by <a href="https://github.com/AntJun" target="_blank" rel="noreferrer">AntJun</a></span>
        <span>Constructed example data. In-memory review.</span><a href="https://github.com/AntJun/change-lens#readme" target="_blank" rel="noreferrer">Format and verification notes<span aria-hidden="true">{"\u2197"}</span></a></footer>
    </main>
  </div>;
}
