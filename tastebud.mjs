#!/usr/bin/env node
// Tastebud - compositional project fingerprints for agent memory.
// Give every project a deterministic high-dimensional identity vector; every day's work is a
// weighted blend of those vectors. One "taste" (a dot product) decomposes any day back into its
// ingredients - including detecting ingredients nobody has named yet.
//
// Usage: node tastebud.mjs <command> [args]
//   check                          validate data integrity
//   decode <date>                  rebuild a day's composition from its hypervector alone
//   where <slug>                   all days containing a project (major w / minor)
//   first <slug>                   first/last appearance, day count
//   cooccur <a> <b>                days where both projects are major
//   window <from> <to>             aggregate composition over a date range
//   diff <a1> <a2> <b1> <b2>       compare two windows: gone / new / shifted
//   gaps                           workstreams seen in logs but never given a project file
//   backtest <slug> [thr]          simulate a project being unknown; when would it be flagged?
//   drift <slug> [halflife]        EMA identity vector + entanglement with other projects
//   similar <date>                 nearest days by fingerprint cosine
//   tasteslike <slug>              nearest known relatives of an (unknown) ingredient
//   unknowns [--write]             open unknown ingredients for triage (writes a report with --write)
//   mint <slug> [opts]             safe codebook write (--class --parent --alias --undo --no-report)
//   alias <name> <target>          resolve an unknown by aliasing it onto an existing codebook slug
//   dismiss <slug> [note]          dismiss an unknown as a one-off (revives if seen meaningfully more)
//   watch <slug> [note]            park an unknown on the watchlist (decision ledger)
//   decisions                      print the persistent decision ledger grouped by status
//   autofile [--write]             auto-file the safe class of unknowns (has project file + seen as major)
//   color <date|slug>              hex color garnish (the metaphor this project started with)
//   digest                         plain-text status digest to stdout (Decide queue + pulse)
//
// Config: tastebud.config.json in the current directory or next to this script.
// Optional config keys used here: projectsDir (dir of <slug>.md project files) for autofile/has_file.

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, appendFileSync,
  lstatSync, realpathSync, readdirSync, unlinkSync, symlinkSync,
  openSync, fsyncSync, closeSync, mkdtempSync, mkdirSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { loadConfig, validateConfig, loadData, validateCandidateDirs, resolveLogDirs, resolveLog, companionMax } from './validate.mjs';
import { withLock, writeAtomic, writeFully } from './lock.mjs';

// Runtime floor: this engine uses ESM + global fetch (Node 18+). Fail fast with one line
// rather than a confusing "fetch is not defined" deeper in.
const NODE_MAJOR = parseInt(process.versions.node, 10);
if (NODE_MAJOR < 18) {
  console.error(`tastebud requires Node 18+ (uses ESM and global fetch); you have ${process.versions.node}.`);
  process.exit(1);
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const config = loadConfig(SCRIPT_DIR);
validateConfig(config, config._configDir);
const DATA = resolve(config._configDir, config.dataDir ?? './examples');
const D = config.dimensions ?? 4096;

// ---------- deterministic ±1 hypervectors ----------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vecCache = new Map();
function vec(slug) {
  if (vecCache.has(slug)) return vecCache.get(slug);
  const rng = mulberry32(fnv1a(slug));
  const v = new Int8Array(D);
  for (let i = 0; i < D; i++) v[i] = rng() < 0.5 ? -1 : 1;
  vecCache.set(slug, v);
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };
const norm = a => Math.sqrt(dot(a, a));

// ---------- data ----------
// Normalize a raw compositions object into sorted, weight-normalized day rows. Pure so it serves
// both module load (READ commands) and fresh in-lock reads (candidate gates) from one definition.
function normalizeDays(comps) {
  return comps.days.map(d => {
    const majSlugs = new Set(d.major.map(m => m.slug));
    const minor = [...new Set((d.minor ?? []).filter(s => !majSlugs.has(s)))];
    const total = d.major.reduce((s, m) => s + m.w, 0);
    const major = total > 0 ? d.major.map(m => ({ slug: m.slug, w: m.w / total })) : [];
    return { ...d, major, minor };
  }).sort((a, b) => a.date.localeCompare(b.date));
}
// Codebook membership from a codebook object: canonical keys (KNOWN) and every alias (ALIASED).
// Both count as "known" for the unnamed-ingredient detector; aliasing resolves without touching KNOWN.
function buildKnownAliased(cb) {
  const KNOWN = new Set(Object.keys(cb.projects));
  const ALIASED = new Set();
  for (const p of Object.values(cb.projects)) for (const a of (p.aliases || [])) ALIASED.add(a);
  return { KNOWN, ALIASED };
}

const { codebook, comps } = loadData(DATA);
const days = normalizeDays(comps);
const { KNOWN, ALIASED } = buildKnownAliased(codebook);

function bundle(day, excluded = new Set()) {
  const b = new Float64Array(D);
  for (const { slug, w } of day.major) {
    if (excluded.has(slug)) continue;
    const v = vec(slug);
    for (let i = 0; i < D; i++) b[i] += w * v[i];
  }
  return b;
}
const estW = (b, slug) => dot(b, vec(slug)) / D;

function decodeBundle(b, candidates, minW = 0.04) {
  return candidates
    .map(slug => ({ slug, est: estW(b, slug) }))
    .filter(r => r.est >= minW)
    .sort((x, y) => y.est - x.est);
}
const allSlugsEver = [...new Set([...KNOWN, ...days.flatMap(d => d.major.map(m => m.slug))])];

const fmt = n => n.toFixed(3);
const byDate = Object.fromEntries(days.map(d => [d.date, d]));

// provenance marker for a day's tag: surface the writer trust tier so a reader can tell a
// supervised tag from an unattended cron or a degraded local-model fallback. Source lives
// in the compositions `flags` array (written by tagger.mjs).
function provTag(d) {
  const f = Array.isArray(d.flags) ? d.flags : [];
  if (!f.length) return '';
  const src = f.find(x => x !== 'nightly') || f.join(',');
  const mark = /oauth|cron/.test(src) ? '~cron'
             : /local|fallback/.test(src) ? '!local'
             : '*supervised';
  return `  [${mark}: ${src}]`;
}

// ---------- taste-profile (shared by tasteslike + unknowns + candidate gate g6) ----------
// A slug's flavor comes from CONTEXT: the company it keeps (co-occurring major work, weighted
// by both shares and rarity). Rarity weighting (inverse day-frequency) down-weights ubiquitous
// companions (e.g. a daily monitor or ops chore) that say little about identity.
// Factory over a `days` array so the SAME math runs on module-load days (reads) and on fresh
// in-lock days (gates), from one definition. companion_share(n) = companions.get(n) / activity.
function makeTaste(days) {
  const df = new Map();
  for (const d of days) for (const m of d.major) df.set(m.slug, (df.get(m.slug) ?? 0) + 1);
  const activeDays = days.filter(d => d.major.length).length;
  const idf = s => Math.log(1 + activeDays / (df.get(s) ?? 1));
  function tasteProfile(slug) {
    const companions = new Map();
    let activity = 0;
    for (const d of days) {
      const m = d.major.find(x => x.slug === slug);
      if (!m) continue;
      activity += m.w;
      for (const o of d.major) if (o.slug !== slug)
        companions.set(o.slug, (companions.get(o.slug) ?? 0) + m.w * o.w * idf(o.slug));
    }
    const p = new Float64Array(D);
    for (const [cs, cw] of companions) { const v = vec(cs); for (let i = 0; i < D; i++) p[i] += cw * v[i]; }
    return { p, activity, companions };
  }
  return { tasteProfile, idf, activeDays };
}
const { tasteProfile } = makeTaste(days);

// ---------- decision ledger (persistent triage memory; round-trips, snapshots before write) ----------
const LEDGER_PATH = join(DATA, 'unknowns-ledger.json');
const today = () => new Date().toISOString().slice(0, 10);  // UTC YYYY-MM-DD
function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, entries: {} };
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
}
const serializeLedger = led => JSON.stringify(led, null, 2);
// Atomic ledger write (temp + fsync + rename). Mutating commands call this INSIDE the lock.
const saveLedgerAtomic = led => writeAtomic(LEDGER_PATH, serializeLedger(led));

// Immutable instrumentation carried across EVERY status change, plus the per-status field
// whitelist. Built FRESH (never a spread-merge of the old entry) so a stale field can never ride
// along. The via:promote transition guard lives here: a minted entry promoted from a candidate may
// only move through the undo path, so dismiss/watch/alias throw rather than erase its recovery sha.
const LEDGER_STATUSES = ['open', 'minted', 'dismissed', 'watching', 'aliased', 'undone'];
function buildLedgerEntry(prev, status, fields = {}) {
  if (!LEDGER_STATUSES.includes(status)) throw new Error(`internal: unknown ledger status "${status}"`);
  if (prev && prev.status === 'minted' && prev.via === 'promote' && status !== 'minted' && status !== 'undone')
    throw new Error(`refusing to overwrite promotion provenance: a candidate-promoted mint can only be reversed with "mint <slug> --undo", not "${status}"`);
  const e = { status };
  switch (status) {
    case 'open':
      break;
    case 'minted':
      e.decided_on = fields.decided_on;
      if (fields.via != null) e.via = fields.via;
      if (fields.via === 'promote') {
        if (!fields.promote_sha) throw new Error('internal: via:promote minted entry requires promote_sha');
        e.promote_sha = fields.promote_sha;
      }
      break;
    case 'dismissed':
      e.decided_on = fields.decided_on;
      e.baseline_days = fields.baseline_days ?? 0;
      if (fields.note) e.note = fields.note;
      break;
    case 'watching':
      e.decided_on = fields.decided_on;
      if (fields.note) e.note = fields.note;
      break;
    case 'aliased':
      e.decided_on = fields.decided_on;
      e.alias_target = fields.alias_target;
      break;
    case 'undone':
      e.decided_on = fields.decided_on;
      break;
  }
  // Instrumentation last, carried from prev unless the caller supplies a value (mark-sent/promote).
  const ripe = fields.first_ripe_on ?? prev?.first_ripe_on;
  const sent = fields.first_sent_on ?? prev?.first_sent_on;
  if (ripe != null) e.first_ripe_on = ripe;
  if (sent != null) e.first_sent_on = sent;
  return e;
}
// decided_on for a ledger slug (for report annotations); '?' if absent.
function led_decided_on(slug, led = loadLedger()) {
  const e = led.entries[slug];
  return e?.decided_on ?? '?';
}

// optional project-file lookup: only meaningful when config.projectsDir is set; otherwise no
// project files exist (so autofile files nothing and gaps-by-file is inert).
const projectFileExists = slug =>
  config.projectsDir ? existsSync(join(resolve(config._configDir, config.projectsDir), slug + '.md')) : false;

// ---------- open-unknown rows (shared by `unknowns`, report writer, `autofile`) ----------
// open unknown = slug seen anywhere (major / minor / new) that is NOT a codebook key AND NOT an alias.
function unknownRows({ codebook, ledger, days }) {
  const { KNOWN, ALIASED } = buildKnownAliased(codebook);
  const { tasteProfile } = makeTaste(days);
  const AGE = parseInt(process.env.TASTEBUD_UNKNOWN_AGE_DAYS ?? '14', 10);        // ESCALATE_AGE_DAYS
  const MIN = parseInt(process.env.TASTEBUD_UNKNOWN_MIN_DAYS ?? '3', 10);         // ESCALATE_MIN_DAYS
  const ALIAS_HINT = parseFloat(process.env.TASTEBUD_UNKNOWN_ALIAS_HINT ?? '0.40');
  const ALIAS_MIN_DAYS = parseInt(process.env.TASTEBUD_UNKNOWN_ALIAS_MIN_DAYS ?? '2', 10);
  // maturity gate: an unknown is "ripe" (worth asking about) only once it has been seen enough,
  // carried enough major mass, or aged enough. Until then it ripens silently (Maturing, FYI only).
  const RIPE_DAYS = parseInt(process.env.TASTEBUD_RIPE_DAYS ?? '2', 10);
  const RIPE_MASS = parseFloat(process.env.TASTEBUD_RIPE_MASS ?? '0.5');
  const RIPE_AGE = parseInt(process.env.TASTEBUD_RIPE_AGE_DAYS ?? '7', 10);
  const OVERDUE_AGE = parseInt(process.env.TASTEBUD_OVERDUE_AGE_DAYS ?? '14', 10);
  const REVIVE_DELTA = parseInt(process.env.TASTEBUD_REVIVE_DELTA_DAYS ?? '1', 10);
  const now = new Date();
  const todayUTC = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const ageDays = from => Math.round((todayUTC - Date.parse(from + 'T00:00:00Z')) / 86400000);
  const led = ledger;

  // gather every slug mention across major / minor / new, with its date and major weight
  const seen = new Map(); // slug -> { dates:Set, firstSeen, lastSeen, majorMass }
  const note = (slug, date, w) => {
    let e = seen.get(slug);
    if (!e) { e = { dates: new Set(), firstSeen: date, lastSeen: date, majorMass: 0 }; seen.set(slug, e); }
    e.dates.add(date);
    if (date < e.firstSeen) e.firstSeen = date;
    if (date > e.lastSeen) e.lastSeen = date;
    e.majorMass += w;
  };
  for (const d of days) {
    for (const m of d.major) note(m.slug, d.date, m.w);
    for (const s of d.minor) note(s, d.date, 0);
    for (const s of (d.new || [])) note(s, d.date, 0);
  }

  return [...seen.entries()]
    // resolved = a codebook key OR an alias of one; both drop off the unknown list.
    .filter(([slug]) => !KNOWN.has(slug) && !ALIASED.has(slug))
    .map(([slug, e]) => {
      const days_seen = e.dates.size;
      const age = ageDays(e.firstSeen);
      const escalated = age >= AGE && days_seen >= MIN;
      // maturity: ripens silently until it has been seen / massed / aged enough to be worth asking.
      const maturing = days_seen < RIPE_DAYS && e.majorMass < RIPE_MASS && age < RIPE_AGE;
      const ripe = !maturing;
      const overdue = ripe && age >= OVERDUE_AGE;
      // neighbors: top-3 rarity-weighted co-occurrence companions (reuse tasteslike logic)
      const { activity, companions } = tasteProfile(slug);
      const neighbors = [...companions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, w]) => ({ slug: s, score: activity > 0 ? w / activity : 0 }));
      const top = neighbors[0];
      // ledger-backed decision state and "back from the dead" revival.
      const entry = led.entries[slug];
      const status = entry?.status ?? 'open';
      const revived = status === 'dismissed' && days_seen >= ((entry?.baseline_days ?? 0) + REVIVE_DELTA);
      // recommendation: confident alias if a strong, settled neighbor exists; else mint once ripe; else dismiss.
      let recommend, recommendTarget = null, reason;
      if (top && top.score >= ALIAS_HINT && days_seen >= ALIAS_MIN_DAYS) {
        recommend = 'alias'; recommendTarget = top.slug;
        reason = `keeps company almost entirely with ${top.slug} (${fmt(top.score)}); reads as the same work`;
      } else if (days_seen >= 2 && (days_seen >= RIPE_DAYS || e.majorMass >= RIPE_MASS)) {
        recommend = 'mint';
        reason = top
          ? `recurring with real mass; closest neighbor ${top.slug} (${fmt(top.score)}) is not close enough to alias`
          : 'recurring with real mass and no co-occurring companions; looks like its own workstream';
      } else if (days_seen === 1 && e.majorMass >= RIPE_MASS) {
        // One heavy day is not enough evidence for a permanent slug: a sole-major single day
        // is often a routine spike. Never recommend MINT off one day regardless of mass.
        recommend = 'watch';
        reason = `sole evidence is one heavy day (mass ${fmt(e.majorMass)}); could be a routine spike, watch for recurrence before minting`;
      } else {
        recommend = 'dismiss';
        reason = top
          ? `thin so far (${days_seen} day(s), mass ${fmt(e.majorMass)}); closest is ${top.slug} (${fmt(top.score)}) but too early to commit`
          : `thin so far (${days_seen} day(s), mass ${fmt(e.majorMass)}) and no companions; likely a one-off`;
      }
      if (revived && recommend === 'dismiss') {
        recommend = 'watch';
        reason = `active again after you dismissed it on ${entry.decided_on}; still thin (${days_seen} day(s), mass ${fmt(e.majorMass)}) but worth keeping an eye on`;
      }
      const suggestion = recommend === 'alias' ? `likely alias of ${recommendTarget}`
        : recommend === 'mint' ? 'looks mintable' : 'thin; dismiss or wait';
      return { slug, firstSeen: e.firstSeen, lastSeen: e.lastSeen, age, days_seen,
               major_mass: e.majorMass, escalated, neighbors, suggestion,
               status, maturing, ripe, overdue, revived, recommend, recommendTarget, reason };
    })
    .sort((a, b) =>
      (b.escalated - a.escalated) ||
      (b.major_mass - a.major_mass) ||
      (b.days_seen - a.days_seen) ||
      a.slug.localeCompare(b.slug));
}
// READ-command wrapper over module state (fresh ledger each call; codebook/days are load-time).
const computeUnknownRows = () => unknownRows({ codebook, ledger: loadLedger(), days });

// triage-ready markdown report (regenerated by `unknowns --write`, decision commands, `autofile`).
// Mature-before-asking: only ripe (and revived) rows reach Decide; the rest ripen quietly.
function writeUnknownsReport(rows = computeUnknownRows(), led = loadLedger()) {
  const ymd = today();
  const nb = r => r.neighbors.length
    ? r.neighbors.map(n => `${n.slug} (${fmt(n.score)})`).join(', ')
    : '(none)';
  const verdict = r => r.recommend === 'mint' ? 'MINT'
    : r.recommend === 'alias' ? `ALIAS onto ${r.recommendTarget}`
    : r.recommend === 'watch' ? 'WATCH'
    : 'DISMISS';

  const decide = rows
    .filter(r => (r.status === 'open' && r.ripe) || r.revived)
    .sort((a, b) => (b.overdue - a.overdue) || (b.major_mass - a.major_mass) || a.slug.localeCompare(b.slug));
  const watching = rows.filter(r => r.status === 'watching');
  const maturing = rows.filter(r => r.status === 'open' && r.maturing);
  const dismissed = rows.filter(r => r.status === 'dismissed' && !r.revived).length;

  const out = [];
  out.push(`# Tastebud unknown-ingredient report (generated ${ymd})`);
  out.push('');
  out.push(`decide: ${decide.length} / watching: ${watching.length} / maturing: ${maturing.length} / dismissed: ${dismissed}`);
  out.push('');

  out.push('## Decide');
  out.push('');
  if (!decide.length) { out.push('(nothing ripe to decide right now.)'); out.push(''); }
  for (const r of decide) {
    out.push(`### ${r.slug}  [${r.overdue ? 'OVERDUE ' : ''}open ${r.age}d, ${r.days_seen} day(s), mass ${fmt(r.major_mass)}]`);
    out.push(`- keeps company with: ${nb(r)}`);
    out.push(`- recommend: **${verdict(r)}**: ${r.reason}`);
    if (r.revived) out.push(`- NOTE: you dismissed this on ${led_decided_on(r.slug, led)}, but it is active again`);
    out.push('');
  }

  if (watching.length) {
    out.push('## Watching');
    out.push('');
    for (const r of watching) out.push(`- ${r.slug} (watching since ${led_decided_on(r.slug, led)}): now ${r.days_seen} day(s), mass ${fmt(r.major_mass)}`);
    out.push('');
  }

  if (maturing.length) {
    out.push('## Maturing');
    out.push('');
    for (const r of maturing) out.push(`- ${r.slug} (${r.days_seen}d, mass ${fmt(r.major_mass)}, first seen ${r.firstSeen})`);
    out.push('');
  }

  const path = join(DATA, 'unknowns-report.md');
  writeFileSync(path, out.join('\n'), 'utf8');
  return path;
}

// ---------- codebook serializer (preserve one-entry-per-line scannable style; round-trips) ----------
// One project per line, column-aligned keys, with the existing in-entry spacing ({ "k": v, ... }).
// Valid JSON that round-trips; whitespace mirrors the hand-authored original for a minimal diff.
// Built structurally (each value JSON.stringify'd independently) so string contents never leak
// into the formatting: no regex-on-JSON that could misfire on a quote/comma inside an alias.
function jval(v) {
  // JSON value with a ", " separator between array elements (still valid JSON).
  return Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v);
}
function spaced(entry) {
  const inner = Object.keys(entry)
    .map(k => `${JSON.stringify(k)}: ${jval(entry[k])}`)
    .join(', ');
  return inner ? `{ ${inner} }` : '{}';
}
function serializeCodebook(cb) {
  const keys = Object.keys(cb.projects);
  const labelLen = keys.reduce((m, k) => Math.max(m, JSON.stringify(k).length + 1), 0); // "key":
  const lines = ['{'];
  for (const k of Object.keys(cb)) {
    if (k === 'projects') continue;
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(cb[k])},`);
  }
  lines.push('  "projects": {');
  keys.forEach((k, i) => {
    const label = (JSON.stringify(k) + ':').padEnd(labelLen);
    lines.push(`    ${label} ${spaced(cb.projects[k])}${i < keys.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}

// ---------- mint core (pure helpers over an explicit codebook; callers hold the lock) ----------
const MINT_CLASSES = ['product', 'business', 'ops', 'research', 'content', 'personal', 'meta'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODEBOOK_PATH = join(DATA, 'codebook.json');
const saveCodebookAtomic = cb => writeAtomic(CODEBOOK_PATH, serializeCodebook(cb));
// Refusal string (writes nothing) or null if the add is legal against codebook membership K.
function mintCheck(K, { slug, parent, klass }) {
  if (!SLUG_RE.test(slug)) return `bad slug "${slug}": must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)`;
  if (K.has(slug)) return `"${slug}" already exists in the codebook (renames are never done; add an alias instead)`;
  if (parent != null && !K.has(parent)) return `bad parent "${parent}": not an existing codebook key`;
  if (!MINT_CLASSES.includes(klass)) return `bad class "${klass}": one of ${MINT_CLASSES.join('|')}`;
  return null;
}
// Add the entry to cb.projects (mutates cb). has_file is set EXPLICITLY by the caller.
function mintApply(cb, { slug, parent = null, aliases = [], klass, has_file }) {
  const entry = {};
  if (parent != null) entry.parent = parent;
  entry.aliases = aliases;
  entry.class = klass;
  entry.has_file = has_file;
  cb.projects[slug] = entry;
  return entry;
}

// ---------- candidate engine: grammar, nine gates, promote transaction ----------
const EVENTS_PATH = join(DATA, 'candidate-events.jsonl');
const AUTOPROMOTE_PATH = join(DATA, 'autopromote.json');
const AUTOFILE_SAFE_CLASSES = ['product'];            // unattended autopromote is product-only, no parent
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// Fresh, consistent snapshot of the three mutable stores, read INSIDE the lock so the gates and the
// transaction see the same bytes. Compositions are read fresh too (the tagger may have appended).
function loadFresh() {
  const cb = JSON.parse(readFileSync(CODEBOOK_PATH, 'utf8'));
  const ledger = loadLedger();
  const freshDays = normalizeDays(JSON.parse(readFileSync(join(DATA, 'compositions.json'), 'utf8')));
  return { codebook: cb, ledger, days: freshDays };
}

// Kill-point hook (selftest only): hard-terminate right after a named commit sub-step to manufacture
// the exact crash `check` reconciliation must detect. Inert unless TASTEBUD_KILL_AFTER is set.
const KILL_AFTER = process.env.TASTEBUD_KILL_AFTER || '';
function killpoint(tag) { if (KILL_AFTER === tag) process.exit(137); }
// Fault-injection hook (selftest only): THROW after a named sub-step so the caught rollback path is
// exercised (distinct from killpoint, which hard-exits). Inert unless TASTEBUD_FAIL_AFTER is set.
const FAIL_AFTER = process.env.TASTEBUD_FAIL_AFTER || '';
function failpoint(tag) { if (FAIL_AFTER === tag) throw new Error(`injected failure after ${tag}`); }
// Corruption hook (selftest only): tamper the just-written file at a named sub-step so the sha
// verification that guards the commit is exercised. Inert unless TASTEBUD_CORRUPT_AFTER is set.
const CORRUPT_AFTER = process.env.TASTEBUD_CORRUPT_AFTER || '';
function corruptpoint(tag, path) { if (CORRUPT_AFTER === tag) appendFileSync(path, 'X'); }

// ---- candidate-events.jsonl (advisory, sanitized, dedup on the payload minus ts) ----
function appendEvent(ev) {
  try {
    const payload = { slug: ev.slug, event: ev.event };
    if (ev.candidateSha) payload.candidateSha = ev.candidateSha;
    if (ev.gates) payload.gates = ev.gates;
    if (ev.detail) payload.detail = ev.detail;
    const key = JSON.stringify(payload);
    if (existsSync(EVENTS_PATH)) {
      for (const line of readFileSync(EVENTS_PATH, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }   // tolerate a truncated final line
        const { ts, ...rest } = rec;
        if (JSON.stringify(rest) === key) return;                      // dedup on normalized payload
      }
    }
    appendFileSync(EVENTS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n');
  } catch (e) { console.error(`(candidate event append failed: ${e.message})`); }
}

// ---- closed, anchored candidate frontmatter grammar (NOT YAML; no type coercion) ----
const CANDIDATE_KEYS = new Set(['slug', 'class', 'parent', 'status', 'drafted_by', 'drafted_on']);
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function parseCandidate(raw) {
  let text = raw;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);            // strip leading BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');           // normalize CRLF -> LF first
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  if (end === -1) return null;
  const fm = lines.slice(1, end);
  const data = Object.create(null);
  const seen = new Set();
  let i = 0;
  for (; i < fm.length; i++) {
    if (fm[i] === 'evidence:') break;
    const m = /^([a-z_]+): (.*)$/.exec(fm[i]);
    if (!m) return null;                                              // any other indentation / shape
    const key = m[1], val = m[2];
    if (PROTO_KEYS.has(key) || !CANDIDATE_KEYS.has(key) || seen.has(key)) return null;
    if (/^[\[\{&*|>]/.test(val)) return null;                         // no flow arrays / anchors / block scalars
    seen.add(key);
    data[key] = val;
  }
  if (fm[i] !== 'evidence:') return null;                             // evidence block is required
  i++;
  const evidence = [];
  for (; i < fm.length; i += 2) {
    const dm = /^  - date: (\d{4}-\d{2}-\d{2})$/.exec(fm[i]);
    if (!dm) return null;
    const qm = fm[i + 1] != null ? /^    quote: "(.*)"$/.exec(fm[i + 1]) : null;
    if (!qm) return null;                                             // unbalanced / trailing text fails the anchor
    evidence.push({ date: dm[1], quote: qm[1] });                     // quote = text between first and last "
  }
  if (evidence.length < 2) return null;
  for (const k of ['slug', 'class', 'status', 'drafted_by', 'drafted_on']) if (!(k in data)) return null;
  return {
    slug: data.slug, class: data.class, parent: ('parent' in data ? data.parent : null),
    status: data.status, drafted_by: data.drafted_by, drafted_on: data.drafted_on, evidence,
  };
}

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);   // m[0] is the full match; groups are m[1..3]
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d; // component round-trip
}
const normLine = s => s.replace(/\s+/g, ' ').trim().normalize('NFC');

// validateCandidate: the nine gates. g1 first (parse + schema); if it fails, return ONLY g1 because
// the later gates need its parsed meta. Otherwise evaluate g2..g9 and collect every failure.
// Returns { ok, fails:[gateId], meta:{ data, sha, bytes, path, safeForUnattended } }.
function validateCandidate({ slug, candidatesDir, projectsDir, logDirs, codebook, ledger, days, companionMax, bytes }) {
  const fails = [];
  const candPath = join(candidatesDir, slug + '.md');
  let raw = bytes;
  if (raw == null) { try { raw = readFileSync(candPath); } catch { return { ok: false, fails: ['g1'] }; } }
  const sha = sha256(raw);
  const data = parseCandidate(raw.toString('utf8'));
  const g1ok = !!data
    && data.slug === slug && SLUG_RE.test(slug)
    && MINT_CLASSES.includes(data.class)
    && data.status === 'candidate'
    && String(data.drafted_by).trim().length > 0
    && isRealDate(data.drafted_on)
    && data.evidence.length >= 2
    && data.evidence.every(e => isRealDate(e.date) && e.quote.trim().length > 0);
  if (!g1ok) return { ok: false, fails: ['g1'], meta: { sha, bytes: raw, path: candPath } };

  const { KNOWN, ALIASED } = buildKnownAliased(codebook);
  const { tasteProfile } = makeTaste(days);
  // g2 path safety
  try {
    const st = lstatSync(candPath);
    if (!st.isFile() || dirname(realpathSync(candPath)) !== realpathSync(candidatesDir)) fails.push('g2');
  } catch { fails.push('g2'); }
  // g3 not-known
  if (KNOWN.has(slug) || ALIASED.has(slug)) fails.push('g3');
  // g4 ledger-open (absent or 'open' passes)
  const st4 = ledger.entries?.[slug]?.status;
  if (st4 && st4 !== 'open') fails.push('g4');
  // g5 ripe-mint from the pure unknownRows on this fresh state
  const row = unknownRows({ codebook, ledger, days }).find(r => r.slug === slug);
  if (!(row && row.ripe && row.recommend === 'mint')) fails.push('g5');
  // g6 companion guard over the FULL known companion set
  const { activity, companions } = tasteProfile(slug);
  let g6bad = false;
  for (const [o, w] of companions) {
    if (!KNOWN.has(o)) continue;
    if ((activity > 0 ? w / activity : 0) >= companionMax) { g6bad = true; break; }
  }
  if (g6bad) fails.push('g6');
  // g7 evidence: each quote == a normalized FULL LINE of its date's log, >=12 non-space chars, >=2 distinct dates
  {
    let g7ok = true;
    const dates = new Set();
    for (const e of data.evidence) {
      const q = normLine(e.quote);
      if (q.replace(/ /g, '').length < 12) { g7ok = false; break; }
      const r = resolveLog(logDirs, e.date);
      if (!r.ok) { g7ok = false; break; }
      const logLines = readFileSync(r.path, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      if (!logLines.some(l => normLine(l) === q)) { g7ok = false; break; }
      dates.add(e.date);
    }
    if (!g7ok || dates.size < 2) fails.push('g7');
  }
  // g8 destination-absent
  try { lstatSync(join(projectsDir, slug + '.md')); fails.push('g8'); } catch {}
  // g9 class/parent
  if (!MINT_CLASSES.includes(data.class) || (data.parent != null && !KNOWN.has(data.parent))) fails.push('g9');

  const safeForUnattended = AUTOFILE_SAFE_CLASSES.includes(data.class) && data.parent == null;
  return { ok: fails.length === 0, fails, meta: { data, sha, bytes: raw, path: candPath, safeForUnattended } };
}

// Capture raw pre-transaction file state so rollback can restore either bytes OR absence.
function captureFile(p) { return existsSync(p) ? { existed: true, bytes: readFileSync(p) } : { existed: false }; }
function restoreFile(p, cap) {
  if (cap.existed) writeAtomic(p, cap.bytes);
  else if (existsSync(p)) unlinkSync(p);
}

// The definitive promote transaction. Runs UNDER the lock (reentrant, so sweep-candidates can hold
// the outer lock across the whole enumeration). Durable via:promote marker written FIRST; ordered
// rollback that RETAINS the marker on a prerequisite-restore failure so `check` can guide recovery.
function promoteViaCandidate({ slug, candidatesDir, projectsDir, logDirs, unattended }) {
  return withLock(DATA, () => {
    // 0. pre-read path safety BEFORE opening/hashing
    if (!SLUG_RE.test(slug)) return { ok: false, fails: ['g1'] };
    const candPath = join(candidatesDir, slug + '.md');
    try {
      const st = lstatSync(candPath);
      if (!st.isFile() || dirname(realpathSync(candPath)) !== realpathSync(candidatesDir))
        return { ok: false, fails: ['g2'] };
    } catch { return { ok: false, fails: ['g2'] }; }
    // 1. snapshot bytes + sha; run gates on fresh state
    const bytes = readFileSync(candPath);
    const sha = sha256(bytes);
    const { codebook: cb, ledger, days: freshDays } = loadFresh();
    const v = validateCandidate({ slug, candidatesDir, projectsDir, logDirs, codebook: cb, ledger, days: freshDays, companionMax: companionMax(), bytes });
    if (!v.ok) { appendEvent({ slug, event: 'rejected', candidateSha: sha, gates: v.fails }); return { ok: false, fails: v.fails }; }
    if (unattended && !v.meta.safeForUnattended) return { ok: false, fails: ['safe-class'], blockedUnattended: true };
    // 2. capture RAW pre-transaction state (existence + bytes); rollback can restore ABSENCE too
    const cbCap = captureFile(CODEBOOK_PATH);
    const ledCap = captureFile(LEDGER_PATH);
    // 3. re-read candidate; sha drift => TOCTOU abort, no writes
    if (sha256(readFileSync(candPath)) !== sha) {
      appendEvent({ slug, event: 'promote-failed', detail: 'toctou-pre' });
      return { ok: false, fails: ['toctou'] };
    }
    const projPath = join(projectsDir, slug + '.md');
    let destCreated = false, markerWritten = false;
    try {
      // 4a. LEDGER minted via:promote  (durable in-progress marker)
      const prev = ledger.entries[slug];
      const first_ripe_on = prev?.first_ripe_on ?? today();          // g5 proved ripeness
      const entry = buildLedgerEntry(prev, 'minted', { decided_on: today(), via: 'promote', promote_sha: sha, first_ripe_on });
      const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: entry } };
      saveLedgerAtomic(led2); markerWritten = true; killpoint('4a'); failpoint('4a');
      // 4b. CODEBOOK new entry, has_file:true set EXPLICITLY
      mintApply(cb, { slug, parent: v.meta.data.parent, aliases: [], klass: v.meta.data.class, has_file: true });
      saveCodebookAtomic(cb); killpoint('4b'); failpoint('4b');
      // 4c. project file, exclusive no-clobber (cross-volume-safe: fresh write, no rename). Write
      // ALL bytes (writeSync can short-write), fsync, close in finally, then VERIFY the on-disk sha
      // equals promote_sha before we destroy the candidate: a truncated/partial write must never be
      // committed as a valid project file.
      const fd = openSync(projPath, 'wx'); destCreated = true;
      try { writeFully(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      corruptpoint('4c', projPath);
      if (sha256(readFileSync(projPath)) !== sha) throw new Error('project file write verification failed (on-disk sha != promote_sha)');
      killpoint('4c'); failpoint('4c');
      // 4d. COMMIT POINT: candidate path identity + bytes unchanged since the snapshot, then unlink
      const st2 = lstatSync(candPath);
      if (!st2.isFile() || dirname(realpathSync(candPath)) !== realpathSync(candidatesDir) || sha256(readFileSync(candPath)) !== sha)
        throw new Error('candidate changed under us at the commit point');
      unlinkSync(candPath); killpoint('4d');
      // COMMITTED. 4e post-commit best-effort (advisory: warns, never fails the promote).
      try { appendEvent({ slug, event: 'promoted', candidateSha: sha, detail: unattended ? 'unattended' : 'human' }); }
      catch (e) { console.error(`(warn: event append: ${e.message})`); }
      try { writeUnknownsReport(unknownRows({ codebook: cb, ledger: led2, days: freshDays }), led2); }
      catch (e) { console.error(`(warn: report regen: ${e.message})`); }
      return { ok: true, slug, class: v.meta.data.class, parent: v.meta.data.parent, sha };
    } catch (err) {
      // 5. ROLLBACK (ordered). (i) remove tx-owned project file; (ii) restore codebook; (iii) ONLY if
      // both succeeded, restore ledger LAST (clears the marker). If (i)/(ii) fail, keep the marker.
      let iOk = true, iiOk = true;
      if (destCreated) { try { unlinkSync(projPath); } catch { iOk = false; } }
      try { restoreFile(CODEBOOK_PATH, cbCap); } catch { iiOk = false; }
      if (iOk && iiOk) { try { restoreFile(LEDGER_PATH, ledCap); } catch { iiOk = false; } }
      if (markerWritten && (!iOk || !iiOk)) {
        appendEvent({ slug, event: 'promote-failed', detail: 'recovery-required' });
        return { ok: false, fails: ['recovery-required'], recovery: true,
          error: `RECOVERY-REQUIRED: promote of "${slug}" failed and could not fully roll back. The via:promote ledger marker was retained; run "node tastebud.mjs check" for the exact artifact and repair.` };
      }
      appendEvent({ slug, event: 'promote-failed', detail: 'rolled-back' });
      return { ok: false, fails: ['caught'], error: `promote failed and rolled back cleanly: ${err.message}` };
    }
  });
}

// mint --undo for a candidate-promoted (via:promote) slug: an explicit REVERSE transaction mirroring
// promote, retaining the via:promote marker until the LAST step so every crash state is recoverable.
function undoPromotedMint({ slug, candidatesDir, projectsDir }) {
  return withLock(DATA, () => {
    const cb = JSON.parse(readFileSync(CODEBOOK_PATH, 'utf8'));
    const ledger = loadLedger();
    const { KNOWN } = buildKnownAliased(cb);
    if (!KNOWN.has(slug)) return { ok: false, error: `nothing to undo: "${slug}" is not a codebook key` };
    const prev = ledger.entries[slug];
    if (prev?.status !== 'minted')
      return { ok: false, error: `refusing to undo "${slug}": ledger status is "${prev?.status ?? 'none'}", not "minted" (undo only removes tool-minted slugs; founding/hand-added slugs are protected)` };

    if (prev.via === 'promote') {
      const candPath = join(candidatesDir, slug + '.md');
      const projPath = join(projectsDir, slug + '.md');
      if (existsSync(candPath)) return { ok: false, error: `refusing to undo "${slug}": a candidate file already exists at ${basename(candPath)}` };
      if (!existsSync(projPath)) return { ok: false, error: `RECOVERY-REQUIRED: project file for "${slug}" is missing; cannot reconstruct the candidate. Run "node tastebud.mjs check".` };
      const bytes = readFileSync(projPath);
      const projSha = sha256(bytes);
      // The project file IS the promoted candidate bytes; verify against promote_sha BEFORE
      // reconstructing anything, so a corrupted or edited project file never silently round-trips.
      if (prev.promote_sha && projSha !== prev.promote_sha)
        return { ok: false, error: `RECOVERY-REQUIRED: project file for "${slug}" does not match its promote_sha; refusing to reconstruct a candidate from unverified bytes. Run "node tastebud.mjs check".` };
      // (a) reconstruct the candidate: write ALL bytes, fsync, close, then verify the candidate we
      // wrote before we remove the project file (the only remaining copy).
      const fd = openSync(candPath, 'wx');
      try { writeFully(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      if (sha256(readFileSync(candPath)) !== projSha) {
        try { unlinkSync(candPath); } catch {}   // clean abort: nothing else changed yet
        return { ok: false, error: `RECOVERY-REQUIRED: candidate reconstruction for "${slug}" failed verification; no changes made. Run "node tastebud.mjs check".` };
      }
      unlinkSync(projPath);                                                                        // (b)
      delete cb.projects[slug]; saveCodebookAtomic(cb);                                            // (c)
      const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: buildLedgerEntry(prev, 'undone', { decided_on: today() }) } };
      saveLedgerAtomic(led2);                                                                       // (d) clears via:promote LAST
      appendEvent({ slug, event: 'undone', candidateSha: sha256(bytes) });
      return { ok: true, slug, reverse: true };
    }
    // legacy direct mint (no via): remove codebook entry, set ledger undone, no file touched.
    delete cb.projects[slug]; saveCodebookAtomic(cb);
    const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: buildLedgerEntry(prev, 'undone', { decided_on: today() }) } };
    saveLedgerAtomic(led2);
    return { ok: true, slug, reverse: false };
  });
}

// autopromote.json {version:1, enabled}. Missing = disabled; malformed = fail-closed disabled + warn.
function readAutopromote() {
  if (!existsSync(AUTOPROMOTE_PATH)) return { enabled: false };
  try {
    const j = JSON.parse(readFileSync(AUTOPROMOTE_PATH, 'utf8'));
    if (j && typeof j.enabled === 'boolean') return { enabled: j.enabled };
    console.error('(autopromote.json malformed - treating autopromote as DISABLED)');
    return { enabled: false };
  } catch {
    console.error('(autopromote.json unreadable/invalid - treating autopromote as DISABLED)');
    return { enabled: false };
  }
}

// Read-only view of the candidate directory for the digest: every *.md validated against module
// state. No writes, no lock. Empty when the dirs are not configured/present. Sorted by slug.
function currentCandidates() {
  const cDir = resolve(config._configDir, config.candidatesDir ?? join(DATA, 'project-candidates'));
  const pDir = config.projectsDir ? resolve(config._configDir, config.projectsDir) : null;
  if (!existsSync(cDir) || !pDir || !existsSync(pDir)) return [];
  const logDirs = resolveLogDirs(config, config._configDir);
  const led = loadLedger();
  const max = companionMax();
  const out = [];
  for (const name of readdirSync(cDir)) {
    if (!name.endsWith('.md') || !SLUG_RE.test(name.slice(0, -3))) continue;
    const slug = name.slice(0, -3);
    const v = validateCandidate({ slug, candidatesDir: cDir, projectsDir: pDir, logDirs, codebook, ledger: led, days, companionMax: max, bytes: null });
    out.push({ slug, pass: v.ok, gate: v.ok ? null : v.fails[0] });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------- selftest-candidates: child-process fixture suite ----------
// Every fixture builds its own temp dir (config + data + logs + candidates + projects) and drives
// the engine through CHILD PROCESSES (config/data load at module init, so state must be on disk).
// Writes only under a temp root; no network. Prints `SELFTEST PASS N/N`, nonzero on any failure.
async function runSelftestCandidates() {
  const SELF = fileURLToPath(import.meta.url);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tbself-'));
  let pass = 0, total = 0, envN = 0;
  const fails = [], notes = [];
  const t = async (name, fn) => { total++; try { await fn(); pass++; } catch (e) { fails.push(`FAIL [${name}]: ${e.message}`); } };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

  const KNOWN_CB = { version: 1, projects: {
    'known-a': { aliases: [], class: 'ops', has_file: false },
    'known-b': { aliases: [], class: 'product', has_file: false },
  } };
  const logWith = line => `# log\n\n## Section\n${line}\n`;
  function candidateFile({ slug, klass = 'product', status = 'candidate', parent = null, drafted_by = 'tester', drafted_on = '2026-02-01', ev }) {
    const L = ['---', `slug: ${slug}`, `class: ${klass}`];
    if (parent != null) L.push(`parent: ${parent}`);
    L.push(`status: ${status}`, `drafted_by: ${drafted_by}`, `drafted_on: ${drafted_on}`, 'evidence:');
    for (const e of ev) L.push(`  - date: ${e.date}`, `    quote: "${e.quote}"`);
    L.push('---', 'body text', '');
    return L.join('\n');
  }
  function makeEnv({ codebook, days, ledger, candidates = {}, projects = {}, logs = {} }) {
    const base = join(tmpRoot, 'e' + (envN++));
    const data = join(base, 'data'); mkdirSync(data, { recursive: true });
    const cDir = join(base, 'candidates'); mkdirSync(cDir);
    const pDir = join(base, 'projects'); mkdirSync(pDir);
    const lDir = join(base, 'logs'); mkdirSync(lDir);
    writeFileSync(join(data, 'codebook.json'), JSON.stringify(codebook, null, 2));
    writeFileSync(join(data, 'compositions.json'), JSON.stringify({ version: 1, days }, null, 1));
    writeFileSync(join(data, 'unknowns-ledger.json'), JSON.stringify(ledger ?? { version: 1, entries: {} }, null, 2));
    for (const [k, v] of Object.entries(candidates)) writeFileSync(join(cDir, k + '.md'), v);
    for (const [k, v] of Object.entries(projects)) writeFileSync(join(pDir, k + '.md'), v);
    for (const [k, v] of Object.entries(logs)) writeFileSync(join(lDir, k + '.md'), v);
    writeFileSync(join(base, 'tastebud.config.json'), JSON.stringify({
      dataDir: './data', logDirs: ['./logs'], candidatesDir: './candidates', projectsDir: './projects', dimensions: 512,
    }, null, 2));
    return { base, data, cDir, pDir, lDir };
  }
  // A fully passing candidate scenario for `slug`: sole-major on two distinct days (ripe mint, no
  // companions), two matching logs, one candidate citing both dates.
  function baseSpec(slug) {
    const q1 = `- Built the first end to end slice of the ${slug} workstream today.`;
    const q2 = `- Wrote the ${slug} test harness and wired up its configuration file.`;
    return {
      codebook: JSON.parse(JSON.stringify(KNOWN_CB)),
      days: [
        { date: '2026-02-01', major: [{ slug, w: 1 }], minor: [], new: [slug], flags: [], oneline: 'd1' },
        { date: '2026-02-02', major: [{ slug, w: 1 }], minor: [], new: [slug], flags: [], oneline: 'd2' },
      ],
      logs: { '2026-02-01': logWith(q1), '2026-02-02': logWith(q2) },
      candidates: { [slug]: candidateFile({ slug, ev: [{ date: '2026-02-01', quote: q1 }, { date: '2026-02-02', quote: q2 }] }) },
      _q: [q1, q2],
    };
  }
  const promoEnv = slug => makeEnv(baseSpec(slug));
  const run = (env, args, extraEnv = {}) => spawnSync('node', [SELF, ...args], { cwd: env.base, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  const runAsync = (env, args, extraEnv = {}) => new Promise(res => {
    const c = spawn('node', [SELF, ...args], { cwd: env.base, env: { ...process.env, ...extraEnv } });
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('close', code => res({ status: code, stdout: out, stderr: err }));
  });
  const readCb = env => JSON.parse(readFileSync(join(env.data, 'codebook.json'), 'utf8'));
  const readLed = env => JSON.parse(readFileSync(join(env.data, 'unknowns-ledger.json'), 'utf8'));
  function gatesOf(env, slug, extraEnv = {}) {
    const r = run(env, ['sweep-candidates'], extraEnv);
    const m = new RegExp(`^FAIL ${slug}: (.+)$`, 'm').exec(r.stdout);
    return m ? m[1].split(',').map(s => s.trim()) : [];
  }

  // ---- happy path + reversibility ----
  await t('happy-path promote', async () => {
    const env = promoEnv('new-thing');
    const r = run(env, ['promote', 'new-thing']);
    assert(r.status === 0, `promote exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert(readCb(env).projects['new-thing']?.has_file === true, 'codebook missing has_file:true');
    assert(existsSync(join(env.pDir, 'new-thing.md')), 'project file not created');
    assert(!existsSync(join(env.cDir, 'new-thing.md')), 'candidate not removed');
    const led = readLed(env).entries['new-thing'];
    assert(led.status === 'minted' && led.via === 'promote' && !!led.promote_sha, 'ledger not minted via:promote');
    assert(run(env, ['check']).status === 0, 'check not clean after promote');
  });
  await t('undo -> undone blocks re-promote', async () => {
    const env = promoEnv('undothing');
    assert(run(env, ['promote', 'undothing']).status === 0, 'promote failed');
    const u = run(env, ['mint', 'undothing', '--undo']);
    assert(u.status === 0, `undo exit ${u.status}: ${u.stdout}`);
    assert(!readCb(env).projects['undothing'], 'codebook entry not removed by undo');
    assert(existsSync(join(env.cDir, 'undothing.md')), 'candidate not restored by undo');
    assert(!existsSync(join(env.pDir, 'undothing.md')), 'project file not removed by undo');
    assert(readLed(env).entries['undothing'].status === 'undone', 'ledger not undone');
    const rp = run(env, ['promote', 'undothing']);
    assert(rp.status === 1 && /g4/.test(rp.stdout), 're-promote not blocked by g4');
  });

  // ---- each gate individually ----
  await t('g1 bad schema', async () => {
    const s = baseSpec('gone');
    s.candidates.gone = candidateFile({ slug: 'gone', status: 'draft', ev: [{ date: '2026-02-01', quote: s._q[0] }, { date: '2026-02-02', quote: s._q[1] }] });
    assert(gatesOf(makeEnv(s), 'gone').includes('g1'), 'g1 not triggered');
  });
  await t('g2 path escape (symlink)', async () => {
    const env = makeEnv(baseSpec('gtwo'));
    const inside = join(env.cDir, 'gtwo.md');
    const outside = join(env.base, 'outside-gtwo.md');
    writeFileSync(outside, readFileSync(inside)); unlinkSync(inside);
    try { symlinkSync(outside, inside); }
    catch { notes.push('g2: symlink unsupported here, sub-check skipped'); return; }
    assert(gatesOf(env, 'gtwo').includes('g2'), 'g2 not triggered by escaping symlink');
  });
  await t('g3 already known', async () => {
    const s = baseSpec('gthree');
    s.codebook.projects['gthree'] = { aliases: [], class: 'product', has_file: false };
    assert(gatesOf(makeEnv(s), 'gthree').includes('g3'), 'g3 not triggered');
  });
  await t('g4 ledger not open', async () => {
    const s = baseSpec('gfour');
    s.ledger = { version: 1, entries: { gfour: { status: 'watching', decided_on: '2026-02-03' } } };
    assert(gatesOf(makeEnv(s), 'gfour').includes('g4'), 'g4 not triggered');
  });
  await t('g5 not ripe-mint', async () => {
    const s = baseSpec('gfive');
    s.days = [s.days[0]];   // only one day -> recommend watch, not mint
    assert(gatesOf(makeEnv(s), 'gfive').includes('g5'), 'g5 not triggered');
  });
  await t('g6 companion guard', async () => {
    const s = baseSpec('gsix');
    s.days[1].major = [{ slug: 'gsix', w: 0.8 }, { slug: 'known-a', w: 0.2 }];
    const gates = gatesOf(makeEnv(s), 'gsix', { TASTEBUD_CANDIDATE_COMPANION_MAX: '0.05' });
    assert(gates.includes('g6'), `g6 not triggered (gates: ${gates})`);
  });
  await t('g7 evidence mismatch', async () => {
    const s = baseSpec('gseven');
    s.candidates.gseven = candidateFile({ slug: 'gseven', ev: [
      { date: '2026-02-01', quote: 'this exact line does not appear in any daily log file' },
      { date: '2026-02-02', quote: 'neither does this second fabricated evidence quote line' },
    ] });
    assert(gatesOf(makeEnv(s), 'gseven').includes('g7'), 'g7 not triggered');
  });
  await t('g8 destination present', async () => {
    const s = baseSpec('geight');
    s.projects = { geight: '# already here\n' };
    assert(gatesOf(makeEnv(s), 'geight').includes('g8'), 'g8 not triggered');
  });
  await t('g9 bad parent', async () => {
    const s = baseSpec('gnine');
    s.candidates.gnine = candidateFile({ slug: 'gnine', parent: 'no-such-parent', ev: [{ date: '2026-02-01', quote: s._q[0] }, { date: '2026-02-02', quote: s._q[1] }] });
    assert(gatesOf(makeEnv(s), 'gnine').includes('g9'), 'g9 not triggered');
  });

  // ---- rollback ----
  await t('caught write failure -> byte + in-memory rollback', async () => {
    const env = promoEnv('rbk');
    const r = run(env, ['promote', 'rbk'], { TASTEBUD_FAIL_AFTER: '4c' });
    assert(r.status !== 0, 'promote should fail');
    assert(!readCb(env).projects['rbk'], 'codebook not rolled back');
    assert(existsSync(join(env.cDir, 'rbk.md')), 'candidate should remain');
    assert(!existsSync(join(env.pDir, 'rbk.md')), 'project file should be removed by rollback');
    const led = readLed(env).entries['rbk'];
    assert(!led || led.status !== 'minted', 'ledger marker not cleared');
    assert(run(env, ['check']).status === 0, 'check should be clean after rollback');
  });
  await t('project write sha-verify catches corruption -> rollback', async () => {
    const env = promoEnv('corrupt');
    const r = run(env, ['promote', 'corrupt'], { TASTEBUD_CORRUPT_AFTER: '4c' });
    assert(r.status !== 0, 'promote should fail when the written project sha mismatches');
    assert(!readCb(env).projects['corrupt'], 'codebook not rolled back');
    assert(existsSync(join(env.cDir, 'corrupt.md')), 'candidate should remain (never unlinked)');
    assert(!existsSync(join(env.pDir, 'corrupt.md')), 'corrupted project file should be removed by rollback');
    assert(run(env, ['check']).status === 0, 'check should be clean after rollback');
  });
  await t('undo refuses a project file that mismatches promote_sha', async () => {
    const env = promoEnv('undoguard');
    assert(run(env, ['promote', 'undoguard']).status === 0, 'promote failed');
    appendFileSync(join(env.pDir, 'undoguard.md'), 'tampered');   // corrupt the promoted project file
    const u = run(env, ['mint', 'undoguard', '--undo']);
    assert(u.status === 1, 'undo should refuse to reconstruct from a tampered project file');
    assert(!existsSync(join(env.cDir, 'undoguard.md')), 'no candidate should be left behind by the refused undo');
    assert(readCb(env).projects['undoguard'], 'codebook entry should survive a refused undo');
  });

  // ---- shadow vs autopromote ----
  await t('shadow (autopromote off)', async () => {
    const env = promoEnv('shad');
    const r = run(env, ['sweep-candidates', '--write']);
    assert(r.status === 0 && /shadow shad/.test(r.stdout), `not shadowed: ${r.stdout}`);
    assert(existsSync(join(env.cDir, 'shad.md')) && !readCb(env).projects['shad'], 'promoted while autopromote off');
  });
  await t('autopromote on', async () => {
    const env = promoEnv('autop');
    assert(run(env, ['autopromote', 'on']).status === 0, 'autopromote on failed');
    const r = run(env, ['sweep-candidates', '--write']);
    assert(r.status === 0 && readCb(env).projects['autop'], `not autopromoted: ${r.stdout}`);
    assert(!existsSync(join(env.cDir, 'autop.md')), 'candidate not consumed');
  });
  await t('safe-class block then human promote', async () => {
    const s = baseSpec('opsy');
    s.candidates.opsy = candidateFile({ slug: 'opsy', klass: 'ops', ev: [{ date: '2026-02-01', quote: s._q[0] }, { date: '2026-02-02', quote: s._q[1] }] });
    const env = makeEnv(s);
    assert(run(env, ['autopromote', 'on']).status === 0, 'autopromote on failed');
    const sw = run(env, ['sweep-candidates', '--write']);
    assert(/shadow opsy/.test(sw.stdout), `ops class should be shadowed: ${sw.stdout}`);
    assert(existsSync(join(env.cDir, 'opsy.md')), 'candidate consumed by unattended sweep');
    const pr = run(env, ['promote', 'opsy']);
    assert(pr.status === 0 && readCb(env).projects.opsy?.class === 'ops', `human promote of ops class failed: ${pr.stdout}${pr.stderr}`);
  });

  // ---- events ----
  await t('event dedup (created + rejected)', async () => {
    const s = baseSpec('dupe');
    s.candidates.dupe = candidateFile({ slug: 'dupe', ev: [
      { date: '2026-02-01', quote: 'a fabricated quote that matches no line in the logs' },
      { date: '2026-02-02', quote: 'another fabricated quote that matches nothing at all' },
    ] });
    const env = makeEnv(s);
    run(env, ['sweep-candidates', '--write']);
    run(env, ['sweep-candidates', '--write']);
    const lines = readFileSync(join(env.data, 'candidate-events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert(lines.length === 2, `expected 2 deduped events, got ${lines.length}`);
    const evs = lines.map(l => JSON.parse(l).event).sort();
    assert(evs[0] === 'created' && evs[1] === 'rejected', `unexpected events: ${evs}`);
  });

  // ---- migrate-ledger ----
  await t('migrate-ledger idempotency + legacy shapes', async () => {
    const env = makeEnv({ codebook: KNOWN_CB, days: [], ledger: { entries: {
      a: { status: 'minted', decided_on: '2026-01-01', junk: 'x' },
      b: { status: 'aliased', decided_on: '2026-01-02', alias_target: 'known-a', extra: 1 },
    } } });
    const m1 = run(env, ['migrate-ledger']);
    assert(m1.status === 0, `migrate exit ${m1.status}: ${m1.stderr}`);
    const led = readLed(env);
    assert(led.version === 1 && !('junk' in led.entries.a) && !('extra' in led.entries.b), 'legacy fields not normalized');
    assert(/already normalized/.test(run(env, ['migrate-ledger']).stdout), 'migrate not idempotent');
  });
  await t('migrate-ledger aborts on unmappable status', async () => {
    const env = makeEnv({ codebook: KNOWN_CB, days: [], ledger: { version: 1, entries: { z: { status: 'bogus', decided_on: 'x' } } } });
    const m = run(env, ['migrate-ledger']);
    assert(m.status === 1 && /ABORTED/.test(m.stderr), 'did not abort on unknown status');
    assert(readLed(env).entries.z.status === 'bogus', 'ledger changed despite abort');
  });

  // ---- concurrency ----
  await t('concurrent distinct promotes (no lost update)', async () => {
    const q = s => [`- First real day of ${s} with a full working slice built end to end.`, `- Second day of ${s}: wrote tests and wired the configuration file up.`];
    const [qa1, qa2] = q('alpha'), [qb1, qb2] = q('beta');
    const env = makeEnv({
      codebook: JSON.parse(JSON.stringify(KNOWN_CB)),
      days: [
        { date: '2026-03-01', major: [{ slug: 'alpha', w: 1 }], minor: [], new: ['alpha'], flags: [], oneline: 'a1' },
        { date: '2026-03-02', major: [{ slug: 'alpha', w: 1 }], minor: [], new: ['alpha'], flags: [], oneline: 'a2' },
        { date: '2026-03-03', major: [{ slug: 'beta', w: 1 }], minor: [], new: ['beta'], flags: [], oneline: 'b1' },
        { date: '2026-03-04', major: [{ slug: 'beta', w: 1 }], minor: [], new: ['beta'], flags: [], oneline: 'b2' },
      ],
      logs: { '2026-03-01': logWith(qa1), '2026-03-02': logWith(qa2), '2026-03-03': logWith(qb1), '2026-03-04': logWith(qb2) },
      candidates: {
        alpha: candidateFile({ slug: 'alpha', drafted_on: '2026-03-05', ev: [{ date: '2026-03-01', quote: qa1 }, { date: '2026-03-02', quote: qa2 }] }),
        beta: candidateFile({ slug: 'beta', drafted_on: '2026-03-05', ev: [{ date: '2026-03-03', quote: qb1 }, { date: '2026-03-04', quote: qb2 }] }),
      },
    });
    const [ra, rb] = await Promise.all([runAsync(env, ['promote', 'alpha']), runAsync(env, ['promote', 'beta'])]);
    assert(ra.status === 0 && rb.status === 0, `promotes exit ${ra.status}/${rb.status}`);
    const cb = readCb(env);
    assert(cb.projects.alpha && cb.projects.beta, 'lost update: a promoted slug is missing');
  });
  await t('same-slug race (one wins, one blocked)', async () => {
    const env = promoEnv('racer');
    const [r1, r2] = await Promise.all([runAsync(env, ['promote', 'racer']), runAsync(env, ['promote', 'racer'])]);
    const oks = [r1, r2].filter(r => r.status === 0).length;
    assert(oks === 1, `expected exactly one success, got ${oks}`);
    assert(readCb(env).projects.racer, 'winner did not persist');
  });

  // ---- lock reap ----
  await t('stale-lock reap', async () => {
    const env = promoEnv('stale');
    writeFileSync(join(env.base, '.tastebud.lock'), JSON.stringify({ pid: 2147480000, startTime: Date.now(), token: 'deadbeef' }));
    const r = run(env, ['promote', 'stale']);
    assert(r.status === 0 && readCb(env).projects.stale, `stale lock not reaped: exit ${r.status} ${r.stdout}${r.stderr}`);
  });

  // ---- legacy regression ----
  await t('legacy commands still work', async () => {
    const env = makeEnv({ codebook: JSON.parse(JSON.stringify(KNOWN_CB)), days: [
      { date: '2026-04-01', major: [{ slug: 'known-a', w: 1 }], minor: [], new: [], flags: [], oneline: 'x' },
    ] });
    assert(run(env, ['check']).status === 0, 'check failed');
    assert(run(env, ['unknowns']).status === 0, 'unknowns failed');
    assert(run(env, ['mint', 'fresh-legacy', '--class', 'product', '--no-report']).status === 0, 'mint failed');
    assert(readCb(env).projects['fresh-legacy'], 'mint did not persist');
    assert(run(env, ['mint', 'fresh-legacy', '--undo', '--no-report']).status === 0, 'undo failed');
    assert(!readCb(env).projects['fresh-legacy'] && readLed(env).entries['fresh-legacy'].status === 'undone', 'legacy undo not -> undone');
    assert(run(env, ['alias', 'some-alias', 'known-a']).status === 0, 'alias failed');
    assert(run(env, ['dismiss', 'ghost']).status === 0, 'dismiss failed');
    assert(run(env, ['decisions']).status === 0, 'decisions failed');
  });

  // ---- transition guard ----
  await t('transition guard (dismiss/watch refuse via:promote)', async () => {
    const env = promoEnv('guarded');
    assert(run(env, ['promote', 'guarded']).status === 0, 'promote failed');
    assert(run(env, ['dismiss', 'guarded']).status === 1, 'dismiss should refuse a via:promote entry');
    assert(run(env, ['watch', 'guarded']).status === 1, 'watch should refuse a via:promote entry');
    const led = readLed(env).entries.guarded;
    assert(led.status === 'minted' && led.via === 'promote', 'via:promote entry was overwritten');
  });

  // ---- kill points ----
  for (const [pt, incomplete] of [['4a', true], ['4b', true], ['4c', true], ['4d', false]]) {
    await t(`kill-point ${pt}`, async () => {
      const env = promoEnv('kp' + pt);
      const r = run(env, ['promote', 'kp' + pt], { TASTEBUD_KILL_AFTER: pt });
      assert(r.status === 137, `expected hard exit 137 at ${pt}, got ${r.status}`);
      const c = run(env, ['check']);
      if (incomplete) assert(c.status === 1 && /INCOMPLETE-PROMOTION/.test(c.stdout), `check should flag incomplete after ${pt}: ${c.stdout}`);
      else assert(c.status === 0 && !/INCOMPLETE/.test(c.stdout), `check should be clean after ${pt}: ${c.stdout}`);
    });
  }

  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  for (const n of notes) console.error(`NOTE: ${n}`);
  for (const f of fails) console.error(f);
  console.log(`SELFTEST PASS ${pass}/${total}`);
  process.exit(fails.length ? 1 : 0);
}

// ---------- commands ----------
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'check') {
  let issues = 0;
  for (const d of days) {
    const sum = d.major.reduce((s, m) => s + m.w, 0);
    if (d.major.length && Math.abs(sum - 1) > 1e-9) { console.log(`WEIGHT ${d.date}: sum=${sum}`); issues++; }
    for (const m of d.major) if (!KNOWN.has(m.slug) && !(d.new || []).includes(m.slug))
      { console.log(`UNKNOWN-SLUG ${d.date}: ${m.slug} (major, not in codebook, not marked new)`); issues++; }
  }
  // Crash-recovery reconciliation over via:promote ledger entries only (fresh reads, sha-verified).
  // Complete = codebook key present AND project file present with sha === promote_sha AND candidate
  // absent. Any deviation is an INCOMPLETE PROMOTION with the exact artifact + a manual repair.
  // Founding/hand-added codebook keys (no ledger entry) are never treated as corruption.
  {
    const freshLed = loadLedger();
    const cbNow = JSON.parse(readFileSync(CODEBOOK_PATH, 'utf8'));
    const promoted = Object.entries(freshLed.entries || {}).filter(([, e]) => e.status === 'minted' && e.via === 'promote');
    if (promoted.length) {
      const cDir = resolve(config._configDir, config.candidatesDir ?? join(DATA, 'project-candidates'));
      const pDir = config.projectsDir ? resolve(config._configDir, config.projectsDir) : null;
      for (const [slug, e] of promoted) {
        const problems = [];
        if (!cbNow.projects[slug]) problems.push('codebook entry missing');
        if (!pDir) problems.push('projectsDir not configured (cannot verify the promoted file)');
        else {
          const pf = join(pDir, slug + '.md');
          if (!existsSync(pf)) problems.push(`project file missing (${basename(pf)})`);
          else if (sha256(readFileSync(pf)) !== e.promote_sha) problems.push(`project file sha != promote_sha (${basename(pf)})`);
        }
        const cf = join(cDir, slug + '.md');
        if (existsSync(cf)) problems.push(`candidate file still present (${basename(cf)})`);
        if (problems.length) {
          console.log(`INCOMPLETE-PROMOTION ${slug}: ${problems.join('; ')}`);
          console.log(`  repair: to keep it, restore the missing artifact (project bytes = the candidate bytes) and remove any lingering candidate; to abandon it, run "node tastebud.mjs mint ${slug} --undo".`);
          issues++;
        }
      }
    }
  }
  const t = days.find(d => d.major.length >= 2) ?? days[0];
  const rec = decodeBundle(bundle(t), t.major.map(m => m.slug));
  const ok = t.major.every(m => {
    const r = rec.find(x => x.slug === m.slug);
    return r && Math.abs(r.est - m.w) < 0.05;
  });
  console.log(`days=${days.length} slugs=${KNOWN.size} D=${D}`);
  console.log(`vector-recovery sanity (${t.date}): ${ok ? 'PASS' : 'FAIL'}`);
  console.log(issues ? `${issues} data issue(s) (normalized at load)` : 'no data issues');
  // Non-zero exit on any data issue or a failed vector-recovery so `check` is CI/script usable.
  if (issues || !ok) process.exitCode = 1;
}

else if (cmd === 'decode') {
  const d = byDate[args[0]];
  if (!d) { console.log('no such day'); process.exit(1); }
  const b = bundle(d);
  console.log(`${d.date} - ${d.oneline ?? ''}${provTag(d)}`);
  console.log('recovered from vector alone (vs actual):');
  for (const { slug, est } of decodeBundle(b, allSlugsEver)) {
    const actual = d.major.find(m => m.slug === slug);
    console.log(`  ${slug.padEnd(28)} est=${fmt(est)}  actual=${actual ? fmt(actual.w) : '-'}${KNOWN.has(slug) ? '' : '  [NOT IN CODEBOOK]'}`);
  }
  if (d.minor.length) console.log(`  minors (table): ${d.minor.join(', ')}`);
}

else if (cmd === 'where') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  for (const d of hits) {
    const m = d.major.find(x => x.slug === slug);
    console.log(`  ${d.date}  ${m ? 'MAJOR ' + fmt(m.w) : 'minor      '}  ${d.oneline ?? ''}${provTag(d)}`);
  }
  console.log(`${hits.length} day(s); major on ${hits.filter(d => d.major.some(m => m.slug === slug)).length}`);
}

else if (cmd === 'first') {
  const slug = args[0];
  const hits = days.filter(d => d.major.some(m => m.slug === slug) || d.minor.includes(slug));
  const majors = days.filter(d => d.major.some(m => m.slug === slug));
  if (!hits.length) { console.log('never seen'); process.exit(0); }
  console.log(`${slug}: first mention ${hits[0].date}, first major ${majors[0]?.date ?? '-'}, last ${hits[hits.length - 1].date}, ${hits.length} day(s)`);
}

else if (cmd === 'cooccur') {
  const [a, b] = args;
  const hits = days.filter(d => d.major.some(m => m.slug === a) && d.major.some(m => m.slug === b));
  hits.forEach(d => console.log(`  ${d.date}  ${d.oneline ?? ''}`));
  console.log(`${hits.length} day(s) with both ${a} and ${b} major`);
}

else if (cmd === 'window' || cmd === 'diff') {
  const agg = (from, to) => {
    const w = new Float64Array(D);
    const set = days.filter(d => d.date >= from && d.date <= to && d.major.length);
    for (const d of set) { const b = bundle(d); for (let i = 0; i < D; i++) w[i] += b[i] / set.length; }
    return { w, n: set.length };
  };
  if (cmd === 'window') {
    const { w, n } = agg(args[0], args[1]);
    console.log(`${args[0]} → ${args[1]} (${n} active days):`);
    decodeBundle(w, allSlugsEver, 0.02).slice(0, 14).forEach(r => console.log(`  ${r.slug.padEnd(28)} ${fmt(r.est)}`));
  } else {
    const A = agg(args[0], args[1]), B = agg(args[2], args[3]);
    const dA = Object.fromEntries(decodeBundle(A.w, allSlugsEver, 0.02).map(r => [r.slug, r.est]));
    const dB = Object.fromEntries(decodeBundle(B.w, allSlugsEver, 0.02).map(r => [r.slug, r.est]));
    console.log(`A=${args[0]}..${args[1]} (${A.n}d)  B=${args[2]}..${args[3]} (${B.n}d)`);
    console.log('GONE (in A, not B):'); Object.keys(dA).filter(s => !dB[s]).forEach(s => console.log(`  ${s.padEnd(28)} ${fmt(dA[s])} → 0`));
    console.log('NEW (in B, not A):'); Object.keys(dB).filter(s => !dA[s]).forEach(s => console.log(`  ${s.padEnd(28)} 0 → ${fmt(dB[s])}`));
    console.log('SHIFTED:'); Object.keys(dA).filter(s => dB[s]).forEach(s => console.log(`  ${s.padEnd(28)} ${fmt(dA[s])} → ${fmt(dB[s])}`));
  }
}

else if (cmd === 'gaps') {
  const seen = new Map();
  for (const d of days) for (const m of d.major) {
    const e = seen.get(m.slug) ?? { days: 0, mass: 0, first: d.date };
    e.days++; e.mass += m.w; seen.set(m.slug, e);
  }
  console.log('workstreams in logs with NO project file:');
  [...seen.entries()]
    .filter(([s]) => !KNOWN.has(s) || codebook.projects[s]?.has_file === false)
    .sort((a, b2) => b2[1].mass - a[1].mass)
    .forEach(([s, e]) => console.log(`  ${s.padEnd(28)} ${String(e.days).padStart(3)} day(s)  mass=${fmt(e.mass)}  first=${e.first}${KNOWN.has(s) ? '' : '  [NOT EVEN IN CODEBOOK]'}`));
}

else if (cmd === 'backtest') {
  const slug = args[0];
  const thr = parseFloat(args[1] ?? '0.20');
  const excluded = new Set([slug]);
  const firstAppear = days.find(d => d.major.some(m => m.slug === slug))?.date;
  if (!firstAppear) { console.log('slug never major; nothing to backtest'); process.exit(0); }
  console.log(`backtest: pretend "${slug}" is unknown. threshold=${thr}. true first major=${firstAppear}`);
  let firstFlag = null, flagged = 0;
  for (const d of days) {
    if (!d.major.length) continue;
    // Count only TARGET-ACTIVE days toward detection/lag. A day whose only unexplained mass is
    // some OTHER unknown slug (e.g. sourdough-lab) is not an aquarium-controller detection; it
    // would flag no matter which slug we backtested. Restricting to days the target is actually
    // major on stops that misattribution.
    if (!d.major.some(m => m.slug === slug)) continue;
    const unexplained = d.major.filter(m => excluded.has(m.slug) || !KNOWN.has(m.slug)).reduce((s, m) => s + m.w, 0);
    const b = bundle(d);
    const r = Float64Array.from(b);
    for (const s of KNOWN) {
      if (excluded.has(s)) continue;
      const e = estW(b, s);
      if (e < 0.04) continue;
      const v = vec(s);
      for (let i = 0; i < D; i++) r[i] -= e * v[i];
    }
    const resid = norm(b) > 0 ? norm(r) / norm(b) : 0;
    if (unexplained >= thr) {
      flagged++;
      if (!firstFlag) firstFlag = d.date;
      console.log(`  FLAG ${d.date}  unexplained=${fmt(unexplained)}  vec-residual=${fmt(resid)}  ${d.oneline ?? ''}`);
    }
  }
  if (firstFlag) {
    const lag = (new Date(firstFlag) - new Date(firstAppear)) / 86400000;
    console.log(`RESULT: first flag ${firstFlag} (lag ${lag} day(s) after true first major), ${flagged} day(s) flagged`);
  } else console.log('RESULT: never flagged - detector FAILED for this slug at this threshold');
}

else if (cmd === 'drift') {
  const slug = args[0];
  const halflife = parseFloat(args[1] ?? '10');
  const alpha = 1 - Math.pow(0.5, 1 / halflife);
  const ema = new Float64Array(D);
  let active = 0;
  for (const d of days) {
    const m = d.major.find(x => x.slug === slug);
    if (!m) continue;
    active++;
    const b = bundle(d);
    for (let i = 0; i < D; i++) ema[i] = ema[i] * (1 - alpha) + b[i] * alpha;
  }
  if (!active) { console.log('never major'); process.exit(0); }
  console.log(`${slug} identity after ${active} active day(s) (EMA halflife ${halflife}):`);
  console.log('entangled with (decoded from drift vector):');
  decodeBundle(ema, allSlugsEver, 0.03).slice(0, 8).forEach(r =>
    console.log(`  ${r.slug.padEnd(28)} ${fmt(r.est)}${r.slug === slug ? '  (self)' : ''}`));
}

else if (cmd === 'similar') {
  const d = byDate[args[0]];
  if (!d) { console.log('no such day'); process.exit(1); }
  const b = bundle(d), nb = norm(b);
  days.filter(x => x.date !== d.date && x.major.length)
    .map(x => { const c = bundle(x); return { date: x.date, cos: dot(b, c) / (nb * norm(c)), oneline: x.oneline ?? '' }; })
    .sort((x, y) => y.cos - x.cos).slice(0, 6)
    .forEach(r => console.log(`  ${r.date}  cos=${fmt(r.cos)}  ${r.oneline}`));
}

else if (cmd === 'tasteslike') {
  // "I don't know this ingredient, but it tastes like tarragon."
  // Slug vectors are orthogonal by construction, so flavor comes from CONTEXT: a project's
  // taste-profile is the company it keeps, rarity-weighted so ubiquitous background work
  // (daily monitors, ops chores) doesn't make everything taste the same.
  // (profile math lifted to module-scope tasteProfile/idf, shared with `unknowns`.)
  const slug = args[0];
  const profile = tasteProfile;
  const { p: target, activity, companions } = profile(slug);
  if (!activity) { console.log(`"${slug}" never appears as major - nothing to taste`); process.exit(0); }
  const cb = codebook.projects[slug];
  console.log(`${slug}${cb ? ` (${cb.class ?? 'project'})` : '  [UNKNOWN INGREDIENT - not in codebook]'}`);
  console.log('keeps company with (rarity-weighted co-occurrence):');
  const nt = norm(target);
  if (companions.size === 0 || nt === 0) {
    // A sole-major slug shares no day with other major work, so its taste profile is zero-norm;
    // a cosine would divide by zero (NaN). Report no profile and skip the tastes-like section.
    console.log('  (none - this slug never shares a day with other major work, so it has no taste profile yet)');
  } else {
    [...companions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([s, w]) => console.log(`  ${s.padEnd(28)} ${fmt(w / activity)}`));
    console.log('tastes like (similar taste-profiles among known ingredients):');
    allSlugsEver
      .filter(s => s !== slug && KNOWN.has(s))
      .map(s => { const { p, activity: a } = profile(s); return a && norm(p) > 0 ? { slug: s, cos: dot(target, p) / (nt * norm(p)) } : null; })
      .filter(Boolean)
      .sort((x, y) => y.cos - x.cos)
      .slice(0, 5)
      .forEach(r => console.log(`  ${r.slug.padEnd(28)} cos=${fmt(r.cos)}`));
  }
}

else if (cmd === 'color') {
  const hsl2hex = (h, s, l) => {
    const f = n => { const k = (n + h / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  const slugColor = s => hsl2hex(fnv1a(s) % 360, 0.65, 0.55);
  const d = byDate[args[0]];
  if (d) {
    let R = 0, G = 0, B = 0;
    for (const m of d.major) {
      const hex = slugColor(m.slug);
      R += m.w * parseInt(hex.slice(1, 3), 16); G += m.w * parseInt(hex.slice(3, 5), 16); B += m.w * parseInt(hex.slice(5, 7), 16);
    }
    const hex = `#${[R, G, B].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
    console.log(`${d.date} = ${hex}`);
    d.major.forEach(m => console.log(`  ${slugColor(m.slug)} ${m.slug} (${fmt(m.w)})`));
  } else console.log(`${args[0]} = ${slugColor(args[0])}`);
}

else if (cmd === 'unknowns') {
  // Surface unresolved "unknown ingredient" workstreams for weekly triage.
  // (Once filed/aliased in the codebook it is "resolved" and drops off this list.)
  const rows = computeUnknownRows();
  // maturity/decision tag per row: ledger status wins, else maturity bucket.
  const tag = r => r.status !== 'open' ? r.status.toUpperCase()
    : r.revived ? 'REVIVED'
    : r.overdue ? 'OVERDUE'
    : r.maturing ? 'maturing'
    : 'ripe';
  const verdict = r => r.recommend === 'alias' ? `alias->${r.recommendTarget}` : r.recommend;
  const decideN = rows.filter(r => (r.status === 'open' && r.ripe) || r.revived).length;
  const maturingN = rows.filter(r => r.status === 'open' && r.maturing).length;

  // ---- always: readable stdout summary ----
  console.log(`unknowns: ${rows.length} total  (decide ${decideN}, maturing ${maturingN})`);
  for (const r of rows) {
    console.log(`  ${r.slug.padEnd(28)} open ${String(r.age).padStart(3)}d  ${String(r.days_seen).padStart(2)} day(s)  mass=${fmt(r.major_mass)}  [${tag(r).padEnd(9)}]  -> ${verdict(r)}`);
  }

  // ---- optional: triage-ready markdown report ----
  if (process.argv.includes('--write')) {
    const path = writeUnknownsReport(rows);
    console.log(`wrote ${path}`);
  }
}

else if (cmd === 'mint') {
  // Safe codebook write: validate, snapshot codebook.json -> .bak, write, regenerate report.
  // Renames are never done; the codebook is a permanent slug->vector store. --undo reverses an add.
  const flag = name => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? '') : null;
  };
  const slug = args[0];
  const undo = process.argv.includes('--undo');
  if (!slug || slug.startsWith('--')) {
    console.log('usage: mint <slug> [--class C] [--parent P] [--alias a,b,c] [--undo] [--no-report]');
    process.exit(1);
  }
  const klass = flag('--class') ?? 'product';
  const parent = flag('--parent');                                    // null if not given
  const aliasRaw = flag('--alias');
  const aliases = aliasRaw ? aliasRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const noReport = process.argv.includes('--no-report');
  const cDir = resolve(config._configDir, config.candidatesDir ?? join(DATA, 'project-candidates'));
  const pDir = config.projectsDir ? resolve(config._configDir, config.projectsDir) : join(DATA, 'projects');

  if (undo) {
    // Legacy direct mints reverse in place (no file touched); candidate-promoted mints run the
    // explicit reverse transaction (reconstruct candidate, remove project, drop codebook, ledger->undone).
    const res = undoPromotedMint({ slug, candidatesDir: cDir, projectsDir: pDir });
    if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }
    if (!noReport) withLock(DATA, () => {
      const { codebook: cb, ledger, days: d } = loadFresh();
      writeUnknownsReport(unknownRows({ codebook: cb, ledger, days: d }), ledger);
    });
    console.log(res.reverse
      ? `undid candidate-promoted "${res.slug}": codebook entry removed, candidate file restored, project file removed, ledger -> undone`
      : `removed "${res.slug}" from the codebook; ledger -> undone`);
    console.log(noReport ? 'report skipped (--no-report)' : `regenerated ${join(DATA, 'unknowns-report.md')}`);
    process.exit(0);
  }

  const res = withLock(DATA, () => {
    const { codebook: cb, ledger, days: d } = loadFresh();
    const { KNOWN: K } = buildKnownAliased(cb);
    const err = mintCheck(K, { slug, parent, klass });
    if (err) return { ok: false, error: err };
    const has_file = projectFileExists(slug);
    mintApply(cb, { slug, parent, aliases, klass, has_file });
    saveCodebookAtomic(cb);
    const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: buildLedgerEntry(ledger.entries[slug], 'minted', { decided_on: today() }) } };
    saveLedgerAtomic(led2);
    if (!noReport) writeUnknownsReport(unknownRows({ codebook: cb, ledger: led2, days: d }), led2);
    return { ok: true, slug, class: klass, parent, aliases, has_file };
  });
  if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }
  console.log(`minted "${res.slug}"  class=${res.class}  parent=${res.parent ?? '(none)'}  has_file=${res.has_file}  aliases=[${res.aliases.join(', ')}]`);
  console.log(noReport ? 'report skipped (--no-report)' : `regenerated ${join(DATA, 'unknowns-report.md')}`);
}

else if (cmd === 'alias') {
  // Resolve an unknown by aliasing it onto an existing codebook slug (true resolution: it leaves
  // the unknown list because ALIASED now contains it). Refuses self-conflicting cases. Snapshots first.
  const [name, target] = args;
  if (!name || !target) { console.log('usage: alias <name> <target-codebook-slug>'); process.exit(1); }
  const res = withLock(DATA, () => {
    const { codebook: cb, ledger, days: d } = loadFresh();
    const { KNOWN: K } = buildKnownAliased(cb);
    if (!K.has(target)) return { ok: false, error: `target "${target}" is not a codebook key` };
    if (K.has(name)) return { ok: false, error: `"${name}" is already a codebook key (alias onto a slug, not a slug onto itself)` };
    let entry2;
    try { entry2 = buildLedgerEntry(ledger.entries[name], 'aliased', { decided_on: today(), alias_target: target }); }
    catch (e) { return { ok: false, error: e.message }; }
    const cbEntry = cb.projects[target];
    cbEntry.aliases = cbEntry.aliases || [];
    if (!cbEntry.aliases.includes(name)) { cbEntry.aliases.push(name); saveCodebookAtomic(cb); }
    const led2 = { ...ledger, entries: { ...ledger.entries, [name]: entry2 } };
    saveLedgerAtomic(led2);
    writeUnknownsReport(unknownRows({ codebook: cb, ledger: led2, days: d }), led2);
    return { ok: true, name, target };
  });
  if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }
  console.log(`aliased "${res.name}" -> "${res.target}" (added to ${res.target}.aliases; "${res.name}" now resolves)`);
  console.log(`regenerated ${join(DATA, 'unknowns-report.md')}`);
}

else if (cmd === 'dismiss') {
  // Dismiss an unknown as a one-off. Records baseline_days so it can REVIVE if seen meaningfully more.
  const slug = args[0];
  if (!slug) { console.log('usage: dismiss <slug> [note...]'); process.exit(1); }
  const note = args.slice(1).join(' ').trim();
  const res = withLock(DATA, () => {
    const { codebook: cb, ledger, days: d } = loadFresh();
    const row = unknownRows({ codebook: cb, ledger, days: d }).find(r => r.slug === slug);
    const baseline_days = row ? row.days_seen : 0;
    let entry2;
    try { entry2 = buildLedgerEntry(ledger.entries[slug], 'dismissed', { decided_on: today(), baseline_days, ...(note ? { note } : {}) }); }
    catch (e) { return { ok: false, error: e.message }; }
    const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: entry2 } };
    saveLedgerAtomic(led2);
    writeUnknownsReport(unknownRows({ codebook: cb, ledger: led2, days: d }), led2);
    return { ok: true, slug, baseline_days, note };
  });
  if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }
  console.log(`dismissed "${res.slug}" (baseline ${res.baseline_days} day(s); revives if seen >= ${res.baseline_days + 1})${res.note ? `: ${res.note}` : ''}`);
  console.log(`regenerated ${join(DATA, 'unknowns-report.md')}`);
}

else if (cmd === 'watch') {
  // Park an unknown on the watchlist: surfaces in Watching (terse), out of Decide, kept in view.
  const slug = args[0];
  if (!slug) { console.log('usage: watch <slug> [note...]'); process.exit(1); }
  const note = args.slice(1).join(' ').trim();
  const res = withLock(DATA, () => {
    const { codebook: cb, ledger, days: d } = loadFresh();
    let entry2;
    try { entry2 = buildLedgerEntry(ledger.entries[slug], 'watching', { decided_on: today(), ...(note ? { note } : {}) }); }
    catch (e) { return { ok: false, error: e.message }; }
    const led2 = { ...ledger, entries: { ...ledger.entries, [slug]: entry2 } };
    saveLedgerAtomic(led2);
    writeUnknownsReport(unknownRows({ codebook: cb, ledger: led2, days: d }), led2);
    return { ok: true, slug, note };
  });
  if (!res.ok) { console.log(`refused: ${res.error}`); process.exit(1); }
  console.log(`watching "${res.slug}" (since ${today()})${res.note ? `: ${res.note}` : ''}`);
  console.log(`regenerated ${join(DATA, 'unknowns-report.md')}`);
}

else if (cmd === 'decisions') {
  // Print the persistent decision ledger grouped by status.
  const led = loadLedger();
  const entries = Object.entries(led.entries);
  if (!entries.length) { console.log('ledger empty (no decisions recorded).'); process.exit(0); }
  console.log(`decision ledger: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  for (const status of ['watching', 'dismissed', 'minted', 'aliased']) {
    const group = entries.filter(([, e]) => e.status === status);
    if (!group.length) continue;
    console.log(`\n${status} (${group.length}):`);
    for (const [slug, e] of group.sort((a, b) => a[0].localeCompare(b[0]))) {
      const extra = e.alias_target ? ` -> ${e.alias_target}` : e.baseline_days != null ? ` (baseline ${e.baseline_days}d)` : '';
      console.log(`  ${slug.padEnd(28)} ${e.decided_on ?? '?'}${extra}${e.note ? `  // ${e.note}` : ''}`);
    }
  }
}

else if (cmd === 'autofile') {
  // RETAINED but DEPRECATED: file-existence auto-mint. The candidate flow (sweep-candidates +
  // promote) is the recommended path; it re-validates evidence instead of trusting a bare file.
  // Deprecation goes to STDERR so the STDOUT `AUTOFILED:` contract (and exit codes) is unchanged.
  console.error('DEPRECATED: `autofile` treats file-existence as human judgment and is deprecated; use the candidate flow (sweep-candidates + promote). See CANDIDATES.md. It is no longer part of the nightly sweep.');
  const write = process.argv.includes('--write');
  const detail = [];
  const result = withLock(DATA, () => {
    const { codebook: cb, ledger, days: d } = loadFresh();
    const candidates = unknownRows({ codebook: cb, ledger, days: d })
      .filter(r => r.major_mass > 0 && SLUG_RE.test(r.slug) && projectFileExists(r.slug));
    if (!candidates.length) return { filed: [], candidates: [], write };
    const filed = [];
    let led = ledger, cur = cb;
    for (const r of candidates) {
      if (write) {
        const { KNOWN: K } = buildKnownAliased(cur);
        const err = mintCheck(K, { slug: r.slug, parent: null, klass: 'product' });
        if (err) { detail.push(`  SKIP ${r.slug}: ${err}`); continue; }
        mintApply(cur, { slug: r.slug, parent: null, aliases: [], klass: 'product', has_file: true });
        saveCodebookAtomic(cur);
        led = { ...led, entries: { ...led.entries, [r.slug]: buildLedgerEntry(led.entries[r.slug], 'minted', { decided_on: today() }) } };
        saveLedgerAtomic(led);
        filed.push(r.slug);
        detail.push(`  filed ${r.slug.padEnd(28)} class=product  has_file=true  mass=${fmt(r.major_mass)}`);
      } else {
        detail.push(`  would file ${r.slug.padEnd(28)} class=product  mass=${fmt(r.major_mass)}`);
      }
    }
    if (write && filed.length) writeUnknownsReport(unknownRows({ codebook: cur, ledger: led, days: d }), led);
    return { filed, candidates: candidates.map(r => r.slug), write };
  });

  if (!result.candidates.length) {
    console.log(write ? 'nothing to autofile.' : 'dry run: nothing would be filed.');
    console.log('AUTOFILED: none');
    process.exit(0);
  }
  console.log(`${write ? 'filing' : 'dry run: would file'} ${result.candidates.length} unknown(s) (has project file + seen as major):`);
  for (const line of detail) console.log(line);
  if (write && result.filed.length) console.log(`regenerated ${join(DATA, 'unknowns-report.md')} (undo any slug with: mint <slug> --undo)`);
  const out = write ? result.filed : result.candidates;
  console.log(`AUTOFILED: ${out.length ? out.join(' ') : 'none'}`);
}

else if (cmd === 'digest') {
  // Compose a plain-text status digest (aligned monospace, no markdown tables) and print to
  // stdout. Reuses computeUnknownRows / loadLedger / today / days / KNOWN / fmt. A notifier
  // (e.g. the sweeper's config.notifyCommand hook) can push this text wherever you like.
  const rows = computeUnknownRows();
  // Decide order MUST match writeUnknownsReport: overdue first, then major_mass desc, then slug.
  const decide = rows
    .filter(r => (r.status === 'open' && r.ripe) || r.revived)
    .sort((a, b) => (b.overdue - a.overdue) || (b.major_mass - a.major_mass) || a.slug.localeCompare(b.slug));
  const maturingN = rows.filter(r => r.status === 'open' && r.maturing).length;
  const latest = days[days.length - 1];
  const topSlug = latest && latest.major[0] ? latest.major[0].slug : '(none)';
  const latestDay = latest ? latest.date : '(none)';
  // Latest day's oneline rides along in the pulse/footer when present (truncated to 70 chars);
  // absent/empty oneline leaves the label as just the top slug, byte-identical to before.
  const oneline = latest && typeof latest.oneline === 'string' ? latest.oneline : '';
  const tagLabel = oneline ? `${topSlug}: "${oneline.slice(0, 70)}"` : topSlug;
  const slugN = KNOWN.size;
  const ymd = today();

  // recently: ledger entries decided today or yesterday (UTC), grouped by status.
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const recentByStatus = new Map();
  for (const [slug, e] of Object.entries(loadLedger().entries)) {
    if (e.decided_on === ymd || e.decided_on === yest) {
      if (!recentByStatus.has(e.status)) recentByStatus.set(e.status, []);
      recentByStatus.get(e.status).push(slug);
    }
  }
  const recent = [...recentByStatus.entries()]
    .map(([status, slugs]) => `${status} ${slugs.join(', ')}`)
    .join('; ');

  const verdict = r => r.recommend === 'mint' ? 'MINT'
    : r.recommend === 'alias' ? `ALIAS onto ${r.recommendTarget}`
    : r.recommend === 'watch' ? 'WATCH'
    : 'DISMISS';
  const mass2 = n => n.toFixed(2);

  const cands = currentCandidates();

  // ONE canonical machine interface. `digest --json` prints exactly {date, decide, candidates} and
  // exits 0; the sweeper consumes this and NEVER parses the human text below.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ date: ymd, decide: decide.map(r => r.slug), candidates: cands }));
    process.exit(0);
  }

  const out = [];
  if (decide.length > 0) {
    // decide count on line 1: phone notification previews (and any first-line-only
    // transport) must carry the signal, not just a bare header.
    out.push(`🎨 Tastebud - ${ymd}: ${decide.length} need your call`);
    out.push('DECIDE:');
    for (const r of decide) {
      out.push(`  ${r.slug.padEnd(26)} ${r.age}d  mass ${mass2(r.major_mass)}  -> ${verdict(r)}`);
    }
    const f = decide[0].slug;
    out.push(`  reply: "dismiss ${f}" / "mint ${f}" / "watch ${f}" / "alias ${f} onto <someExistingCodebookSlug>"`);
    out.push('');
    out.push(`tagged ${latestDay} (${tagLabel}) | maturing ${maturingN} | ${slugN} slugs | ok`);
    if (recent) out.push(`recently: ${recent}`);
  } else {
    let pulse = `🎨 Tastebud - ${ymd}: tagged ${latestDay} (${tagLabel}). 0 to decide.`;
    if (maturingN > 0) pulse += ` ${maturingN} maturing.`;
    pulse += ` ${slugN} slugs, ok.`;
    out.push(pulse);
    if (recent) out.push(`recently: ${recent}`);
  }
  // CANDIDATE section: passing = ready to mint by name; failing = the first gate that blocked it.
  for (const c of cands) {
    out.push(c.pass ? `CANDIDATE ${c.slug} (would mint): reply promote ${c.slug}`
                    : `CANDIDATE ${c.slug} blocked: ${c.gate}`);
  }
  console.log(out.join('\n'));
}

else if (cmd === 'promote') {
  // Human promote: any valid class/parent; all nine gates still run under the lock.
  const slug = args[0];
  if (!slug || slug.startsWith('--')) { console.log('usage: promote <slug>'); process.exit(1); }
  const { candidatesDir, projectsDir } = validateCandidateDirs(config, config._configDir);
  const logDirs = resolveLogDirs(config, config._configDir);
  const res = promoteViaCandidate({ slug, candidatesDir, projectsDir, logDirs, unattended: false });
  if (res.ok) {
    console.log(`promoted "${res.slug}"  class=${res.class}  parent=${res.parent ?? '(none)'}  has_file=true`);
    console.log(`  wrote ${join(projectsDir, res.slug + '.md')}; removed the candidate; ledger -> minted (via:promote)`);
    process.exit(0);
  }
  if (res.recovery) { console.error(res.error); process.exit(1); }
  console.log(`refused to promote "${slug}": ${res.error ?? 'gate(s) ' + (res.fails || []).join(', ')}`);
  process.exit(1);
}

else if (cmd === 'autopromote') {
  // Persist autopromote.json {version:1, enabled}. on/off atomic-write under the lock.
  const sub = args[0];
  if (sub === 'status') {
    console.log(readAutopromote().enabled ? 'enabled' : 'disabled');
    process.exit(0);
  }
  if (sub === 'on' || sub === 'off') {
    validateCandidateDirs(config, config._configDir);   // candidate command: dirs must exist
    withLock(DATA, () => writeAtomic(AUTOPROMOTE_PATH, JSON.stringify({ version: 1, enabled: sub === 'on' }, null, 2)));
    console.log(`autopromote ${sub === 'on' ? 'enabled' : 'disabled'}`);
    process.exit(0);
  }
  console.log('usage: autopromote on|off|status');
  process.exit(1);
}

else if (cmd === 'sweep-candidates') {
  // No --write: ZERO writes (validate + print). --write: the WHOLE enumeration under ONE lock;
  // per candidate emit created/rejected events and (if autopromote + unattended-safe + all gates)
  // promote. Exit 0 for ordinary gate failures; nonzero ONLY on an engine exception.
  const write = process.argv.includes('--write');
  const { candidatesDir, projectsDir } = validateCandidateDirs(config, config._configDir);
  const logDirs = resolveLogDirs(config, config._configDir);

  if (!write) {
    const led = loadLedger();
    const max = companionMax();
    const names = readdirSync(candidatesDir).filter(n => n.endsWith('.md') && SLUG_RE.test(n.slice(0, -3))).sort();
    for (const n of names) {
      const slug = n.slice(0, -3);
      const v = validateCandidate({ slug, candidatesDir, projectsDir, logDirs, codebook, ledger: led, days, companionMax: max, bytes: null });
      console.log(v.ok ? `PASS ${slug} (would mint)` : `FAIL ${slug}: ${v.fails.join(', ')}`);
    }
    console.log(`sweep-candidates (dry run): ${names.length} candidate(s), no writes`);
    process.exit(0);
  }

  try {
    let promoted = 0, rejected = 0, blocked = 0, count = 0;
    // The WHOLE enumeration (directory listing, autopromote state, and every per-candidate action)
    // runs inside ONE lock so the critical section is not read before it is held.
    withLock(DATA, () => {
      const auto = readAutopromote().enabled;
      const names = readdirSync(candidatesDir).filter(n => n.endsWith('.md') && SLUG_RE.test(n.slice(0, -3))).sort();
      count = names.length;
      for (const n of names) {
        const slug = n.slice(0, -3);
        const { codebook: cb, ledger, days: d } = loadFresh();
        const bytes = readFileSync(join(candidatesDir, slug + '.md'));
        const sha = sha256(bytes);
        appendEvent({ slug, event: 'created', candidateSha: sha });   // once per {slug,sha}
        const v = validateCandidate({ slug, candidatesDir, projectsDir, logDirs, codebook: cb, ledger, days: d, companionMax: companionMax(), bytes });
        if (!v.ok) {
          appendEvent({ slug, event: 'rejected', candidateSha: sha, gates: v.fails });  // once per {slug,sha,gateset}
          console.log(`rejected ${slug}: ${v.fails.join(', ')}`);
          rejected++;
          continue;
        }
        if (auto && v.meta.safeForUnattended) {
          const r = promoteViaCandidate({ slug, candidatesDir, projectsDir, logDirs, unattended: true });
          if (r.ok) { console.log(`autopromoted ${slug}`); promoted++; }
          else if (r.recovery) { throw new Error(r.error); }
          else { console.log(`autopromote skipped ${slug}: ${(r.fails || []).join(', ')}`); blocked++; }
        } else {
          console.log(`shadow ${slug}: all gates pass${auto ? ' but not unattended-safe (needs human promote)' : ' (autopromote disabled; needs human promote)'}`);
          blocked++;
        }
      }
    });
    console.log(`sweep-candidates: ${count} candidate(s); promoted ${promoted}, rejected ${rejected}, held ${blocked}`);
    process.exit(0);
  } catch (e) {
    console.error(`sweep-candidates ENGINE FAILURE: ${e.message}`);
    process.exit(1);
  }
}

else if (cmd === 'migrate-ledger') {
  // Normalize the ledger to {version:1, entries} with every entry rewritten to the whitelist schema.
  // Idempotent; --dry prints the diff; ABORTS (writes nothing) on a shape it cannot map.
  const dry = process.argv.includes('--dry');
  if (!existsSync(LEDGER_PATH)) { console.log('no ledger file - nothing to migrate'); process.exit(0); }
  const src = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const entries = (src && src.entries && typeof src.entries === 'object') ? src.entries : {};
  const out = { version: 1, entries: {} };
  try {
    for (const [slug, e] of Object.entries(entries)) {
      const status = e && e.status;
      if (!LEDGER_STATUSES.includes(status))
        throw new Error(`slug "${slug}" has unmappable status ${JSON.stringify(status)}`);
      const fields = {
        decided_on: e.decided_on, via: e.via, promote_sha: e.promote_sha,
        baseline_days: e.baseline_days, note: e.note, alias_target: e.alias_target,
        first_ripe_on: e.first_ripe_on, first_sent_on: e.first_sent_on,
      };
      if (status === 'minted' && e.via === 'promote' && !e.promote_sha)
        throw new Error(`slug "${slug}" is minted via:promote but has no promote_sha`);
      if (status === 'aliased' && !e.alias_target)
        throw new Error(`slug "${slug}" is aliased but has no alias_target`);
      out.entries[slug] = buildLedgerEntry(null, status, fields);
    }
  } catch (e) {
    console.error(`migrate-ledger ABORTED (nothing written): ${e.message}`);
    process.exit(1);
  }
  const before = JSON.stringify(src, null, 2), after = serializeLedger(out);
  if (before === after) { console.log('ledger already normalized (no change)'); process.exit(0); }
  if (dry) {
    console.log('migrate-ledger --dry: would rewrite unknowns-ledger.json');
    console.log('--- before ---'); console.log(before);
    console.log('--- after ----'); console.log(after);
    process.exit(0);
  }
  withLock(DATA, () => {
    try { copyFileSync(LEDGER_PATH, LEDGER_PATH + '.bak'); } catch {}
    saveLedgerAtomic(out);
  });
  console.log('migrate-ledger: rewrote unknowns-ledger.json to {version:1, entries} (backup at unknowns-ledger.json.bak)');
}

else if (cmd === 'mark-sent') {
  // Idempotent instrumentation: stamp first_ripe_on/first_sent_on for the given (ripe, in-digest)
  // slugs. first_sent_on only when absent. Called by the sweeper after a confirmed notify.
  const slugs = args.filter(a => !a.startsWith('--'));
  if (!slugs.length) { console.log('usage: mark-sent <slug> [slug...]'); process.exit(0); }
  const stamp = today();
  const changed = withLock(DATA, () => {
    const ledger = loadLedger();
    const done = [];
    let led = ledger;
    for (const slug of slugs) {
      const prev = led.entries[slug];
      const first_ripe_on = prev?.first_ripe_on ?? stamp;
      const first_sent_on = prev?.first_sent_on ?? stamp;                 // set only if absent
      const status = prev?.status ?? 'open';
      const fields = { ...prev, status, first_ripe_on, first_sent_on };   // per-status whitelist re-applied by buildLedgerEntry
      let entry2;
      try { entry2 = buildLedgerEntry(prev, status, fields); }
      catch { continue; }                                                // never break a via:promote entry
      led = { ...led, entries: { ...led.entries, [slug]: entry2 } };
      done.push(slug);
    }
    if (done.length) saveLedgerAtomic(led);
    return done;
  });
  console.log(`mark-sent: stamped ${changed.length}/${slugs.length} (${changed.join(', ') || 'none'})`);
}

else if (cmd === 'selftest-candidates') {
  await runSelftestCandidates();
}

else {
  console.log('commands: check decode where first cooccur window diff gaps backtest drift similar tasteslike color unknowns mint alias dismiss watch decisions autofile promote autopromote sweep-candidates migrate-ledger mark-sent digest');
}
