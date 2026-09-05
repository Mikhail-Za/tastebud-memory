import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { aliasIndex, nameKey, realDate, hash } from './schema.mjs';
import { resolveLog, resolveLogDirs } from '../validate.mjs';

export function exactQuery(config, cb, comps, command, args = []) {
  const aliases = aliasIndex(cb), canonical = s => aliases.get(nameKey(s)) ?? s;
  const days = comps.days.map(d => {
    const weights = new Map();
    for (const m of d.major) weights.set(canonical(m.slug), (weights.get(canonical(m.slug)) ?? 0) + m.w);
    return { ...d, major: [...weights].map(([slug, w]) => ({ slug, w })), minor: [...new Set((d.minor ?? []).map(canonical))].filter(s => !weights.has(s)) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const logs = resolveLogDirs(config, config._configDir);
  const date = s => { if (!realDate(s)) throw new Error(`invalid date: ${s}`); return s; };
  const hits = s => days.filter(d => d.major.some(m => m.slug === s) || d.minor.includes(s));
  const coverage = () => {
    const dates = [...new Set(logs.flatMap(dir => readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map(n => n.slice(0, 10))))].sort();
    return dates.map(day => {
      const r = resolveLog(logs, day), row = comps.days.find(d => d.date === day);
      return { date: day, status: !r.ok ? r.reason : !row ? 'untagged' : !row.source_hash ? 'unverified' : row.source_hash !== hash(readFileSync(r.path)) ? 'changed' : 'current', ...(r.ok ? { path: r.path } : {}) };
    }).concat(comps.days.filter(d => !dates.includes(d.date)).map(d => ({ date: d.date, status: 'missing-source' })));
  };
  const window = (from, to) => {
    date(from); date(to); if (from > to) throw new Error('from must be <= to');
    const selected = days.filter(d => d.date >= from && d.date <= to), weights = new Map();
    for (const d of selected) for (const m of d.major) weights.set(m.slug, (weights.get(m.slug) ?? 0) + m.w);
    const active = selected.filter(d => d.major.length).length;
    return { from, to, days: selected.length, active_days: active, projects: [...weights].map(([slug, mass]) => ({ slug, mass, mean: mass / (active || 1) })).sort((a, b) => b.mass - a.mass), coverage: coverage().filter(r => r.date >= from && r.date <= to) };
  };
  if (command === 'project') {
    if (!args[0]) throw new Error('project required');
    const slug=canonical(args[0]), entry=cb.projects[slug];
    if (!entry) throw new Error('unknown project');
    const path=entry.document_path?resolve(config._configDir,entry.document_path):config.projectsDir?join(resolve(config._configDir,config.projectsDir),slug+'.md'):null;
    return {slug,queried_as:args[0],document_path:path,document_exists:!!path&&existsSync(path),aliases:[...aliases].filter(([,s])=>s===slug).map(([a])=>a)};
  }
  if (command === 'coverage') return { rows: coverage() };
  if (command === 'decode') {
    date(args[0]);
    const row = days.find(d => d.date === args[0]);
    return { status: row ? 'tagged' : 'not-tagged', day: row ?? null, coverage: coverage().find(r => r.date === args[0]) ?? { date: args[0], status: 'no-source' } };
  }
  if (command === 'where' || command === 'first') {
    if (!args[0]) throw new Error('project required');
    const slug = canonical(args[0]), rows = hits(slug);
    return { slug, queried_as: args[0], first: rows[0]?.date ?? null, first_major: rows.find(d => d.major.some(m => m.slug === slug))?.date ?? null, last: rows.at(-1)?.date ?? null, count: rows.length, ...(command === 'where' ? { rows } : {}) };
  }
  if (command === 'cooccur') {
    if (!args[0] || !args[1]) throw new Error('two projects required');
    const [a, b] = args.map(canonical);
    return { a, b, rows: days.filter(d => d.major.some(m => m.slug === a) && d.major.some(m => m.slug === b)) };
  }
  if (command === 'window') return window(...args);
  if (command === 'diff') {
    const a = window(args[0], args[1]), b = window(args[2], args[3]);
    return { a, b, changes: [...new Set([...a.projects, ...b.projects].map(p => p.slug))].map(slug => ({ slug, before: a.projects.find(p => p.slug === slug)?.mean ?? 0, after: b.projects.find(p => p.slug === slug)?.mean ?? 0 })) };
  }
  if (command === 'gaps') return { rows: [...new Set(days.flatMap(d => d.major.map(m => m.slug)))].map(slug => {
    const doc = cb.projects[slug]?.document_path;
    const path = doc ? resolve(config._configDir, doc) : config.projectsDir ? join(resolve(config._configDir, config.projectsDir), slug + '.md') : null;
    return { slug, path, exists: !!path && existsSync(path), count: hits(slug).length };
  }).filter(r => !r.exists).sort((a, b) => b.count - a.count) };
  throw new Error(`unsupported exact query: ${command}`);
}
