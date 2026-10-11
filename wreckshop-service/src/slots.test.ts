import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { Store } from './db.js';
import { buildAtlas } from './atlas.js';
import { catalog } from './publish.js';
import { SLOTS, STANDARD_SLOTS, cellOf, posterMap, slotOfCell } from './slots.js';
import { maxSlots } from './types.js';

test('numbering 2: 32 posters, every atlas cell exactly once, walking order by zone', () => {
  assert.equal(SLOTS.length, 32);
  assert.deepEqual(SLOTS.map(s => s.slot), Array.from({ length: 32 }, (_, i) => i + 1));
  assert.deepEqual([...SLOTS.map(s => s.cell)].sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
  const zones = SLOTS.map(s => s.zone);
  const order = ['entrance', 'arrival', 'lower', 'upper'];
  for (let i = 1; i < zones.length; i++) assert.ok(order.indexOf(zones[i]!) >= order.indexOf(zones[i - 1]!), `zone order at ${i + 1}`);
  for (const s of SLOTS) { assert.equal(cellOf(s.slot), s.cell); assert.equal(slotOfCell(s.cell), s.slot); }
});

test('standard = exactly the entrance + arrival hall (11); premium = all 32', () => {
  assert.equal(STANDARD_SLOTS, 11);
  assert.equal(maxSlots('standard'), 11);
  assert.equal(maxSlots('premium'), 32);
  const standard = SLOTS.filter(s => s.slot <= STANDARD_SLOTS);
  assert.ok(standard.every(s => s.zone === 'entrance' || s.zone === 'arrival'));
  assert.equal(SLOTS.filter(s => s.zone === 'entrance' || s.zone === 'arrival').length, 11);
  // The old map: entrance was cells 27–32, arrival hall 17–20 plus 01.
  assert.deepEqual(standard.map(s => s.cell).sort((a, b) => a - b), [1, 17, 18, 19, 20, 27, 28, 29, 30, 31, 32]);
  assert.ok(posterMap().length < 2000, 'fits one Discord message');
});

test('a standard group\'s poster 1 lands on the sidewalk totem (cell 29, sheet B) and only there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-atlas-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const defaults = resolve('defaults');
    const g = store.registerGroup('Standard Venue');
    const beforeA = await buildAtlas(store, g.id, defaults, 0);
    const src = join(dir, 'pink.png');
    writeFileSync(src, await sharp({ create: { width: 256, height: 384, channels: 3, background: '#ff0055' } }).png().toBuffer());
    store.decide(store.submit(g.id, 1, 'u', src, src).id, 'r', true);
    assert.equal((await buildAtlas(store, g.id, defaults, 0)).sha256, beforeA.sha256, 'sheet A untouched');
    const b = await buildAtlas(store, g.id, defaults, 1);
    // cell 29 → sheet B index 12 → column 0, row 3
    const px = await sharp(b.bytes).extract({ left: 256, top: 3 * 512 + 256, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...px], [255, 0, 85]);
    const catalogEntry = JSON.parse(catalog(store).toString()).groups.find((x: { id: number }) => x.id === g.id);
    assert.equal(catalogEntry.tier, 'standard', 'catalog shape unchanged: the world needs no update for the renumber');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('upgrading from numbering 1: premium posters stay put physically, standard posters keep their numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-migrate-'));
  const path = join(dir, 'db.sqlite');
  let store = new Store(path);
  const std = store.registerGroup('Std');
  const pre = store.registerGroup('Pre', 'premium');
  store.close();
  // Write numbering-1 data straight in: slot = atlas cell.
  const raw = new Database(path);
  const sub = raw.prepare(`INSERT INTO submissions(group_id,slot,submitter_id,source_path,preview_path,status) VALUES(?,?,'u','s','p','live')`);
  const put = raw.prepare('INSERT INTO assignments(group_id,slot,submission_id) VALUES(?,?,?)');
  for (const [g, cell] of [[std.id, 1], [std.id, 5], [pre.id, 1], [pre.id, 2], [pre.id, 32]] as const)
    put.run(g, cell, Number(sub.run(g, cell).lastInsertRowid));
  raw.prepare("UPDATE settings SET value='1' WHERE key='poster_numbering'").run();
  raw.close();
  try {
    store = new Store(path);
    assert.equal(store.setting('poster_numbering'), '2');
    assert.deepEqual([...store.assigned(std.id).keys()].sort((a, b) => a - b), [1, 5], 'standard numbers kept (now entrance spots)');
    assert.deepEqual([...store.assigned(pre.id).keys()].sort((a, b) => a - b), [11, 12, 4].sort((a, b) => a - b),
      'premium: cell 1 → poster 11, cell 2 → poster 12, cell 32 → poster 4');
    assert.deepEqual(store.submissions(pre.id).map(s => s.slot).sort((a, b) => a - b), [4, 11, 12]);
    store.close();
    store = new Store(path);
    assert.deepEqual([...store.assigned(pre.id).keys()].sort((a, b) => a - b), [4, 11, 12], 'runs once');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
