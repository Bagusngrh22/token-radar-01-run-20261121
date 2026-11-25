// Token Radar entry point (Node 22, standard library only).
// Reads the sealed snapshot, scores it with lib/model.ts, and writes
// the grader's /output: board.json, data.js, dashboard/, screenshots/
// and dossier.json (via the vendored makefun-board library).
// Before it writes the dossier it re-checks its own work: the board
// must pass the gate-shaped checks in lib/model.ts, the dashboard
// source must fit the dossier text cap, no dashboard file may name a
// network address, and every screenshot must be a PNG/JPEG inside
// the gate's size cap.
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
const NETWORK = /https?:\/\//;

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

const inputArg = flag("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory>`);
}
const outDir = flag("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const snap = parseSnapshot(readFileSync(inputFile, "utf8"));
const { board, radar } = buildRadar(snap);
const issue = boardIssue(board, snap);
if (issue !== null) fail(`board refused: ${issue}`);
if (radar.rows.length !== board.length) fail("radar rows and board rows disagree");

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
for (const f of dashFiles) {
  const path = join(outDir, "dashboard", f);
  dashBytes += statSync(path).size;
  const text = readFileSync(path, "utf8");
  if (NETWORK.test(text)) fail(`dashboard file ${f} names a network address`);
}
if (dashBytes > TEXT_MAX_BYTES) {
  fail(
    `dashboard source is ${dashBytes} bytes, past the ${TEXT_MAX_BYTES} dossier text cap: the judge would read a cut page`,
  );
}
const shots = copyDir(join(here, "screenshots"), join(outDir, "screenshots"));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length}: hand in 3`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`bad screenshot name ${name}`);
  const size = statSync(join(outDir, "screenshots", name)).size;
  if (size > 524_288) fail(`screenshot ${name} is ${size} bytes, past the 512 KiB cap`);
}

writeFileSync(
  join(outDir, "dossier.json"),
  buildDossier(outDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);
const dossierBytes = statSync(join(outDir, "dossier.json")).size;
if (dossierBytes > 1_572_864) fail(`dossier.json is ${dossierBytes} bytes, past the 1.5 MiB cap`);

process.stdout.write(
  `token radar (${radar.model_version}): ${snap.protocols.length} protocols, ${snap.watchlist.length} watchlist, ${board.length} rows (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, "board.json")}, ${join(outDir, "data.js")}, dashboard/ (${dashFiles.length} files, ${dashBytes} bytes), screenshots/ (${shots.length}) and dossier.json\n`,
);
