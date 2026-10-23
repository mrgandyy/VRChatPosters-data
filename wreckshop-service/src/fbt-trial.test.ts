import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.js';
import { setLevel } from './fbt-admin.js';
import { expireTrials, noticeRecipients, onTrial, redeemTrial, tiersExplainer, TRIAL_ENDS, updateNotice } from './fbt-trial.js';

const BEFORE = TRIAL_ENDS - 10 * 86_400_000;

test('redeem: Premium clubs become Headliners until the end of October, then go back to Premium', () => {
  const s = new Store(':memory:');
  try {
    const p = s.registerGroup('Velvet', 'premium', undefined, '111');
    const std = s.registerGroup('Corner Bar', 'standard', undefined, '112');
    const r = redeemTrial(s, '111', BEFORE);
    assert.deepEqual(r.granted.map(g => g.id), [p.id]);
    assert.equal(s.group(p.id)!.level, 'headliner');
    assert.equal(s.group(std.id)!.tier, 'standard', 'Standard clubs are not upgraded');
    assert.match(r.reply, /Velvet\*\* is a Headliner until October 31/);
    assert.match(redeemTrial(s, '112', BEFORE).reply, /Corner Bar\*\* is Standard/);
    assert.equal(redeemTrial(s, '111', BEFORE).granted.length, 0, 'redeeming twice changes nothing');
    assert.match(redeemTrial(s, '111', BEFORE).reply, /already on the Headliner trial/);
    assert.deepEqual(expireTrials(s, BEFORE), [], 'not yet');
    assert.deepEqual(expireTrials(s, TRIAL_ENDS).map(g => g.id), [p.id]);
    assert.deepEqual([s.group(p.id)!.tier, s.group(p.id)!.level ?? null], ['premium', null]);
    assert.equal(onTrial(s, p.id), false);
    assert.deepEqual(expireTrials(s, TRIAL_ENDS + 1), [], 'only once');
  } finally { s.db.close(); }
});

test('a real Headliner approval during the trial is never undone', () => {
  const s = new Store(':memory:');
  try {
    const p = s.registerGroup('Velvet', 'premium', undefined, '111');
    redeemTrial(s, '111', BEFORE);
    setLevel(s, p.id, 'headliner'); // staff approve Headliner for real
    assert.equal(onTrial(s, p.id), false);
    assert.deepEqual(expireTrials(s, TRIAL_ENDS), []);
    assert.equal(s.group(p.id)!.level, 'headliner');
  } finally { s.db.close(); }
});

test('redeem: real Headliners, no club, and after the deadline', () => {
  const s = new Store(':memory:');
  try {
    const h = s.registerGroup('Crown', 'premium', undefined, '222');
    setLevel(s, h.id, 'headliner');
    assert.match(redeemTrial(s, '222', BEFORE).reply, /already a Headliner\./);
    assert.match(redeemTrial(s, '999', BEFORE).reply, /don't run a club/);
    s.registerGroup('Late', 'premium', undefined, '333');
    const late = redeemTrial(s, '333', TRIAL_ENDS);
    assert.equal(late.granted.length, 0); assert.match(late.reply, /ended/);
  } finally { s.db.close(); }
});

test('update notice: one per person, worded for their clubs; explainer fits Discord', () => {
  const s = new Store(':memory:');
  try {
    s.registerGroup('Velvet', 'premium', undefined, '111');
    s.registerGroup('Corner Bar', 'standard', undefined, '112');
    s.registerGroup('Tiny', 'standard', undefined, '444');
    const off = s.registerGroup('Gone', 'standard', undefined, '555'); s.setEnabled(off.id, false);
    const rec = noticeRecipients(s);
    assert.deepEqual([...rec.keys()].sort(), ['111', '112', '444'], 'resting clubs are skipped');
    const premium = updateNotice(rec.get('111')!, '42');
    assert.match(premium, /tier is intact/); assert.match(premium, /`\/redeem`/); assert.match(premium, /updated and improved/);
    assert.doesNotMatch(premium, /bug/i);
    assert.match(updateNotice(rec.get('444')!, '42'), /<#42>/);
    assert.ok(premium.length <= 2000);
    const t = tiersExplainer(BEFORE);
    assert.ok(t.fields.every(f => f.value.length <= 1024 && f.name.length <= 256));
    assert.match(t.fields.map(f => f.value).join('\n'), /\/redeem/);
    assert.doesNotMatch(tiersExplainer(TRIAL_ENDS).fields.map(f => f.value).join('\n'), /\/redeem/, 'trial line disappears after October');
  } finally { s.db.close(); }
});
