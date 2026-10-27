import { readFile } from "node:fs/promises";

const text = await readFile("package-lock.json", "utf8");
const lock = JSON.parse(text);
for (const [name, metadata] of Object.entries(lock.packages)) {
  if (name && !name.startsWith("node_modules/")) throw new Error("Unexpected package path.");
  if (metadata.resolved) {
    const source = new URL(metadata.resolved);
    if (source.protocol !== "https:" || source.hostname !== "registry.npmjs.org"
        || source.username || source.password) throw new Error("Unexpected package source.");
  }
}
if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
  throw new Error("Unexpected contact data in lock metadata.");
}
console.log("CHANGE_LENS_LOCK_START");
console.log(text.trimEnd());
console.log("CHANGE_LENS_LOCK_END");
