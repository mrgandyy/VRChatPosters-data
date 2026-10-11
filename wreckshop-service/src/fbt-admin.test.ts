import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.js';
import { applyAdmin } from './fbt-admin.js';

const resolve = async (q: string) => {
  const t = q.replace(/^@/, '');
  if (/^\d{5,25}$/.test(t)) return t;
  if (t === 'resolve') return '200000000000000002';
  throw new Error(`No member named "${t}" in the server.`);
};

test('staff actions: create, rename, tiers, reps by name, suspend, link, codes', async () => {
  const s = new Store(':memory:');
  try {
    const c = await applyAdmin(s, { action: 'create', name: 'Resolve Room', tier: 'premium', rep: '@resolve' }, resolve);
    const id = c.groupId;
    assert.equal(s.group(id)!.tier, 'premium');
    assert.deepEqual(s.representatives(id), ['200000000000000002']);
    await applyAdmin(s, { action: 'rename', groupId: id, name: 'Resolve Lounge' }, resolve);
    assert.equal(s.group(id)!.name, 'Resolve Lounge');
    await applyAdmin(s, { action: 'tier', groupId: id, tier: 'headliner' }, resolve);
    assert.deepEqual([s.group(id)!.tier, s.group(id)!.level], ['premium', 'headliner']);
    await applyAdmin(s, { action: 'tier', groupId: id, tier: 'premium' }, resolve);
    assert.deepEqual([s.group(id)!.tier, s.group(id)!.level], ['premium', null], 'premium clears headliner');
    await applyAdmin(s, { action: 'tier', groupId: id, tier: 'standard' }, resolve);
    assert.equal(s.group(id)!.tier, 'standard');
    await applyAdmin(s, { action: 'addRep', groupId: id, user: '300000000000000003' }, resolve);
    await assert.rejects(applyAdmin(s, { action: 'addRep', groupId: id, user: 'nobody' }, resolve), /No member/);
    await applyAdmin(s, { action: 'removeRep', groupId: id, user: '200000000000000002' }, resolve);
    assert.deepEqual(s.representatives(id), ['300000000000000003']);
    await assert.rejects(applyAdmin(s, { action: 'removeRep', groupId: id, user: '200000000000000002' }, resolve), /isn't a rep/);
    await applyAdmin(s, { action: 'suspend', groupId: id, enabled: false }, resolve);
    assert.equal(s.group(id)!.enabled, 0);
    await applyAdmin(s, { action: 'link', groupId: id, url: 'grp_3efba4a4-18d7-43ec-b8ef-1cafd9cec1c4' }, resolve);
    assert.match(s.group(id)!.vrchatUrl ?? '', /grp_3efba4a4/);
    const before = s.group(id)!.code;
    await applyAdmin(s, { action: 'resetCode', groupId: id }, resolve);
    assert.notEqual(s.group(id)!.code, before);
    assert.match(s.group(id)!.code, /^\d{8}$/);
  } finally { s.close(); }
});

test('remove is restorable; the house group is protected', async () => {
  const s = new Store(':memory:');
  try {
    const g = s.registerGroup('Gone Soon', 'standard', undefined, '400000000000000004');
    await applyAdmin(s, { action: 'remove', groupId: g.id }, resolve);
    assert.equal(s.group(g.id), undefined);
    await assert.rejects(applyAdmin(s, { action: 'rename', groupId: g.id, name: 'X' }, resolve), /isn't in the bot/);
    await applyAdmin(s, { action: 'restore', groupId: g.id }, resolve);
    assert.equal(s.group(g.id)!.enabled, 1);
    await assert.rejects(applyAdmin(s, { action: 'restore', groupId: g.id }, resolve), /isn't removed/);
    await assert.rejects(applyAdmin(s, { action: 'remove', groupId: 0 }, resolve));
    await assert.rejects(applyAdmin(s, { action: 'tier', groupId: 0, tier: 'standard' }, resolve));
  } finally { s.close(); }
});
