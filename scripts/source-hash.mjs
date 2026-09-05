#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hash } from '../lib/schema.mjs';
try { console.log(JSON.stringify({ source_hash: hash(readFileSync(process.argv[2])) })); }
catch (e) { console.error(e.message); process.exitCode = 1; }
