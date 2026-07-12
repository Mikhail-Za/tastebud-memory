// Shared startup validation for tastebud.mjs and tagger.mjs.
// Every failure exits with ONE concise, field-specific line and no raw stack trace,
// so a stranger who fat-fingers the config or corrupts a data file gets a hint, not a dump.
// Stdlib only; imported by both scripts so the rules live in exactly one place.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function die(msg) {
  console.error(`tastebud: ${msg}`);
  process.exit(1);
}

function readJSON(path, label) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return die(`${label} not found (${path})`); }
  try { return JSON.parse(raw); }
  catch (e) { return die(`${label} is not valid JSON (${path}): ${e.message}`); }
}

// Locate + parse tastebud.config.json (cwd first, then the script dir). Missing file and
// malformed JSON both exit with a one-liner instead of throwing.
export function loadConfig(scriptDir) {
  for (const dir of [process.cwd(), scriptDir]) {
    const p = join(dir, 'tastebud.config.json');
    if (existsSync(p)) return { ...readJSON(p, 'tastebud.config.json'), _configDir: dir };
  }
  return die('tastebud.config.json not found (looked in cwd and script dir)');
}

// Config shape: dimensions must be a sane integer; dataDir and every logDirs entry must exist.
export function validateConfig(config, configDir) {
  const dims = config.dimensions ?? 4096;
  if (!Number.isInteger(dims) || dims < 64)
    die(`config "dimensions" must be an integer >= 64 (got ${JSON.stringify(config.dimensions)})`);
  const dataDir = resolve(configDir, config.dataDir ?? './examples');
  if (!existsSync(dataDir)) die(`config "dataDir" does not exist: ${dataDir}`);
  for (const d of (config.logDirs ?? [])) {
    if (!existsSync(resolve(configDir, d))) die(`config "logDirs" entry does not exist: ${resolve(configDir, d)}`);
  }
}

// Load + shape-check the two data files. Returns { codebook, comps }.
export function loadData(DATA) {
  const codebook = readJSON(join(DATA, 'codebook.json'), 'codebook.json');
  if (!codebook.projects || typeof codebook.projects !== 'object' || Array.isArray(codebook.projects))
    die('codebook.json: "projects" must be an object of slug entries');

  const comps = readJSON(join(DATA, 'compositions.json'), 'compositions.json');
  if (!Array.isArray(comps.days))
    die('compositions.json: "days" must be an array of {date, major[], minor[]}');
  comps.days.forEach((d, i) => {
    if (!d || typeof d.date !== 'string')
      die(`compositions.json: days[${i}] must have a string "date"`);
    if (!Array.isArray(d.major))
      die(`compositions.json: days[${i}] (${d.date}) "major" must be an array`);
    if ('minor' in d && !Array.isArray(d.minor))
      die(`compositions.json: days[${i}] (${d.date}) "minor" must be an array`);
  });
  return { codebook, comps };
}
