// Portable continuity store. Immutable evidence and event receipts are the source of truth;
// summaries, search indexes, and bounded briefs are rebuildable views.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, nameKey, slugRE } from './schema.mjs';
import { Preferences } from './preferences.mjs';

const KINDS = ['fact', 'decision', 'constraint', 'preference', 'failure', 'lesson', 'outcome', 'summary'];
const iso = (value = new Date().toISOString()) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('valid ISO timestamp required');
  return new Date(value).toISOString();
};
const text = (value, label, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text (max ${max})`);
  return value.trim();
};

export class Memory {
  constructor(config, { readonly = false } = {}) {
    this.config = config;
    this.root = resolve(config._configDir, config.workspaceDir ?? '.');
    this.file = resolve(config._configDir, config.memoryDb ?? `${config.dataDir ?? './examples'}/memory.sqlite`);
    this.workspace = config.workspaceId;
    if (!this.workspace || !/^[a-z0-9-]{3,100}$/.test(this.workspace)) throw new Error('configure a stable workspaceId (independent of the filesystem path)');
    if (!readonly) mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file, { readOnly: readonly });
    this.db.exec('PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;');
    if (!readonly) {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,slug TEXT UNIQUE NOT NULL,document_path TEXT);
        CREATE TABLE IF NOT EXISTS aliases(name TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id));
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,current_hash TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS source_versions(source_id TEXT REFERENCES sources(id),hash TEXT,content TEXT NOT NULL,captured_at TEXT NOT NULL,PRIMARY KEY(source_id,hash));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,producer TEXT NOT NULL,session TEXT NOT NULL,project_id TEXT REFERENCES projects(id),type TEXT NOT NULL,occurred_at TEXT NOT NULL,recorded_at TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,supersedes TEXT REFERENCES claims(id),valid_until TEXT,event_id TEXT UNIQUE REFERENCES events(id));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,owner TEXT,dependencies TEXT NOT NULL,next_action TEXT,outcome TEXT,due_at TEXT,event_id TEXT UNIQUE REFERENCES events(id));
        CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,claim_id TEXT REFERENCES claims(id),outcome TEXT NOT NULL,note TEXT,event_id TEXT UNIQUE REFERENCES events(id));
        CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,hash UNINDEXED,content);
        CREATE INDEX IF NOT EXISTS events_project_time ON events(project_id,recorded_at);
        CREATE INDEX IF NOT EXISTS claims_project ON claims(project_id);
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id,id);
      `);
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('version', '1');
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('workspace_id', this.workspace);
    }
    if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('workspace_id')?.value !== this.workspace) throw new Error('workspace identity mismatch; use an explicit migration');
    if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('version')?.value !== '1') throw new Error('unsupported memory schema');
    this.policy = new Preferences(this, readonly);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  project(name) {
    const row = this.db.prepare('SELECT p.* FROM projects p JOIN aliases a ON p.id=a.project_id WHERE a.name=?').get(nameKey(name));
    if (!row) throw new Error(`unknown project: ${name}`);
    return row;
  }
  registerProject({ slug, aliases = [], document_path = null }) {
    return this.transaction(() => this._registerProject({ slug, aliases, document_path }));
  }
  // A codebook sync owns the complete alias set for these projects. Reconcile the
  // whole batch atomically so removals and transfers do not depend on row order.
  syncProjects(projects) {
    return this.transaction(() => {
      const slugs = new Set();
      for (const p of projects) {
        if (slugs.has(p.slug)) throw new Error(`duplicate project: ${p.slug}`);
        slugs.add(p.slug);
        this.db.prepare('DELETE FROM aliases WHERE project_id IN (SELECT id FROM projects WHERE slug=?)').run(p.slug);
      }
      return projects.map(p => {
        const row = this._registerProject(p);
        this.db.prepare('UPDATE projects SET document_path=? WHERE id=?').run(p.document_path ?? null, row.id);
        return { ...row, document_path: p.document_path ?? null };
      });
    });
  }
  _registerProject({ slug, aliases = [], document_path = null }) {
    if (!slugRE.test(slug) || slug.length > 80) throw new Error('invalid project slug');
      let row = this.db.prepare('SELECT * FROM projects WHERE slug=?').get(slug);
      if (!row) {
        row = { id: randomUUID(), slug, document_path };
        this.db.prepare('INSERT INTO projects VALUES (?,?,?)').run(row.id, slug, document_path);
      } else if (document_path) this.db.prepare('UPDATE projects SET document_path=? WHERE id=?').run(document_path, row.id);
      for (const name of [slug, ...aliases]) {
        const key = nameKey(text(name, 'alias', 200));
        const old = this.db.prepare('SELECT project_id FROM aliases WHERE name=?').get(key);
        if (old && old.project_id !== row.id) throw new Error(`alias collision: ${name}`);
        this.db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)').run(key, row.id);
      }
      return row;
  }
  safePath(path) {
    const abs = resolve(this.root, text(path, 'path', 1000));
    const rel = relative(realpathSync(this.root), realpathSync(abs));
    if (rel.startsWith('..' + sep) || rel === '..' || resolve(abs) === resolve(this.file)) throw new Error('source must be inside the configured workspace');
    if (!statSync(abs).isFile() || !/\.md$/i.test(abs)) throw new Error('source must be a Markdown file');
    return { abs, path: relative(this.root, abs).split(sep).join('/') };
  }
  captureSource(path, kind = 'document') {
    if (!['document', 'daily', 'evidence', 'archive'].includes(kind)) throw new Error('invalid source kind');
    const source = this.safePath(path), content = readFileSync(source.abs, 'utf8');
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('source too large (4 MiB maximum)');
    const sha = hash(content);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM sources WHERE path=?').get(source.path);
      const id = old?.id ?? randomUUID();
      if (!old) this.db.prepare('INSERT INTO sources VALUES (?,?,?,?,0)').run(id, source.path, kind, sha);
      else this.db.prepare('UPDATE sources SET current_hash=? WHERE id=?').run(sha, id);
      const result = this.db.prepare('INSERT OR IGNORE INTO source_versions VALUES (?,?,?,?)').run(id, sha, content, new Date().toISOString());
      if (result.changes) this.db.prepare('INSERT INTO source_fts VALUES (?,?,?)').run(id, sha, content);
      return { source_id: id, hash: sha, path: source.path, changed: !!old && old.current_hash !== sha };
    });
  }
  evidence(items) {
    if (!Array.isArray(items) || items.length > 20) throw new Error('evidence must be an array (max 20)');
    return items.map(e => {
      const row = this.db.prepare('SELECT content FROM source_versions WHERE source_id=? AND hash=?').get(e.source_id, e.hash);
      const quote = text(e.quote, 'evidence quote', 4000);
      if (!row || !row.content.includes(quote)) throw new Error('evidence quote does not match the captured source revision');
      const offset = row.content.indexOf(quote);
      return { source_id: e.source_id, hash: e.hash, quote, line: row.content.slice(0, offset).split('\n').length };
    });
  }
  record(event, producer) {
    text(producer, 'configured producer', 100);
    const id = text(event.id, 'event id', 200), session = text(event.session, 'session', 200);
    const payloadHash = hash(event);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
      if (old) {
        if (old.payload_hash !== payloadHash || old.producer !== producer) throw new Error('event id already used for a different payload or producer');
        return { id, seq: old.seq, acknowledged: true, duplicate: true };
      }
      const project = this.project(event.project), payload = event.payload ?? {};
      const occurred = iso(event.occurred_at), recorded = new Date().toISOString();
      if (occurred > recorded) throw new Error('event occurred_at cannot be in the future');
      if (!['claim', 'task', 'feedback', 'checkpoint', 'preference_proposal', 'preference_use'].includes(event.type)) throw new Error('unsupported event type');
      const insertion = this.db.prepare('INSERT INTO events(id,producer,session,project_id,type,occurred_at,recorded_at,payload,payload_hash) VALUES (?,?,?,?,?,?,?,?,?)').run(id, producer, session, project.id, event.type, occurred, recorded, JSON.stringify(payload), payloadHash);
      if (event.type === 'claim') {
        if (!KINDS.includes(payload.kind)) throw new Error('invalid claim kind');
        const evidence = this.evidence(payload.evidence ?? []), body = text(payload.body, 'claim body');
        const status = evidence.length ? 'supported' : 'proposed';
        if (payload.status && payload.status !== status) throw new Error('claim status is derived from evidence; agents cannot self-approve');
        const supersedes = payload.supersedes ?? null;
        if (supersedes) {
          const prior = this.db.prepare('SELECT * FROM claims WHERE id=?').get(supersedes);
          if (!prior || prior.project_id !== project.id) throw new Error('superseded claim must belong to this project');
          if (status !== 'supported') throw new Error('a correction requires evidence');
          if (this.db.prepare('SELECT id FROM claims WHERE supersedes=?').get(supersedes)) throw new Error('claim already superseded; correct its current revision');
        }
        this.db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run(payload.id ?? id, project.id, payload.kind, body, status, JSON.stringify(evidence), supersedes, payload.valid_until ? iso(payload.valid_until) : null, id);
      } else if (event.type === 'task') {
        const taskId = text(payload.id, 'task id', 200), title = text(payload.title, 'task title', 2000);
        if (!['open', 'blocked', 'done', 'cancelled'].includes(payload.status)) throw new Error('invalid task status');
        if (payload.status === 'done' && !payload.outcome?.trim()) throw new Error('completed tasks require an outcome');
        const prior = this.db.prepare('SELECT * FROM tasks WHERE id=? ORDER BY rowid DESC LIMIT 1').get(taskId);
        if (prior && prior.project_id !== project.id) throw new Error('task belongs to another project');
        if (prior && payload.previous_event_id !== prior.event_id) throw new Error('task changed or previous_event_id missing; reread the brief before updating');
        const dependencies = payload.dependencies ?? (prior ? JSON.parse(prior.dependencies) : []);
        if (payload.status === 'done') for (const dependency of dependencies) {
          const state = this.db.prepare('SELECT status FROM tasks WHERE id=? ORDER BY rowid DESC LIMIT 1').get(dependency);
          if (!state || state.status !== 'done') throw new Error('complete dependencies before this task');
        }
        if (!Array.isArray(dependencies) || dependencies.some(d => typeof d !== 'string' || d === taskId || !this.db.prepare('SELECT id FROM tasks WHERE id=?').get(d))) throw new Error('dependencies must reference existing other tasks');
        const reachesSelf = (id, seen=new Set()) => {
          if (id===taskId) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          const row=this.db.prepare('SELECT dependencies FROM tasks WHERE id=? ORDER BY rowid DESC LIMIT 1').get(id);
          return row ? JSON.parse(row.dependencies).some(next=>reachesSelf(next,seen)) : false;
        };
        if (dependencies.some(id=>reachesSelf(id))) throw new Error('task dependency cycle');
        this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(taskId, project.id, title, payload.status, payload.owner ?? prior?.owner ?? null, JSON.stringify(dependencies), payload.next_action ?? null, payload.outcome ?? null, payload.due_at ? iso(payload.due_at) : null, id);
      } else if (event.type === 'feedback') {
        if (!['useful', 'stale', 'incorrect', 'missed', 'handoff-success', 'handoff-failed'].includes(payload.outcome)) throw new Error('invalid feedback outcome');
        if (payload.claim_id && this.db.prepare('SELECT project_id FROM claims WHERE id=?').get(payload.claim_id)?.project_id !== project.id) throw new Error('feedback claim belongs to another project');
        this.db.prepare('INSERT INTO feedback VALUES (?,?,?,?,?)').run(id, payload.claim_id ?? null, payload.outcome, payload.note ?? null, id);
      } else if (event.type.startsWith('preference_')) this.policy.record(event, project);
      else text(payload.body, 'checkpoint body');
      if (process.env.TASTEBUD_TEST_CRASH === 'before-commit') process.exit(137);
      return { id, seq: Number(insertion.lastInsertRowid), acknowledged: true, duplicate: false };
    });
  }
  search(query, { limit = 8, as_of } = {}) {
    const words = String(query).match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20) ?? [];
    if (!words.length) return [];
    limit = Math.min(50, Math.max(1, Number(limit) || 8));
    const match = words.map(w => '"' + w.replaceAll('"', '""') + '"').join(' OR ');
    return this.db.prepare(`SELECT f.source_id,f.hash,s.path,s.archived,bm25(source_fts) AS score,snippet(source_fts,2,'','', ' … ',48) AS excerpt
      FROM source_fts f JOIN sources s ON s.id=f.source_id JOIN source_versions v ON v.source_id=f.source_id AND v.hash=f.hash
      WHERE source_fts MATCH ? AND v.captured_at<=? AND v.captured_at=(SELECT MAX(v2.captured_at) FROM source_versions v2 WHERE v2.source_id=v.source_id AND v2.captured_at<=?) ORDER BY score LIMIT ?`).all(match, iso(as_of), iso(as_of), limit);
  }
  preferences(args) { return this.policy.view(args); }
  brief({ project: name, task = '', domain, as_of, budget = 1600 }) {
    budget = Number(budget);
    if (!Number.isInteger(budget) || budget < 256 || budget > 16000) throw new Error('budget must be an integer from 256 to 16000');
    const when = iso(as_of), project = this.project(name), words = new Set(String(task).toLowerCase().match(/\w+/g) ?? []);
    const active = this.db.prepare(`SELECT c.*,e.producer,e.recorded_at FROM claims c JOIN events e ON c.event_id=e.id WHERE c.project_id=? AND e.recorded_at<=? AND e.occurred_at<=?
      AND NOT EXISTS(SELECT 1 FROM claims newer JOIN events ne ON newer.event_id=ne.id WHERE newer.supersedes=c.id AND ne.recorded_at<=? AND ne.occurred_at<=?)`).all(project.id, when, when, when, when);
    const claims = active.map(c => {
      const evidence = JSON.parse(c.evidence).map(e => {
        const src = this.db.prepare('SELECT * FROM sources WHERE id=?').get(e.source_id);
        return { ...e, ...(e.quote === c.body ? { quote: undefined, quote_is_body: true } : {}), path: src.path, source_changed: src.current_hash !== e.hash, archived: !!src.archived };
      });
      const negative = this.db.prepare(`SELECT count(*) AS n FROM feedback f JOIN events e ON f.event_id=e.id WHERE f.claim_id=? AND f.outcome IN ('stale','incorrect') AND e.recorded_at<=?`).get(c.id, when).n;
      const score = (['constraint', 'decision', 'failure'].includes(c.kind) ? 20 : 0) + (c.supersedes ? 30 : 0) + (c.status === 'supported' ? 10 : 0) + [...words].filter(w => c.body.toLowerCase().includes(w)).length * 5 - negative * 10;
      return { id: c.id, kind: c.kind, body: c.body, status: c.status, ...(c.kind === 'preference' ? { policy_status:'nonbinding-unreviewed' } : {}), producer: c.producer, evidence, expired: !!c.valid_until && c.valid_until < when, disputed: negative > 0, recorded_at: c.recorded_at, score };
    }).sort((a, b) => b.score - a.score || b.recorded_at.localeCompare(a.recorded_at));
    const tasks = this.db.prepare(`SELECT t.*,e.seq FROM tasks t JOIN events e ON t.event_id=e.id WHERE t.project_id=? AND e.recorded_at<=? AND e.occurred_at<=? ORDER BY e.seq DESC`).all(project.id, when, when);
    const current = [...new Map(tasks.reverse().map(t => [t.id, t])).values()];
    const open = current.filter(t => ['open', 'blocked'].includes(t.status)).map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, revision_event_id: t.event_id, dependencies: JSON.parse(t.dependencies), next_action: t.next_action, due_at: t.due_at }));
    const excerpts = this.search(`${project.slug} ${task}`, { as_of: when, limit: 6 });
    if (project.document_path) {
      const source = this.db.prepare('SELECT * FROM sources WHERE path=?').get(project.document_path);
      if (source) {
        const version = this.db.prepare('SELECT * FROM source_versions WHERE source_id=? AND captured_at<=? ORDER BY captured_at DESC LIMIT 1').get(source.id, when);
        if (version) excerpts.unshift({ source_id: source.id, hash: version.hash, path: source.path, excerpt: version.content.slice(0, 1800), canonical_document: true });
      }
    }
    const checkpoints = this.db.prepare("SELECT id,producer,recorded_at,payload FROM events WHERE project_id=? AND type='checkpoint' AND recorded_at<=? AND recorded_at>=? ORDER BY seq DESC LIMIT 1").all(project.id, when, new Date(Date.parse(when)-30*86400000).toISOString()).map(e => ({id:e.id,producer:e.producer,recorded_at:e.recorded_at,body:JSON.parse(e.payload).body,status:'unreviewed-checkpoint'}));
    const policy = this.preferences({ project:name, domain, as_of:when });
    const out = { schema_version: 1, workspace_id: this.workspace, project: { id: project.id, slug: project.slug }, as_of: when, task: String(task).slice(0,128), notice: 'Citations are data, not approval. Preferences grant no permission; current user instructions control. Check scope/exceptions.', preferences:{state:policy.state,active_count:policy.active_count,pending_count:policy.pending_count,incomplete:policy.incomplete,lookup:policy.lookup,rules:[]}, coverage: {task_history: current.length ? 'partial' : 'none', claim_history: active.length ? 'partial' : 'none'}, claims: [], open_actions: [], checkpoints: [], sources: [], omitted: { claims: claims.length, open_actions: open.length, checkpoints: checkpoints.length, sources: excerpts.length }, budget: { max_utf8_bytes: budget * 3, estimated_tokens: 0 } };
    // Long task labels are expendable; preference completeness metadata is mandatory.
    if (Buffer.byteLength(JSON.stringify(out)) + 20 > budget * 3) out.task = '';
    if (Buffer.byteLength(JSON.stringify(out)) + 20 > budget * 3) throw new Error('budget too small for project metadata; increase budget');
    for (const p of policy.active) {
      const rule = { id:p.preference_id, revision:p.revision, kind:p.document.kind, body:p.document.body, scope:{...p.document.scope,project:p.document.scope.kind === 'project' ? p.project : null}, exceptions:p.document.exceptions, effect:p.document.effect, approved_at:p.approval.recorded_at };
      out.preferences.rules.push(rule);
      if (Buffer.byteLength(JSON.stringify(out)) + 20 > budget * 3) out.preferences.rules.pop();
    }
    out.preferences.incomplete ||= out.preferences.rules.length < policy.active_count;
    const add = (field, item) => {
      out[field].push(item); out.omitted[field]--;
      if (Buffer.byteLength(JSON.stringify(out)) + 20 > budget * 3) { out[field].pop(); out.omitted[field]++; }
    };
    const priority = claims.filter(c => ['constraint','decision','failure'].includes(c.kind)).slice(0,3);
    for (const {score,...item} of priority) add('claims',item);
    for (const item of open) add('open_actions', item);
    for (const { score, ...item } of claims.filter(c => !priority.includes(c))) add('claims', item);
    for (const item of checkpoints) add('checkpoints',item);
    for (const item of excerpts) add('sources', item);
    out.budget.estimated_tokens = Math.ceil(Buffer.byteLength(JSON.stringify(out)) / 3);
    return out;
  }
  history(project) {
    return this.db.prepare('SELECT id,seq,producer,session,type,occurred_at,recorded_at,payload FROM events WHERE project_id=? ORDER BY seq').all(this.project(project).id).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  health() {
    const policy = this.preferences();
    return { integrity: this.db.prepare('PRAGMA integrity_check').get().integrity_check, workspace_id: this.workspace, preferences:{state:policy.state,active_count:policy.active_count,pending_count:policy.pending_count}, counts: Object.fromEntries(['projects', 'sources', 'source_versions', 'events', 'claims', 'tasks', 'feedback', ...(this.policy.ready() ? ['preference_proposals','preference_uses','preference_reviews','preference_launches'] : [])].map(t => [t, this.db.prepare(`SELECT count(*) n FROM ${t}`).get().n])), sources: this.db.prepare('SELECT * FROM sources').all().map(s => {
      const path = resolve(this.root, s.path);
      return { id: s.id, path: s.path, status: !existsSync(path) ? s.archived ? 'archived-in-store' : 'missing-file' : hash(readFileSync(path)) !== s.current_hash ? 'changed' : 'current' };
    }) };
  }
  archive(sourceId) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM sources WHERE id=?').get(sourceId)) throw new Error('unknown source');
      this.db.prepare('UPDATE sources SET archived=1 WHERE id=?').run(sourceId);
      return { source_id: sourceId, archived: true, evidence_retained: true };
    });
  }
  readSource({source_id, hash: revision, offset=0, limit=4000}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) throw new Error('invalid evidence range');
    const row=this.db.prepare('SELECT s.path,s.archived,v.content,v.hash FROM sources s JOIN source_versions v ON s.id=v.source_id WHERE s.id=? AND v.hash=?').get(source_id,revision);
    if (!row) throw new Error('source revision not found');
    return {source_id,hash:row.hash,path:row.path,archived:!!row.archived,offset,content:row.content.slice(offset,offset+limit),next_offset:offset+limit<row.content.length?offset+limit:null};
  }
  relocateSource(sourceId, path) {
    const source = this.safePath(path), digest = hash(readFileSync(source.abs));
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
      if (!old || old.current_hash !== digest) throw new Error('relocation must preserve the current source bytes');
      this.db.prepare('UPDATE sources SET path=? WHERE id=?').run(source.path,sourceId);
      this.db.prepare('UPDATE projects SET document_path=? WHERE document_path=?').run(source.path,old.path);
      return {source_id:sourceId,path:source.path,hash:digest};
    });
  }
  async backup(path) {
    path = resolve(path);
    if (existsSync(path)) throw new Error('backup destination already exists');
    await backup(this.db, path);
    return { path, hash: hash(readFileSync(path)), schema_version: 1, workspace_id: this.workspace };
  }
}
