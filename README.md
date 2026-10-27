# ChangeLens

Offline CSV snapshot reconciliation with explicit keys, ambiguity handling, and inspectable evidence.

ChangeLens compares portable data exports in a browser. It keeps row identity explicit,
separates duplicate-key groups from unique matches, and records source hashes and
reconciliation counts. CSV parsing and comparison queries use DuckDB-WASM.

The application and its release checks are being integrated. All example inputs are
constructed fixtures. Maintained by [AntJun](https://github.com/AntJun).
