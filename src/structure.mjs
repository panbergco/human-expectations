const active = state => state.expectations.filter(e => !e.supersededBy);

export function setStructure(state, plan) {
  if (!plan || typeof plan.dimension !== 'string' || !plan.dimension.trim() || !Array.isArray(plan.groups)) throw Error('Name one cut dimension and supply groups');
  const known = new Set(active(state).map(e => e.id)), used = new Set(), groupIds = new Set();
  function walk(nodes, top = false, depth = 0) {
    if (depth > 10 || !Array.isArray(nodes) || nodes.length > 7 || nodes.length < (top && known.size < 3 ? known.size : 3)) throw Error('Groups must have 3–7 members; nest rather than widen');
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
      rows, criteria: rows.flatMap(e => e.criteria), reconciled: rows.length > 0 && rows.every(e => e.reconciled),
      kind: rows.every(e => e.kind === 'standing') ? 'standing' : rows.every(e => e.kind === 'outcome') ? 'outcome' : 'mixed' };
  });
  const unplaced = [...byId.values()].filter(e => !assigned.has(e.id));
  if (unplaced.length) result.push({ id: 'UNPLACED', title: 'New intent awaits structural reconciliation', rows: unplaced, criteria: unplaced.flatMap(e => e.criteria), reconciled: false, kind: 'mixed' });
  return result.filter(r => r.rows.length);
}

export function groupNodes(plan) {
  return (plan?.groups || []).filter(n => typeof n !== 'string').flatMap(n => [n, ...groupNodes({ groups: n.children })]);
}
