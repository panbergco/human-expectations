// Expand compact origin sets into individually attributable records. A model proposal involving
// non-human/uncertain sources is quarantined, never silently promoted into a human requirement.
export function expandCompact(value, state, resolveRef) {
  if (!Array.isArray(value.human) || !Array.isArray(value.automation) || !Array.isArray(value.uncertain)) return value;
  const origins = new Map();
  for (const [field, origin] of [['human', 'human-supported'], ['automation', 'automation'], ['uncertain', 'uncertain']]) {
    for (const ref of value[field]) {
      const key = resolveRef(ref);
      if (origins.has(key)) throw Error(`Input ${ref} appears in two origin sets`);
      origins.set(key, origin);
    }
  }
  if (!Array.isArray(value.expectations)) throw Error('Return an expectations array');
  const notes = new Map();
  for (const note of value.notes || []) for (const ref of note.refs || []) {
    const key = resolveRef(ref);
    if (!origins.has(key)) throw Error(`Note cites unknown input ${ref}`);
    notes.set(key, note);
  }
  const links = new Map(), reasons = new Map(), needsReview = new Set(), deferred = new Set();
  const expectations = [], unverifiedProposals = [];
  const definitions = new Map(state.expectations.map(e => [e.id, e]));
  for (const p of value.expectations) {
    if (p.title && p.intent && p.kind && Array.isArray(p.sources) && p.sources.every(ref => origins.get(resolveRef(ref)) === 'human-supported' && !notes.get(resolveRef(ref))?.needsContext)) definitions.set(p.id, p);
  }
  for (const p of value.expectations) {
    if (!Array.isArray(p.sources) || !p.sources.length) throw Error(`Patch ${p.id} needs source inputs from this batch`);
    const sources = p.sources.map(resolveRef), unsupported = sources.filter(ref => origins.get(ref) !== 'human-supported' || notes.get(ref)?.needsContext);
    const prior = definitions.get(p.id), definition = { ...prior, ...p };
    const proposedCriteria = p.criteria || (state.expectations.some(e => e.id === p.id) ? [] : prior?.criteria || []);
    const incomplete = !definition.title || !definition.intent || !definition.kind || !Array.isArray(proposedCriteria)
      || (!state.expectations.some(e => e.id === p.id) && !proposedCriteria.length)
      || proposedCriteria.some(c => !c.id || !c.obligation || !c.check);
    if (unsupported.length || incomplete) {
      unverifiedProposals.push({ proposal: p, sources, unsupported, reason: incomplete ? 'Unknown patch target without a complete definition; no expectation ID was guessed' : 'Not all proposed authority is human-supported; no part of this patch was accepted' });
      for (const ref of sources) {
        if (origins.get(ref) === 'human-supported' && !notes.get(ref)?.needsContext) {
          needsReview.add(ref);
          if ((state.inputs.find(i => i.ref === ref)?.intentDeferrals || 0) < 1) deferred.add(ref);
        }
      }
      continue;
    }
    for (const ref of sources) {
      links.set(ref, [...(links.get(ref) || []), p.id]); reasons.set(ref, p.reason);
    }
    expectations.push({ ...definition, criteria: proposedCriteria });
  }
  const decisions = [...origins].map(([ref, origin]) => {
    const linked = [...new Set(links.get(ref) || [])], note = notes.get(ref);
    return { ref, origin, nature: note?.needsContext ? 'needs-context' : linked.length ? 'expectation' : needsReview.has(ref) ? 'needs-context' : origin === 'human-supported' ? 'steering' : origin === 'automation' ? 'framework' : 'needs-context',
      expectations: linked, relation: note?.relation || (linked.length ? 'related' : 'none'),
      needsReview: needsReview.has(ref), pendingIntent: deferred.has(ref),
      reason: note?.reason || reasons.get(ref) || (needsReview.has(ref) ? 'A proposed outcome mixed this human source with unverified authority; retry only the human exchange once' : origin === 'human-supported' ? 'Human context/transient action; no new durable obligation asserted' : origin === 'automation' ? 'Framework or agent-origin traffic, not human authority' : 'Origin or meaning needs corroborating context') };
  });
  return { ...value, expectations, decisions, unverifiedProposals };
}
