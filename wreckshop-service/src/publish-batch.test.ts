import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Store } from './db.js';
import { buildAtlas } from './atlas.js';
import { processOneJob, referencedArt, type PublishConfig } from './publish.js';

const sha1 = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

/** A tiny in-memory GitHub (Git Data API + Contents API) and Pages host. */
function fakeGitHub(initial: Record<string, Buffer>, opts: { moveBranchOnce?: boolean } = {}) {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parent: string | null; message: string }>();
  let n = 0;
  const put = (files: Map<string, string>) => { const id = `t${++n}`; trees.set(id, files); return id; };
  const files0 = new Map<string, string>();
  for (const [p, b] of Object.entries(initial)) { blobs.set(sha1(b), b); files0.set(p, sha1(b)); }
  let head = 'c0'; commits.set(head, { tree: put(files0), parent: null, message: 'init' });
  let moveOnce = !!opts.moveBranchOnce;
  const state = { patches: 0, commitsMade: [] as string[], contentPuts: 0 };
  const fileAt = (path: string) => { const s = trees.get(commits.get(head)!.tree)!.get(path); return s ? blobs.get(s) : undefined; };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host === 'feed.example') {
      const b = fileAt(url.pathname.replace(/^\//, ''));
      return b ? new Response(new Uint8Array(b)) : new Response('missing', { status: 404 });
    }
    const path = url.pathname.replace('/repos/test/feed/', '');
    if (path.startsWith('git/ref/heads/') && method === 'GET') return json({ object: { sha: head } });
    if (path.startsWith('git/commits/') && method === 'GET') return json({ tree: { sha: commits.get(path.split('/')[2]!)!.tree } });
    if (path.startsWith('git/trees/') && method === 'GET') {
      const t = trees.get(path.split('/')[2]!)!;
      return json({ truncated: false, tree: [...t].map(([p, s]) => ({ path: p, type: 'blob', sha: s })) });
    }
    if (path === 'git/blobs' && method === 'POST') { const b = Buffer.from(body.content, 'base64'); blobs.set(sha1(b), b); return json({ sha: sha1(b) }, 201); }
    if (path === 'git/trees' && method === 'POST') {
      const t = new Map(trees.get(body.base_tree)!);
      for (const e of body.tree) { if (e.sha === null) t.delete(e.path); else t.set(e.path, e.sha); }
      return json({ sha: put(t) }, 201);
    }
    if (path === 'git/commits' && method === 'POST') { const id = `c${++n}`; commits.set(id, { tree: body.tree, parent: body.parents[0], message: body.message }); return json({ sha: id }, 201); }
    if (path.startsWith('git/refs/heads/') && method === 'PATCH') {
      state.patches++;
      if (moveOnce) { // someone else (the heat board) committed first
        moveOnce = false;
        const t = new Map(trees.get(commits.get(head)!.tree)!); const b = Buffer.from('{"heat":2}'); blobs.set(sha1(b), b); t.set('heat.json', sha1(b));
        const id = `c${++n}`; commits.set(id, { tree: put(t), parent: head, message: 'heat' }); head = id;
      }
      if (commits.get(body.sha)!.parent !== head) return json({ message: 'not a fast forward' }, 422);
      head = body.sha; state.commitsMade.push(commits.get(head)!.message); return json({ object: { sha: head } });
    }
    if (path.startsWith('contents/')) { if (method === 'PUT') state.contentPuts++; return json({ message: 'nope' }, 404); }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { fetchImpl, state, fileAt, files: () => [...trees.get(commits.get(head)!.tree)!.keys()].sort() };
}

const config: PublishConfig = { token: 't', owner: 'test', repository: 'feed', branch: 'main', publicBase: 'https://feed.example',
  defaultsDir: 'defaults', dataDir: '', dryRun: false };

async function withFake<T>(gh: ReturnType<typeof fakeGitHub>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = gh.fetchImpl as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('poster sheets are opaque RGB (no unused alpha layer)', async () => {
  const store = new Store(':memory:');
  try {
    const atlas = await buildAtlas(store, 0, 'defaults');
    const meta = await sharp(atlas.bytes).metadata();
    assert.equal(meta.channels, 3); assert.equal(meta.hasAlpha, false); assert.equal(meta.width, 2048);
  } finally { store.close(); }
});

test('everything waiting ships in ONE commit, prunes unused pool files only, and records every release', async () => {
  const store = new Store(':memory:');
  const gh = fakeGitHub({
    'catalog.json': Buffer.from('{"groups":[]}'), 'heat.json': Buffer.from('{}'),
    'atlases/g40-r01.png': Buffer.from('stale sheet'), 'atlases/g40-r01-b.png': Buffer.from('stale sheet b'),
    'billboards/g30-r02.png': Buffer.from('stale banner'), 'studio/g00-r01.png': Buffer.from('studio slot'),
    'wreckshop-service/src/bot.ts': Buffer.from('code'), 'default-posters/DefaultAtlas.png': Buffer.from('default'),
  });
  try {
    const a = store.registerGroup('Alpha'); const b = store.registerGroup('Bravo');
    for (const id of [0, a.id, b.id]) store.queuePublish(id);
    const message = await withFake(gh, () => processOneJob(store, config));
    assert.match(message!, /in one commit/);
    assert.equal(gh.state.commitsMade.length, 1, 'one commit for the whole batch');
    assert.equal(gh.state.contentPuts, 0, 'no per-file commits');
    const files = gh.files();
    for (const gone of ['atlases/g40-r01.png', 'atlases/g40-r01-b.png', 'billboards/g30-r02.png']) assert.ok(!files.includes(gone), `${gone} pruned`);
    for (const kept of ['heat.json', 'studio/g00-r01.png', 'wreckshop-service/src/bot.ts', 'default-posters/DefaultAtlas.png']) assert.ok(files.includes(kept), `${kept} kept`);
    const live = gh.fileAt('catalog.json')!;
    const groups = (JSON.parse(live.toString()) as { groups: { id: number; atlasPoolIndex: number; atlasBPoolIndex: number }[] }).groups;
    const grid = (i: number) => `atlases/g${String(Math.floor(i / 8)).padStart(2, '0')}-r${String(i % 8 + 1).padStart(2, '0')}`;
    for (const g of groups.filter(g => g.atlasPoolIndex >= 0)) {
      assert.ok(files.includes(`${grid(g.atlasPoolIndex)}.png`), `group ${g.id} sheet A live`);
      if (g.atlasBPoolIndex >= 0) assert.ok(files.includes(`${grid(g.atlasBPoolIndex)}-b.png`), `group ${g.id} sheet B live`);
    }
    assert.ok(referencedArt(live).size > 0);
    for (const id of [0, a.id, b.id]) assert.ok(groups.find(g => g.id === id)!.atlasPoolIndex >= 0, `group ${id} activated`);
    for (const id of [0, a.id, b.id]) assert.ok(store.activeRelease(id), `group ${id} release recorded`);
    assert.equal(store.nextJob(), undefined, 'queue drained');
    // Nothing new to publish: no commit at all.
    store.queuePublish(a.id);
    await withFake(gh, () => processOneJob(store, config));
    assert.equal(gh.state.commitsMade.length, 1);
  } finally { store.close(); }
});

test('a branch that moves mid-publish is rebuilt on the new head, keeping the other commit', async () => {
  const store = new Store(':memory:');
  const gh = fakeGitHub({ 'catalog.json': Buffer.from('{"groups":[]}'), 'heat.json': Buffer.from('{}') }, { moveBranchOnce: true });
  try {
    store.queuePublish(0);
    await withFake(gh, () => processOneJob(store, config));
    assert.equal(gh.state.patches, 2);
    assert.equal(gh.fileAt('heat.json')!.toString(), '{"heat":2}', 'the heat board commit survived');
    assert.ok(store.activeRelease(0));
  } finally { store.close(); }
});

test('mass deletion is refused: a bad catalog never wipes the feed', async () => {
  const store = new Store(':memory:');
  const stale: Record<string, Buffer> = { 'catalog.json': Buffer.from('{"groups":[]}') };
  for (let i = 100; i < 170; i++) stale[`atlases/g${String(Math.floor(i / 8)).padStart(2, '0')}-r${String(i % 8 + 1).padStart(2, '0')}.png`] = Buffer.from(`old ${i}`);
  const gh = fakeGitHub(stale);
  try {
    store.queuePublish(0);
    await withFake(gh, () => processOneJob(store, config));
    assert.equal(gh.files().filter(f => f.startsWith('atlases/') && Number(f.slice(9, 11)) >= 12).length, 70, 'all 70 kept');
  } finally { store.close(); }
});
