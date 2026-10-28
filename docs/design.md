# Architecture and validation

~~~text
File controls -> bounded UTF-8/header checks -> SHA-256 of original bytes
                                   |
React session owner -> structural validation worker
                                   |
                    quiet classic worker -> DuckDB-WASM in-memory tables
                                   |
                    strict CSV -> explicit keys -> category counts
                                   |
                    bounded result pages -> selected row evidence
~~~

The interface owns input-read tokens, a comparison revision, and independent page/detail
generations. A later input, policy, clear, or cancellation invalidates older asynchronous
results. The engine session owns its database worker, validation worker, and abort promise. Disposing it terminates
both workers and settles the app-facing cancellation path even when the upstream SDK
leaves terminated tasks unresolved.

The 45-second comparison deadline covers engine startup, CSV import, queries, and
summary collection. Individual inspection queries also have a bounded deadline.
Input byte, column, row, cell, field, key, and result-page limits constrain work.

## Parsing and SQL boundaries

Papa Parse reads the bounded first physical header line. An owned validation worker
also performs step-based structural validation before database import, enforcing
record widths and data limits. Its record count and a SHA-256 digest of length-framed
parsed cells must agree with DuckDB. This detects differing interpretations of spaces
around quotes without transferring raw values through validation responses. The application rejects header
controls and invalid identities before comparison. DuckDB parses the entire file with
an explicit positional VARCHAR schema, strict record widths, and forced non-null text.

External headers map to generated c0, c1, and subsequent identifiers. Keys map to generated
k0, k1, and subsequent aliases. No header or cell text is interpolated into SQL. File
registration uses fixed names and copied buffers, preserving the original imports for
later policy changes. Query filters and numeric record references are validated.

Extensions do not auto-install or auto-load. After CSV import, external access is
disabled. There is no arbitrary SQL entry point, remote file registration, or persistent
database path.

## Private diagnostics

The owned classic-worker bootstrap suppresses console methods before importing the
unmodified vendor worker. The pinned vendor dispatcher can otherwise log raw parser
exceptions outside its logger interface.

An earlier parent-worker error listener prevents default reporting and stops propagation
before disposing the session. The application exposes fixed format, limit, and lifecycle
errors. Raw engine exception strings never become interface messages.

All application and vendor assets are served from the same origin. The content security
policy limits connections and scripts, allows WebAssembly, and disables forms, objects,
and base-URL changes. React renders imported strings as text.

## Verification method

The independent Python generator uses CSV writer output, raw row arrays, tuples, and
counters. It shares no SQL or comparison implementation with the application. Its
constructed cases cover identity, text/null handling, schema changes, quoting, and
ambiguity. Conservation equations are asserted independently.

Node tests cover bounded header parsing, byte hashes, header/key policy, generated SQL
boundaries, category accounting, and result-page limits. Browser tests exercise the
production application, real WASM engine, imports, evidence, exports, cancellation,
keyboard controls, logging, network behavior, and a generated 50,000-row pair.

The benchmark records its actual browser/engine environment and elapsed time. A single
run describes that environment; it establishes no general latency or memory guarantee.
