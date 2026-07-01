#!/usr/bin/env node
// Tastebud nightly sweeper / fallback tagger.
//
// Recommended production pattern (see docs/production-pattern.md):
//   1. Your PRIMARY LLM (whatever your agent platform already runs on a schedule) tags
//      yesterday's log and writes the result to <dataDir>/inbox/<date>.json - a tiny file write,
//      easy for any agent to do reliably.
//   2. This script runs ~an hour later as the SWEEPER: it ingests the inbox file
//      deterministically. Only if the inbox is missing/invalid does it call a LOCAL fallback
//      model itself - and every fallback is recorded in alerts.log with the reason, and
//      optionally pushed to you via config.notifyCommand.
//
// Modes:
//   node tagger.mjs nightly [date] [--write]   sweep recent days (default: a bounded look-back window); dry-run unless --write
//   node tagger.mjs test <date> [date...]      re-tag days with the local model, compare vs stored

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function loadConfig() {
  for (const dir of [process.cwd(), SCRIPT_DIR]) {
    const p = join(dir, 'tastebud.config.json');
    if (existsSync(p)) return { ...JSON.parse(readFileSync(p, 'utf8')), _configDir: dir };
  }
  throw new Error('tastebud.config.json not found');
}
const config = loadConfig();
const DATA = resolve(config._configDir, config.dataDir ?? './examples');
const LOG_DIRS = (config.logDirs ?? []).map(d => resolve(config._configDir, d));
const INBOX = join(DATA, 'inbox');
const LOCAL = config.localModel ?? {};
// Sibling engine, resolved next to this script (not the cwd), so the auto-file and
// report-regeneration hooks work regardless of where the sweep is launched from.
const ENGINE = join(SCRIPT_DIR, 'tastebud.mjs');

// Look-back window: when no explicit date is given, a late-written log can still
// be picked up on a later sweep within this window. Bounded - never an unbounded loop.
const LOOKBACK_DAYS = Math.max(1, Number(process.env.TASTEBUD_LOOKBACK_DAYS) || 10);
// A missing log is only worth a (soft) notify once it is genuinely old; younger
// missing days are just "not written yet" and stay silent (console only, no notify).
const STALE_DAYS = Math.max(1, Number(process.env.TASTEBUD_STALE_DAYS) || 2);

// Run-scoped collector for stale-missing-log days. These are NO LONGER a separate notify
// (folded into the nightly digest as a single trailing note instead). Console-only here.
const nologDays = [];

function notify(text) {
  // Optional push to any chat/alert service: set config.notifyCommand to a shell command
  // containing {message}, e.g. "ntfy publish my-topic \"{message}\"". Failures never break tagging.
  if (!config.notifyCommand) return;
  try {
    const cmd = config.notifyCommand.replace('{message}', text.replace(/["`$]/g, "'"));
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) console.log(`(notify failed: ${(r.stderr || r.stdout || '').slice(0, 200)})`);
  } catch (e) { console.log(`(notify failed: ${e.message})`); }
}

function alert(msg) {
  // A genuine FAILURE worth a human's attention: logged to alerts.log AND pushed via notify.
  // Routine, non-failure notices (unknown ingredient seen, auto-filed a slug) must use
  // console.log directly instead, so they never page anyone.
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { appendFileSync(join(DATA, 'alerts.log'), line + '\n'); } catch {}
  console.log('ALERT: ' + msg);
  notify('👅 Tastebud alert: ' + msg);
}

const codebook = JSON.parse(readFileSync(join(DATA, 'codebook.json'), 'utf8'));
const slugLines = Object.entries(codebook.projects)
  .map(([s, p]) => `${s}${p.aliases?.length ? ' (=' + p.aliases.slice(0, 4).join(', ') + ')' : ''}`)
  .join('; ');

const RULES = `You tag an AI agent's daily work log with a weighted project composition.
CANONICAL SLUGS (normalize aliases to these): ${slugLines}
RULES:
1. MAJOR = substantive work (a section or several meaty bullets); MINOR = passing reference or status line.
2. Major weights sum to 1.0, proportional to share of the day's substantive content.
3. Routine status lines (service restarts, health checks) = minor at most - unless they are the day's ONLY content, in which case the routine item is the sole major with w=1.0.
4. If one project's tooling is merely USED in service of another project, the subject project gets the major credit; the tool project is major only if the tool itself was built/changed.
5. If a workstream matches NO slug exactly, invent a new kebab-case slug and list it under "new". NEVER force-fit a similar-sounding slug - inventing is correct, guessing is wrong.
Respond with ONLY this JSON, no markdown fences, no commentary:
{"major":[{"slug":"x","w":0.6}],"minor":["y"],"new":[]}`;

function findLog(date) {
  for (const dir of LOG_DIRS) {
    const p = join(dir, date + '.md');
    if (existsSync(p)) return p;
  }
  return null;
}

function normalize(parsed) {
  if (!Array.isArray(parsed.major)) throw new Error('bad shape: major not an array');
  const total = parsed.major.reduce((s, m) => s + (Number(m.w) || 0), 0) || 1;
  const major = parsed.major.map(m => ({ slug: String(m.slug), w: +((Number(m.w) || 0) / total).toFixed(3) }));
  const arr = x => Array.isArray(x) ? x.map(String) : typeof x === 'string' && x ? [x] : [];
  return { major, minor: arr(parsed.minor), new: arr(parsed.new) };
}

async function localTag(date) {
  if (!LOCAL.url) throw new Error('no localModel configured in tastebud.config.json');
  const path = findLog(date);
  if (!path) throw new Error(`no log file for ${date}`);
  const log = readFileSync(path, 'utf8').slice(0, 24000);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(LOCAL.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(LOCAL.key ? { Authorization: `Bearer ${LOCAL.key}` } : {}) },
        body: JSON.stringify({
          model: LOCAL.model, temperature: 0.1, max_tokens: 600,
          messages: [{ role: 'system', content: RULES },
                     { role: 'user', content: `Daily log for ${date}:\n\n${log}` }],
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      let txt = data.choices[0].message.content.trim();
      txt = txt.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '');
      return normalize(JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)));
    } catch (e) { lastErr = e; }
  }
  throw new Error(`local lane failed after 3 attempts: ${lastErr.message}`);
}

// Process exactly one date: ingest the primary inbox if present/valid, else fall back
// to the LOCAL lane - BUT only when a daily log actually exists to tag. A date with no
// log at all is not a tagging failure and must not trip the hard "ALL lanes failed" alarm.
// Returns true if the day was tagged (and, when write, appended); false if skipped/no-log.
async function processDate(date, { write, comps, compsPath, refDate }) {
  const inboxPath = join(INBOX, date + '.json');

  if (comps.days.some(d => d.date === date)) {
    if (existsSync(inboxPath)) { try { unlinkSync(inboxPath); console.log('cleaned stale inbox file'); } catch {} }
    console.log(`${date} already tagged - nothing to do`);
    return false;
  }

  // No log written for this date yet: NOT a tagging failure. Do not run the fallback
  // and do not emit the "primary produced no tag" alert (which presumes a log to tag).
  if (!findLog(date)) {
    // Age in whole days from this date to the reference (yesterday), midnight-to-midnight
    // so it is independent of the wall-clock time the sweep happens to run at.
    const ageDays = Math.round((Date.parse(refDate + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000);
    if (ageDays >= STALE_DAYS) {
      // Folded: no separate notify. Console-only, and collect for the nightly digest note.
      console.log(`no daily log was ever written for ${date} (now ${ageDays} days old) - nothing to tag, this is not a tagging failure`);
      nologDays.push(date);
    } else {
      console.log(`${date}: no log yet - will retry on a later sweep`);
    }
    return false;
  }

  let g = null, source = null, oneline = '';
  if (existsSync(inboxPath)) {
    try {
      const raw = JSON.parse(readFileSync(inboxPath, 'utf8'));
      g = normalize(raw);
      // oneline rides along in the inbox JSON (see examples/nightly-prompt.md); older files without it get ''.
      if (typeof raw.oneline === 'string') oneline = raw.oneline.trim().slice(0, 100);
      // provenance may be overridden by the inbox writer (e.g. a supervised backfill); default = the primary cron.
      source = (typeof raw.source === 'string' && /^[a-z0-9.-]{1,40}$/.test(raw.source)) ? raw.source : 'primary-cron';
    } catch (e) {
      alert(`inbox file for ${date} exists but is INVALID (${e.message}) - primary tagger output malformed`);
    }
  } else {
    alert(`primary tagger did NOT produce a tag for ${date} (inbox empty) - check your scheduled tagging job`);
  }

  if (!g) {
    try {
      g = await localTag(date);
      source = 'local-fallback';
      alert(`tagged ${date} with LOCAL FALLBACK (${LOCAL.model}) because the primary tagger failed - investigate`);
    } catch (e) {
      alert(`ALL lanes failed for ${date}: ${e.message} - day left untagged, will NOT retry automatically`);
      return false;
    }
  }

  const entry = { date, major: g.major, minor: g.minor, new: g.new, flags: ['nightly', source], oneline };
  console.log(JSON.stringify(entry));
  // Routine notice only: log it to the console, never page anyone via notify.
  const unknown = g.major.filter(m => !codebook.projects[m.slug]).map(m => m.slug);
  if (unknown.length)
    console.log(`unknown ingredient detected on ${date} (${unknown.join(', ')}) - run "node tastebud.mjs tasteslike <slug>" and consider adding it to the codebook.`);
  if (write) {
    try { copyFileSync(compsPath, compsPath + '.bak'); } catch (e) { alert(`could not write compositions.json.bak (${e.message}) - aborting append to protect the data`); process.exit(1); }
    comps.days.push(entry);
    comps.days.sort((x, y) => x.date.localeCompare(y.date));
    writeFileSync(compsPath, JSON.stringify(comps, null, 1));
    if (existsSync(inboxPath)) { try { unlinkSync(inboxPath); } catch {} }
    console.log(`appended ${date} to compositions.json (source: ${source})`);
  } else console.log(`(dry-run - source would be: ${source})`);
  return true;
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'nightly') {
  const write = rest.includes('--write');
  const dateArg = rest.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const compsPath = join(DATA, 'compositions.json');
  const comps = JSON.parse(readFileSync(compsPath, 'utf8'));

  // Same UTC "yesterday" reference the script has always used; the look-back window
  // is computed from this same instant so behavior is fully deterministic per run.
  const ref = Date.now() - 86400000;
  const refDate = new Date(ref).toISOString().slice(0, 10);

  let dates;
  if (dateArg) {
    // Explicit date: process ONLY that one day, no look-back (preserves prior behavior).
    dates = [dateArg];
  } else {
    // Default: backfill (yesterday - LOOKBACK_DAYS + 1) .. yesterday, OLDEST first,
    // so a late-written log gets picked up on a subsequent sweep. Days already in
    // compositions are skipped inside processDate.
    dates = [];
    for (let i = LOOKBACK_DAYS - 1; i >= 0; i--)
      dates.push(new Date(ref - i * 86400000).toISOString().slice(0, 10));
  }

  for (const date of dates)
    await processDate(date, { write, comps, compsPath, refDate });

  // All date processing is complete; tagging will not be touched past this point.
  // Best-effort auto-file: mint open unknowns that ALREADY qualify so the codebook
  // absorbs them before the report below is regenerated. Runs only on a real write run.
  // Any failure (non-zero status, thrown error, or timeout) is logged to the CONSOLE
  // ONLY and must never throw out of here and never change the exit code. The AUTOFILED:
  // contract line is reported to the console only - it never pages anyone via notify.
  if (write) {
    try {
      const r = spawnSync('node', [ENGINE, 'autofile', '--write'], { encoding: 'utf8', timeout: 60000 });
      if (r.error) console.log(`(autofile failed: ${r.error.message})`);
      else if (r.status !== 0) console.log(`(autofile failed: exit ${r.status} ${(r.stderr || r.stdout || '').slice(0, 200)})`);
      else {
        const out = String(r.stdout || '');
        let filed = null;
        for (const m of out.matchAll(/^AUTOFILED:\s*(.+?)\s*$/gm)) filed = m[1].trim();
        if (filed && filed !== 'none') {
          const slugs = filed.split(/\s+/).filter(Boolean);
          if (slugs.length)
            console.log(`auto-filed ${slugs.length} project(s) to the codebook: ${slugs.join(' ')} - undo any with: node tastebud.mjs mint <slug> --undo`);
        }
        console.log(`autofile complete (${filed && filed !== 'none' ? filed : 'none'})`);
      }
    } catch (e) { console.log(`(autofile failed: ${e.message})`); }
  }

  // All date processing is complete; tagging will not be touched past this point.
  // Best-effort: regenerate the unknown-ingredient report via the sibling engine.
  // Only on a real write run, so dry-runs stay side-effect-free. Any failure
  // (non-zero status, thrown error, or timeout) is logged to the CONSOLE ONLY and must
  // never throw out of here, never change the exit code, and never affect tagging.
  if (write) {
    try {
      const r = spawnSync('node', [ENGINE, 'unknowns', '--write'], { encoding: 'utf8', timeout: 60000 });
      if (r.error) console.log(`(unknowns report regen failed: ${r.error.message})`);
      else if (r.status !== 0) console.log(`(unknowns report regen failed: exit ${r.status} ${(r.stderr || r.stdout || '').slice(0, 200)})`);
      else console.log('regenerated unknowns-report.md');
    } catch (e) { console.log(`(unknowns report regen failed: ${e.message})`); }
  }

  // Nightly digest: compose via the engine's `digest` command and push through the SAME generic
  // notify mechanism the alerts use (config.notifyCommand {message} hook). Fires once per nightly
  // run, whether or not new days were tagged. Best-effort and fully try/caught: this can NEVER
  // throw, change the exit code, or affect tagging (which is already complete and untouched above).
  // Any stale-missing-log days collected this run are folded in as a single trailing note.
  // TASTEBUD_NO_DIGEST=1 suppresses the send (for manual/backfill runs, so a batch of
  // historical dates does not push a digest per invocation).
  if (write && !process.env.TASTEBUD_NO_DIGEST) {
    try {
      const r = spawnSync('node', [ENGINE, 'digest'], { encoding: 'utf8', timeout: 60000 });
      if (r.error) console.log(`(digest send failed: ${r.error.message})`);
      else if (r.status !== 0) console.log(`(digest send failed: exit ${r.status} ${(r.stderr || r.stdout || '').slice(0, 200)})`);
      else {
        let text = String(r.stdout || '').trim();
        if (text) {
          if (nologDays.length) text += `\n(no log: ${nologDays.join(', ')})`;
          notify(text);
          console.log('sent nightly digest');
        } else console.log('(digest send skipped: empty digest output)');
      }
    } catch (e) { console.log(`(digest send failed: ${e.message})`); }
  }
}

else if (mode === 'test') {
  const comps = JSON.parse(readFileSync(join(DATA, 'compositions.json'), 'utf8'));
  const stored = Object.fromEntries(comps.days.map(d => [d.date, d]));
  let sumJ = 0, n = 0;
  for (const date of rest) {
    const s = stored[date];
    if (!s) { console.log(`${date}: not in compositions, skipped`); continue; }
    let g;
    try { g = await localTag(date); } catch (e) { console.log(`${date}: ${e.message}`); continue; }
    const a = new Set(s.major.map(m => m.slug)), b = new Set(g.major.map(m => m.slug));
    const j = [...a].filter(x => b.has(x)).length / (new Set([...a, ...b]).size || 1);
    sumJ += j; n++;
    console.log(`${date}: jaccard=${j.toFixed(2)}  stored={${[...a].join(',')}}  got={${[...b].join(',')}}`);
  }
  if (n) console.log(`agreement: avg major-set jaccard ${(sumJ / n).toFixed(2)} over ${n} day(s) - bar from our methodology: >=0.80`);
}

else { console.log('modes: nightly [date] [--write] | test <dates...>'); mkdirSync(INBOX, { recursive: true }); }
