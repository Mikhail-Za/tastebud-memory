// Shared startup validation for tastebud.mjs and tagger.mjs.
// Every failure exits with ONE concise, field-specific line and no raw stack trace,
// so a stranger who fat-fingers the config or corrupts a data file gets a hint, not a dump.
// Stdlib only; imported by both scripts so the rules live in exactly one place.

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

function die(msg) {
  console.error(`tastebud: ${msg}`);
  process.exit(1);
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
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

// Config shape: dimensions must be a sane integer; dataDir and every logDirs entry must exist and
// be a directory. candidatesDir/projectsDir are NOT checked here: they are validated lazily, only
// when a candidate command actually runs (see validateCandidateDirs), so the legacy commands keep
// working on a config that never mentions them.
export function validateConfig(config, configDir) {
  const dims = config.dimensions ?? 4096;
  if (!Number.isInteger(dims) || dims < 64)
    die(`config "dimensions" must be an integer >= 64 (got ${JSON.stringify(config.dimensions)})`);
  const dataDir = resolve(configDir, config.dataDir ?? './examples');
  if (!existsSync(dataDir)) die(`config "dataDir" does not exist: ${dataDir}`);
  if ('logDirs' in config && config.logDirs != null && !Array.isArray(config.logDirs))
    die('config "logDirs" must be an array of directory paths');
  for (const d of (config.logDirs ?? [])) {
    if (typeof d !== 'string') die(`config "logDirs" entries must be strings (got ${JSON.stringify(d)})`);
    const abs = resolve(configDir, d);
    if (!isDir(abs)) die(`config "logDirs" entry is not an existing directory: ${abs}`);
  }
}

// THE canonical date -> log resolver, shared by the tagger and the candidate evidence gate (g7) so
// both resolve a `<date>.md` identically. First-match by dir order, but two dirs both holding the
// same date is ambiguous and fails (we refuse to guess which log is authoritative).
export function resolveLog(logDirs, date) {
  const hits = logDirs.filter(dir => existsSync(join(dir, date + '.md')));
  if (hits.length === 0) return { ok: false, reason: 'no-log' };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, path: join(hits[0], date + '.md') };
}

// Absolute log dirs, canonicalized (symlinks resolved) and deduped by canonical path, in config
// order. Shared by the tagger's date resolver and the candidate evidence gate so both search the
// exact same set. Assumes validateConfig already proved each dir exists.
export function resolveLogDirs(config, configDir) {
  const out = [];
  const seen = new Set();
  for (const d of (config.logDirs ?? [])) {
    let abs = resolve(configDir, d);
    try { abs = realpathSync(abs); } catch {}
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

// Lazily validate the two candidate directories (exists AND is a directory). Called ONLY from the
// candidate commands (promote / sweep-candidates / autopromote). candidatesDir defaults to
// <dataDir>/project-candidates; projectsDir has no default and MUST be configured for these
// commands. Returns absolute paths.
export function validateCandidateDirs(config, configDir) {
  const dataDir = resolve(configDir, config.dataDir ?? './examples');
  const candidatesDir = resolve(configDir, config.candidatesDir ?? join(dataDir, 'project-candidates'));
  if (!isDir(candidatesDir)) die(`config "candidatesDir" is not an existing directory: ${candidatesDir}`);
  if (!config.projectsDir) die('config "projectsDir" must be set for candidate commands (the directory promoted project files are written to)');
  const projectsDir = resolve(configDir, config.projectsDir);
  if (!isDir(projectsDir)) die(`config "projectsDir" is not an existing directory: ${projectsDir}`);
  return { candidatesDir, projectsDir };
}

// TASTEBUD_CANDIDATE_COMPANION_MAX: the g6 companion-share ceiling. Default 0.30. Must parse to a
// finite number in [0,1]; anything else is a fail-closed configuration error (we NEVER silently
// disable the companion guard by treating a bad value as "no limit").
export function companionMax() {
  const raw = process.env.TASTEBUD_CANDIDATE_COMPANION_MAX;
  if (raw == null || raw === '') return 0.30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1)
    die(`TASTEBUD_CANDIDATE_COMPANION_MAX must be a finite number in [0,1] (got ${JSON.stringify(raw)})`);
  return n;
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
