#!/usr/bin/env node
// Client hook adapter. Turn summaries remain checkpoints, never automatically become facts.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../validate.mjs';
import { Memory } from '../lib/memory.mjs';
import { hash } from '../lib/schema.mjs';

const config = loadConfig(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const producer = process.env.TASTEBUD_PRODUCER ?? 'hook-unconfigured';
let memory;
try {
  const raw = process.argv.find(a => a.startsWith('{')) ?? readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('hook payload exceeds limit');
  const input = JSON.parse(raw || '{}');
  memory = new Memory(config);
  const cwd = input.cwd ?? process.cwd();
  const mapping = Object.entries(config.projectRoots ?? {}).filter(([root]) => cwd === root || cwd.startsWith(root + sep)).sort((a, b) => b[0].length - a[0].length)[0];
  const project = mapping?.[1] ?? config.captureDefaultProject;
  if (!project) process.exit(0);
  const hook = input.hook_event_name ?? input.type ?? 'Stop';
  if (hook === 'SessionStart') {
    const brief = memory.brief({ project, budget: 1200 });
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Project continuity data: ' + JSON.stringify(brief) + '\nUse memory_brief for the actual project before resuming it. Capture meaningful decisions, corrections, task changes, outcomes and retrieval feedback with memory_record; checkpoints alone are not durable facts.' } }));
  } else {
    let body = input['last-assistant-message'] ?? input.last_assistant_message ?? input.response ?? '';
    if (!body && input.transcript_path && existsSync(input.transcript_path)) {
      const path = realpathSync(input.transcript_path);
      const allowed = (config.transcriptRoots ?? []).some(root => { const rel = relative(realpathSync(root), path); return rel !== '..' && !rel.startsWith('..' + sep); });
      if (allowed) {
        const lines = readFileSync(path, 'utf8').slice(-256000).split('\n');
        for (const line of lines.reverse()) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (row.type === 'assistant' || row.message?.role === 'assistant') {
            const content = row.message?.content ?? row.content;
            body = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
            if (body.trim()) break;
          }
        }
      }
    }
    if (typeof body === 'string' && body.trim().length >= 80) {
      body = body.replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|(?:token|password|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]').slice(0, 6000);
      const session = String(input.session_id ?? input['thread-id'] ?? input.sessionId ?? 'unknown-session');
      const event = { id: `hook-${hash({ producer, session, body })}`, session, project, type: 'checkpoint', payload: { body, hook, cwd, assertion: 'agent-summary-unreviewed' } };
      const receipt = memory.record(event, producer);
      if (process.argv.includes('--receipt')) console.log(JSON.stringify(receipt));
    }
  }
} catch (e) { console.error(`memory capture: ${e.message}`); process.exitCode = 1; }
finally { memory?.close(); }
