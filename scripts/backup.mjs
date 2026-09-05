#!/usr/bin/env node
// One portable bundle: consistent SQLite snapshot, source revisions, identities, JSON stores,
// candidates and configured pending queues. Restore creates a NEW workspace, never overwrites one.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../validate.mjs';
import { Memory } from '../lib/memory.mjs';
import { hash } from '../lib/schema.mjs';
import { acquire, release, writeAtomic } from '../lock.mjs';

const [command, target, destination] = process.argv.slice(2);
let memory;
try {
  if (command === 'create') {
    if (!target || existsSync(target)) throw new Error('provide a new backup bundle filename');
    const config = loadConfig(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    memory = new Memory(config);
    const data = resolve(config._configDir, config.dataDir), files = [], snapshot = resolve(target + '.sqlite-tmp');
    acquire(data);
    try {
      await memory.backup(snapshot);
      const add = (path, name) => { const bytes = readFileSync(path); files.push({ path: name, hash: hash(bytes), base64: bytes.toString('base64') }); };
      add(snapshot, 'data/memory.sqlite');
      const walk = async (path, prefix) => {
        if (!existsSync(path)) return;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const source = join(path, entry.name), name = join(prefix, entry.name).split(sep).join('/');
          if (entry.isDirectory() && !entry.name.startsWith('.') && !['review-20260905'].includes(entry.name)) await walk(source, name);
          else if (entry.isFile() && !/\.sqlite(?:-wal|-shm)?$|\.bak$|\.tmp$|\.log$/.test(entry.name) && /\.(json|jsonl|md)$/.test(entry.name)) add(source, name);
          else if (entry.isFile() && entry.name.endsWith('.sqlite') && source !== memory.file) {
            const db = new DatabaseSync(source, { readOnly: true }); const temp = snapshot + '-' + files.length;
            try { await backup(db, temp); add(temp, name); } finally { db.close(); if (existsSync(temp)) rmSync(temp); }
          }
        }
      };
      await walk(data, 'data');
      if (config.candidatesDir) await walk(resolve(config._configDir, config.candidatesDir), 'candidates');
      for (const path of config.backupPaths ?? []) {
        const abs = resolve(config._configDir, path), rel = relative(memory.root, abs);
        if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('backup paths must be inside workspace');
        await walk(abs, rel);
      }
      const bundle = { version: 1, created_at: new Date().toISOString(), workspace_id: memory.workspace, source_root: memory.root, config, files };
      writeAtomic(resolve(target), JSON.stringify(bundle));
      writeAtomic(resolve(target) + '.manifest.json', JSON.stringify({ ...bundle, config: undefined, files: files.map(({ base64, ...f }) => f), bundle_hash: hash(readFileSync(target)) }, null, 2));
      console.log(JSON.stringify({ path: resolve(target), files: files.length, hash: hash(readFileSync(target)) }));
    } finally { release(data); if (existsSync(snapshot)) rmSync(snapshot); }
  } else if (command === 'restore') {
    if (!destination || existsSync(destination)) throw new Error('restore destination must not exist');
    const bundle = JSON.parse(readFileSync(target, 'utf8'));
    if (bundle.version !== 1 || !Array.isArray(bundle.files)) throw new Error('unsupported bundle');
    const manifest = JSON.parse(readFileSync(target + '.manifest.json', 'utf8'));
    if (hash(readFileSync(target)) !== manifest.bundle_hash) throw new Error('bundle hash mismatch');
    const root = resolve(destination);
    // Validate every entry before creating any files.
    for (const f of bundle.files) {
      if (typeof f.path !== 'string' || resolve(root, f.path) === root || !resolve(root, f.path).startsWith(root + sep) || hash(Buffer.from(f.base64, 'base64')) !== f.hash) throw new Error('invalid bundle path or hash');
    }
    for (const f of bundle.files) { const path = resolve(root, f.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(f.base64, 'base64')); }
    const config = { ...bundle.config, _configDir: root, workspaceDir: '.', dataDir: './data', memoryDb: './data/memory.sqlite', candidatesDir: './candidates', projectRoots: {}, transcriptRoots: [], backupPaths: [] };
    memory = new Memory(config);
    for (const row of memory.db.prepare('SELECT s.path,v.content FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.current_hash=v.hash').all()) {
      const path = resolve(root, row.path);
      if (!path.startsWith(root + sep)) throw new Error('source path escapes restore');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, row.content);
    }
    const relocate = path => './' + relative(bundle.source_root, resolve(bundle.config._configDir, path)).split(sep).join('/');
    config.logDirs = (bundle.config.logDirs ?? []).map(relocate);
    config.projectsDir = bundle.config.projectsDir ? relocate(bundle.config.projectsDir) : './projects';
    config.memorySourceDirs = (bundle.config.memorySourceDirs ?? []).map(relocate);
    for (const path of [config.candidatesDir, config.projectsDir, ...config.logDirs]) mkdirSync(resolve(root, path), { recursive: true });
    const cbPath = join(root, 'data/codebook.json');
    if (existsSync(cbPath)) { const cb = JSON.parse(readFileSync(cbPath)); for (const p of Object.values(cb.projects)) if (p.document_path) p.document_path = relocate(p.document_path); writeAtomic(cbPath, JSON.stringify(cb, null, 2)); }
    writeAtomic(join(root, 'tastebud.config.json'), JSON.stringify(config, null, 2));
    const integrity = memory.health().integrity;
    if (integrity !== 'ok') throw new Error('restored database integrity failed');
    console.log(JSON.stringify({ restored: root, workspace_id: memory.workspace, integrity, files_verified: bundle.files.length }));
  } else throw new Error('usage: backup.mjs create BUNDLE | restore BUNDLE NEW_DIRECTORY');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { memory?.close(); }
