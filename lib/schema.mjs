import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const slugRE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const nameKey = s => String(s).normalize('NFKC').trim().toLowerCase();
export function realDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
export function businessDate(zone = 'UTC', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function aliasIndex(codebook) {
  const index = new Map();
  const canonical = slug => {
    const seen = new Set(); let current = slug;
    while (codebook.projects[current]?.canonical_slug) {
      if (seen.has(current)) throw new Error('project redirect cycle');
      seen.add(current); current = codebook.projects[current].canonical_slug;
      if (!codebook.projects[current]) throw new Error('project redirect target missing');
    }
    return current;
  };
  for (const [slug, project] of Object.entries(codebook.projects ?? {})) {
    if (!slugRE.test(slug)) throw new Error(`invalid project slug: ${slug}`);
    if (!project || typeof project !== 'object' || (project.aliases != null && !Array.isArray(project.aliases))) throw new Error(`invalid project: ${slug}`);
    for (const name of [slug, ...(project.aliases ?? [])]) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f]/.test(name)) throw new Error(`invalid alias for ${slug}`);
      const key = nameKey(name);
      if (index.has(key) && index.get(key) !== canonical(slug)) throw new Error(`alias collision: ${name} (${index.get(key)}, ${slug})`);
      index.set(key, canonical(slug));
    }
  }
  return index;
}
export function validateDay(day, expectedDate) {
  if (!day || !realDate(day.date)) throw new Error('date must be a real YYYY-MM-DD');
  if (expectedDate && day.date !== expectedDate) throw new Error(`date mismatch: expected ${expectedDate}`);
  if (!Array.isArray(day.major) || !Array.isArray(day.minor ?? []) || !Array.isArray(day.new ?? [])) throw new Error(`${day.date}: major/minor/new must be arrays`);
  const seen = new Set();
  let total = 0;
  for (const m of day.major) {
    if (!m || !slugRE.test(m.slug) || typeof m.w !== 'number' || !Number.isFinite(m.w) || m.w <= 0 || m.w > 1) throw new Error(`${day.date}: invalid major slug/weight`);
    if (seen.has(m.slug)) throw new Error(`${day.date}: duplicate major ${m.slug}`);
    seen.add(m.slug); total += m.w;
  }
  if (day.major.length && Math.abs(total - 1) > .005) throw new Error(`${day.date}: weights sum to ${total}, expected 1 (tolerance .005)`);
  for (const s of day.minor ?? []) {
    if (!slugRE.test(s) || seen.has(s)) throw new Error(`${day.date}: invalid/duplicate/overlapping minor ${s}`);
    seen.add(s);
  }
  if (new Set(day.new ?? []).size !== (day.new ?? []).length || (day.new ?? []).some(s => !slugRE.test(s) || !seen.has(s))) throw new Error(`${day.date}: invalid new slugs`);
  return day;
}
export function validateDataset(cb, comps, legacyRows = {}) {
  aliasIndex(cb);
  if (!Array.isArray(comps.days)) throw new Error('compositions.days must be an array');
  const seen = new Set(), warnings = [];
  for (const d of comps.days) {
    if (seen.has(d.date)) throw new Error(`duplicate date: ${d.date}`);
    seen.add(d.date);
    try { validateDay(d); }
    catch (e) {
      if (legacyRows[d.date] !== hash(d)) throw e;
      warnings.push(`legacy row ${d.date}: ${e.message}`);
    }
  }
  return warnings;
}
