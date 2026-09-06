import { parentPort, workerData } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, realpath, readdir, open, stat } from 'node:fs/promises';
import { join, parse, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { directory, document, load, lock, save, scan, prepare, reconcile, record, summary, exchange, safeDirectory, readRecord, atomic } from './core.mjs';
import { setStructure, drill, recheckQueue } from './structure.mjs';
import { sessionActivity } from './activity.mjs';
import { consolidationInput, applyTidy } from './consolidation.mjs';

async function writeRecord(path, value) {
  await atomic(path, document(value));
}
async function discover(project, roots) {
  const queue = [...new Set(roots)], files = [];
  while (queue.length) {
    const dir = queue.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const f = await open(path, 'r');
        try {
          let buffer = Buffer.alloc(512), { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
          let end = buffer.subarray(0, bytesRead).indexOf(10);
          if (end < 0 && bytesRead === buffer.length) {
            const larger = Buffer.alloc(65536); buffer.copy(larger);
            const more = await f.read(larger, bytesRead, larger.length - bytesRead, bytesRead);
            bytesRead += more.bytesRead; buffer = larger; end = buffer.subarray(0, bytesRead).indexOf(10);
          }
          if (end < 0) continue;
          const h = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          if (h.type === 'session' && typeof h.cwd === 'string' && await realpath(h.cwd).catch(() => h.cwd) === project) files.push(path);
        } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
        finally { await f.close(); }
      }
    }
  }
  return files.sort();
}
async function execute(job) {
  const project = await realpath(job.project);
  if ([parse(project).root, await realpath(homedir())].includes(project)) throw Error('Choose a project directory, not home/root');
  const dir = await safeDirectory(project), configPath = join(dir, '.CONTROL.md'), statusPath = join(dir, '.STATUS.md');
  const globalPath = job.globalDir ? join(job.globalDir, '.CONTROL.md') : null;
  const effective = async () => {
    const local = await readRecord(configPath, {}), global = globalPath ? await readRecord(globalPath, {}) : {};
    // Off by default. An explicit project setting always wins over the global one.
    const enabled = typeof local.enabled === 'boolean' ? local.enabled : global.enabled === true;
    return { ...local, enabled, minutes: local.minutes || global.minutes || 30, activation: typeof local.enabled === 'boolean' ? 'project' : global.enabled === true ? 'global' : 'default-off' };
  };
  if (job.op === 'status') return { ...await effective(), ...await readRecord(statusPath, {}) };
  if (job.op === 'projects') {
    // Which project directories would start collecting under a global on: every session cwd known to pi that is not explicitly off.
    const seen = new Map();
    for (const root of job.roots || []) for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      for (const f of await readdir(join(root, dir.name)).catch(() => [])) if (f.endsWith('.jsonl')) {
        try { const h = await open(join(root, dir.name, f), 'r'); const b = Buffer.alloc(2048); const { bytesRead } = await h.read(b, 0, 2048, 0); await h.close();
          const line = b.subarray(0, bytesRead).toString('utf8').split('\n')[0]; const hd = JSON.parse(line); if (hd.type === 'session' && typeof hd.cwd === 'string') seen.set(hd.cwd, (seen.get(hd.cwd) || 0) + 1); } catch {}
        break; // one header per directory is enough
      }
    }
    const out = [];
    for (const [cwd, n] of seen) { const local = await readRecord(join(cwd, '.human-expectations', '.CONTROL.md'), {}).catch(() => ({})); out.push({ project: cwd, sessions: n, projectSetting: typeof local.enabled === 'boolean' ? (local.enabled ? 'on' : 'off') : 'inherits' }); }
    return out.sort((a, b) => a.project.localeCompare(b.project));
  }
  if (job.op === 'configure' && job.scope === 'global') {
    if (!globalPath) throw Error('No global settings directory');
    await mkdir(job.globalDir, { recursive: true, mode: 0o700 });
    await writeRecord(globalPath, { ...await readRecord(globalPath, {}), enabled: job.enabled, minutes: job.minutes });
    return effective();
  }
  if (job.op === 'configure') return lock(project, '.writer-lock', async () => {
    const config = { ...await readRecord(configPath, {}), enabled: job.enabled, minutes: job.minutes };
    if (job.budgetTokens !== undefined) { if (!Number.isFinite(job.budgetTokens) || job.budgetTokens < 500 || job.budgetTokens > 50000) throw Error('Budget must be 500–50000 tokens'); config.budgetTokens = job.budgetTokens; }
    if (job.backfill) {
      if (!['none', 'session', 'all'].includes(job.backfill)) throw Error('Backfill scope must be none, session or all');
      Object.assign(config, { backfill: job.backfill, since: job.backfill === 'all' ? null : new Date().toISOString(), sessionFile: job.sessionFile || null });
    }
    if (!Number.isFinite(config.minutes) || config.minutes < 1 || config.minutes > 1440) throw Error('Minutes must be 1–1440');
    if (job.automationPrefixes) {
      if (!Array.isArray(job.automationPrefixes) || job.automationPrefixes.some(s => typeof s !== 'string' || s.length < 8)) throw Error('Automation prefixes must be explicit strings of at least 8 characters');
      config.automationPrefixes = job.automationPrefixes;
    }
    await writeRecord(configPath, config); return effective();
  });
  if (job.op === 'claim') {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, '.review-lock.md'), document({ token: job.token, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); return true;
  }
  if (job.op === 'release') {
    const path = join(dir, '.review-lock.md'), lease = await readRecord(path);
    if (lease?.token !== job.token) throw Error('Cannot release another reviewer’s lock');
    await unlink(path); return true;
  }
  if (job.op === 'prepare') return prepare(await load(project), job.maxInputs, job.maxBytes, job.compact, job.since);
  if (job.op === 'prepareStructure') return consolidationInput(await load(project, { sources: false }));
  if (job.op === 'source') {
    const state = await load(project), item = state.inputs.find(i => i.ref === job.ref);
    if (!item) throw Error('Unknown source'); return { item, exchange: exchange(state, item) };
  }
  if (job.op === 'report') {
    // Readers never take the writer lock; every writer already regenerates EXPECTATIONS.md on save.
    const state = await load(project, { sources: !!job.session }); // drill/summary need no sources
    const activity = job.session ? sessionActivity(state, job.session) : undefined;
    if (job.node !== undefined) return drill(state, job.node || undefined);
    if (job.recheck) return { recheck: recheckQueue(state) };
    return { ...summary(state), ...(activity ? { sessionActivity: activity } : {}), report: join(dir, 'EXPECTATIONS.md') };
  }
  return lock(project, '.writer-lock', async () => {
    const needsSources = ['scan', 'apply'].includes(job.op);
    let state = await load(project, { sources: needsSources }), detail = {};
    if (job.op === 'scan') {
      const config = await readRecord(configPath, {});
      const files = job.files || await discover(project, job.roots || []);
      detail = { added: 0, bytes: 0, sessionsDiscovered: files.length };
      for (const file of files) {
        if (job.files && !(await stat(file)).isFile()) throw Error(`Explicit transcript is not a file: ${file}`);
        const r = await scan(state, file, config.automationPrefixes || [], config); detail.added += r.added; detail.bytes += r.bytes;
      }
      // Without authenticated sender evidence, routed/replayed text cannot become human authority.
      for (const i of state.inputs) if (!i.decision && i.origin === 'routed-unverified') { state.sourcesDirty = true; i.decision = {
        origin: 'uncertain', nature: 'needs-context', reason: 'Routed/replayed sender is not authenticated as human; retained for attribution review', expectations: [],
      }; }
      state.lastScan = new Date().toISOString(); // Advance the cadence even on an unchanged/empty scan.
      state.revision++;
    } else if (job.op === 'apply') {
      state = reconcile(state, job.batch, job.result);
      if (job.run) {
        const prior = state.runs.find(r => r.id === job.run.id);
        if (prior) Object.assign(prior, { failed: false, recovered: true }); else state.runs.push(job.run);
      }
    }
    else if (job.op === 'record') {
      const proofs = new Map();
      for (const check of job.update?.checks || []) {
        const path = await realpath(resolve(project, check.artifact));
        if (!path.startsWith(project + sep) || !(await stat(path)).isFile()) throw Error('Evidence must be an existing project-local file, not a bare claim or external pointer');
        if (!proofs.has(path)) {
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(path)) digest.update(chunk);
          proofs.set(path, digest.digest('hex'));
        }
        check.artifact = relative(project, path); check.artifactSha256 = proofs.get(path);
      }
      state = record(state, job.update);
    }
    else if (job.op === 'layout') {
      if (job.split && state.expectations.length > 7 && !state.structure) throw Error('Create a reviewed 3–7-member outcome hierarchy before splitting this large report');
      state.split = job.split; state.revision++;
    }
    else if (job.op === 'tidy') {
      if (job.revision !== state.revision) throw Error('Stale tidy');
      state = applyTidy(state, job.proposal);
      if (job.run) state.runs.push(job.run);
    }
    else if (job.op === 'structure') {
      if (job.revision !== state.revision) throw Error('Stale structure update');
      const current = consolidationInput(state);
      if (job.digest && job.digest !== current.digest) throw Error('Stale consolidation catalogue');
      state = setStructure(state, job.structure);
      state.structureDigest = current.digest;
      if (job.run) state.runs.push(job.run);
    }
    else if (job.op === 'error') {
      state.lastError = job.message;
      if (job.run && !state.runs.some(r => r.id === job.run.id)) state.runs.push({ ...job.run, failed: true });
      if (job.rejectedOutput) await writeRecord(join(dir, '.REJECTED.md'), { error: job.message, response: job.rejectedOutput });
    }
    else throw Error(`Unknown operation ${job.op}`);
    if (job.op !== 'error') state.lastError = null;
    await save(state);
    const status = { ...summary(state), lastError: state.lastError, ...detail };
    await writeRecord(statusPath, status); return status;
  });
}
execute(workerData).then(value => parentPort.postMessage({ ok: true, value })).catch(error => parentPort.postMessage({ ok: false, error: String(error?.stack || error) }));
