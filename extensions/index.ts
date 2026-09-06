import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { runJob } from '../src/jobs.mjs';
import { decodeOutput } from '../src/output.mjs';
import { consolidationPrompt } from '../src/consolidation.mjs';
import { rideInstruction, extractRide, hideRide } from '../src/ride.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Per ridden turn: bookkeeping never exceeds this many source inputs / bytes of appended context.
const RIDE_INPUTS = 6, RIDE_BYTES = 12000, RIDE_STRUCTURE_BYTES = 40000;

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
  const project = (ctx: ExtensionContext) => resolve(String(pi.getFlag('he-project') || ctx.cwd));
  const roots = (ctx: ExtensionContext) => [join(agentDir(), 'sessions'), ctx.sessionManager.getSessionDir()];
  const job = (ctx: ExtensionContext, data: Record<string, unknown>) => {
    if (!ctx.isProjectTrusted()) throw Error('Trust the current project before using human expectations');
    return withFileMutationQueue(join(project(ctx), '.human-expectations/.STATE.md'), () => runJob({ ...data, project: project(ctx), globalDir: join(agentDir(), 'human-expectations') }));
  };
  const compact = (value: unknown) => {
    const part = truncateHead(typeof value === 'string' ? value : JSON.stringify(value, null, 2), { maxBytes: 20000, maxLines: 200 });
    return part.content + (part.truncated ? '\n[Truncated. Full records are in .human-expectations/.STATE.md; source results identify the original transcript and entry.]' : '');
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
  async function releaseRide(ctx: ExtensionContext) {
    const current = ride; ride = undefined;
    if (current) rides.missed++;
    if (current) await job(ctx, { op: 'release', token: current.token }).catch(() => {});
  }
  async function armRide(ctx: ExtensionContext) {
    if (!enabled || ride || active || stopped) return;
    const token = randomUUID();
    try {
      await job(ctx, { op: 'claim', token }); // Another session holding the lease means no double-carrying.
    } catch { return; }
    try {
      const status = await job(ctx, { op: 'status' });
      if (status.pending > 0) {
        const batch = await job(ctx, { op: 'prepare', maxInputs: RIDE_INPUTS, maxBytes: RIDE_BYTES, compact: true });
        if (!batch.inputs.length) throw Error('nothing to carry');
        const { references: _r, oversized: _o, ...payload } = batch;
        ride = { kind: 'inputs', token, batch, text: rideInstruction('inputs', payload), started: Date.now() }; rides.armed++;
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
    const run = { id: randomUUID(), at: new Date().toISOString(), kind: current.kind, mode: 'ridden-turn', usage: null,
      contextSha256: createHash('sha256').update(current.text).digest('hex') };
    try {
      const result = decodeOutput(json);
      if (current.kind === 'inputs') await job(ctx, { op: 'apply', batch: current.batch, result, run });
      else await job(ctx, { op: 'structure', revision: current.input.revision, digest: current.input.digest, structure: result, run });
      rides.applied++;
    } catch (error) {
      rides.rejected++;
      // Invalid output is recorded and the sources stay pending. No repair request is ever started.
      await job(ctx, { op: 'error', message: String(error), run, rejectedOutput: json }).catch(() => {});
    } finally { await releaseRide(ctx); }
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
  async function explicitPass(ctx: ExtensionContext, bootstrap: boolean, file?: string) {
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
        for (let batchNumber = 0; batchNumber < (bootstrap ? 200 : 1); batchNumber++) {
          if (abort.signal.aborted || stopped) break;
          const batch = await job(ctx, { op: 'prepare', ...(bootstrap ? { maxInputs: 96, maxBytes: Math.min(350000, (model.contextWindow || 128000) * 1.2) } : {}) });
          if (!batch.inputs.length) break;
          const { references: _references, ...reviewInput } = batch;
          let repair: { validationError: string; rejectedOutput: string } | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            let run: Record<string, unknown> | undefined, text = '';
            try {
              const inputData = JSON.stringify({ ...reviewInput, repair });
              const response = await ctx.modelRegistry.complete(model, { systemPrompt: protocol, messages: [{ role: 'user', content: inputData, timestamp: Date.now() }] },
                { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(bootstrap ? 240000 : 120000)]), maxTokens: bootstrap ? Math.min(32000, model.maxTokens || 32000) : Math.min(12000, model.maxTokens || 12000), reasoningEffort: 'low', sessionId: randomUUID() });
              run = { id: randomUUID(), at: new Date().toISOString(), mode: 'explicit-pass', model: `${model.provider}/${model.id}`, usage: response.usage, inputs: batch.inputs.length,
                sourceRefs: batch.inputs.map((i: { ref: string }) => batch.references?.[i.ref] || i.ref), contextSha256: createHash('sha256').update(protocol + '\0' + inputData).digest('hex') };
              const calls = response.content.filter(b => b.type === 'toolCall');
              const call = calls.length === 1 ? calls[0] : undefined;
              text = call ? JSON.stringify(call.arguments) : response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              if (response.stopReason !== 'stop' && !(response.stopReason === 'toolUse' && call)) throw Error(`Extraction stopped: ${response.stopReason}: ${response.errorMessage || 'no provider diagnostic'}`);
              const result = decodeOutput(text);
              if (abort.signal.aborted || stopped) throw Error('Extraction cancelled; sources remain pending');
              status = await job(ctx, { op: 'apply', batch, result, run });
              break;
            } catch (error) {
              await job(ctx, { op: 'error', message: String(error), run, rejectedOutput: text });
              if (attempt || !text || abort.signal.aborted || stopped || /Stale review|Busy:|EEXIST/.test(String(error))) throw error;
              repair = { validationError: String(error), rejectedOutput: text };
            }
          }
        }
        if (!abort.signal.aborted && !stopped && status.pending === 0) status = await consolidateExplicit(ctx, abort.signal) || status;
        return status;
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

  pi.registerCommand('human-expectations', {
    description: 'on|off [--global] [minutes], status, report [session|this], collect, bootstrap [transcript] (explicit paid pass), split, single',
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const global = words.includes('--global');
      const [action = 'report', ...rest] = words.filter(w => w !== '--global');
      try {
        if (action === 'on' || action === 'off') {
          if (action === 'off') { controller?.abort(); await active?.catch(() => {}); if (timer) clearTimeout(timer); timer = undefined; await releaseRide(ctx); }
          const minutes = rest[0] ? Number(rest[0]) : 30;
          const status = await job(ctx, { op: 'configure', enabled: action === 'on', minutes, scope: global ? 'global' : 'project' });
          enabled = !!status.enabled;
          if (enabled) { startWatching(ctx); mark(ctx); } else stopWatching();
          show(ctx, `${global ? 'Global' : 'Project'} setting: ${action}. Effective here: ${status.enabled ? 'on' : 'off'} (${status.activation}).\n` +
            (status.enabled ? 'Bookkeeping rides your own turns in small bounded pieces; it never starts a model request of its own. A project-level off always wins over global on.' : 'The Markdown record is retained. Nothing runs until re-enabled.'));
        } else if (action === 'collect') {
          show(ctx, await collect(ctx, rest.length ? rest.join(' ') : undefined));
        } else if (action === 'review' || action === 'bootstrap') {
          show(ctx, await explicitPass(ctx, action === 'bootstrap', rest.length ? rest.join(' ') : undefined));
        } else if (action === 'report') {
          const session = rest[0] === 'this' ? ctx.sessionManager.getSessionId() : rest[0];
          const result = await job(ctx, { op: 'report', session });
          if (session) { show(ctx, result.sessionActivity); return; }
          const text = await readFile(result.report, 'utf8');
          show(ctx, text.split(/\n## HE-/)[0] + `\n\nFull Markdown: ${result.report}` + (text.length > 60000 ? '\nLarge report: /human-expectations split offers an outcome-based overview and linked detail files.' : ''));
        } else if (action === 'split' || action === 'single') {
          show(ctx, await job(ctx, { op: 'layout', split: action === 'split' }));
        } else if (action === 'status') show(ctx, { ...await job(ctx, { op: 'status' }), thisSession: { enabled, rides } });
        else throw Error('Use on|off [--global] [minutes], status, report, collect, bootstrap [transcript], split or single');
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); }
    },
  });
  pi.registerTool({
    name: 'human_expectations', label: 'Human expectations',
    description: 'Read project-wide intent, sources and coverage; record measured acceptance evidence; review a MECE hierarchy. Never treats a transcript claim as proof. Responses bounded to 20KB/200 lines. Read the bundled human-expectations skill for MECE and source-authority rules.',
    parameters: Type.Object({
      action: StringEnum(['report', 'status', 'source', 'record', 'structure'] as const),
      ref: Type.Optional(Type.String()), session: Type.Optional(Type.String({ description: 'Report: full/unique-prefix session ID, or this. Verification activity, not inferred implementation credit.' })), revision: Type.Optional(Type.Integer()),
      structure: Type.Optional(Type.Any({ description: 'MECE hierarchy: {dimension, groups}. Each node is an HE-id or {id:GX-0001,title,dimension,children}; 3–7 members per group, every active HE-id exactly once.' })),
      update: Type.Optional(Type.Object({
        revision: Type.Integer(), expectation: Type.String(), holder: Type.String(), session: Type.String(),
        reconciled: Type.Optional(Type.Boolean()), coverageEvidence: Type.Optional(Type.String()),
        checks: Type.Array(Type.Object({ id: Type.String(), verdict: StringEnum(['passed', 'failed', 'blocked', 'unknown'] as const),
          observed: Type.String(), observedAt: Type.Optional(Type.String({ description: 'Actual observation ISO timestamp; required for historical evidence, defaults to now for a fresh check.' })), method: Type.String(), artifact: Type.String(), scope: Type.String(), checkedBy: Type.String(), session: Type.String() })),
      })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const update = params.update ? { ...params.update, recordedBy: ctx.sessionManager.getSessionId() } : undefined;
      const result = await job(ctx, { op: params.action, ref: params.ref, update, revision: params.revision, structure: params.structure, session: params.session === 'this' ? ctx.sessionManager.getSessionId() : params.session });
      return { content: [{ type: 'text', text: compact(result) }], details: {} };
    },
  });
}
