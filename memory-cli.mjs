#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadData } from './validate.mjs';
import { aliasIndex } from './lib/schema.mjs';
import { Memory } from './lib/memory.mjs';
import { exactQuery } from './lib/exact.mjs';
import { ingest } from './lib/ingest.mjs';
import { writeAtomic } from './lock.mjs';

const config = loadConfig(dirname(fileURLToPath(import.meta.url)));
const [command, ...args] = process.argv.slice(2);
let memory;
try {
  const data = resolve(config._configDir, config.dataDir ?? './examples');
  memory = new Memory(config, { readonly: ['brief', 'search', 'history', 'health'].includes(command) });
  let result;
  if (command === 'sync') {
    const { codebook } = loadData(data, config.legacyRows ?? {});
    let projects = 0, sources = 0, changed = 0;
    const names = aliasIndex(codebook);
    const registrations = [];
    for (const [slug, p] of Object.entries(codebook.projects)) {
      if (p.canonical_slug) continue;
      const path = p.document_path ? resolve(config._configDir, p.document_path) : config.projectsDir ? join(resolve(config._configDir, config.projectsDir), slug + '.md') : null;
      registrations.push({ slug, aliases: [...names].filter(([, canonical]) => canonical === slug).map(([name]) => name), document_path: path && existsSync(path) ? relative(memory.root, path).split('\\').join('/') : null }); projects++;
    }
    memory.syncProjects(registrations);
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) walk(join(path, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const r = memory.captureSource(join(path, entry.name), /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name) ? 'daily' : 'document');
          sources++; if (r.changed) changed++;
        }
      }
    };
    for (const dir of config.memorySourceDirs ?? []) walk(resolve(config._configDir, dir));
    result = { projects, sources, changed, health: memory.health().integrity };
  } else if (command === 'brief') result = memory.brief({ project: args[0], task: args[1] ?? '', budget: Number(args[2] ?? 1600), as_of: args[3] });
  else if (command === 'search') result = memory.search(args.join(' '));
  else if (command === 'history') result = memory.history(args[0]);
  else if (command === 'health') result = memory.health();
  else if (command === 'record') result = memory.record(JSON.parse(readFileSync(args[0] ?? 0, 'utf8')), process.env.TASTEBUD_PRODUCER ?? 'local-operator');
  else if (command === 'source') result = memory.captureSource(args[0]);
  else if (command === 'relocate') result = memory.relocateSource(args[0], args[1]);
  else if (command === 'archive') result = memory.archive(args[0]);
  else if (command === 'backup') {
    result = await memory.backup(args[0]);
    writeAtomic(args[0] + '.manifest.json', JSON.stringify(result, null, 2));
  } else if (command === 'coverage') {
    const { codebook, comps } = loadData(data, config.legacyRows ?? {});
    result = exactQuery(config, codebook, comps, 'coverage');
  } else if (command === 'ingest') {
    result = ingest({ data, date: args[0], raw: JSON.parse(readFileSync(args[1], 'utf8')), sourcePath: args[2], write: args.includes('--write'), revise: args.includes('--revise'), producer: process.env.TASTEBUD_PRODUCER ?? 'local-operator', legacyRows: config.legacyRows ?? {} });
  } else throw new Error('commands: sync | brief PROJECT [TASK] [BUDGET] [AS_OF] | search QUERY | history PROJECT | health | record [FILE] | source PATH | archive SOURCE_ID | backup PATH | coverage | ingest DATE PROPOSAL SOURCE [--write] [--revise]');
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(`tastebud: ${e.message}`); process.exitCode = 1; }
finally { memory?.close(); }
