import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { catalog, lookOf, publishGroup } from './publish.js';
import { ROLE_KEYS, decideStudioTexture, liveStudio, parseTheme, parseVenue, prepareStudioTexture, setStudioTheme, studioSlot, submitStudioTexture } from './studio.js';

const THEME = { accent: '#FF4FA3', glow: '#5fd4ff', glowLevel: 2, finish: 'marble', texture: true };
const entry = (store: Store, id: number) => JSON.parse(catalog(store).toString()).groups.find((g: { id: number }) => g.id === id);

test('studio themes are validated', () => {
  assert.deepEqual(parseTheme(THEME), { accent: '#ff4fa3', glow: '#5fd4ff', glowLevel: 2, finish: 'marble', texture: true });
  assert.equal(parseTheme({ ...THEME, finish: 'gold' }), undefined);
  assert.equal(parseTheme({ ...THEME, accent: 'red' }), undefined);
  assert.equal(parseTheme({ ...THEME, glow: 'javascript:' }), undefined);
  assert.equal(parseTheme({ ...THEME, glowLevel: 9 })!.glowLevel, 1);
  assert.equal(parseTheme(null), undefined);
});

test('catalog: studio only for Premium/Headliner with a saved theme; it feeds accent and glow', async () => {
  const store = new Store(':memory:');
  try {
    const standard = store.registerGroup('Plain');
    const premium = store.registerGroup('Gold', 'premium');
    store.setSetting(`look-${premium.id}`, JSON.stringify({ accent: '#e8507a', glow: 0 }));
    assert.equal(entry(store, premium.id).studio, undefined, 'no theme yet');
    assert.equal(entry(store, premium.id).accent, '#e8507a');
    setStudioTheme(store, premium.id, THEME);
    assert.equal(store.setting('catalog-dirty'), '1');
    assert.deepEqual(entry(store, premium.id).studio, { accent: '#ff4fa3', glow: '#5fd4ff', finish: 'marble', texturePool: -1 });
    assert.deepEqual(lookOf(store, premium.id), { accent: '#ff4fa3', glow: 2 }, 'studio accent and glow level feed the fields older worlds read');
    assert.equal(entry(store, premium.id).accent, '#ff4fa3');
    assert.equal(entry(store, premium.id).glow, 2);
    setStudioTheme(store, standard.id, THEME);
    assert.equal(entry(store, standard.id).studio, undefined, 'Standard groups never get a studio');
    assert.equal(entry(store, standard.id).accent, '', 'and their accent stays their own look');
    store.setHeadliner(premium.id, true);
    assert.ok(entry(store, premium.id).studio, 'Headliner keeps it');
    store.setEnabled(premium.id, false);
    assert.equal(entry(store, premium.id).studio, undefined, 'suspended: none');
    store.setEnabled(premium.id, true);
    setStudioTheme(store, premium.id, null);
    assert.equal(entry(store, premium.id).studio, undefined, 'cleared');
    assert.throws(() => setStudioTheme(store, premium.id, { ...THEME, finish: 'gold' }), /not valid/);
  } finally { store.db.close(); }
});

test('studio texture: review, 1024 x 1024 in a stable studio/ slot, texturePool after publish, reclaimed from lapsed groups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-studio-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    const premium = store.registerGroup('Gold', 'premium');
    const standard = store.registerGroup('Plain');
    const source = join(dir, 'marble.png');
    writeFileSync(source, await sharp({ create: { width: 2000, height: 1500, channels: 4, background: { r: 200, g: 190, b: 180, alpha: 0.5 } } }).png().toBuffer());
    assert.throws(() => submitStudioTexture(store, standard.id, 'u', source, source), /Premium/);
    const id = submitStudioTexture(store, premium.id, 'u', source, source);
    assert.equal(await prepareStudioTexture(store, premium.id), undefined, 'nothing until approved');
    decideStudioTexture(store, id, 'staff', true);
    assert.throws(() => decideStudioTexture(store, id, 'staff', true), /already reviewed/);
    const ready = (await prepareStudioTexture(store, premium.id))!;
    const meta = await sharp(ready.bytes).metadata();
    assert.equal(meta.width, 1024); assert.equal(meta.height, 1024); assert.equal(meta.hasAlpha, false);
    assert.equal(ready.release.path, 'studio/g00-r01.png');
    assert.equal((await prepareStudioTexture(store, premium.id))!.release.poolIndex, ready.release.poolIndex, 'same slot every time');

    setStudioTheme(store, premium.id, THEME);
    const config = { branch: 'main', publicBase: 'https://feed.example', defaultsDir: join(process.cwd(), 'defaults'), dataDir: dir, dryRun: true };
    assert.match(await publishGroup(store, premium.id, config), /dry-run/);
    store.setSetting(`studio-live-${premium.id}`, JSON.stringify(ready.release));
    assert.equal(entry(store, premium.id).studio.texturePool, 0);
    setStudioTheme(store, premium.id, { ...THEME, texture: false });
    assert.equal(entry(store, premium.id).studio.texturePool, -1, 'the theme can leave the texture off');
    setStudioTheme(store, premium.id, THEME);

    // Fill every slot with Premium groups; the next one waits until a group lapses, then takes its slot.
    for (let i = 1; i < 64; i++) assert.equal(studioSlot(store, store.registerGroup(`Club ${i}`, 'premium').id), i);
    const late = store.registerGroup('Late', 'premium');
    assert.equal(studioSlot(store, late.id), undefined, 'all 64 held by Premium groups');
    store.setTier(premium.id, 'standard');
    assert.equal(entry(store, premium.id).studio, undefined);
    assert.equal(studioSlot(store, late.id), 0, 'the lapsed group\'s slot is reclaimed');
    store.setTier(premium.id, 'premium');
    assert.equal(liveStudio(store, premium.id), undefined, 'its old texture no longer points at a slot it owns');
    assert.equal(entry(store, premium.id).studio.texturePool, -1);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

const LOOK = { theme: 'neon_tokyo', roles: Object.fromEntries(ROLE_KEYS.map(k => [k, { f: k === 'Walls' ? 'neon_hex_panel' : '', b: 0, c: 1, s: -2, h: 12 }])) };

test('pass 23: venue looks are validated and published as `venue`', () => {
  assert.deepEqual(parseVenue(LOOK), LOOK);
  assert.equal(parseVenue({ ...LOOK, theme: 'Bad Key!' }), undefined);
  assert.equal(parseVenue({ ...LOOK, roles: { ...LOOK.roles, Wood: { f: '', b: 5, c: 0, s: 0, h: 0 } } }), undefined, 'tone out of range');
  assert.equal(parseVenue({ ...LOOK, roles: { ...LOOK.roles, Wood: undefined } }), undefined, 'every role is needed');
  const theme = parseTheme({ accent: '#123456', glow: '#abcdef', glowLevel: 0, venue: LOOK })!;
  assert.deepEqual(theme, { accent: '#123456', glow: '#abcdef', glowLevel: 0, texture: false, venue: LOOK });
  assert.equal(parseTheme({ accent: '#123456', glow: '#abcdef', glowLevel: 0, venue: { theme: '' } }), undefined);
  const store = new Store(':memory:');
  try {
    const premium = store.registerGroup('Neon', 'premium');
    const standard = store.registerGroup('Plain');
    setStudioTheme(store, premium.id, { accent: '#21e6ff', glow: '#21e6ff', glowLevel: 2, venue: LOOK });
    setStudioTheme(store, standard.id, { accent: '#21e6ff', glow: '#21e6ff', glowLevel: 2, venue: LOOK });
    assert.deepEqual(entry(store, premium.id).venue, LOOK);
    assert.deepEqual(entry(store, premium.id).studio, { accent: '#21e6ff', glow: '#21e6ff', finish: '', texturePool: -1 }, 'no texture with a venue look');
    assert.equal(entry(store, premium.id).accent, '#21e6ff');
    assert.equal(entry(store, standard.id).venue, undefined, 'Standard groups never get one');
    setStudioTheme(store, premium.id, null);
    assert.equal(entry(store, premium.id).venue, undefined, 'cleared');
  } finally { store.db.close(); }
});
