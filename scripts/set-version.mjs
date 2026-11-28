// Keeps the version in one step across every package, the Nextcloud app and the deploy compose file's image default.
//   node scripts/set-version.mjs 0.2.0      set it everywhere
//   node scripts/set-version.mjs --check    fail if they differ (CI; with --tag v0.2.0 also checks a release tag)
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const json = ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/shared/package.json"];
const info = "integration/nextcloud-app/ncmail/appinfo/info.xml";
const read = (p) => readFileSync(new URL(p, root), "utf8");
const infoVersion = () => /<version>([^<]+)<\/version>/.exec(read(info))[1];
const compose = "deploy/docker-compose.yml";
const composeImage = /(ncmail:\$\{NCMAIL_VERSION:-)([^}]+)\}/;
const composeVersion = () => composeImage.exec(read(compose))?.[2] ?? "(no ncmail image default)";
const versions = () => Object.fromEntries([
  ...json.map((p) => [p, JSON.parse(read(p)).version]), [info, infoVersion()], [compose, composeVersion()],
]);

const args = process.argv.slice(2);
if (args[0] === "--check") {
  const v = versions();
  const want = args[1] === "--tag" ? args[2].replace(/^v/, "") : v["package.json"];
  const bad = Object.entries(v).filter(([, x]) => x !== want);
  if (bad.length) { console.error(`Expected ${want}, found:\n` + bad.map(([p, x]) => `  ${p}: ${x}`).join("\n")); process.exit(1); }
  console.log(`All versions are ${want}.`);
} else {
  const v = args[0];
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v ?? "")) { console.error("Usage: node scripts/set-version.mjs <major.minor.patch>"); process.exit(1); }
  for (const p of json) writeFileSync(new URL(p, root), read(p).replace(/("version":\s*")[^"]+/, `$1${v}`));
  writeFileSync(new URL(info, root), read(info).replace(/<version>[^<]+<\/version>/, `<version>${v}</version>`));
  writeFileSync(new URL(compose, root), read(compose).replace(composeImage, `$1${v}}`));
  console.log(`Version set to ${v}. Add it to CHANGELOG.md, then commit and tag v${v}.`);
}
