// Memory is evidence, never authority. A verdict's freshness is derived from what has happened since it was
// observed — it is never refreshed by reading, rewriting or re-displaying the record.
export const STATES = ['current', 'stale', 'historical', 'unknown', 'needs-review'];

/**
 * @param c   criterion { verdict, evidence:{at, scope, build?}, scopeVersion? }
 * @param e   its expectation { sources:[{timestamp}], scopeVersion, challengedAt? }
 * @param now optional project facts { build?: string }  (e.g. current commit) — only used when the evidence names one.
 */
export function freshness(c, e, now = {}) {
  if (!c.evidence || c.verdict === 'unknown') return { state: 'unknown', reason: 'no accepted measurement' };
  const at = c.evidence.at;
  if (!e) return { state: 'unknown', reason: 'no owning expectation supplied' };
  const latestWords = (e.sources || []).map(s => s.timestamp).sort().at(-1);
  if (c.evidence.scopeVersion !== undefined && c.evidence.scopeVersion !== e.scopeVersion) return { state: 'stale', reason: `obligation scope changed after this measurement (v${c.evidence.scopeVersion} → v${e.scopeVersion})` };
  if (e.challengedAt && e.challengedAt > at) return { state: 'needs-review', reason: `the human challenged this outcome on ${e.challengedAt.slice(0, 10)}, after the measurement` };
  if (latestWords && latestWords > at) return { state: 'stale', reason: `a later human statement (${latestWords.slice(0, 10)}) may have changed what is expected` };
  if (now.build && c.evidence.build && now.build !== c.evidence.build) return { state: 'historical', reason: `measured on build ${String(c.evidence.build).slice(0, 8)}, project is now on ${String(now.build).slice(0, 8)}` };
  return { state: 'current', reason: `measured ${at.slice(0, 10)} on the stated scope` };
}

/** Roll-up that gives credit only to current passes. */
export function credit(criteria, e, now) {
  let passed = 0, stale = 0;
  for (const c of criteria) {
    if (c.verdict !== 'passed') continue;
    if (freshness(c, e, now).state === 'current') passed++; else stale++;
  }
  return { passed, stale, total: criteria.length };
}
