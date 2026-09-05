import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../lock.mjs';
import { aliasIndex, nameKey, validateDay, validateDataset, hash } from './schema.mjs';

export function parseProposal(raw, date, codebook) {
  validateDay({ ...raw, date: raw.date ?? date }, date);
  const aliases = aliasIndex(codebook), canon = s => aliases.get(nameKey(s)) ?? s;
  const proposal = { date, major: raw.major.map(m => ({ slug: canon(m.slug), w: m.w })), minor: (raw.minor ?? []).map(canon), new: (raw.new ?? []).map(canon) };
  validateDay(proposal, date); // alias normalization must not create hidden duplicate weights
  return proposal;
}

// Source bytes and proposals are retained before acknowledgment; a retry with the same input is
// idempotent. Replacement requires an explicit revision and carries the old composition forward.
export function ingest({ data, date, raw, sourcePath, producer = 'inbox-unverified', write = false, revise = false, legacyRows = {} }) {
  const apply = () => {
    const cb = JSON.parse(readFileSync(join(data, 'codebook.json'), 'utf8'));
    const path = join(data, 'compositions.json');
    const comps = JSON.parse(readFileSync(path, 'utf8'));
    validateDataset(cb, comps, legacyRows);
    const parsed = parseProposal(raw, date, cb), bytes = readFileSync(sourcePath), source_hash = hash(bytes);
    if (raw.source_hash && raw.source_hash !== source_hash) throw new Error('proposal source hash differs from the current log; retag the changed source');
    const old = comps.days.find(d => d.date === date);
    if (old && !revise) return { status: old.source_hash === source_hash ? 'current' : 'needs-review', date, source_hash, previous_hash: old.source_hash ?? null };
    const entry = { ...parsed, flags: ['nightly', producer], provenance: { producer, asserted_source: raw.source ?? null, trust: 'agent-proposal' }, oneline: String(raw.oneline ?? '').slice(0, 200), source_hash, source_path: sourcePath, revision: (old?.revision ?? 0) + 1 };
    if (!write) return { status: 'dry-run', entry };
    const versions = join(data, 'source-versions'), proposals = join(data, 'proposals'), revisions = join(data, 'composition-revisions');
    for (const dir of [versions, proposals, revisions]) mkdirSync(dir, { recursive: true });
    writeAtomic(join(versions, source_hash + '.md'), bytes);
    writeAtomic(join(proposals, `${date}-${hash(raw)}.json`), JSON.stringify({ producer, raw, source_hash }, null, 2));
    if (old) writeAtomic(join(revisions, `${date}-${hash(old)}.json`), JSON.stringify(old, null, 2));
    comps.days = [...comps.days.filter(d => d.date !== date), entry].sort((a, b) => a.date.localeCompare(b.date));
    writeAtomic(path, JSON.stringify(comps, null, 1));
    return { status: old ? 'revised' : 'ingested', entry };
  };
  return write ? withLock(data, apply) : apply();
}
