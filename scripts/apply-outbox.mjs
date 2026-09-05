#!/usr/bin/env node
import { applyOutbox } from '../lib/outbox.mjs';
const root = process.env.MEMORY_OUTBOX_ROOT;
if (!root) { console.error('MEMORY_OUTBOX_ROOT is required'); process.exit(1); }
try {
  const result = applyOutbox(root, { dry: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(result));
  if (result.deadletters || result.malformed || result.pending) process.exitCode = 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
