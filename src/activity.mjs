import { rollups } from './structure.mjs';

// Verification activity is not implementation credit. Rechecking a passing obligation must not
// manufacture newly delivered work, and uninspected obligations stay in the project denominator.
export function sessionActivity(state, requested) {
  const known = new Set([...state.inputs.map(i => i.session), ...Object.values(state.files || {}).map(f => f.header?.id)].filter(Boolean));
  for (const e of state.expectations) for (const c of e.criteria) {
    for (const v of [...(c.history || []).map(h => h.evidence || h), c.evidence]) if (v?.session) known.add(v.session);
  }
  const matches = [...known].filter(id => id === requested || id.startsWith(requested));
  if (matches.length !== 1) throw Error('Session reference is unknown or ambiguous in this project');
  const session = matches[0], rows = [];
  for (const e of state.expectations.filter(e => !e.supersededBy)) {
    let inspected = 0, passed = 0, newlyPassing = 0, noLongerPassing = 0, rechecked = 0;
    for (const c of e.criteria) {
      const observations = (c.history || []).map(h => ({ verdict: h.verdict, evidence: h.evidence || (h.session ? h : null) })).concat({ verdict: c.verdict, evidence: c.evidence })
        .filter(o => o.evidence?.session)
        .sort((a, b) => Date.parse(a.evidence.at || a.evidence.recordedAt || 0) - Date.parse(b.evidence.at || b.evidence.recordedAt || 0));
      let previous = 'unknown', baseline, last, count = 0;
      for (const o of observations) {
        if (o.evidence?.session === session) {
          if (!count) baseline = previous;
          last = o.verdict; count++;
        }
        previous = o.verdict;
      }
      if (!count) continue;
      inspected++; if (last === 'passed') passed++;
      if (baseline !== 'passed' && last === 'passed') newlyPassing++;
      else if (baseline === 'passed' && last !== 'passed') noLongerPassing++;
      else rechecked++;
    }
    const raised = e.sources.some(s => s.ref.startsWith(session + '/'));
    if (raised || inspected) rows.push({ id: e.id, title: e.title, kind: e.kind, raisedHere: raised,
      projectPassed: e.criteria.filter(c => c.verdict === 'passed').length, projectTotal: e.criteria.length,
      inspectedHere: inspected, passedAtLastSessionObservation: passed, newlyPassing, noLongerPassing, rechecked });
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  const outcomeGroups = rollups(state).map(g => {
    const selected = g.rows.map(e => byId.get(e.id)).filter(Boolean);
    const measures = kind => {
      const scoped = selected.filter(r => r.kind === kind), criteria = g.rows.filter(e => e.kind === kind).flatMap(e => e.criteria);
      const total = key => scoped.reduce((n, r) => n + r[key], 0);
      return { inspectedHere: total('inspectedHere'), newlyPassing: total('newlyPassing'), noLongerPassing: total('noLongerPassing'), rechecked: total('rechecked'),
        passedAtLastSessionObservation: total('passedAtLastSessionObservation'), projectPassed: criteria.filter(c => c.verdict === 'passed').length, projectTotal: criteria.length };
    };
    return { id: g.id, title: g.title, expectationIds: selected.map(r => r.id), raisedHere: selected.filter(r => r.raisedHere).length,
      outcomes: measures('outcome'), standingCompliance: measures('standing') };
  }).filter(g => g.expectationIds.length);
  return { session, meaning: 'Verification changes observed by this session; not implementation credit. Mixed groups must not be described as a delivery percentage.',
    humanSupportedInputs: state.inputs.filter(i => i.session === session && i.decision?.origin === 'human-supported').length,
    outcomeGroups };
}
