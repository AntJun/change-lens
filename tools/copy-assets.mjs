import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

await mkdir("public/vendor", { recursive: true });
const distribution = "node_modules/@duckdb/duckdb-wasm/dist";
for (const name of ["duckdb-mvp.wasm", "duckdb-browser-mvp.worker.js"]) {
  await copyFile(path.join(distribution, name), path.join("public/vendor", name));
}
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const notices = ["ChangeLens runtime dependency notices\n\nOriginal notices follow without modification.\n"];
for (const [directory, metadata] of Object.entries(lock.packages)) {
  if (!directory.startsWith("node_modules/") || metadata.dev) continue;
  const files = await readdir(directory);
  for (const filename of files.filter(name => /^(?:licen[sc]e|copying|notice)(?:\.[a-z]+)?$/i.test(name))) {
    const text = await readFile(path.join(directory, filename), "utf8");
    notices.push("\n\n--- " + directory + "/" + filename + " ---\n\n" + text);
  }
}
await writeFile("public/vendor/notices.txt", notices.join(""), "utf8");
console.log("Copied self-hosted runtime assets and dependency notices.");
