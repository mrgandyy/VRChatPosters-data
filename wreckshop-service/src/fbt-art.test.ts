import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Client } from 'discord.js';
import { Store } from './db.js';
import { createArt, kindOfAction } from './fbt-art.js';
import { artOf, syncPayload } from './fbt-site.js';

function fakeClient(sent: unknown[], edits: unknown[]) {
  const message = { id: 'm1', content: 'card', edit: async (x: unknown) => { edits.push(x); } };
  const channel = { id: 'c1', type: 0, send: async (x: unknown) => { sent.push(x); return message; }, messages: { fetch: async () => message } };
  const guild = { channels: { cache: new Map([['c1', channel]]) } };
  return { guilds: { cache: new Map([['g1', guild]]) } } as unknown as Client;
}

test('website artwork: checks, review card, decisions and the art summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-art-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    store.setSetting('approval_channel', 'c1');
    const sent: unknown[] = [], edits: unknown[] = [], audit: string[] = [];
    const art = createArt({ store, dataDir: dir, client: fakeClient(sent, edits), guildId: 'g1', auditLog: async (_g, m) => { audit.push(m); } });
    const standard = store.registerGroup('Standard Room');
    const premium = store.registerGroup('Premium Room', 'premium');
    const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#883344' } }).png().toBuffer();
    const wide = await sharp({ create: { width: 1024, height: 256, channels: 3, background: '#334488' } }).png().toBuffer();

    await assert.rejects(art.submit('poster', standard.id, 12, 'u1', png), /slot|poster/i, 'standard groups stop at 11');
    await assert.rejects(art.submit('billboard', standard.id, null, 'u1', wide), /Premium/);
    await assert.rejects(art.submit('poster', 0, 1, 'u1', png), /catalog/);

    const p = await art.submit('poster', standard.id, 5, 'u1', png, 'up-1');
    assert.equal(sent.length, 1);
    assert.equal(art.uploadFor('poster', p), 'up-1');
    assert.deepEqual(art.reviewOf('poster', p), { groupId: standard.id, submitter: 'u1', status: 'submitted', slot: 5 });
    await art.decide('poster', p, true, 'staff');
    assert.equal(art.reviewOf('poster', p)!.status, 'approved');
    assert.equal(edits.length, 1, 'Discord card updated');
    await assert.rejects(art.decide('poster', p, false, 'staff'), /already/);

    const b = await art.submit('billboard', premium.id, null, 'u2', wide, 'up-2');
    assert.equal(art.reviewOf('billboard', b)!.status, 'submitted');
    await art.decide('billboard', b, false, 'staff');
    assert.equal(art.reviewOf('billboard', b)!.status, 'rejected');
    const k = await art.submit('backdrop', premium.id, null, 'u2', png);
    await art.decide('backdrop', k, true, 'staff');
    assert.equal(art.uploadFor('backdrop', k), undefined, 'Discord-only uploads have no website link');

    const summary = artOf(store);
    assert.deepEqual(summary.get(standard.id), { posters: [5], billboard: false, backdrop: false });
    assert.deepEqual(summary.get(premium.id), { posters: [], billboard: false, backdrop: true });
    const sync = syncPayload(store);
    assert.deepEqual(sync.groups.find(g => g.id === standard.id)!.art.posters, [5]);
    assert.ok(audit.length >= 4);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('review buttons map to their kind', () => {
  assert.deepEqual(kindOfAction('approve'), { kind: 'poster', approve: true });
  assert.deepEqual(kindOfAction('bannerreject'), { kind: 'billboard', approve: false });
  assert.deepEqual(kindOfAction('backdropapprove'), { kind: 'backdrop', approve: true });
  assert.equal(kindOfAction('appok'), undefined);
});

test('venue look from the website rides along in the world catalog', async () => {
  const { catalog, lookOf } = await import('./publish.js');
  const store = new Store(':memory:');
  try {
    const g = store.registerGroup('Looks Room');
    assert.deepEqual(lookOf(store, g.id), { accent: '', glow: 1 });
    store.setSetting(`look-${g.id}`, JSON.stringify({ accent: '#ff4fa3', glow: 2 }));
    const entry = JSON.parse(catalog(store).toString()).groups.find((x: { id: number }) => x.id === g.id);
    assert.equal(entry.accent, '#ff4fa3');
    assert.equal(entry.glow, 2);
    store.setSetting(`look-${g.id}`, JSON.stringify({ accent: 'javascript:', glow: 9 }));
    assert.deepEqual(lookOf(store, g.id), { accent: '', glow: 1 }, 'bad values fall back');
  } finally { store.db.close(); }
});
