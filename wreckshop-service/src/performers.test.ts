import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import {
  buildPerformerAtlas, cleanPerformerName, decidePerformerArt, performerSlot, publishPerformers, removePerformer, removePerformerArt,
  renamePerformer, rosterJson, submitPerformerArt, upsertPerformer, validateVrcId,
} from './performers.js';
import { slotPoolPath } from './url-pool.js';

const A = '100000000000000001', B = '100000000000000002', C = '100000000000000003';
const VA = 'usr_aaaaaaaa-1111-2222-3333-444444444444', VB = 'usr_bbbbbbbb-1111-2222-3333-444444444444', VC = 'usr_cccccccc-1111-2222-3333-444444444444';
const png = (w: number, h: number, background: string) => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
async function pixel(bytes: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

test('VRChat ids and names are checked', () => {
  assert.equal(validateVrcId(' USR_AAAAAAAA-1111-2222-3333-444444444444 '), VA);
  assert.equal(validateVrcId('8JoV9XEdpo'), '8JoV9XEdpo', 'very old accounts keep their short id');
  assert.throws(() => validateVrcId('grp_aaaaaaaa-1111-2222-3333-444444444444'));
  assert.throws(() => validateVrcId('https://vrchat.com/home/user/usr_x'));
  assert.equal(cleanPerformerName('  Velvet\u0007 Fox '), 'Velvet Fox');
  assert.throws(() => cleanPerformerName('   '));
  assert.throws(() => cleanPerformerName('x'.repeat(65)));
});

test('atlas layout: pole left half, chair top right, deck bottom right, missing kinds transparent', async () => {
  const full = await buildPerformerAtlas({ pole: await png(300, 600, '#ff0000'), chair: await png(400, 400, '#00ff00'), deck: await png(800, 400, '#0000ff') });
  const meta = await sharp(full).metadata();
  assert.equal(meta.width, 1024); assert.equal(meta.height, 1024); assert.equal(meta.format, 'png');
  const [pole, chair, deck, deckBar] = await Promise.all([pixel(full, 256, 512), pixel(full, 768, 256), pixel(full, 768, 768), pixel(full, 768, 520)]);
  assert.ok(pole[0]! > 200 && pole[1]! < 50 && pole[3] === 255, `pole ${pole}`);
  assert.ok(chair[1]! > 200 && chair[0]! < 50 && chair[3] === 255, `chair ${chair}`);
  assert.ok(deck[2]! > 200 && deck[0]! < 50 && deck[3] === 255, `deck ${deck}`);
  assert.ok(deckBar[0]! < 20 && deckBar[1]! < 20 && deckBar[2]! < 20 && deckBar[3] === 255, 'a wide logo is fitted whole on black');
  const poleOnly = await buildPerformerAtlas({ pole: await png(512, 1024, '#ff0000') });
  assert.equal((await pixel(poleOnly, 768, 256))[3], 0, 'no chair art: transparent');
  assert.equal((await pixel(poleOnly, 768, 768))[3], 0, 'no deck art: transparent');
  assert.equal((await pixel(poleOnly, 10, 1010))[3], 255);
});

test('pool slots: stable per performer, freed on removal, lowest free reused', () => {
  const store = new Store(':memory:');
  try {
    upsertPerformer(store, A, VA, 'Alpha'); upsertPerformer(store, B, VB, 'Bravo');
    assert.equal(performerSlot(store, VA), 0);
    assert.equal(performerSlot(store, VB), 1);
    assert.equal(performerSlot(store, VA), 0, 'the same slot every time');
    removePerformer(store, VA);
    upsertPerformer(store, C, VC, 'Charlie');
    assert.equal(performerSlot(store, VC), 0, 'freed slot goes to the next performer');
    assert.equal(performerSlot(store, VB), 1, 'nobody else moves');
    for (let i = 0; i < 62; i++) performerSlot(store, `usr_${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
    assert.equal(performerSlot(store, 'usr_ffffffff-0000-0000-0000-000000000000'), undefined, '64 slots only');
    assert.equal(slotPoolPath('performers', 0), 'performers/g00-r01.png');
    assert.equal(slotPoolPath('performers', 63), 'performers/g07-r08.png');
    assert.throws(() => slotPoolPath('performers', 64));
  } finally { store.db.close(); }
});

test('one identity per Discord account and per VRChat account; re-verifying moves the slot', () => {
  const store = new Store(':memory:');
  try {
    upsertPerformer(store, A, VA, 'Alpha');
    assert.throws(() => upsertPerformer(store, B, VA, 'Thief'), /another Discord account/);
    const slot = performerSlot(store, VA);
    upsertPerformer(store, A, VB, 'Alpha Two');
    assert.equal(performerSlot(store, VB), slot);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM performers').get() as { n: number }).n, 1);
    assert.equal(renamePerformer(store, VB, 'Alpha Two'), false);
    assert.equal(renamePerformer(store, VB, 'Alpha Three'), true);
  } finally { store.db.close(); }
});

test('roster JSON: the exact world contract', () => {
  const json = JSON.parse(rosterJson([
    { vrcId: VB, name: 'Bravo', pool: 3, pole: false, chair: true, deck: false },
    { vrcId: VA, name: 'Alpha', pool: 1, pole: true, chair: false, deck: true },
  ], '2026-10-12T00:00:00.000Z').toString());
  assert.deepEqual(json, { version: 1, updated: '2026-10-12T00:00:00.000Z', performers: [
    { vrcId: VA, name: 'Alpha', pool: 1, pole: true, chair: false, deck: true },
    { vrcId: VB, name: 'Bravo', pool: 3, pole: false, chair: true, deck: false },
  ] });
});

test('publishing: approved art only, slot files then performers.json, nothing when unchanged, names refresh, removal drops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-performers-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const original = globalThis.fetch;
  const files = new Map<string, Buffer>(); const commits: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://feed.example/')) {
      const bytes = files.get(new URL(url).pathname.slice(1));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('missing', { status: 404 });
    }
    const path = decodeURIComponent(url.split('/contents/')[1]!.split('?')[0]!);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content: string; message: string };
      files.set(path, Buffer.from(body.content, 'base64')); commits.push(`${path} · ${body.message}`);
      return new Response('{}', { status: 201 });
    }
    const bytes = files.get(path);
    return bytes ? new Response(JSON.stringify({ sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') })) : new Response('{}', { status: 404 });
  };
  const config = { branch: 'main', owner: 'o', repository: 'r', token: 't', publicBase: 'https://feed.example', defaultsDir: '', dataDir: dir, dryRun: false };
  try {
    const src = join(dir, 'pole.png'); writeFileSync(src, await png(512, 1024, '#aa2266'));
    upsertPerformer(store, A, VA, 'Alpha');
    upsertPerformer(store, B, VB, 'Bravo');
    const pending = submitPerformerArt(store, A, 'pole', src, src);
    assert.throws(() => submitPerformerArt(store, C, 'deck', src, src), /verified performers/);
    assert.match((await publishPerformers(store, config))!, /0 performer/, 'the first run publishes an empty roster, so the URL exists');
    assert.deepEqual(JSON.parse(files.get('performers.json')!.toString()).performers, []);
    assert.equal(await publishPerformers(store, config), undefined, 'then nothing until something changes');
    commits.length = 0;
    decidePerformerArt(store, pending, 'staff', true);
    const deck = submitPerformerArt(store, B, 'deck', src, src); decidePerformerArt(store, deck, 'staff', true);
    const rejected = submitPerformerArt(store, B, 'chair', src, src); decidePerformerArt(store, rejected, 'staff', false);
    assert.match((await publishPerformers(store, config, new Date('2026-10-12T01:00:00Z')))!, /2 performer\(s\), 2 atlas/);
    assert.deepEqual(commits.map(c => c.split(' · ')[0]), ['performers/g00-r01.png', 'performers/g00-r02.png', 'performers.json']);
    assert.ok(commits.every(c => !/Alpha|Bravo|1000000/.test(c)), 'commit messages carry no names or Discord ids');
    const roster = JSON.parse(files.get('performers.json')!.toString());
    assert.deepEqual(roster, { version: 1, updated: '2026-10-12T01:00:00.000Z', performers: [
      { vrcId: VA, name: 'Alpha', pool: 0, pole: true, chair: false, deck: false },
      { vrcId: VB, name: 'Bravo', pool: 1, pole: false, chair: false, deck: true },
    ] });
    assert.ok(!files.get('performers.json')!.toString().includes(A), 'no Discord ids in public files');

    commits.length = 0;
    assert.equal(await publishPerformers(store, config), undefined, 'unchanged: no commit, timestamp untouched');
    assert.equal(commits.length, 0);

    renamePerformer(store, VA, 'Alpha Prime');
    await publishPerformers(store, config);
    assert.deepEqual(commits.map(c => c.split(' · ')[0]), ['performers.json'], 'a rename only rewrites the roster');
    assert.equal(JSON.parse(files.get('performers.json')!.toString()).performers[0].name, 'Alpha Prime');

    commits.length = 0;
    const repole = submitPerformerArt(store, A, 'pole', src, src); decidePerformerArt(store, repole, 'staff', true);
    const src2 = join(dir, 'pole2.png'); writeFileSync(src2, await png(512, 1024, '#2266aa'));
    store.db.prepare('UPDATE performer_art SET sourcePath=? WHERE id=?').run(src2, repole);
    await publishPerformers(store, config);
    assert.deepEqual(commits.map(c => c.split(' · ')[0]), ['performers/g00-r01.png', 'performers.json'], 're-upload overwrites the same slot');

    removePerformerArt(store, B, 'deck');
    removePerformer(store, VA);
    await publishPerformers(store, config);
    assert.deepEqual(JSON.parse(files.get('performers.json')!.toString()).performers, [], 'removed performers and taken-down art leave the roster');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM performer_pool WHERE vrc_id=?').get(VA) as { n: number }).n, 0, 'slot freed');

    const dry = await publishPerformers(store, { ...config, dryRun: true });
    assert.equal(dry, undefined, 'still unchanged');
    upsertPerformer(store, A, VA, 'Alpha');
    assert.match((await publishPerformers(store, { ...config, dryRun: true }))!, /dry-run: 1 performer/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'dry-run', 'performers.json'), 'utf8')).performers[0].pool, 0);
  } finally { globalThis.fetch = original; store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
