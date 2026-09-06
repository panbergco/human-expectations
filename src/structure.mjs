import { freshness } from './freshness.mjs';
const active = state => state.expectations.filter(e => !e.supersededBy);
const tagged = e => e.criteria.map(c => Object.assign(Object.create(null), c, { __e: e }));

export function setStructure(state, plan) {
  if (!plan || typeof plan.dimension !== 'string' || !plan.dimension.trim() || !Array.isArray(plan.groups)) throw Error('Name one cut dimension and supply groups');
  const known = new Set(active(state).map(e => e.id)), used = new Set(), groupIds = new Set();
  function walk(nodes, top = false, depth = 0) {
    // Three levels at most: outcomes → sub-outcomes → expectations. Checks sit under expectations and are not a grouping level.
    if (depth > 1) throw Error('At most two grouping levels above expectations (outcome → sub-outcome → expectation)');
    if (!Array.isArray(nodes) || nodes.length > 7 || nodes.length < (top && known.size < 3 ? known.size : 3)) throw Error('Groups must have 3–7 members; nest rather than widen');
    for (const node of nodes) {
      if (typeof node === 'string') {
        if (!known.has(node) || used.has(node)) throw Error('Unknown or multiply-owned expectation');
        used.add(node);
      } else {
        if (!node || !/^GX-\d{4}$/.test(node.id) || groupIds.has(node.id) || typeof node.title !== 'string' || !node.title.trim() || typeof node.dimension !== 'string' || !node.dimension.trim()) throw Error('Each group needs a unique GX-0001-style ID, conclusion heading and cut dimension');
        groupIds.add(node.id); walk(node.children, false, depth + 1);
      }
    }
  }
  walk(plan.groups, true);
  if (used.size !== known.size) throw Error('Source structure must cover every active expectation exactly once');
  const next = structuredClone(state);
  (next.structureHistory ||= []).push({ at: new Date().toISOString(), before: next.structure || null });
  next.structure = structuredClone(plan); next.revision++;
  return next;
}

export function rollups(state) {
  const byId = new Map(active(state).map(e => [e.id, e])), assigned = new Set();
  const rowsOf = node => typeof node === 'string' ? (byId.has(node) ? [byId.get(node)] : []) : node.children.flatMap(rowsOf);
  const groups = state.structure?.groups || [...byId.keys()];
  const result = groups.map(node => {
    const rows = rowsOf(node).filter(e => { if (assigned.has(e.id)) return false; assigned.add(e.id); return true; });
    return { id: typeof node === 'string' ? node : node.id, title: typeof node === 'string' ? byId.get(node)?.title || node : node.title,
      rows, criteria: rows.flatMap(tagged), reconciled: rows.length > 0 && rows.every(e => e.reconciled),
      kind: rows.every(e => e.kind === 'standing') ? 'standing' : rows.every(e => e.kind === 'outcome') ? 'outcome' : 'mixed' };
  });
  const unplaced = [...byId.values()].filter(e => !assigned.has(e.id));
  if (unplaced.length) result.push({ id: 'UNPLACED', title: 'New intent awaits structural reconciliation', rows: unplaced, criteria: unplaced.flatMap(tagged), reconciled: false, kind: 'mixed' });
  return result.filter(r => r.rows.length);
}

export function groupNodes(plan) {
  return (plan?.groups || []).filter(n => typeof n !== 'string').flatMap(n => [n, ...groupNodes({ groups: n.children })]);
}

const bar = criteria => {
  const total = criteria.length;
  const passed = criteria.filter(c => c.verdict === 'passed' && freshness(c, c.__e).state === 'current').length;
  const stale = criteria.filter(c => c.verdict === 'passed' && freshness(c, c.__e).state !== 'current').length;
  const pct = total ? Math.round(100 * passed / total) : null, blocks = Math.floor((pct || 0) / 10);
  return { passed, stale, total, pct, bar: `${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${pct ?? '—'}% (${passed}/${total})${stale ? ` · ${stale} stale pass${stale > 1 ? 'es' : ''}` : ''}` };
};
/** Drill-down view: level 1 = outcomes, level 2 = sub-outcomes, level 3 = expectations, then their checks. */
export function drill(state, id) {
  const byId = new Map(active(state).map(e => [e.id, e]));
  const rowsOf = node => typeof node === 'string' ? (byId.has(node) ? [byId.get(node)] : []) : node.children.flatMap(rowsOf);
  const describe = (node, level) => {
    const rows = rowsOf(node), criteria = rows.flatMap(tagged);
    const e = typeof node === 'string' ? byId.get(node) : null;
    return { id: e ? e.id : node.id, level, kind: e ? 'expectation' : 'group', title: e ? e.title : node.title, ...bar(criteria),
      unverified: criteria.filter(c => c.verdict !== 'passed').length, expectations: rows.length, children: e ? undefined : node.children.length };
  };
  if (!id) return { level: 1, title: 'Outcomes', rows: (state.structure?.groups || [...byId.keys()]).map(n => describe(n, 1)) };
  const e = byId.get(id);
  if (e) return { level: 3, id: e.id, title: e.title, intent: e.intent, kind: e.kind, holder: e.holder, ...bar(tagged(e)),
    checks: e.criteria.map(c => ({ id: c.id, obligation: c.obligation, verdict: c.verdict, freshness: freshness(c, e), observed: c.evidence?.observed || null, verifiedAt: c.evidence?.at || null, scope: c.evidence?.scope || null })),
    sources: e.sources.map(s => ({ ref: s.ref, when: s.timestamp, words: s.quote })) };
  for (const g of groupNodes(state.structure)) if (g.id === id) {
    const level = (state.structure.groups || []).some(n => n === g || n.id === g.id) ? 2 : 3;
    return { level, id: g.id, title: g.title, dimension: g.dimension, ...bar(rowsOf(g).flatMap(tagged)), rows: g.children.map(n => describe(n, level)) };
  }
  throw Error(`Unknown outcome, group or expectation ${id}`);
}
