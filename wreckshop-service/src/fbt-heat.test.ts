import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.js';
import { heatDue, heatKey, MOMENTUM, publishHeat, sanitizeHeat } from './fbt-heat.js';

const site = {
  schema: 1, generated: '2026-10-12T03:00:00.000Z', windowDays: 30,
  clubs: [
    { id: 4, name: 'Velvet Crown', momentum: 'Rising', tier: 'premium', headliner: true, nights: 9, rank: 1, score: 99 },
    { id: 7, name: 'Waypoint', momentum: 'Cooling', tier: 'standard', headliner: true, nights: 2 },
    { id: 7, name: 'Duplicate', momentum: 'Rising', tier: 'standard', headliner: false, nights: 1 },
    { id: 0, name: 'House', momentum: 'Rising', tier: 'premium', headliner: false, nights: 1 },
    { id: 9, name: '  Neon\u0007 Room  ', momentum: 'On the way up', tier: 'gold', headliner: false, nights: -3 },
  ],
  supporters: { headliners: ['Velvet Crown'], premium: ['Lux', 42, ''], vip: ['Someone'] },
};

test('heat.json: exact shape, positive momentum only, no ranks, VIP list stays empty', () => {
  const s = sanitizeHeat(site);
  assert.deepEqual(Object.keys(s), ['schema', 'generated', 'windowDays', 'clubs', 'supporters']);
  assert.deepEqual(s.clubs.map(c => c.id), [4, 7, 9], 'order kept, duplicates and the house dropped');
  for (const c of s.clubs) {
    assert.deepEqual(Object.keys(c), ['id', 'name', 'momentum', 'tier', 'headliner', 'nights']);
    assert.ok((MOMENTUM as readonly string[]).includes(c.momentum));
  }
  assert.equal(s.clubs[1]!.momentum, 'Steady glow', 'a negative label never goes out');
  assert.equal(s.clubs[1]!.headliner, false, 'only premium clubs can be headliners');
  assert.deepEqual(s.clubs[2], { id: 9, name: 'Neon Room', momentum: 'On the way up', tier: 'standard', headliner: false, nights: 0 });
  assert.deepEqual(s.supporters, { headliners: ['Velvet Crown'], premium: ['Lux', '42'], vip: [] });
  assert.throws(() => sanitizeHeat({ schema: 2, clubs: [] }), /unknown format/);
  assert.throws(() => sanitizeHeat(null));
  assert.equal(heatKey(s), heatKey({ ...s, generated: '2030-01-01T00:00:00.000Z' }), 'the timestamp alone is not a change');
  assert.ok(Buffer.byteLength(JSON.stringify(sanitizeHeat({ ...site, clubs: Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: 'x'.repeat(200), momentum: 'Rising', tier: 'premium', headliner: true, nights: 5 })), supporters: { headliners: Array(500).fill('y'.repeat(200)), premium: Array(500).fill('z'.repeat(200)) } }))) < 16_000, 'stays small');
});

test('heat.json publishes only when it changed (dry run), on an hourly check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-heat-'));
  const store = new Store(':memory:');
  const realFetch = globalThis.fetch;
  let body: unknown = site;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const config = { branch: 'main', defaultsDir: dir, dataDir: dir, dryRun: true };
    const siteCfg = { url: 'https://site.test', secret: 's' };
    assert.equal(await publishHeat(store, config, {}), undefined, 'no website link, nothing to do');
    assert.match((await publishHeat(store, config, siteCfg))!, /3 club/);
    const written = JSON.parse(readFileSync(join(dir, 'dry-run/heat.json'), 'utf8'));
    assert.equal(written.schema, 1);
    assert.deepEqual(written.supporters.vip, []);
    body = { ...site, generated: '2026-10-12T04:00:00.000Z' };
    assert.equal(await publishHeat(store, config, siteCfg), undefined, 'same board, no commit');
    body = { ...site, clubs: site.clubs.slice(0, 1) };
    assert.match((await publishHeat(store, config, siteCfg))!, /1 club/);
    assert.equal(heatDue(store, 0), true);
    store.setSetting('heat-checked-at', String(1_000_000));
    assert.equal(heatDue(store, 1_000_000 + 10 * 60_000), false);
    assert.equal(heatDue(store, 1_000_000 + 61 * 60_000), true);
  } finally { globalThis.fetch = realFetch; store.close(); rmSync(dir, { recursive: true, force: true }); }
});
