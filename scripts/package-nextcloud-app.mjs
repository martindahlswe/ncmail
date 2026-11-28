// Builds the Nextcloud app archive: dist/ncmail-<version>.tar.gz (the folder is named "ncmail", as Nextcloud expects) and its checksum.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, "utf8")).version;
mkdirSync(`${root}dist`, { recursive: true });
const out = `${root}dist/ncmail-${version}.tar.gz`;
// COPYFILE_DISABLE keeps macOS from adding ._ files
execFileSync("tar", ["-czf", out, "-C", `${root}integration/nextcloud-app`, "--exclude=.DS_Store", "ncmail"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sum = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(`${out}.sha256`, `${sum}  ncmail-${version}.tar.gz\n`);
console.log(`${out}\nsha256 ${sum}`);
