#!/usr/bin/env node
// tastebud-read — read-only MCP server exposing Tastebud fingerprints to your agent.
// Register with any MCP-capable agent platform, e.g.:
//   {"command": "node", "args": ["/path/to/tastebud-memory/mcp-server/server.mjs"]}
// All tools shell out to tastebud.mjs, which never writes anything.

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tastebud.mjs');

const TOOLS = [
  { name: 'tastebud_decode', description: 'Taste a day: decompose one daily log into its weighted project composition without reading the log. Args: date (YYYY-MM-DD).', args: ['date'], schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'] } },
  { name: 'tastebud_where', description: 'Exhaustively list every day a project appears (major with weight, or minor). Args: slug.', args: ['slug'], schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'tastebud_first', description: 'First mention, first major, last mention and day count for a project slug (alias-proof origin lookup).', args: ['slug'], schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'tastebud_cooccur', description: 'Days where two projects were both major. Args: a, b (slugs).', args: ['a', 'b'], schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } },
  { name: 'tastebud_window', description: 'Aggregate project composition over a date range. Args: from, to (YYYY-MM-DD).', args: ['from', 'to'], schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'tastebud_gaps', description: 'Workstreams that appear in daily logs but have no project file, ranked by activity mass. No args.', args: [], schema: { type: 'object', properties: {} } },
  { name: 'tastebud_tasteslike', description: 'For an (unknown) ingredient slug: who it keeps company with and which known projects have similar taste-profiles.', args: ['slug'], schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'tastebud_similar', description: 'Nearest days to a given day by fingerprint similarity. Args: date (YYYY-MM-DD).', args: ['date'], schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } },
];

function runEngine(cmd, argv) {
  const r = spawnSync('node', [ENGINE, cmd, ...argv], { encoding: 'utf8', timeout: 30000 });
  if (r.error) return `tastebud error: ${r.error.message}`;
  return (r.stdout || '') + (r.stderr ? `\n[stderr] ${r.stderr}` : '');
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const replyErr = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize')
    reply(id, { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tastebud-read', version: '1.0.0' } });
  else if (method?.startsWith('notifications/')) { /* no response to notifications */ }
  else if (method === 'tools/list')
    reply(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
  else if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return replyErr(id, -32602, `unknown tool ${params?.name}`);
    const cmd = tool.name.replace('tastebud_', '');
    const argv = tool.args.map(a => String(params?.arguments?.[a] ?? ''));
    reply(id, { content: [{ type: 'text', text: runEngine(cmd, argv) }], isError: false });
  }
  else if (id !== undefined) replyErr(id, -32601, `method ${method} not supported`);
});
