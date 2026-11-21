// Token Radar entry point (Node 22, standard library only).
// Reads the sealed snapshot, scores it with lib/model.ts, and writes
// the grader's /output: board.json, data.js, dashboard/, screenshots/
// and dossier.json (via the vendored makefun-board library).
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardIssue, buildRadar, dataScript, parseSnapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flag("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`,
  );
  process.exit(2);
}
const outDir = flag("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const snap = parseSnapshot(readFileSync(inputFile, "utf8"));
const { board, radar } = buildRadar(snap);
const issue = boardIssue(board, snap);
if (issue !== null) {
  process.stderr.write(`token radar: board refused: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "board.json"), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, "data.js"), dataScript(radar));

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const dashFiles = copyDir(join(here, "dashboard"), join(outDir, "dashboard"));
let dashBytes = 0;
for (const f of dashFiles) dashBytes += statSync(join(outDir, "dashboard", f)).size;
if (dashBytes > TEXT_MAX_BYTES) {
  process.stderr.write(
    `token radar: dashboard source is ${dashBytes} bytes, past the ${TEXT_MAX_BYTES} dossier text cap: the judge would read a cut page\n`,
  );
  process.exit(1);
}
const shots = copyDir(join(here, "screenshots"), join(outDir, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in 3\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: bad screenshot name ${name}\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(outDir, "dossier.json"),
  buildDossier(outDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} watchlist, ${board.length} rows (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, "board.json")}, ${join(outDir, "data.js")}, dashboard/, screenshots/ (${shots.length}) and dossier.json\n`,
);
