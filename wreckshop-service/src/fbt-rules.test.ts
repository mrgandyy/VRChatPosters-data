import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.js';
import { deactivateForInactivity, demoteDm, demoteForAge, premiumWelcome } from './fbt-rules.js';
import { setLevel } from './fbt-admin.js';

test('age promise: Premium and Headliner drop to Standard, once', () => {
  const s = new Store(':memory:');
  try {
    const p = s.registerGroup('Promise Club', 'premium');
    setLevel(s, p.id, 'headliner');
    assert.match(demoteForAge(s, p.id)!, /dropped to Standard/);
    assert.deepEqual([s.group(p.id)!.tier, s.group(p.id)!.level ?? null], ['standard', null]);
    assert.equal(demoteForAge(s, p.id), null, 'already Standard: nothing to do');
    assert.ok(s.group(p.id)!.enabled, 'demoted, not deactivated');
  } finally { s.db.close(); }
});

test('inactivity: off the site as Standard, house protected, idempotent', () => {
  const s = new Store(':memory:');
  try {
    const p = s.registerGroup('Quiet Lounge', 'premium');
    assert.match(deactivateForInactivity(s, p.id)!, /is resting \(off the site\)/);
    assert.ok(!s.group(p.id)!.enabled, 'disabled');
    assert.equal(s.group(p.id)!.tier, 'standard');
    assert.equal(deactivateForInactivity(s, p.id), null);
    assert.equal(deactivateForInactivity(s, 0), null, 'the house group never comes off');
  } finally { s.db.close(); }
});

test('messages: the welcome walks through the promise; the demotion says how to come back', () => {
  const w = premiumWelcome('Promise Club', 'headliner', { linked: false, manageUrl: 'https://x/manage', hostUrl: 'https://x/host', pageUrl: 'https://x/' });
  assert.match(w.title, /Headliner/);
  const all = w.fields.map(f => f.value).join('\n');
  assert.match(all, /age-verified \(18\+\)/); assert.match(all, /fbtheat/); assert.match(all, /30 days/); assert.match(all, /\/group link/);
  assert.ok(w.fields.every(f => f.value.length <= 1024 && f.name.length <= 256), 'fits Discord embed limits');
  const linked = premiumWelcome('Promise Club', 'premium', { linked: true, manageUrl: 'm', hostUrl: 'h', pageUrl: 'p' });
  assert.match(linked.fields.map(f => f.value).join('\n'), /sent \*\*fbtheat\*\* a request/);
  const dm = demoteDm('Promise Club', 'your group\'s rooms weren\'t age-verified (18+)', 'https://x/apply');
  assert.match(dm, /back to Standard/); assert.match(dm, /https:\/\/x\/apply/);
});
