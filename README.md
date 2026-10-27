# ChangeLens

[![CI](https://github.com/AntJun/change-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/AntJun/change-lens/actions/workflows/ci.yml)

**Review two CSV snapshots with explicit row identity and inspectable evidence.**

[Open the workbench](https://www.antjun.com/change-lens/) |
[Comparison policy](docs/policy.md) |
[Architecture](docs/design.md)

ChangeLens helps review portable exports during a migration, synchronization check,
or API change. Select shared key columns, compare two snapshots, and inspect the
source records behind changed, added, removed, and unchanged rows.

Repeated keys form separate ambiguity groups. Empty or null key components produce
unkeyed rows. Every input row belongs to an accounted category.

React and TypeScript provide the interface. DuckDB-WASM supplies CSV parsing and
comparison queries in a dedicated worker. All runtime assets are hosted with the app.

Maintained by [AntJun](https://github.com/AntJun). MIT licensed.

## Try it

1. Select **Load example**. The input data is constructed inventory data.
2. Keep both **SKU** and **region** selected as the composite key.
3. Select **Compare snapshots**.
4. Inspect changed rows, the repeated-key group, and unkeyed records.
5. Export a summary or selected row evidence as JSON.

The example contains 10 rows per side: 3 changed, 2 added, 1 removed, 3 unchanged,
one ambiguous key group, and one unkeyed row on each side.

For your own review, select a before and after CSV, choose 1-8 shared key columns,
and select the null policy before comparing.

## Explicit semantics

- Cell values remain text. Identifiers such as 001 and 1 remain distinct.
- Header names match exactly, including case. Reordering columns preserves matching.
- Empty text remains empty text. Optional marker mode maps exact \N values to null.
- A key with an empty or null component is excluded from keyed matching.
- A repeated tuple on either side makes the whole key group ambiguous on both sides.
- Unique matched rows compare shared non-key fields with null-aware equality.
- Added and removed columns appear as schema changes, separately from row-change counts.
- Source references use 1-based parsed data-record ordinals after the header.

The [policy](docs/policy.md) defines blank records, field limits, and count conservation.

## Evidence and privacy

The summary export includes source SHA-256 hashes, schemas, policies, engine version,
counts, and elapsed comparison time. It excludes source filenames and raw row values.
Selected-row exports include the displayed cell values and explicit missing/null state.
Ambiguous-group exports state whether their bounded member list is truncated.

Selected files are read into tab memory. The app sends no file contents to a service,
stores no review history, and uses no analytics or third-party runtime asset service.
Clear or cancel terminates the owned engine worker. Changing inputs or policies
invalidates older results. The app loads its static assets over the network; once the
engine assets are available, file comparison uses the loaded tab.

There is no service worker or offline-reload guarantee. Clearing releases application
references and workers; browser memory reclamation follows the browser's lifecycle.

## Bounds

| Input or operation | Limit |
|---|---|
| File size | 8 MiB per snapshot |
| Rows | 100,000 parsed data records per snapshot |
| Cells | 1,000,000 per snapshot |
| Columns | 64 per snapshot |
| Field length | 16,384 characters |
| Header name | 256 characters, unique and nonempty, without control characters |
| Key columns | 1-8 |
| Result page | 50 rows or key groups |
| Ambiguous evidence | At most 50 source members, with total and truncation stated |
| Operation deadline | 45 seconds |

CSV uses UTF-8, commas, double-quoted fields, doubled quote escapes, and consistent
record widths. Malformed records fail the comparison. The tool uses an engine memory
setting of 256MB; the browser also holds input bytes and interface state.

## Development

Node.js 24 and Python 3 are used by the verification workflow.

~~~sh
npm ci --ignore-scripts
npm test
npm run build
python3 tools/generate_cases.py
npx playwright install --with-deps chromium firefox
npm run test:browser
npm run preview
~~~

The production build copies pinned DuckDB worker/WASM assets and runtime dependency
license notices into the static output. package-lock.json fixes the resolved dependency
graph. CI also checks dependency advisories and all fetched Git history for credentials
and private contact data.

## Scope

The comparison uses its documented text/null/key policy. It checks the supplied exports;
database transaction isolation, export completeness, numeric tolerances, timestamps,
and application-specific equivalence require separate evidence.

Technical references: [DuckDB-WASM 1.32.0](https://github.com/duckdb/duckdb-wasm/releases/tag/v1.32.0) |
[DuckDB CSV parsing](https://duckdb.org/docs/1.4/data/csv/overview) |
[Papa Parse](https://www.papaparse.com/docs).
