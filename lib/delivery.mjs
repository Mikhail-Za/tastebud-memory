import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hash } from './schema.mjs';
import { withLock } from '../lock.mjs';

// At-least-once transport. A lost acknowledgment may cause a retry; transports can deduplicate
// with {id}. Successful exit is the default acknowledgment contract; configure a receipt pattern
// for transports that can exit successfully without delivering.
export function deliver(config, data, message) {
  return withLock(data, () => {
    const db = new DatabaseSync(join(data, 'delivery.sqlite'));
    try {
      db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,message TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,ack TEXT,created_at TEXT NOT NULL);`);
      const id = hash(message);
      db.prepare('INSERT OR IGNORE INTO deliveries(id,message,created_at) VALUES (?,?,?)').run(id, message, new Date().toISOString());
      if (!Array.isArray(config.notifyArgs) || !config.notifyArgs.length) return { ok: false, reason: 'no-transport', pending: db.prepare('SELECT count(*) n FROM deliveries WHERE ack IS NULL').get().n };
      for (const row of db.prepare('SELECT * FROM deliveries WHERE ack IS NULL ORDER BY created_at LIMIT 20').all()) {
        const argv = config.notifyArgs.map(a => a === '{message}' ? row.message : a === '{id}' ? row.id : a);
        const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
        const receipt = config.notifyAckPattern ? new RegExp(config.notifyAckPattern).exec(result.stdout ?? '')?.[0] : result.status === 0 ? 'exit-0' : null;
        db.prepare('UPDATE deliveries SET attempts=attempts+1,ack=? WHERE id=?').run(!result.error && result.status === 0 && receipt ? receipt : null, row.id);
      }
      return { ok: !!db.prepare('SELECT ack FROM deliveries WHERE id=?').get(id)?.ack, pending: db.prepare('SELECT count(*) n FROM deliveries WHERE ack IS NULL').get().n };
    } finally { db.close(); }
  });
}
