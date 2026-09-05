import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, openSync, closeSync, fsyncSync, realpathSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { writeFully, withLock } from '../lock.mjs';
import { hash } from './schema.mjs';

// Legacy JSONL producers retain their append target forever. Receipts replace merge-back and
// queue deletion, eliminating races with arrivals and producers that already hold an open fd.
// New clients should use the SQLite event API. Archive these journals through a coordinated
// producer cutover, never by truncating the live file during an applier pass.
export function applyOutbox(root, { dry = false, afterSnapshot, retryIds = [] } = {}) {
  root = resolve(root);
  const dir = join(root, 'telemetry');
  if (!existsSync(dir)) return { applied: 0, pending: 0, deadletters: 0, malformed: 0 };
  const run = () => {
    const dbPath = join(dir, 'memory-intents.receipts.sqlite');
    const db = (!dry || existsSync(dbPath)) ? new DatabaseSync(dbPath, { readOnly: dry }) : null;
    if (!dry) db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failures(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,error TEXT NOT NULL,dead INTEGER NOT NULL DEFAULT 0);`);
    if (!dry) for (const id of retryIds) db.prepare('UPDATE failures SET attempts=0,dead=0 WHERE id=?').run(id);
    const bodyPresent = (current, body) => {
      const haystack='\n'+current.replaceAll('\r\n','\n')+'\n', needle=body.replaceAll('\r\n','\n');
      return haystack.includes('\n'+needle+'\n') || haystack.includes('\n- '+needle+'\n');
    };
    const result = { applied: 0, already_applied: 0, pending: 0, deadletters: 0, malformed: 0, dry };
    try {
      const lines = [];
      for (const name of ['memory-intents.sending.jsonl', 'memory-intents.jsonl']) {
        const path = join(dir, name);
        if (!existsSync(path)) continue;
        const bytes = readFileSync(path, 'utf8'), last = bytes.lastIndexOf('\n');
        if (bytes.slice(last + 1).trim()) result.malformed++;
        lines.push(...bytes.slice(0, last + 1).split('\n').filter(s => s.trim()));
      }
      afterSnapshot?.(); // deterministic concurrency test seam; never supplied by the CLI
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); if (typeof rec?.id !== 'string' || !rec.id.trim()) throw new Error(); }
        catch { result.malformed++; continue; }
        const body = (Array.isArray(rec.body) ? rec.body : [rec.body]).map(b => typeof b === 'string' ? b.trim() : '').filter(Boolean);
        const digest = hash({ id: rec.id, kind: rec.kind, target: rec.target, body });
        const receipt = db?.prepare('SELECT * FROM receipts WHERE id=?').get(rec.id);
        if (receipt && receipt.payload_hash === digest) { result.already_applied++; continue; }
        const old = db?.prepare('SELECT * FROM failures WHERE id=?').get(rec.id);
        if (old?.dead) continue;
        try {
          if (receipt) throw new Error('intent ID reused with different body');
          if (!['create', 'update'].includes(rec.kind)) throw new Error('kind must be create/update');
          if (!body.length) throw new Error('empty body');
          if (typeof rec.target !== 'string' || !/^memory\/[a-z0-9-]+\/.+\.md$/.test(rec.target) || rec.target.split('/').includes('..')) throw new Error('target must be a Markdown file in a memory subdirectory');
          const target = resolve(root, rec.target);
          const real = realpathSync(existsSync(target) ? target : dirname(target));
          const rel = relative(realpathSync(root), real);
          if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('target escapes workspace');
          if (rec.kind === 'update' && !existsSync(target)) throw new Error('update target missing');
          const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
          const pending = body.filter(b => !bodyPresent(current,b)); // headings/IDs never acknowledge missing body
          if (dry) { result.pending += pending.length > 0 ? 1 : 0; continue; }
          if (pending.length) {
            const fd = openSync(target, 'a');
            try { writeFully(fd, Buffer.from(`\n## Memory outbox (${rec.id.replace(/[\r\n]/g, ' ')})\n${pending.map(b => '- ' + b).join('\n')}\n`)); fsyncSync(fd); } finally { closeSync(fd); }
          }
          const final = readFileSync(target, 'utf8');
          if (!body.every(b => bodyPresent(final,b))) throw new Error('body verification failed');
          db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(rec.id, digest, new Date().toISOString());
          db.prepare('DELETE FROM failures WHERE id=?').run(rec.id);
          result.applied++;
        } catch (e) {
          result.pending++;
          if (!dry) {
            const attempts = (old?.attempts ?? Number(rec.attempts) ?? 0) + 1;
            const count = Number.isFinite(attempts) ? attempts : 1;
            if (count >= 3) {
              appendFileSync(join(dir, 'memory-intents.alerts.jsonl'), JSON.stringify({ id: rec.id, kind: 'memory-intent-deadletter', ts: rec.ts, text: e.message, intent: rec }) + '\n');
            }
            db.prepare('INSERT INTO failures VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,error=excluded.error,dead=excluded.dead').run(rec.id, count, e.message, count >= 3 ? 1 : 0);
          }
        }
      }
      result.deadletters = db?.prepare('SELECT count(*) n FROM failures WHERE dead=1').get().n ?? 0;
      return result;
    } finally { db?.close(); }
  };
  return dry ? run() : withLock(dir, run);
}
