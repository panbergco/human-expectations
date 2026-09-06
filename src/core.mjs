import { readFile, writeFile, mkdir, open, rename, unlink, stat, realpath, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { rollups, groupNodes } from './structure.mjs';
import { expandCompact } from './compact.mjs';
import { completeLines } from './lines.mjs';

export const hash = s => createHash('sha256').update(s).digest('hex');
const stamp = () => new Date().toISOString();
export const textOf = c => typeof c === 'string' ? c : (Array.isArray(c) ? c : []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
const need = (s, name) => { if (typeof s !== 'string' || !s.trim()) throw Error(`Missing ${name}`); return s; };
const uniq = xs => [...new Set(xs)];
export const directory = project => join(project, '.human-expectations');
export const document = value => '# Internal record — generated, do not edit while updating\n\n```json\n' + JSON.stringify(value) + '\n```\n';
export const parseDocument = text => JSON.parse(text.slice(text.indexOf('```json\n') + 8, text.lastIndexOf('\n```')));
export async function safeDirectory(project) {
  const dir = directory(project);
  const info = await lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw Error('Refusing a redirected/non-directory expectation store');
  return dir;
}
export async function readRecord(path, fallback) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw Error('Refusing a symlinked internal record');
    return parseDocument(await readFile(path, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export const fresh = project => ({ version: 2, project, revision: 0, inputs: [], expectations: [], files: {}, runs: [], lastScan: null, lastReview: null });
export async function load(project) {
  try {
    const s = await readRecord(join(await safeDirectory(project), '.STATE.md'), fresh(project));
    if (s.version !== 2 || s.project !== project || !Array.isArray(s.inputs) || !Array.isArray(s.expectations)) throw Error('Invalid expectation state; refusing overwrite');
    return s;
  } catch (e) { if (e.code === 'ENOENT') return fresh(project); throw e; }
}
export async function atomic(path, content) {
  const temp = `${path}.${randomUUID()}.tmp.md`;
  try {
    const f = await open(temp, 'wx', 0o600);
    try { await f.writeFile(content); await f.sync(); } finally { await f.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function lock(project, name, fn) {
  const dir = await safeDirectory(project);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name + '.md');
  const f = await open(path, 'wx', 0o600).catch(e => { if (e.code === 'EEXIST') throw Error(`Busy: ${path}; after a crash verify the recorded PID is dead before removing this lock`); throw e; });
  try { await f.writeFile(document({ pid: process.pid, at: stamp() })); return await fn(); }
  finally { await f.close(); await unlink(path); }
}
export async function save(state) {
  const dir = directory(state.project);
  await atomic(join(dir, '.STATE.md'), document(state));
  const full = markdown(state);
  if (state.split) {
    const overview = full.split(/\n## HE-/)[0];
    const links = view => rollups(view).map(g => `- [${g.id} — ${g.title}](${g.id}.md)`).join('\n');
    await atomic(join(dir, 'EXPECTATIONS.md'), overview + '\n\n## Detail by human outcome\n' + links(state) + '\n');
    for (const e of state.expectations) await atomic(join(dir, `${e.id}.md`), '[Back to overview](EXPECTATIONS.md)\n\n' + markdown({ ...state, structure: null, expectations: [e] }));
    for (const node of groupNodes(state.structure)) {
      const rows = rollups({ ...state, structure: { groups: [node] } })[0].rows;
      const view = { ...state, expectations: rows, structure: { dimension: node.dimension, groups: node.children } };
      await atomic(join(dir, `${node.id}.md`), `[Back to overview](EXPECTATIONS.md)\n\n# ${node.title}\n\n` + markdown(view).split(/\n## HE-/)[0] + '\n\n' + links(view));
    }
    const unplaced = rollups(state).find(g => g.id === 'UNPLACED');
    if (unplaced) await atomic(join(dir, 'UNPLACED.md'), markdown({ ...state, structure: null, expectations: unplaced.rows }));
  } else await atomic(join(dir, 'EXPECTATIONS.md'), full);
}

// These are explicit automation-shaped templates, not a claim that all other user-role text is human.
export function origin(text, prefixes = []) {
  if (prefixes.some(prefix => typeof prefix === 'string' && prefix.length >= 8 && text.startsWith(prefix))) return 'automation-template';
  if (/^\[Source:[^\n]*Destination:[^\n]*\bpid\s+\d+/i.test(text)
      || /^\[from session:[^\n]*\bpid\s+\d+/i.test(text)
      || text.startsWith('[ARRIVING AGAIN — you were sent this ')) return 'routed-unverified';
  return 'unclassified';
}

/** Full first read; appended bytes thereafter. Compact nodes let context follow branches across batches. */
export async function scan(state, file, prefixes = []) {
  file = resolve(file);
  const info = await stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!info) return { added: 0, bytes: 0 };
  let cursor = state.files[file];
  if (cursor && info.size === cursor.observedSize && cursor.ino === info.ino && cursor.mtime === info.mtimeMs) return { added: 0, bytes: 0 };
  if (!info.size) throw Error('Transcript has no complete session header yet');
  if (!cursor || info.size < cursor.offset || cursor.ino !== info.ino || (info.size === cursor.offset && cursor.mtime !== info.mtimeMs)) cursor = { offset: 0, header: null, nodes: Object.create(null) };
  const start = cursor.offset;
  const seen = new Set(state.inputs.map(i => i.key)), seenRefs = new Map(state.inputs.map(i => [i.ref, i.text]));
  let bytes = 0, added = 0;
  for await (const raw of completeLines(file, start, info.size - 1)) {
        const e = JSON.parse(raw.toString('utf8'));
        bytes += raw.length;
        if (!cursor.header) {
          if (e.type !== 'session' || !e.id || typeof e.cwd !== 'string') throw Error('Invalid transcript header');
          if (await realpath(e.cwd) !== state.project) throw Error(`Transcript belongs to ${e.cwd}, not ${state.project}`);
          cursor.header = e;
          continue;
        }
        const role = e.type === 'message' ? e.message?.role : null;
        if (!e.id) {
          if (role === 'user') throw Error('User message has no stable entry ID; cannot claim provenance coverage');
          continue;
        }
        if (typeof e.id !== 'string') throw Error('Invalid transcript entry ID');
        const text = ['user', 'assistant'].includes(role) ? textOf(e.message.content) : '';
        cursor.nodes[e.id] = { id: e.id, parentId: e.parentId, role, text: text.slice(-1800), truncated: text.length > 1800, timestamp: e.timestamp };
        if (role !== 'user') continue;
        const ref = `${cursor.header.id}/${e.id}`;
        if (seenRefs.has(ref)) {
          if (seenRefs.get(ref) !== text) throw Error(`Previously captured source ${ref} was rewritten; explicit reconciliation required`);
          continue;
        }
        const key = hash(JSON.stringify([e.id, e.timestamp, text]));
        if (seen.has(key)) continue;
        const provenance = origin(text, prefixes);
        state.inputs.push({ key, ref: `${cursor.header.id}/${e.id}`, session: cursor.header.id, entry: e.id, file,
          timestamp: e.timestamp, text, origin: provenance,
          hasImages: Array.isArray(e.message.content) && e.message.content.some(b => b.type === 'image'),
          decision: provenance === 'automation-template' ? { origin: 'automation', nature: 'framework', reason: 'Recognised explicit framework/keepalive template (pattern evidence, not authenticated authorship)', expectations: [] } : null });
        seen.add(key); seenRefs.set(ref, text); added++;
  }
  if (!cursor.header) throw Error('Transcript has no complete session header yet');
  cursor.offset = start + bytes; cursor.ino = info.ino; cursor.mtime = info.mtimeMs; cursor.observedSize = info.size;
  state.files[file] = cursor;
  cursor.children = Object.create(null);
  for (const n of Object.values(cursor.nodes)) (cursor.children[n.parentId] ||= []).push(n.id);
  for (const item of state.inputs.filter(i => i.file === file && i.origin === 'unclassified' && (!i.context || i.context.contextPending))) {
    const wasPending = item.context?.contextPending;
    const x = exchange(state, item);
    item.context = { before: x.before.length ? x.before : item.context?.before || [], after: x.after, contextPending: x.contextPending };
    if (wasPending && !x.contextPending && (item.decision?.nature === 'needs-context' || item.decision?.origin === 'uncertain')) item.decision = null;
  }
  // Bound persisted branch context; original transcript remains available for a deeper lookup.
  cursor.nodes = Object.fromEntries(Object.entries(cursor.nodes).slice(-1000));
  delete cursor.children;
  state.inputs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.ref.localeCompare(b.ref));
  state.lastScan = stamp();
  return { added, bytes };
}

export function exchange(state, item) {
  if (item.context && !item.context.contextPending) return { ref: item.ref, timestamp: item.timestamp, originHint: item.origin, text: item.text, hasImages: item.hasImages, ...item.context };
  const cursor = state.files[item.file] || {}, nodes = cursor.nodes || {};
  const before = []; let id = nodes[item.entry]?.parentId; const visited = new Set();
  while (id && !visited.has(id) && before.length < 2) {
    visited.add(id); const n = nodes[id]; if (!n) break;
    if (n.text && ['user', 'assistant'].includes(n.role)) before.unshift(n);
    id = n.parentId;
  }
  const children = cursor.children || Object.create(null);
  if (!cursor.children) for (const n of Object.values(nodes)) (children[n.parentId] ||= []).push(n.id);
  const after = [], queue = [...(children[item.entry] || [])], seen = new Set();
  while (queue.length && after.length < 2) {
    const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
    const n = nodes[id]; if (!n || n.role === 'user') continue;
    if (n.role === 'assistant' && n.text) after.push(n);
    queue.push(...(children[id] || []));
  }
  return { ref: item.ref, timestamp: item.timestamp, originHint: item.origin, text: item.text, hasImages: item.hasImages,
    before, after, contextPending: after.length === 0 };
}

export function prepare(state, maxInputs = 48, maxBytes = 110000) {
  const batch = []; let bytes = 0;
  const originByEntry = new Map(state.inputs.map(i => [JSON.stringify([i.entry, i.timestamp]), i.origin]));
  const pending = state.inputs.filter(i => !i.decision || i.decision.pendingIntent), missed = new Set(state.lastBatch?.missingRefs || []);
  const retry = pending.filter(i => missed.has(i.ref));
  for (const i of (retry.length ? retry : pending)) {
    // Routed messages need attribution, not extraction of requirements allegedly spoken by an agent.
    const x = i.origin === 'routed-unverified' ? { ref: i.ref, timestamp: i.timestamp, originHint: i.origin, text: i.text } : exchange(state, i);
    if (x.before) x.before = x.before.map(n => ({ ...n, originHint: n.role === 'user' ? originByEntry.get(JSON.stringify([n.id, n.timestamp])) || 'unclassified' : 'assistant-context' }));
    const length = Buffer.byteLength(JSON.stringify(x));
    if (length > maxBytes) throw Error(`Input ${i.ref} exceeds batch limit; original retained, explicit review required`);
    if (batch.length && (batch.length === maxInputs || bytes + length > maxBytes)) break;
    batch.push(x); bytes += length;
  }
  const existing = state.expectations.map(e => ({ id: e.id, title: e.title, intent: e.intent, kind: e.kind,
    supersededBy: e.supersededBy, criteria: e.criteria.map(c => ({ id: c.id, obligation: c.obligation, check: c.check })), latestSources: e.sources.slice(-2) }));
  const references = Object.fromEntries(batch.map((x, n) => [`IN-${n + 1}`, x.ref]));
  const payload = { project: state.project, revision: state.revision, existing, references,
    inputs: batch.map((x, n) => ({ ...x, session: x.ref.split('/')[0], ref: `IN-${n + 1}` })) };
  if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes + 70000) throw Error('Expectation index exceeds review budget; reconcile the outcome grouping before continuing');
  return payload;
}

/** Structural validation does not certify semantic MECE or human identity. Those remain explicit judgments. */
export function reconcile(state, batch, result) {
  if (batch.revision !== state.revision) throw Error('Stale review; preserve pending inputs and retry against current state');
  const resolveRef = ref => batch.references?.[ref] || ref;
  result = expandCompact(result, state, resolveRef);
  if (!Array.isArray(result.decisions) || !Array.isArray(result.expectations)) throw Error('Return expectation patches and a classification for every input');
  const decisions = result.decisions.flatMap(d => {
    const { refs, ...fields } = d;
    return (Array.isArray(refs) ? refs : [d.ref]).map(ref => ({ ...fields, ref: resolveRef(ref) }));
  });
  if (!decisions.length || decisions.length > batch.inputs.length) throw Error(`Invalid coverage: ${decisions.length} judgments for ${batch.inputs.length} inputs`);
  const next = structuredClone(state), byRef = new Map(next.inputs.map(i => [i.ref, i]));
  const allowed = new Set(batch.inputs.map(i => resolveRef(i.ref))), covered = new Set();
  const aliases = new Map(next.expectations.map(e => [e.id, e]));
  const owners = new Map();
  const rememberOwner = (id, row) => owners.set(id, owners.has(id) && owners.get(id) !== row ? null : row);
  for (const row of next.expectations) for (const c of row.criteria) rememberOwner(c.id, row);
  for (const proposal of result.expectations) {
    for (const f of ['id', 'title', 'intent', 'kind']) need(proposal[f], f);
    if (!['outcome', 'standing'].includes(proposal.kind)) throw Error('Invalid expectation kind');
    let row = aliases.get(proposal.id);
    // Unknown labels in a fully specified model proposal are local aliases, not durable IDs.
    // The store, not the model, allocates stable sequential identifiers.
    if (row?.supersededBy) throw Error('Do not revive superseded intent');
    if (!row) {
      row = { id: `HE-${String(next.expectations.length + 1).padStart(4, '0')}`, title: proposal.title, intent: proposal.intent,
        kind: proposal.kind, sources: [], criteria: [], history: [], holder: 'unassigned', reconciled: false, scopeVersion: 0 };
      next.expectations.push(row); aliases.set(proposal.id, row); aliases.set(row.id, row);
    }
    if (!Array.isArray(proposal.criteria) || (!row.criteria.length && !proposal.criteria.length)) throw Error('A new expectation needs independently checkable acceptance obligations');
    const incoming = new Set();
    row.history.push({ at: stamp(), reason: need(proposal.reason, 'relationship reasoning'), before: { title: row.title, intent: row.intent, criteria: structuredClone(row.criteria) } });
    row.title = proposal.title; row.intent = proposal.intent; row.kind = proposal.kind;
    for (const c of proposal.criteria) {
      need(c.id, 'criterion id'); need(c.obligation, 'obligation'); need(c.check, 'check');
      let current = row.criteria.find(old => old.id === c.id)
        || row.criteria.find(old => old.obligation === c.obligation && old.check === c.check);
      // Criterion labels are scoped to this outcome; an unknown label can never mutate another outcome.
      if (incoming.has(c.id)) throw Error('Duplicate criterion'); incoming.add(c.id);
      if (!current) {
        current = { id: `${row.id}.${row.criteria.length + 1}`, obligation: c.obligation, check: c.check, verdict: 'unknown', evidence: null, history: [] };
        row.criteria.push(current); row.scopeVersion++;
      } else if (current.obligation !== c.obligation || current.check !== c.check) {
        current.history.push({ at: stamp(), ...current.evidence, verdict: current.verdict });
        current.verdict = 'unknown'; current.evidence = null; row.scopeVersion++;
      }
      current.obligation = c.obligation; current.check = c.check;
      rememberOwner(c.id, row); rememberOwner(current.id, row);
    }
    // Cannot quietly improve a denominator by deleting inconvenient obligations.
    // This is an upsert: omitted existing criteria remain, so an omission cannot improve coverage.
    row.reconciled = false; // Extraction alone is NOT a completeness audit.
  }
  for (const d of decisions) {
    if (!allowed.has(d.ref) || covered.has(d.ref)) throw Error('Unknown/duplicate input reference'); covered.add(d.ref);
    if (!['human-supported', 'automation', 'uncertain'].includes(d.origin)) throw Error('Invalid origin judgment');
    if (!['expectation', 'approval', 'steering', 'noise', 'framework', 'needs-context'].includes(d.nature)) throw Error('Invalid disposition');
    need(d.reason, 'disposition reason');
    if (!Array.isArray(d.expectations)) throw Error('Expected related expectation IDs');
    const assertsIntent = d.origin === 'human-supported' && ['expectation', 'approval'].includes(d.nature);
    if (assertsIntent && d.nature === 'expectation' && !d.expectations.length) throw Error(`Input ${d.ref}: an expectation needs a linked outcome; use needs-context when unresolved.`);
    const item = byRef.get(d.ref);
    const ids = [];
    for (const alias of d.expectations) {
      const row = aliases.get(alias) || owners.get(alias); if (!row) throw Error(`Unknown or ambiguous related expectation/criterion ${alias}`);
      if (assertsIntent) {
        const quote = d.quote || item.text.slice(0, 400);
        need(quote, 'verbatim quote'); if (!item.text.includes(quote)) throw Error('Quote not present in source');
        if (!row.sources.some(s => s.ref === item.ref)) row.sources.push({ ref: item.ref, quote, timestamp: item.timestamp });
      }
      // Non-durable inputs can cross-reference an outcome without becoming a human requirement.
      if (d.relation === 'regression' && d.origin === 'human-supported') for (const c of row.criteria) {
        if (c.verdict === 'passed') { c.history.push({ at: stamp(), verdict: c.verdict, evidence: c.evidence }); c.verdict = 'unknown'; c.evidence = null; }
      }
      ids.push(row.id);
    }
    item.decision = { ...d, expectations: ids, assertsIntent };
    if (d.pendingIntent) item.intentDeferrals = (item.intentDeferrals || 0) + 1;
  }
  for (const change of result.supersessions || []) {
    const old = aliases.get(change.old), replacement = change.replacement ? aliases.get(change.replacement) : null;
    const source = byRef.get(resolveRef(change.ref));
    if (!old || old.supersededBy || (change.replacement && !replacement) || old === replacement || source?.decision?.origin !== 'human-supported') throw Error('Invalid source-backed supersession');
    need(change.quote, 'supersession quote'); need(change.reason, 'supersession reason');
    if (!source.text.includes(change.quote)) throw Error('Supersession quote is not in the human source');
    old.history.push({ at: stamp(), reason: change.reason, source: source.ref, quote: change.quote, before: { supersededBy: old.supersededBy || null } });
    old.supersededBy = replacement?.id || 'withdrawn';
  }
  // No new row without a human-backed source, including hallucinated orphan rows in the model response.
  const orphans = next.expectations.filter(e => !e.sources.length);
  if (orphans.length) throw Error(`No human-backed source for: ${orphans.map(e => e.id + ' ' + e.title).join('; ')}. Remove unsupported proposals or correct the source links without changing uncertain authorship to human.`);
  for (const p of result.unverifiedProposals || []) {
    const key = hash(JSON.stringify([p.proposal.id, p.sources]));
    next.unverifiedProposals ||= [];
    if (!next.unverifiedProposals.some(old => old.key === key)) next.unverifiedProposals.push({ ...p, key, at: stamp() });
  }
  const deferred = decisions.filter(d => d.pendingIntent).map(d => d.ref);
  next.lastBatch = { requested: batch.inputs.length, judged: covered.size, missingRefs: [...new Set([...allowed].filter(ref => !covered.has(ref)).concat(deferred))] };
  next.revision++; next.lastReview = stamp();
  return next;
}

export function record(state, update) {
  if (update.revision !== state.revision) throw Error('Stale evidence update');
  const next = structuredClone(state);
  const row = next.expectations.find(e => e.id === update.expectation);
  if (!row || row.supersededBy) throw Error('Unknown or superseded expectation');
  need(update.holder, 'holder'); row.holder = update.holder;
  if (update.reconciled === true) {
    need(update.coverageEvidence, 'MECE/source reconciliation evidence');
    row.reconciled = true; row.coverageEvidence = update.coverageEvidence;
  }
  if (!Array.isArray(update.checks)) throw Error('Checks must be an array');
  for (const check of update.checks) {
    const c = row.criteria.find(c => c.id === check.id); if (!c) throw Error('Unknown acceptance obligation');
    if (!['passed', 'failed', 'blocked', 'unknown'].includes(check.verdict)) throw Error('Invalid verdict');
    for (const f of ['observed', 'method', 'artifact', 'scope', 'checkedBy', 'session']) need(check[f], f);
    const observedAt = check.observedAt || stamp();
    if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now() + 60000) throw Error('Observation timestamp is invalid or in the future');
    const evidence = { ...check, at: observedAt, recordedAt: stamp(), recordedBy: update.recordedBy || update.session };
    if (c.evidence?.at && Date.parse(c.evidence.at) > Date.parse(observedAt)) {
      c.history.push({ at: stamp(), verdict: check.verdict, evidence, lateArrival: true });
      continue; // Historical imports cannot overwrite a newer measurement.
    }
    c.history.push({ at: stamp(), verdict: c.verdict, evidence: c.evidence });
    const conflict = c.evidence?.at === observedAt && c.verdict !== check.verdict;
    c.verdict = conflict ? 'unknown' : check.verdict;
    c.evidence = { ...evidence, ...(conflict ? { conflict: 'Conflicting verdicts at the same observation time; inspect both records' } : {}) };
  }
  row.history.push({ at: stamp(), reason: 'Recorded measured evidence; not automatically executed or authenticated', session: update.session });
  next.revision++; return next;
}

export function summary(state) {
  const originCounts = {}, verdicts = { passed: 0, failed: 0, blocked: 0, unknown: 0 };
  for (const i of state.inputs) { const label = i.decision?.origin || i.origin; originCounts[label] = (originCounts[label] || 0) + 1; }
  for (const e of state.expectations.filter(e => !e.supersededBy && e.kind === 'outcome')) for (const c of e.criteria) verdicts[c.verdict]++;
  return { revision: state.revision, inputs: state.inputs.length, pending: state.inputs.filter(i => !i.decision || i.decision.pendingIntent).length,
    needsContext: state.inputs.filter(i => i.decision?.nature === 'needs-context' || i.decision?.origin === 'uncertain' || i.decision?.needsReview).length,
    unverifiedProposals: state.unverifiedProposals?.length || 0,
    expectations: state.expectations.length, outcomeGroups: rollups(state).length, sessions: Object.keys(state.files).length,
    originCounts, verdicts, lastScan: state.lastScan, lastReview: state.lastReview, lastError: state.lastError || null,
    lastBatch: state.lastBatch || null,
    recordedCost: state.runs.reduce((n, r) => n + (r.usage?.cost?.total || 0), 0), modelCalls: state.runs.length };
}
const line = s => String(s ?? '—').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
const coverage = e => { const total = e.criteria.length, passed = e.criteria.filter(c => c.verdict === 'passed').length; return { total, passed, pct: total ? Math.round(100 * passed / total) : null }; };
export function markdown(state) {
  const s = summary(state);
  const lines = ['# Human expectations — intent versus measured delivery', '', `Project: ${state.project}`, `Last intake: ${s.lastScan ?? 'never'} · Last intent review: ${s.lastReview ?? 'never'} · Revision ${s.revision}`,
    `${s.inputs} source inputs across ${s.sessions} transcripts · ${s.pending} pending · ${s.needsContext} need context · ${s.expectations} expectation records / ${s.outcomeGroups} outcome groups`,
    `Unverified proposals held outside completion counts: ${s.unverifiedProposals}`,
    `Last extraction error: ${s.lastError || 'none'}`,
    `Origin judgments: ${Object.entries(s.originCounts).map(([k, v]) => `${k}: ${v}`).join(' · ')}`, '',
    '**Bars show recorded acceptance coverage, not effort or an estimate of software completion. Unknown receives no credit. Initial extraction does not verify delivery.**', '',
    '| Human-level outcome | Evidence-backed progress | What is still unproven |', '|---|---|---|'];
  for (const e of rollups(state)) {
    const showBar = criteria => {
      const { total, passed, pct } = coverage({ criteria }), blocks = Math.floor((pct || 0) / 10);
      return `${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${pct ?? '—'}% (${passed}/${total})`;
    };
    const progress = e.kind === 'mixed'
      ? `Outcomes ${showBar(e.rows.filter(r => r.kind === 'outcome').flatMap(r => r.criteria))}; standing compliance ${showBar(e.rows.filter(r => r.kind === 'standing').flatMap(r => r.criteria))}`
      : showBar(e.criteria);
    lines.push(`| ${e.id} · ${line(e.title)} | ${progress}${e.reconciled ? '' : ' provisional'} | ${e.criteria.filter(c => c.verdict !== 'passed').length} checks not passing · ${e.kind === 'standing' ? 'standing compliance, not permanent completion' : e.kind} |`);
  }
  for (const e of state.expectations) {
    lines.push('', `## ${e.id} — ${e.title}${e.supersededBy ? ` (superseded: ${e.supersededBy})` : ''}`, '', e.intent, '', `Holder: ${e.holder} · Scope version: ${e.scopeVersion} · MECE/source coverage: ${e.reconciled ? 'recorded review' : 'not yet audited'}`,
      '| Obligation | Verdict | Measured observation | Evidence / scope / checker |', '|---|---|---|---|');
    for (const c of e.criteria) lines.push(`| ${c.id} ${line(c.obligation)} | ${c.verdict} | ${line(c.evidence?.observed || 'Not checked')} | ${line(c.evidence ? `${c.evidence.artifact}; ${c.evidence.scope}; ${c.evidence.checkedBy}; ${c.evidence.at}` : 'No measured evidence recorded')} |`);
    lines.push('', '### Original human words');
    for (const source of e.sources) lines.push(`- ${source.timestamp} ⟦${source.ref}⟧: ${line(source.quote)}`);
  }
  if (state.unverifiedProposals?.length) {
    lines.push('', '## Unverified proposals — not human requirements', '');
    for (const p of state.unverifiedProposals) lines.push(`- ${line(p.proposal.title || p.proposal.id)}: ${line(p.reason)} · ${p.sources.map(ref => `⟦${ref}⟧`).join(', ')}`);
  }
  lines.push('', '## Limits', 'Human-supported is a contextual classification, not authenticated identity. Routed/uncertain inputs are not human authority. Evidence is recorded by the caller, not executed by this extension. Source references and full judgments are in .STATE.md.',
    `Separate extraction requests: ${s.modelCalls}; reported cost $${s.recordedCost.toFixed(4)} (not included in foreground pi totals).`, '');
  return lines.join('\n');
}
