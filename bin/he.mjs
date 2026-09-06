#!/usr/bin/env node
// Standalone CLI over the same worker operations. Mechanical only: it never calls a model.
// Paid passes (bootstrap/review) need a pi session: run /he bootstrap there.
import { runJob } from '../src/jobs.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const [verb = 'help', ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 1)[0] : undefined; };
const global = !!flag('--global');
const projectFlag = rest.indexOf('--project'); const project = resolve(projectFlag >= 0 ? rest.splice(projectFlag, 2)[1] : process.cwd());
const globalDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'human-expectations');
const roots = [join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'sessions')];
const job = data => runJob({ ...data, project, globalDir });
const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const help = `human-expectations — shared project memory of what the human expects (mechanical CLI)

  he status                      intake, pending, expectations, last error
  he report [session-id|this]    print the outcome overview (or one session's verification activity)
  he collect [transcript.jsonl]  read new transcript text for this project; no inference
  he on [minutes] [--global] [--backfill none|session|all]
  he off [--global]
  he split | he single           overview + detail files, or one report file
  he source <session/entry>      show one captured input with its context
  he bootstrap                   (needs a pi session: run "/he bootstrap" inside pi — it makes model requests)

Options: --project <dir> (default: current directory). Records live in <project>/.human-expectations/ as Markdown.`;
try {
  if (verb === 'help' || verb === '--help' || verb === '-h') print(help);
  else if (verb === 'status') print(await job({ op: 'status' }));
  else if (verb === 'report') {
    const session = rest[0];
    const r = await job({ op: 'report', session });
    print(session ? r.sessionActivity : await readFile(r.report, 'utf8'));
  } else if (verb === 'collect') print(await job({ op: 'scan', ...(rest[0] ? { files: [resolve(rest[0])] } : { roots }) }));
  else if (verb === 'on' || verb === 'off') {
    const b = rest.indexOf('--backfill'); const backfill = b >= 0 ? rest.splice(b, 2)[1] : undefined;
    print(await job({ op: 'configure', enabled: verb === 'on', minutes: rest[0] ? Number(rest[0]) : 30, scope: global ? 'global' : 'project', backfill }));
  } else if (verb === 'split' || verb === 'single') print(await job({ op: 'layout', split: verb === 'split' }));
  else if (verb === 'source') print(await job({ op: 'source', ref: rest[0] }));
  else if (verb === 'bootstrap' || verb === 'review') { console.error('This pass makes model requests and needs a pi session: open pi in the project and run /he ' + verb); process.exit(2); }
  else { console.error(`Unknown verb "${verb}"\n\n${help}`); process.exit(2); }
} catch (error) { console.error(String(error?.message || error)); process.exit(1); }
