import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { decideLocker, lockersJson, prepareLockers, publishLockers, removeLocker, renameLocker, submitLocker, validateVrcName } from './locker.js';
import { assetPath, reserveUrl, LOCKER_POOL_CAPACITY } from './url-pool.js';

const A = '100000000000000001', B = '100000000000000002';

test('VRChat display names: trimmed, required, no control characters', () => {
  assert.equal(validateVrcName('  Velvet Fox '), 'Velvet Fox');
  assert.throws(() => validateVrcName(''), /display name/);
  assert.throws(() => validateVrcName('bad\nname'));
  assert.throws(() => validateVrcName('x'.repeat(65)), /too long/);
  assert.equal(validateVrcName('ナイト☆Dancer'), 'ナイト☆Dancer', 'unicode names are kept as typed');
});

test('dancer lockers: review, one name per dancer, rename, take down, 500 x 700 output and lockers.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wreckshop-locker-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    const source = join(dir, 'tall.png');
    writeFileSync(source, await sharp({ create: { width: 400, height: 900, channels: 3, background: '#663355' } }).png().toBuffer());
    assert.throws(() => submitLocker(store, 'not-a-snowflake', 'Fox', source, source), /Discord/);
    const first = submitLocker(store, A, 'Velvet Fox', source, source);
    assert.deepEqual(await prepareLockers(store), [], 'nothing until approved');
    decideLocker(store, first, 'staff', true);
    assert.equal(store.setting('lockers-dirty'), '1');
    assert.throws(() => decideLocker(store, first, 'staff', true), /already reviewed/);

    // Someone else can't claim the same name (any case), before or after review.
    assert.throws(() => submitLocker(store, B, 'velvet fox', source, source), /already has a locker/);
    const other = submitLocker(store, B, 'Neon Kitty', source, source);
    decideLocker(store, other, 'staff', false);

    let prepared = await prepareLockers(store);
    assert.equal(prepared.length, 1);
    const meta = await sharp(prepared[0]!.bytes).metadata();
    assert.equal(meta.width, 500); assert.equal(meta.height, 700);
    assert.match(prepared[0]!.release.path, /^lockers\/g\d{2}-r0[1-8]\.png$/);
    assert.equal(prepared[0]!.release.path, assetPath('locker', prepared[0]!.release.poolIndex));
    assert.deepEqual((await prepareLockers(store))[0]!.release, prepared[0]!.release, 'retries reuse the reserved URL');
    assert.deepEqual(JSON.parse(lockersJson(prepared).toString()), { lockers: [{ name: 'Velvet Fox', pool: prepared[0]!.release.poolIndex }] });

    // Rename: the same art follows the new name; nobody can take another dancer's name.
    store.setSetting('lockers-dirty', '0');
    assert.equal(renameLocker(store, A, 'Velvet Fox'), false, 'no change, no publish');
    assert.equal(renameLocker(store, A, 'Velvet Vixen'), true);
    assert.equal(store.setting('lockers-dirty'), '1');
    const again = submitLocker(store, B, 'Neon Kitty', source, source);
    decideLocker(store, again, 'staff', true);
    assert.throws(() => renameLocker(store, B, 'VELVET VIXEN'), /already has a locker/);

    // Dry-run publish writes the images and the exact list file the world reads.
    const out = await publishLockers(store, { branch: 'main', defaultsDir: dir, dataDir: dir, dryRun: true });
    assert.match(out!, /2 locker/);
    const list = JSON.parse(readFileSync(join(dir, 'dry-run/lockers/lockers.json'), 'utf8')) as { lockers: { name: string; pool: number }[] };
    assert.deepEqual(Object.keys(list), ['lockers']);
    assert.deepEqual(list.lockers.map(l => l.name).sort(), ['Neon Kitty', 'Velvet Vixen']);
    for (const l of list.lockers) {
      assert.deepEqual(Object.keys(l), ['name', 'pool']);
      assert.ok(Number.isInteger(l.pool) && l.pool >= 0 && l.pool < 128);
      assert.ok(existsSync(join(dir, 'dry-run', assetPath('locker', l.pool))));
    }
    // Two identical images from two dancers still get their own URLs (each locker is its own file).
    assert.notEqual(list.lockers[0]!.pool, list.lockers[1]!.pool);

    assert.equal(removeLocker(store, A), true);
    assert.deepEqual((await prepareLockers(store)).map(l => l.vrcName), ['Neon Kitty']);
    assert.equal(removeLocker(store, A), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the locker pool is 128 URLs, separate from the 256-URL pools', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(LOCKER_POOL_CAPACITY, 128);
    for (let i = 0; i < 128; i++) assert.ok(reserveUrl(store, 'locker', `k:${i}`) < 128);
    assert.throws(() => reserveUrl(store, 'locker', 'overflow'), /capacity exhausted \(128/);
    assert.throws(() => assetPath('locker', 128));
    assert.equal(assetPath('locker', 127), 'lockers/g15-r08.png');
    assert.equal(assetPath('booth', 255), 'booths/g31-r08.png');
    assert.equal(reserveUrl(store, 'booth', 'unrelated'), 0, 'booth and locker pools are independent');
  } finally { store.close(); }
});
