#!/usr/bin/env node
// Owner terminal only. Do not add this launcher or its API to agent workflows.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../validate.mjs';
import { Memory } from '../lib/memory.mjs';
import { startReviewServer } from '../lib/preference-owner.mjs';
let memory;
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Owner review requires stdin and stdout TTY; agents must not launch it.');
  memory = new Memory(loadConfig(resolve(dirname(fileURLToPath(import.meta.url)),'..')));
  const {server,port,token} = await startReviewServer(memory);
  process.stdout.write(`Open in your browser: http://127.0.0.1:${port}/#${token}\nCtrl+C stops owner review.\n`);
  const stop = () => { server.closeAllConnections(); server.close(() => { memory.close(); }); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
} catch (e) { memory?.close(); console.error(e.message); process.exitCode=1; }
