/* Suppress upstream parser logging before any input reaches the owned worker. */
for (const method of [
  "log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table",
  "assert", "group", "groupCollapsed", "groupEnd", "count", "countReset",
  "time", "timeEnd", "timeLog", "timeStamp", "clear", "profile", "profileEnd",
]) {
  console[method] = () => {};
}
importScripts("./vendor/duckdb-browser-mvp.worker.js");
