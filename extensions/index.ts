import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runJob } from '../src/jobs.mjs';
import { decodeOutput } from '../src/output.mjs';
import { consolidationPrompt, tidyPrompt } from '../src/consolidation.mjs';
import { rideInstruction, extractRide, hideRide } from '../src/ride.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Per ridden turn: bookkeeping never exceeds this many source inputs / bytes of appended context.
const RIDE_INPUTS = 6, RIDE_STRUCTURE_BYTES = 40000, DEFAULT_BUDGET_TOKENS = 4000; // ~4 chars per token

export default function humanExpectations(pi: ExtensionAPI) {
  let stopped = false, dirty = false, scheduling = false, enabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<unknown> | undefined;
  let controller: AbortController | undefined;
  const watchers: FSWatcher[] = [];
  // The bookkeeping riding the current turn, if any. Cleared when applied, when the turn settles, or on abort.
  let ride: { kind: 'inputs' | 'structure'; token: string; text: string; batch?: any; input?: any; started: number } | undefined;
  // Session-local observability for the ridden channel: how often it was armed, carried, answered, applied.
  const rides = { armed: 0, carried: 0, answered: 0, applied: 0, rejected: 0, missed: 0 };

  pi.registerFlag('he-project', { type: 'string', description: 'Explicit project to inspect (otherwise current cwd)' });
  const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
  let projectOverride: string | undefined; // set per command by --project <dir>
  const project = (ctx: ExtensionContext) => resolve(String(projectOverride || pi.getFlag('he-project') || ctx.cwd));
  const roots = (ctx: ExtensionContext) => [join(agentDir(), 'sessions'), ctx.sessionManager.getSessionDir()];
  const job = (ctx: ExtensionContext, data: Record<string, unknown>) => {
    if (!ctx.isProjectTrusted()) throw Error('Trust the current project before using human expectations');
    return withFileMutationQueue(join(project(ctx), '.human-expectations/.STATE.md'), () => runJob({ ...data, project: project(ctx), globalDir: join(agentDir(), 'human-expectations') }));
  };
  const compact = (value: unknown) => {
    const part = truncateHead(typeof value === 'string' ? value : JSON.stringify(value, null, 2), { maxBytes: 20000, maxLines: 200 });
    return part.content + (part.truncated ? '\n[Truncated. Full records are in .human-expectations/.STATE.md; source results identify the original transcript and entry.]' : '');
  };
  // Plain text drill-down: outcomes → sub-outcomes → expectation → checks. Only as many levels as the project has.
  const tree = (view: any) => {
    const lines: string[] = [];
    if (view.checks) {
      lines.push(`${view.id} · ${view.title}`, view.intent, `${view.bar} · ${view.kind}`, '');
      for (const c of view.checks) lines.push(`  ${c.verdict === 'passed' ? (c.freshness?.state === 'current' ? '✔' : '◐') : c.verdict === 'failed' ? '✖' : '·'} ${c.id} ${c.obligation}${c.verifiedAt ? ` — ${c.verdict} ${c.verifiedAt.slice(0, 10)}${c.freshness && c.freshness.state !== 'current' ? ` (${c.freshness.state}: ${c.freshness.reason})` : ''}` : ''}`);
      lines.push('', 'Human words:'); for (const s of view.sources.slice(-5)) lines.push(`  ${s.when.slice(0, 10)} "${s.words.slice(0, 160)}"`);
      return lines.join('\n');
    }
    lines.push(view.id ? `${view.id} · ${view.title} — ${view.bar}` : 'Outcomes — verified checks / all checks', '');
    for (const r of view.rows) lines.push(`  ${r.id} · ${r.title}`, `      ${r.bar}${r.kind === 'group' ? ` · ${r.expectations} expectations` : ''} · ${r.unverified} unverified`);
    lines.push('', 'Drill down: /he report <id> · full Markdown: /he report full');
    return lines.join('\n');
  };
  const show = (ctx: ExtensionContext, value: unknown) => pi.sendMessage({ customType: 'human-expectations:report', content: compact(value), display: true }, { triggerTurn: false });

  // ---- Mechanical background: collect appended transcript bytes only. Never inference. ----
  async function collect(ctx: ExtensionContext, file?: string) {
    if (active) throw Error('Expectation update already running in this session');
    active = (async () => {
      const token = randomUUID();
      let claimed = false;
      try {
        await job(ctx, { op: 'claim', token }); claimed = true;
        return await job(ctx, { op: 'scan', ...(file ? { files: [resolve(file)] } : { roots: roots(ctx) }) });
      } finally { if (claimed) await job(ctx, { op: 'release', token }); }
    })();
    try { return await active; } finally { active = undefined; }
  }
  function schedule(ctx: ExtensionContext) {
    if (stopped || !enabled || !dirty || timer || scheduling || active || !['tui', 'rpc'].includes(ctx.mode)) return;
    scheduling = true;
    void job(ctx, { op: 'status' }).then(status => {
      if (!status.enabled || stopped) { enabled = false; stopWatching(); return; }
      const due = status.lastScan ? Date.parse(status.lastScan) + status.minutes * 60000 : 0;
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped || !dirty) return;
        dirty = false;
        void collect(ctx).catch(() => { /* Reported via status; never a notification or turn. */ });
      }, Math.max(1000, due - Date.now()));
      timer.unref();
    }).catch(() => {}).finally(() => { scheduling = false; });
  }
  const mark = (ctx: ExtensionContext) => { if (enabled) { dirty = true; schedule(ctx); } };
  function stopWatching() { for (const watcher of watchers) watcher.close(); watchers.length = 0; }
  function startWatching(ctx: ExtensionContext) {
    if (watchers.length || (ctx.mode !== 'tui' && ctx.mode !== 'rpc')) return;
    for (const path of new Set(roots(ctx))) {
      try {
        const watcher = watch(path, { recursive: true }, (_kind, name) => { if (String(name).endsWith('.jsonl')) mark(ctx); });
        watcher.on('error', () => {}); watchers.push(watcher);
      } catch { /* Session events and resume still catch up if this platform/path cannot be watched. */ }
    }
  }

  // ---- Riding an already-occurring turn: the only automatic path to inference. ----
  async function releaseRide(ctx: ExtensionContext, applied = false) {
    const current = ride; ride = undefined;
    if (current && !applied) rides.missed++;
    if (current) await job(ctx, { op: 'release', token: current.token }).catch(() => {});
  }
  async function armRide(ctx: ExtensionContext) {
    if (!enabled || ride || active || stopped) return;
    // Never ride a turn that is already near the context limit.
    try { const u = ctx.getContextUsage?.(); const pct = u?.percent ?? (u?.tokens && ctx.model?.contextWindow ? 100 * u.tokens / ctx.model.contextWindow : 0); if (pct > 80) return; } catch {}
    const token = randomUUID();
    try {
      await job(ctx, { op: 'claim', token }); // Another session holding the lease means no double-carrying.
    } catch { return; }
    try {
      const status = await job(ctx, { op: 'status' });
      const budgetBytes = Math.max(2000, (status.budgetTokens || DEFAULT_BUDGET_TOKENS) * 4);
      if (status.pending > 0) {
        // The index rides within the budget too: inputs get what remains after the title index.
        const batch = await job(ctx, { op: 'prepare', maxInputs: RIDE_INPUTS, maxBytes: budgetBytes, compact: true });
        if (!batch.inputs.length) throw Error('nothing to carry');
        const { references: _r, oversized: _o, ...payload } = batch;
        let text = rideInstruction('inputs', payload);
        while (Buffer.byteLength(text) > budgetBytes * 1.5 && payload.inputs.length > 1) { payload.inputs.pop(); text = rideInstruction('inputs', payload); }
        ride = { kind: 'inputs', token, batch: { ...batch, inputs: payload.inputs }, text, started: Date.now() }; rides.armed++;
        return;
      }
      const input = await job(ctx, { op: 'prepareStructure' });
      if (input.needed && Buffer.byteLength(JSON.stringify(input.expectations)) <= RIDE_STRUCTURE_BYTES) {
        ride = { kind: 'structure', token, input, text: rideInstruction('structure', { expectations: input.expectations, previousStructure: input.previousStructure }), started: Date.now() }; rides.armed++;
        return;
      }
      throw Error('nothing to carry');
    } catch (error) {
      if (!/nothing to carry/.test(String(error))) await job(ctx, { op: 'error', message: 'Could not arm in-turn bookkeeping: ' + String(error) }).catch(() => {});
      await job(ctx, { op: 'release', token }).catch(() => {});
    }
  }
  async function applyRide(ctx: ExtensionContext, json: string) {
    const current = ride; if (!current) return;
    const run = { id: randomUUID(), at: new Date().toISOString(), kind: current.kind, mode: 'ridden-turn', usage: null, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      session: ctx.sessionManager.getSessionId(), sourceRefs: current.batch ? current.batch.inputs.map((i: { ref: string }) => current.batch.references?.[i.ref] || i.ref) : [],
      contextSha256: createHash('sha256').update(current.text).digest('hex') };
    try {
      const result = decodeOutput(json);
      if (current.kind === 'inputs') {
        const evidence = Array.isArray(result.evidence) ? result.evidence : [];
        delete result.evidence;
        await job(ctx, { op: 'apply', batch: current.batch, result, run });
        for (const ev of evidence) {
          try {
            const { mkdir, appendFile } = await import('node:fs/promises');
            const dir = join(project(ctx), '.human-expectations/audits'); await mkdir(dir, { recursive: true, mode: 0o700 });
            const file = join(dir, `in-turn-${new Date().toISOString().slice(0, 10)}.md`);
            await appendFile(file, `\n## ${ev.check} — ${ev.verdict} — ${new Date().toISOString()}\nSession ${ctx.sessionManager.getSessionId()} (self-report during ordinary work)\nObserved: ${ev.observed}\nMethod: ${ev.method}\nScope: ${ev.scope || 'this session'}\n`, { mode: 0o600 });
            const status = await job(ctx, { op: 'status' });
            const expectation = String(ev.check).replace(/\.\d+$/, '');
            const row = await job(ctx, { op: 'report', node: expectation });
            await job(ctx, { op: 'record', update: { revision: status.revision, expectation, holder: row.holder || 'unassigned', session: ctx.sessionManager.getSessionId(), recordedBy: ctx.sessionManager.getSessionId(),
              checks: [{ id: ev.check, verdict: ev.verdict, observed: String(ev.observed), method: String(ev.method), artifact: relative(project(ctx), file), scope: String(ev.scope || 'this session'), checkedBy: ctx.sessionManager.getSessionId() + ' (in-turn self-report)', session: ctx.sessionManager.getSessionId() }] } });
          } catch { /* evidence that does not validate is dropped; the obligation stays unknown */ }
        }
      }
      else await job(ctx, { op: 'structure', revision: current.input.revision, digest: current.input.digest, structure: result, run });
      rides.applied++;
    } catch (error) {
      rides.rejected++;
      // Invalid output is recorded and the sources stay pending. No repair request is ever started.
      await job(ctx, { op: 'error', message: String(error), run, rejectedOutput: json }).catch(() => {});
    } finally { await releaseRide(ctx, true); }
  }

  pi.on('session_start', (_event, ctx) => {
    stopped = false;
    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return;
    void job(ctx, { op: 'status' }).then(status => {
      if (stopped) return;
      enabled = !!status.enabled;
      if (enabled) { startWatching(ctx); mark(ctx); }
    }).catch(() => {});
  });
  pi.on('before_agent_start', async (_event, ctx) => { await armRide(ctx).catch(() => {}); });
  pi.on('context', (event) => {
    if (!ride) return;
    const last = event.messages.at(-1);
    if (!last) return;
    // Appended to the tail only: the cached prefix of the conversation is untouched and nothing is persisted.
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...(last.content as any[])];
    content.push({ type: 'text', text: ride.text });
    (last as any).content = content; rides.carried++;
    return { messages: event.messages };
  });
  pi.on('message_end', async (event, ctx) => {
    mark(ctx); // Observer only.
    if (!ride || event.message.role !== 'assistant') return;
    const blocks = (event.message as any).content as any[];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const found = extractRide(text);
    if (!found) return;
    rides.answered++;
    await applyRide(ctx, found.json);
    let removed = false;
    return { message: { ...event.message, content: blocks.map(b => {
      if (b.type !== 'text' || removed) return b;
      const hit = extractRide(b.text); if (!hit) return b; removed = true; return { ...b, text: hit.stripped };
    }) } };
  });
  pi.registerMarkdownTransformer((markdown, { messageType }) => messageType === 'assistant' ? hideRide(markdown) : markdown);
  pi.on('agent_end', async (_event, ctx) => { await releaseRide(ctx); });
  pi.on('agent_start', () => { controller?.abort(); });
  pi.on('agent_settled', (_event, ctx) => { void releaseRide(ctx); schedule(ctx); });
  pi.on('session_shutdown', async (_event, ctx) => {
    stopped = true;
    if (timer) clearTimeout(timer); timer = undefined;
    stopWatching();
    controller?.abort(); await active?.catch(() => {});
    await releaseRide(ctx);
  });

  // ---- Explicit, user-invoked passes. These DO make separate model requests and say so. ----
  async function estimate(ctx: ExtensionContext, bootstrap: boolean, since?: string) {
    const model = ctx.model; if (!model) throw Error('Select a model before estimating');
    const status = await job(ctx, { op: 'status' });
    const batch = await job(ctx, { op: 'prepare', since, ...(bootstrap ? { maxInputs: 120, maxBytes: Math.min(650000, Math.floor((model.contextWindow || 128000) * 0.6)) } : {}) });
    const perBatch = Math.max(1, batch.inputs.length), bytes = Buffer.byteLength(JSON.stringify(batch));
    const batches = bootstrap ? Math.ceil(status.pending / perBatch) : Math.min(1, status.pending);
    const inTokens = Math.round(bytes / 4) * batches, outTokens = Math.round(perBatch * 180) * batches;
    const cost = model.cost ? (inTokens * (model.cost.input || 0) + outTokens * (model.cost.output || 0)) / 1e6 : null;
    return { pending: status.pending, perBatch, batches, inputTokens: inTokens, outputTokens: outTokens, estimatedCost: cost, estimatedMinutes: Math.round(batches * 2.5),
      text: `${status.pending} pending inputs → ${batches} request(s) of ~${perBatch} inputs on ${model.provider}/${model.id}; ~${Math.round(inTokens / 1000)}k input + ~${Math.round(outTokens / 1000)}k output tokens; ${cost === null ? 'cost unknown for this model' : `about $${cost.toFixed(2)}`} (subscription accounts: quota, not dollars); ~${Math.round(batches * 2.5)} min. Estimates carry ±30%.` };
  }
  async function ledger(ctx: ExtensionContext, line: string, header = false) {
    const { mkdir, appendFile } = await import('node:fs/promises');
    const dir = join(project(ctx), '.human-expectations'); await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, 'BACKFILL.md'), (header ? `\n# Backfill ${new Date().toISOString()}\n\n| batch | inputs left | expectations | cost so far | elapsed |\n|---|---|---|---|---|\n` : '') + line + '\n', { mode: 0o600 });
  }
  async function explicitPass(ctx: ExtensionContext, bootstrap: boolean, file?: string, since?: string, parallel = 1) {
    if (active) throw Error('Expectation update already running in this session');
    controller = new AbortController();
    const abort = controller;
    active = (async () => {
      const token = randomUUID();
      let claimed = false;
      try {
        await job(ctx, { op: 'claim', token }); claimed = true;
        let status = await job(ctx, { op: 'scan', ...(file ? { files: [resolve(file)] } : { roots: roots(ctx) }) });
        const protocol = await readFile(join(root, 'PROMPT.md'), 'utf8');
        const model = ctx.model;
        if (!model) throw Error('Select a model before extracting intent');
        const progress = (text: string) => { if (ctx.hasUI) ctx.ui.setStatus('human-expectations', text); };
        const startedPending = status.pending, startedAt = Date.now(), startedCost = status.recordedCost || 0;
        if (ctx.hasUI) ctx.ui.notify(`Explicit ${bootstrap ? 'backfill' : 'review'} started: ${status.pending} pending inputs. Live ledger: .human-expectations/BACKFILL.md; progress in the status line; sources stay safe if you stop.`, 'info');
        await ledger(ctx, `| 0 | ${status.pending} | ${status.expectations} | $0.00 | 0 min |`, true);
        const inFlight = new Set<string>();
        let batchNumber = 0, gate: Promise<unknown> = Promise.resolve();
        const oneBatch = async (): Promise<boolean> => {
          if (abort.signal.aborted || stopped) return false;
          // Picking a batch and claiming its inputs is serialised; only the model calls overlap.
          const picked = gate.then(async () => {
            const batch = await job(ctx, { op: 'prepare', since, exclude: [...inFlight], ...(bootstrap ? { maxInputs: 120, maxBytes: Math.min(650000, Math.floor((model.contextWindow || 128000) * 0.6)) } : {}) });
            const mine = batch.inputs.map((i: { ref: string }) => batch.references?.[i.ref] || i.ref); for (const r of mine) inFlight.add(r);
            return { batch, mine };
          });
          gate = picked.catch(() => {});
          const { batch, mine } = await picked;
          if (!batch.inputs.length) return false;
          const n = ++batchNumber;
          progress(`expectations ${bootstrap ? 'backfill' : 'review'}: batch ${n} (${inFlight.size} inputs in flight) · ${status.pending} pending of ${startedPending} · $${((status.recordedCost || 0) - startedCost).toFixed(2)} · ${Math.round((Date.now() - startedAt) / 60000)} min`);
          try { await runBatch(batch, n); } finally { for (const r of mine) inFlight.delete(r); }
          return true;
        };
        const runBatch = async (batch: any, n: number) => {
          const { references: _references, ...reviewInput } = batch;
          let repair: { validationError: string; rejectedOutput: string } | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            let run: Record<string, unknown> | undefined, text = '';
            try {
              const inputData = JSON.stringify({ ...reviewInput, repair });
              const response = await ctx.modelRegistry.complete(model, { systemPrompt: protocol, messages: [{ role: 'user', content: inputData, timestamp: Date.now() }] },
                { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.round(Math.min(1800000, (bootstrap ? 300000 : 120000) + Buffer.byteLength(inputData) / 100)))]), maxTokens: bootstrap ? Math.min(32000, model.maxTokens || 32000) : Math.min(12000, model.maxTokens || 12000), reasoningEffort: 'low', sessionId: randomUUID() });
              run = { id: randomUUID(), at: new Date().toISOString(), mode: 'explicit-pass', model: `${model.provider}/${model.id}`, usage: response.usage, inputs: batch.inputs.length,
                sourceRefs: batch.inputs.map((i: { ref: string }) => batch.references?.[i.ref] || i.ref), contextSha256: createHash('sha256').update(protocol + '\0' + inputData).digest('hex') };
              const calls = response.content.filter(b => b.type === 'toolCall');
              const call = calls.length === 1 ? calls[0] : undefined;
              text = call ? JSON.stringify(call.arguments) : response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              if (response.stopReason !== 'stop' && !(response.stopReason === 'toolUse' && call)) throw Error(`Extraction stopped: ${response.stopReason}: ${response.errorMessage || 'no provider diagnostic'}`);
              const result = decodeOutput(text);
              if (abort.signal.aborted || stopped) throw Error('Extraction cancelled; sources remain pending');
              status = await job(ctx, { op: 'apply', batch, result, run });
              await ledger(ctx, `| ${n} | ${status.pending} | ${status.expectations} | $${((status.recordedCost || 0) - startedCost).toFixed(2)} | ${Math.round((Date.now() - startedAt) / 60000)} min |`);
              break;
            } catch (error) {
              await job(ctx, { op: 'error', message: String(error), run, rejectedOutput: text });
              if (attempt || !text || abort.signal.aborted || stopped || /Stale review|Busy:|EEXIST/.test(String(error))) throw error;
              repair = { validationError: String(error), rejectedOutput: text };
            }
          }
        };
        const limit = bootstrap ? 400 : 1;
        const workers = Array.from({ length: bootstrap ? parallel : 1 }, async () => { while (batchNumber < limit && await oneBatch()) { /* next */ } });
        await Promise.all(workers);
        if (!abort.signal.aborted && !stopped && status.pending === 0) { progress('expectations: consolidating the outcome hierarchy'); status = await consolidateExplicit(ctx, abort.signal) || status; }
        progress(undefined as any);
        await ledger(ctx, `| done | ${status.pending} | ${status.expectations} | $${((status.recordedCost || 0) - startedCost).toFixed(2)} | ${Math.round((Date.now() - startedAt) / 60000)} min |`);
        return { done: `${startedPending - status.pending} inputs processed in ${Math.round((Date.now() - startedAt) / 60000)} min, $${((status.recordedCost || 0) - startedCost).toFixed(2)} reported; ${status.pending} pending remain`, ...status };
      } catch (error) {
        if (claimed) await job(ctx, { op: 'error', message: String(error) }).catch(() => {});
        throw error;
      } finally { if (claimed) await job(ctx, { op: 'release', token }); }
    })();
    try { return await active; } finally { active = undefined; controller = undefined; }
  }
  async function consolidateExplicit(ctx: ExtensionContext, signal: AbortSignal) {
    const input = await job(ctx, { op: 'prepareStructure' });
    if (!input.needed) return;
    const model = ctx.model;
    if (!model) throw Error('Select a model before consolidating expectations');
    let repair: { error: string; rejected: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = '', run: Record<string, unknown> | undefined;
      try {
        const content = JSON.stringify({ ...input, repair });
        if (Buffer.byteLength(content) > Math.min(650000, model.contextWindow * 1.2)) throw Error('Consolidation catalogue exceeds this model budget; select a larger-context model');
        const response = await ctx.modelRegistry.complete(model, { systemPrompt: consolidationPrompt, messages: [{ role: 'user', content, timestamp: Date.now() }] },
          { signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]), maxTokens: Math.min(16000, model.maxTokens || 16000), reasoningEffort: 'low', sessionId: randomUUID() });
        run = { id: randomUUID(), at: new Date().toISOString(), kind: 'consolidation', mode: 'explicit-pass', model: `${model.provider}/${model.id}`, usage: response.usage, contextSha256: createHash('sha256').update(consolidationPrompt + '\0' + content).digest('hex') };
        text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (response.stopReason !== 'stop') throw Error(`Consolidation stopped: ${response.stopReason}`);
        signal.throwIfAborted();
        return await job(ctx, { op: 'structure', revision: input.revision, digest: input.digest, structure: decodeOutput(text), run });
      } catch (error) {
        await job(ctx, { op: 'error', message: String(error), run, rejectedOutput: text });
        if (attempt || !text || signal.aborted || /Stale/.test(String(error))) throw error;
        repair = { error: String(error), rejected: text };
      }
    }
  }

  const VERBS: Record<string, string> = {
    on: 'enable for this project (add --global for all projects)', off: 'disable here (wins over global)', status: 'intake, pending, rides, cost',
    report: 'outcome overview; report this|<session-id> for one session', collect: 'read new transcript text, no inference',
    tidy: 'explicit paid pass: propose merges of duplicate outcomes and splits of compound checks; you approve before anything changes', audit: 'drive the checks of an outcome/expectation against the project and record evidence (starts a turn)', bootstrap: 'explicit paid pass over pending history', review: 'explicit paid pass, one batch', split: 'overview + linked detail files', single: 'one report file',
  };
  const command = {
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.split(/\s+/);
      if (words.length > 1) {
        const verb = words[0], tail = words.at(-1) || '';
        const options = (verb === 'report' ? ['this', 'full', 'recheck', '--project'] : verb === 'on' ? ['--global', '--project', '--budget', '30', '60'] : verb === 'off' ? ['--global', '--project'] : verb === 'bootstrap' || verb === 'review' ? ['--estimate', '--yes', '--since', '--parallel', '--project'] : ['--project']);
        const items = options.filter(o => o.startsWith(tail)).map(o => ({ value: `${words.slice(0, -1).join(' ')} ${o}`, label: o }));
        return items.length ? items : null;
      }
      const items = Object.entries(VERBS).filter(([v]) => v.startsWith(prefix)).map(([v, d]) => ({ value: v, label: v, description: d }));
      return items.length ? items : null;
    },
    description: 'on|off [--global] [minutes], status, report [session|this], collect, bootstrap [transcript] (explicit paid pass), split, single',
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const global = words.includes('--global');
      const at = words.indexOf('--project');
      projectOverride = at >= 0 ? words.splice(at, 2)[1] : undefined;
      const [action = 'report', ...rest] = words.filter(w => w !== '--global');
      try {
        if (action === 'on' || action === 'off') {
          if (action === 'off') { controller?.abort(); await active?.catch(() => {}); if (timer) clearTimeout(timer); timer = undefined; await releaseRide(ctx); }
          const b = rest.indexOf('--budget'); const budgetTokens = b >= 0 ? Number(rest.splice(b, 2)[1]) : undefined;
          const minutes = rest[0] ? Number(rest[0]) : 30;
          let backfill: string | undefined;
          if (action === 'on' && global) {
            const projects = await job(ctx, { op: 'projects', roots: roots(ctx) });
            const affected = projects.filter((p: any) => p.projectSetting !== 'off');
            const ok = !ctx.hasUI || await ctx.ui.confirm('Enable for every project?', `${affected.length} project folder(s) known to pi would start collecting (projects set off stay off):\n` + affected.slice(0, 12).map((p: any) => `  ${p.project}`).join('\n') + (affected.length > 12 ? `\n  … and ${affected.length - 12} more` : ''));
            if (!ok) { show(ctx, 'Global activation cancelled.'); return; }
          }
          if (action === 'on' && !global) {
            const current = await job(ctx, { op: 'status' });
            if (!current.backfill) {
              const options = [
                'No backfill — remember only what is said from now on',
                'This session only — include this conversation\'s history, new sessions from now on',
                'Full history — every session of this project (large projects: hours of ordinary turns, or an explicit paid pass)',
              ];
              const choice = ctx.hasUI ? await ctx.ui.select('History to include (↑/↓ or space to move, Enter to choose):', options) : options[0];
              if (!choice) { show(ctx, 'Activation cancelled; nothing changed.'); return; }
              backfill = ['none', 'session', 'all'][options.indexOf(choice)];
            }
          }
          const status = await job(ctx, { op: 'configure', enabled: action === 'on', minutes, scope: global ? 'global' : 'project', backfill, budgetTokens, sessionFile: ctx.sessionManager.getSessionFile?.() });
          enabled = !!status.enabled;
          if (enabled) { startWatching(ctx); mark(ctx); } else stopWatching();
          if (action === 'on') {
            try { const { execSync } = await import('node:child_process'); execSync('git check-ignore -q .human-expectations/.STATE.md', { cwd: project(ctx), stdio: 'ignore' }); }
            catch { if (ctx.hasUI) ctx.ui.notify('.human-expectations/ is not Git-ignored in this project. Add it to .gitignore (or .git/info/exclude) before committing — it contains your own words.', 'warning'); }
          }
          show(ctx, `${global ? 'Global' : 'Project'} setting: ${action}. Effective here: ${status.enabled ? 'on' : 'off'} (${status.activation}).\n` +
            (status.enabled ? `History: ${status.backfill || 'all'} · per-turn budget ${status.budgetTokens || DEFAULT_BUDGET_TOKENS} tokens. Bookkeeping rides your own turns in small bounded pieces; it never starts a model request of its own. A project-level off always wins over global on. Explicit paid passes stay opt-in: /he bootstrap.` : 'The Markdown record is retained. Nothing runs until re-enabled.'));
        } else if (action === 'collect') {
          show(ctx, await collect(ctx, rest.length ? rest.join(' ') : undefined));
        } else if (action === 'review' || action === 'bootstrap') {
          const si = rest.indexOf('--since'); const since = si >= 0 ? new Date(rest.splice(si, 2)[1]).toISOString() : undefined;
          const pi_ = rest.indexOf('--parallel'); const parallel = pi_ >= 0 ? Math.max(1, Math.min(4, Number(rest.splice(pi_, 2)[1]) || 1)) : 1;
          const file = rest.filter(w => !w.startsWith('--')).join(' ') || undefined;
          if (file) await collect(ctx, file); // an explicit transcript is read first, so the estimate covers it
          const est = await estimate(ctx, action === 'bootstrap', since);
          if (rest.includes('--estimate')) { show(ctx, est.text); return; }
          if (!est.pending) { show(ctx, 'Nothing pending.'); return; }
          const go = !ctx.hasUI || rest.includes('--yes') || await ctx.ui.confirm(`Start ${action}?`, est.text);
          if (!go) { show(ctx, 'Not started.'); return; }
          show(ctx, await explicitPass(ctx, action === 'bootstrap', file, since, parallel));
        } else if (action === 'report') {
          const arg = rest[0];
          if (arg === 'this' || (arg && /^[0-9a-f]{8}/.test(arg) && !/^(HE|GX)-/.test(arg))) {
            const result = await job(ctx, { op: 'report', session: arg === 'this' ? ctx.sessionManager.getSessionId() : arg });
            show(ctx, result.sessionActivity); return;
          }
          if (arg === 'full') { const result = await job(ctx, { op: 'report' }); show(ctx, `Full Markdown: ${result.report}`); return; }
          if (arg === 'recheck') { const q = (await job(ctx, { op: 'report', recheck: true })).recheck; show(ctx, q.length ? ['Passes that no longer count until re-checked:', ...q.map((x: any) => `  ${x.id} — ${x.state}: ${x.reason} (${x.expectation})`), '', 'Re-check with /he audit <HE-id>'].join('\n') : 'No stale passes.'); return; }
          show(ctx, tree(await job(ctx, { op: 'report', node: arg || null })));
        } else if (action === 'audit') {
          // A user-invoked turn: the agent drives the checks with real tools and records what it observed.
          const view = await job(ctx, { op: 'report', node: rest[0] || null });
          const targets = view.checks ? [view] : await Promise.all((view.rows || []).filter((r: any) => r.kind === 'expectation').slice(0, 7).map((r: any) => job(ctx, { op: 'report', node: r.id })));
          if (!targets.length) throw Error('Pick a group with expectations or one HE-id: /he audit HE-0001');
          const status = await job(ctx, { op: 'status' });
          const { execSync } = await import('node:child_process');
          let build = 'unknown'; try { build = execSync('git rev-parse HEAD', { cwd: project(ctx), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
          const brief = [
            `AUDIT of ${targets.length} expectation(s) against the project at ${project(ctx)} — run every command and read every file THERE (cd into it); establish what is actually delivered, not what was claimed.`,
            `READ-ONLY toward the project: do not modify, fix, build or commit anything in it; the only files you write are under .human-expectations/audits/. If a check needs a change to be observable, record it as blocked with what would be needed.`,
            `For every check below: obtain real evidence with the project's own tools (commands, files, the running system, a driven user path). State the method, the scope (build/commit, environment, time window) and the measured observation. A commit, a green test on the wrong layer, or an assistant's "done" is not evidence. If it cannot be observed, the verdict is unknown or blocked — never passed.`,
            `Write your observations to .human-expectations/audits/<HE-id>-${new Date().toISOString().slice(0, 10)}.md (Markdown), then record each verdict with the human_expectations tool: action "record", revision ${status.revision}, expectation <HE-id>, holder "unassigned" unless the record names one, session "${ctx.sessionManager.getSessionId()}", build "${build}", checks [{id, verdict, observed, method, artifact (that audit file), scope, checkedBy "${ctx.sessionManager.getSessionId()} (self-check)", session}]. Re-read status for the current revision before each record call. Do not edit expectations or invent thresholds; if a check is ambiguous, say so in the audit file and leave it unknown.`,
            '', ...targets.map((t: any) => `## ${t.id} — ${t.title}\n${t.intent}\n` + t.checks.map((c: any) => `- ${c.id} [${c.verdict}] ${c.obligation}`).join('\n')),
          ].join('\n');
          pi.sendMessage({ customType: 'human-expectations:audit', content: brief, display: true }, { triggerTurn: true });
        } else if (action === 'tidy') {
          const model = ctx.model; if (!model) throw Error('Select a model');
          const view = await job(ctx, { op: 'report' }); void view;
          const catalogue = await job(ctx, { op: 'prepareStructure' });
          const content = JSON.stringify({ expectations: catalogue.expectations });
          if (ctx.hasUI) ctx.ui.notify(`Tidy review: ${catalogue.expectations.length} expectations, one explicit model request (${Math.round(Buffer.byteLength(content) / 1000)} KB).`, 'info');
          const response = await ctx.modelRegistry.complete(model, { systemPrompt: tidyPrompt, messages: [{ role: 'user', content, timestamp: Date.now() }] }, { signal: AbortSignal.timeout(600000), maxTokens: Math.min(16000, model.maxTokens || 16000), reasoningEffort: 'low', sessionId: randomUUID() });
          const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          const proposal = decodeOutput(text);
          const merges = proposal.merges || [], splits = proposal.splits || [];
          const summary = [`Proposed: ${merges.length} merges, ${splits.length} splits, ${(proposal.leave || []).length} left as is.`, '',
            ...merges.map((m: any) => `MERGE ${m.absorb?.join(', ')} → ${m.keep}: ${m.reason}`), ...splits.map((sp: any) => `SPLIT ${sp.check} → ${sp.into?.length} obligations: ${sp.reason}`)].join('\n');
          show(ctx, summary);
          const ok = ctx.hasUI ? await ctx.ui.confirm('Apply this tidy proposal?', `${merges.length} merges and ${splits.length} splits. Sources and history are kept; nothing is deleted.`) : false;
          if (!ok) { show(ctx, 'Tidy proposal not applied.'); return; }
          const status = await job(ctx, { op: 'status' });
          show(ctx, await job(ctx, { op: 'tidy', revision: status.revision, proposal, run: { id: randomUUID(), at: new Date().toISOString(), kind: 'tidy', mode: 'explicit-pass', model: `${model.provider}/${model.id}`, usage: response.usage } }));
        } else if (action === 'split' || action === 'single') {
          show(ctx, await job(ctx, { op: 'layout', split: action === 'split' }));
        } else if (action === 'status') {
          const s = await job(ctx, { op: 'status' });
          const when = (t?: string) => t ? t.replace('T', ' ').slice(0, 16) : 'never';
          const v = s.verdicts || {};
          show(ctx, [
            `Human expectations — ${project(ctx)}`,
            `Active: ${s.enabled ? 'on' : 'off'} (${s.activation}) · history: ${s.backfill || 'all'} · intake every ${s.minutes} min · per-turn budget ${s.budgetTokens || DEFAULT_BUDGET_TOKENS} tokens`,
            `Record: ${s.expectations ?? 0} expectations in ${s.outcomeGroups ?? 0} outcomes · ${s.inputs ?? 0} inputs from ${s.sessions ?? 0} sessions · ${s.pending ?? 0} pending · ${s.needsContext ?? 0} need context${s.withImages ? ` (${s.withImages} with images a human must interpret)` : ''} · ${s.unverifiedProposals ?? 0} held proposals`,
            `Verified: ${v.passed ?? 0} passed · ${v.failed ?? 0} failed · ${v.blocked ?? 0} blocked · ${v.unknown ?? 0} unknown (outcome checks)`,
            `Last intake: ${when(s.lastScan)} · last review: ${when(s.lastReview)} · last error: ${s.lastError ? s.lastError.split('\n')[0].slice(0, 120) : 'none'}`,
            `This session: rides armed ${rides.armed} · carried ${rides.carried} · answered ${rides.answered} · applied ${rides.applied} · rejected ${rides.rejected} · missed ${rides.missed}`,
            `Model runs: ${s.modelCalls ?? 0} · reported cost of explicit passes $${(s.recordedCost ?? 0).toFixed(2)}`,
          ].join('\n'));
        }
        else throw Error('Use /he on|off [--global] [minutes], status, report [id], audit [id], collect, bootstrap [transcript], split or single');
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); }
      finally { projectOverride = undefined; }
    },
  };
  pi.registerCommand('he', command);
  pi.registerCommand('human-expectations', { ...command, description: 'Alias of /he' });
  pi.registerTool({
    name: 'human_expectations', label: 'Human expectations',
    description: 'Read project-wide intent, sources and coverage; record measured acceptance evidence; review a MECE hierarchy. Never treats a transcript claim as proof. Responses bounded to 20KB/200 lines. Read the bundled human-expectations skill for MECE and source-authority rules.',
    parameters: Type.Object({
      action: StringEnum(['report', 'status', 'source', 'record', 'structure'] as const),
      ref: Type.Optional(Type.String()), node: Type.Optional(Type.String({ description: 'Report drill-down: omit for outcomes, GX-id for a group, HE-id for one expectation with its checks and sources.' })), session: Type.Optional(Type.String({ description: 'Report: full/unique-prefix session ID, or this. Verification activity, not inferred implementation credit.' })), revision: Type.Optional(Type.Integer()),
      structure: Type.Optional(Type.Any({ description: 'MECE hierarchy: {dimension, groups}. Each node is an HE-id or {id:GX-0001,title,dimension,children}; 3–7 members per group, every active HE-id exactly once.' })),
      update: Type.Optional(Type.Object({
        revision: Type.Integer(), expectation: Type.String(), holder: Type.String(), session: Type.String(), build: Type.Optional(Type.String({ description: 'Commit/build the checks were measured on; evidence is marked historical once the project moves on.' })),
        reconciled: Type.Optional(Type.Boolean()), coverageEvidence: Type.Optional(Type.String()),
        checks: Type.Array(Type.Object({ id: Type.String(), verdict: StringEnum(['passed', 'failed', 'blocked', 'unknown'] as const),
          observed: Type.String(), observedAt: Type.Optional(Type.String({ description: 'Actual observation ISO timestamp; required for historical evidence, defaults to now for a fresh check.' })), method: Type.String(), artifact: Type.String(), scope: Type.String(), checkedBy: Type.String(), session: Type.String() })),
      })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const update = params.update ? { ...params.update, recordedBy: ctx.sessionManager.getSessionId() } : undefined;
      const result = await job(ctx, { op: params.action, ref: params.ref, node: params.action === 'report' && params.node !== undefined ? params.node : undefined, update, revision: params.revision, structure: params.structure, session: params.session === 'this' ? ctx.sessionManager.getSessionId() : params.session });
      return { content: [{ type: 'text', text: compact(result) }], details: {} };
    },
  });
}
