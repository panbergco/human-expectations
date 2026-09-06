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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export default function humanExpectations(pi: ExtensionAPI) {
  let stopped = false, dirty = false, scheduling = false, enabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<unknown> | undefined;
  let controller: AbortController | undefined;
  const watchers: FSWatcher[] = [];
  pi.registerFlag('he-project', { type: 'string', description: 'Explicit project to inspect (otherwise current cwd)' });
  const project = (ctx: ExtensionContext) => resolve(String(pi.getFlag('he-project') || ctx.cwd));
  const roots = (ctx: ExtensionContext) => [join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'sessions'), ctx.sessionManager.getSessionDir()];
  const job = (ctx: ExtensionContext, data: Record<string, unknown>) => {
    if (!ctx.isProjectTrusted()) throw Error('Trust the current project before using human expectations');
    return withFileMutationQueue(join(project(ctx), '.human-expectations/.STATE.md'), () => runJob({ ...data, project: project(ctx) }));
  };
  const compact = (value: unknown) => {
    const part = truncateHead(typeof value === 'string' ? value : JSON.stringify(value, null, 2), { maxBytes: 20000, maxLines: 200 });
    return part.content + (part.truncated ? '\n[Truncated. Full records are in .human-expectations/.STATE.md; source results identify the original transcript and entry.]' : '');
  };
  const show = (ctx: ExtensionContext, value: unknown) => pi.sendMessage({ customType: 'human-expectations:report', content: compact(value), display: true }, { triggerTurn: false });

  async function consolidate(ctx: ExtensionContext, signal: AbortSignal) {
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
        const response = await ctx.modelRegistry.complete(model, { systemPrompt: consolidationPrompt,
          messages: [{ role: 'user', content, timestamp: Date.now() }] },
          { signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]), maxTokens: Math.min(16000, model.maxTokens || 16000), reasoningEffort: 'low', sessionId: randomUUID() });
        run = { id: randomUUID(), at: new Date().toISOString(), kind: 'consolidation', model: `${model.provider}/${model.id}`, usage: response.usage,
          contextSha256: createHash('sha256').update(consolidationPrompt + '\0' + content).digest('hex') };
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

  async function cycle(ctx: ExtensionContext, bootstrap = false, file?: string, automatic = false) {
    if (active) throw Error('Expectation update already running in this session');
    if (stopped) return;
    controller = new AbortController();
    const abort = controller;
    active = (async () => {
      const token = randomUUID();
      let claimed = false;
      try {
        await job(ctx, { op: 'claim', token }); claimed = true;
        const scan = await job(ctx, { op: 'scan', ...(file ? { files: [resolve(file)] } : { roots: roots(ctx) }) });
        // Discover all project sessions every cycle; parse only additions, or the entire newly found transcript.
        let status = scan;
        const protocol = await readFile(join(root, 'PROMPT.md'), 'utf8');
        for (let batchNumber = 0; batchNumber < (bootstrap ? 200 : 1); batchNumber++) {
          if (abort.signal.aborted || stopped || (automatic && !ctx.isIdle())) break;
          const batch = await job(ctx, { op: 'prepare', ...(bootstrap ? { maxInputs: 96, maxBytes: Math.min(350000, (ctx.model?.contextWindow || 128000) * 1.2) } : {}) });
          if (!batch.inputs.length) break;
          const { references: _references, ...reviewInput } = batch;
          const model = ctx.model;
          if (!model) throw Error('Select a model before extracting intent');
          let repair: { validationError: string; rejectedOutput: string } | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            let run: Record<string, unknown> | undefined, text = '';
            try {
              const inputData = JSON.stringify({ ...reviewInput, repair });
              const response = await ctx.modelRegistry.complete(model, {
                systemPrompt: protocol,
                messages: [{ role: 'user', content: inputData, timestamp: Date.now() }],
              }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(bootstrap ? 240000 : 120000)]), maxTokens: bootstrap ? Math.min(32000, model.maxTokens || 32000) : Math.min(12000, model.maxTokens || 12000), reasoningEffort: 'low', sessionId: randomUUID() });
              run = { id: randomUUID(), at: new Date().toISOString(), model: `${model.provider}/${model.id}`, usage: response.usage, inputs: batch.inputs.length,
                sourceRefs: batch.inputs.map((i: { ref: string }) => batch.references?.[i.ref] || i.ref),
                contextSha256: createHash('sha256').update(protocol + '\0' + inputData).digest('hex') };
              const calls = response.content.filter(b => b.type === 'toolCall');
              // Data only: some providers frame a structured reply as a call. Never execute it;
              // its arguments still undergo the same source/coverage validation as plain JSON.
              const call = calls.length === 1 ? calls[0] : undefined;
              text = call ? JSON.stringify(call.arguments) : response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              if (response.stopReason !== 'stop' && !(response.stopReason === 'toolUse' && call)) throw Error(`Extraction stopped: ${response.stopReason}: ${response.errorMessage || 'no provider diagnostic'}; output tools: ${calls.map(c => c.name).join(', ')}`);
              if (call) run.outputTool = call.name;
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
        if (!abort.signal.aborted && !stopped && (!automatic || ctx.isIdle()) && status.pending === 0) {
          status = await consolidate(ctx, abort.signal) || status;
        }
        return status;
      } catch (error) {
        if (claimed) await job(ctx, { op: 'error', message: String(error) }).catch(() => {});
        throw error;
      } finally {
        if (claimed) await job(ctx, { op: 'release', token });
      }
    })();
    try { return await active; } finally {
      active = undefined; controller = undefined;
      if (dirty && !stopped) schedule(ctx); // A sibling session may have changed while this batch was in flight.
    }
  }

  function schedule(ctx: ExtensionContext) {
    if (stopped || !enabled || !dirty || timer || scheduling || active || !ctx.isIdle() || !['tui', 'rpc'].includes(ctx.mode)) return;
    scheduling = true;
    void job(ctx, { op: 'status' }).then(status => {
      if (!status.enabled || stopped) { enabled = false; stopWatching(); return; }
      const due = status.lastScan ? Date.parse(status.lastScan) + status.minutes * 60000 : 0;
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped || !dirty || !ctx.isIdle()) return; // agent_settled will retry; never poll a busy agent.
        dirty = false;
        void cycle(ctx, false, undefined, true).catch(() => { /* Durable error is reported on demand; no foreground notification/turn. */ });
      }, Math.max(1000, due - Date.now()));
      timer.unref();
    }).catch(() => {}).finally(() => { scheduling = false; });
  }
  const mark = (ctx: ExtensionContext) => { if (enabled) { dirty = true; schedule(ctx); } };
  function stopWatching() { for (const watcher of watchers) watcher.close(); watchers.length = 0; }
  function startWatching(ctx: ExtensionContext) {
    if (watchers.length || (ctx.mode !== 'tui' && ctx.mode !== 'rpc')) return;
    // Native filesystem notifications cover sibling sessions without model-driven polling.
    for (const path of new Set(roots(ctx))) {
      try {
        const watcher = watch(path, { recursive: true }, (_kind, name) => { if (String(name).endsWith('.jsonl')) mark(ctx); });
        watcher.on('error', () => {}); watchers.push(watcher);
      } catch { /* Session events and resume still catch up if this platform/path cannot be watched. */ }
    }
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
  pi.on('message_end', (_event, ctx) => { mark(ctx); }); // Observer only: no message replacement.
  pi.on('agent_start', () => { controller?.abort(); });
  pi.on('agent_settled', (_event, ctx) => { schedule(ctx); });
  pi.on('session_shutdown', async () => {
    stopped = true;
    if (timer) clearTimeout(timer); timer = undefined;
    stopWatching();
    controller?.abort(); await active?.catch(() => {});
  });

  pi.registerCommand('human-expectations', {
    description: 'on [minutes], off, status, review, bootstrap [transcript], report, split, single',
    handler: async (args, ctx) => {
      const [action = 'report', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (action === 'on' || action === 'off') {
          if (action === 'off') { controller?.abort(); await active?.catch(() => {}); if (timer) clearTimeout(timer); timer = undefined; }
          const minutes = rest[0] ? Number(rest[0]) : 30;
          await job(ctx, { op: 'configure', enabled: action === 'on', minutes });
          enabled = action === 'on';
          if (enabled) { startWatching(ctx); mark(ctx); } else stopWatching();
          show(ctx, `${action === 'on' ? `Enabled: dirty project batches at idle boundaries, at most once per ${minutes} minutes. Initial/new-session intake reads complete transcripts.` : 'Disabled; Markdown record retained.'}\nExtraction uses the selected provider and consumes quota; foreground request hooks do not run for these separate calls. Reports may contain private words; review before sharing.`);
        } else if (action === 'review' || action === 'bootstrap') {
          show(ctx, await cycle(ctx, action === 'bootstrap', rest.length ? rest.join(' ') : undefined));
        } else if (action === 'report') {
          const session = rest[0] === 'this' ? ctx.sessionManager.getSessionId() : rest[0];
          const result = await job(ctx, { op: 'report', session });
          if (session) { show(ctx, result.sessionActivity); return; }
          const text = await readFile(result.report, 'utf8');
          show(ctx, text.split(/\n## HE-/)[0] + `\n\nFull Markdown: ${result.report}` + (text.length > 60000 ? '\nLarge report: /human-expectations split offers an outcome-based overview and linked detail files.' : ''));
        } else if (action === 'split' || action === 'single') {
          show(ctx, await job(ctx, { op: 'layout', split: action === 'split' }));
        } else if (action === 'status') show(ctx, await job(ctx, { op: 'status' }));
        else throw Error('Use on [minutes], off, status, review, bootstrap [transcript], report, split or single');
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); }
    },
  });
  pi.registerTool({
    name: 'human_expectations', label: 'Human expectations',
    description: 'Read project-wide intent, sources and coverage; review one pending batch; record measured acceptance evidence. Never treats a transcript claim as proof. Responses bounded to 20KB/200 lines. Read the bundled human-expectations skill for MECE and source-authority rules.',
    parameters: Type.Object({
      action: StringEnum(['report', 'status', 'source', 'review', 'record', 'structure'] as const),
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
      const result = params.action === 'review' ? await cycle(ctx) : await job(ctx, { op: params.action, ref: params.ref, update, revision: params.revision, structure: params.structure, session: params.session === 'this' ? ctx.sessionManager.getSessionId() : params.session });
      return { content: [{ type: 'text', text: compact(result) }], details: {} };
    },
  });
}
