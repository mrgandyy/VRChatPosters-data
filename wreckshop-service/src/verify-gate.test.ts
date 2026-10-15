import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSummary, auditText, lockDiff, lockedDm, lockedGroups, parseLocked, tierOf, verifyAudit } from './verify-gate.js';

const groups = [
  { id: 0, name: 'House', tier: 'standard' as const, level: null, enabled: 1 },
  { id: 1, name: 'Velvet', tier: 'premium' as const, level: 'headliner' as const, enabled: 1 },
  { id: 2, name: 'Neon', tier: 'premium' as const, level: null, enabled: 1 },
  { id: 3, name: 'Lotus', tier: 'standard' as const, level: null, enabled: 1 },
  { id: 4, name: 'Duo', tier: 'standard' as const, level: null, enabled: 1 },
  { id: 5, name: 'Gone', tier: 'standard' as const, level: null, enabled: 0 },
];
const reps: Record<number, string[]> = { 0: ['900'], 1: ['100'], 2: ['200'], 3: [], 4: ['400', '401'], 5: ['500'] };
const verified = new Set(['200', '401']);
const members = new Set(['100', '200', '400', '401']);
const names = new Map([['100', 'Kai'], ['400', 'Mo*']]);

test('the audit covers all three tiers, live clubs only, Headliner first', () => {
  const a = verifyAudit(groups as never, id => reps[id] ?? [], verified, members, names);
  assert.deepEqual(a.none.map(r => [r.name, r.tier]), [['Velvet', 'Headliner'], ['Lotus', 'Standard']]);
  assert.deepEqual(a.partial.map(r => r.name), ['Duo']);
  assert.deepEqual(lockedGroups(a), [1, 3], 'house #0 and paused clubs never lock');
  const text = auditText(a, new Date('2026-10-15T20:00:00Z'));
  assert.match(text, /Headliner · Velvet \(#1\) · reps: Kai \(100\)/);
  assert.match(text, /Standard · Lotus \(#3\) · reps: none on file/);
  assert.match(text, /not verified: Mo \(400\)/, 'markdown stripped from names');
  assert.match(auditSummary(a, false), /2 clubs with no verified rep \(Headliner 1, Premium 0, Standard 1\)/);
  assert.match(auditSummary(a, false), /gate is \*\*off\*\*/);
  assert.equal(tierOf({ tier: 'premium', level: null }), 'Premium');
});

test('lock lists: parse safely and report what changed', () => {
  assert.deepEqual([...parseLocked('[3,"7",-1,"x"]')], [3, 7]);
  assert.equal(parseLocked('not json').size, 0);
  assert.equal(parseLocked(undefined).size, 0);
  assert.deepEqual(lockDiff(new Set([1, 3]), [3, 9]), { locked: [9], unlocked: [1] });
});

test('the locked DM is friendly and points to the verify bot', () => {
  const m = lockedDm('Neon *Lotus*', '<#123>');
  assert.match(m, /We noticed you're not verified yet/);
  assert.match(m, /verify in <#123> with our 18\+ verify bot/);
  assert.ok(!m.includes('*Lotus*'));
});

test('a locked club is published as not enabled, so the world refuses its code; unlocking restores it', async () => {
  const { Store } = await import('./db.js');
  const { catalog } = await import('./publish.js');
  const s = new Store(':memory:');
  try {
    const g = s.registerGroup('Locked Lounge', 'standard', undefined, '100000000000000009');
    const entry = () => JSON.parse(catalog(s).toString()).groups.find((x: { id: number }) => x.id === g.id);
    assert.equal(entry().enabled, true);
    s.setSetting('verify_locked', JSON.stringify([g.id]));
    assert.equal(entry().enabled, false);
    assert.equal(entry().code, s.group(g.id)!.code, 'the code stays the same; it just isn\'t accepted while locked');
    s.setSetting('verify_locked', '');
    assert.equal(entry().enabled, true);
  } finally { s.close(); }
});
