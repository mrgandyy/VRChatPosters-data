import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Client } from 'discord.js';
import { Store } from './db.js';
import { RETIRED_ACTIONS, createArt, kindOfAction } from './fbt-art.js';
import { upsertPerformer } from './performers.js';
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

    const booth = await art.submit('booth', premium.id, null, 'u2', wide, 'up-3');
    await assert.rejects(art.submit('booth', standard.id, null, 'u1', wide), /Premium/);
    assert.equal(art.reviewOf('booth', booth)!.status, 'submitted');
    await art.decide('booth', booth, true, 'staff');
    assert.equal(art.uploadFor('booth', booth), 'up-3');

    const summary = artOf(store);
    assert.deepEqual(summary.get(standard.id), { posters: [5], billboard: false, backdrop: false, booth: false });
    assert.deepEqual(summary.get(premium.id), { posters: [], billboard: false, backdrop: true, booth: true });
    const sync = syncPayload(store);
    assert.deepEqual(sync.groups.find(g => g.id === standard.id)!.art.posters, [5]);
    assert.ok(audit.length >= 4);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('website performer art: verified performers only, no group, one card per kind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-performer-art-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    store.setSetting('approval_channel', 'c1');
    const sent: { content: string; components: { components: { data: { custom_id: string } }[] }[] }[] = [], edits: unknown[] = [];
    const art = createArt({ store, dataDir: dir, client: fakeClient(sent, edits), guildId: 'g1', auditLog: async () => {} });
    const tall = await sharp({ create: { width: 512, height: 1024, channels: 3, background: '#553366' } }).png().toBuffer();
    await assert.rejects(art.submit('pole', 0, null, '111111', tall, 'up-p0'), /verified performers/);
    upsertPerformer(store, '111111', 'usr_11111111-2222-3333-4444-555555555555', 'Velvet*Fox');
    const id = await art.submit('pole', 0, null, '111111', tall, 'up-p1');
    assert.match(sent.at(-1)!.content, /Performer pole wrap #\d+ for \*\*VelvetFox\*\*/);
    assert.equal(sent.at(-1)!.components[0]!.components[0]!.data.custom_id, `ws:poleapprove:${id}`);
    assert.deepEqual(art.reviewOf('pole', id), { groupId: -1, submitter: '111111', status: 'submitted', slot: null });
    assert.equal(art.uploadFor('pole', id), 'up-p1');
    await art.decide('pole', id, true, 'staff');
    assert.equal(store.setting('performers-dirty'), '1');
    await assert.rejects(art.decide('pole', id, true, 'staff'), /already/);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Venue Studio textures: Premium only, reviewed like the billboard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-studio-art-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    store.setSetting('approval_channel', 'c1');
    const sent: unknown[] = [], edits: unknown[] = [];
    const art = createArt({ store, dataDir: dir, client: fakeClient(sent, edits), guildId: 'g1', auditLog: async () => {} });
    const square = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#3a2a1a' } }).png().toBuffer();
    const standard = store.registerGroup('Plain Room');
    const premium = store.registerGroup('Gold Room', 'premium');
    await assert.rejects(art.submit('studio', standard.id, null, 'u1', square), /Premium/);
    const id = await art.submit('studio', premium.id, null, 'u2', square, 'up-s1');
    assert.equal(art.reviewOf('studio', id)!.status, 'submitted');
    await art.decide('studio', id, true, 'staff');
    assert.equal(art.reviewOf('studio', id)!.status, 'approved');
    assert.ok(store.nextJob(), 'an approved texture queues the group publish');
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('review buttons map to their kind', () => {
  assert.deepEqual(kindOfAction('approve'), { kind: 'poster', approve: true });
  assert.deepEqual(kindOfAction('bannerreject'), { kind: 'billboard', approve: false });
  assert.deepEqual(kindOfAction('backdropapprove'), { kind: 'backdrop', approve: true });
  assert.deepEqual(kindOfAction('boothapprove'), { kind: 'booth', approve: true });
  assert.deepEqual(kindOfAction('studioapprove'), { kind: 'studio', approve: true });
  assert.deepEqual(kindOfAction('polereject'), { kind: 'pole', approve: false });
  assert.deepEqual(kindOfAction('chairapprove'), { kind: 'chair', approve: true });
  assert.deepEqual(kindOfAction('deckreject'), { kind: 'deck', approve: false });
  assert.equal(kindOfAction('lockerreject'), undefined, 'dancer lockers are retired');
  assert.ok(RETIRED_ACTIONS.has('lockerapprove'));
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
