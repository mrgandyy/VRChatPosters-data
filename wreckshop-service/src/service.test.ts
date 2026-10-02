import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { buildAtlas, normalizePoster, uvRect } from './atlas.js';
import { catalog, poolIndex, publishGroup } from './publish.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'wreckshop-test-'));
  const store = new Store(join(dir,'test.sqlite'));
  return { dir, store, finish: () => { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}
const defaults = resolve('defaults');

test('slot caps, group isolation, stale approval, and rejection preserve approved assignment', () => {
  const f = fixture();
  try {
    const standard = f.store.registerGroup('Standard');
    const premium = f.store.registerGroup('Premium','premium');
    assert.throws(() => f.store.submit(standard.id,9,'user','a','b'));
    assert.doesNotThrow(() => f.store.submit(premium.id,16,'user','a','b'));
    const first = f.store.submit(standard.id,1,'user','first','preview');
    f.store.decide(first.id,'reviewer',true);
    const replacement = f.store.submit(standard.id,1,'user','second','preview');
    assert.equal(replacement.previousId,first.id);
    f.store.decide(replacement.id,'reviewer',false);
    assert.equal(f.store.assigned(standard.id).get(1)?.id,first.id);
    assert.throws(() => f.store.decide(replacement.id,'reviewer',true));
    assert.equal(f.store.assigned(premium.id).size,0);
    f.store.removeOverride(standard.id,1);
    assert.equal(f.store.assigned(standard.id).size,0);
    f.store.setEnabled(standard.id,false);
    assert.equal(f.store.groupByCode(standard.code)?.enabled,0);
    assert.equal(f.store.groupByCode('99999999'),undefined);
  } finally { f.finish(); }
});

test('atlas uses 16 fixed cells, bounded UVs, and accepted static images', async () => {
  const f = fixture();
  try {
    const png = await sharp({create:{width:256,height:384,channels:3,background:'#ff0055'}}).png().toBuffer();
    assert.ok((await normalizePoster(png)).length > 0);
    await assert.rejects(normalizePoster(Buffer.from('not an image')));
    const atlas = await buildAtlas(f.store,0,defaults);
    const info = await sharp(atlas.bytes).metadata();
    assert.equal(info.width,2048);
    assert.equal(info.height,2048);
    assert.equal(atlas.sha256.length,64);
    assert.equal(uvRect(1).x,8/2048);
    assert.equal(uvRect(16).y,(3*512+8)/2048);
    assert.throws(() => uvRect(17));
  } finally { f.finish(); }
});

test('publishing queue survives restart and dry run emits catalog without marking live', async () => {
  const f = fixture();
  const dbPath = join(f.dir,'test.sqlite');
  try {
    f.store.queuePublish(0);
    f.store.markJob(f.store.nextJob()!.id,'publishing');
    const reopened = new Store(dbPath);
    try { assert.equal(reopened.nextJob()?.groupId,0); }
    finally { reopened.close(); }
    assert.equal(poolIndex(f.store.group(0)!,1),0);
    const result = await publishGroup(f.store,0,{branch:'main',publicBase:'https://example.github.io/wreckshop',
      defaultsDir:defaults,dataDir:f.dir,dryRun:true});
    assert.match(result,/dry-run/);
    assert.equal(f.store.lastRelease(0),undefined);
    const json = JSON.parse(catalog(f.store).toString()) as { groups: { atlasPoolIndex:number }[] };
    assert.equal(json.groups[0]?.atlasPoolIndex,-1);
    assert.throws(() => f.store.revert(0,999));
  } finally { f.finish(); }
});

test('catalog follows a prior release after rollback and preserves independent groups', () => {
  const f = fixture();
  try {
    const partner = f.store.registerGroup('Partner','premium');
    f.store.recordRelease(0,1,0,'a'.repeat(64),'https://example.test/a.png');
    f.store.recordRelease(0,2,1,'b'.repeat(64),'https://example.test/b.png');
    f.store.recordRelease(partner.id,1,poolIndex(partner,1),'c'.repeat(64),'https://example.test/c.png');
    f.store.revert(0,1);
    const result = JSON.parse(catalog(f.store).toString()) as { groups: { id:number; revision:number; atlasPoolIndex:number }[] };
    assert.equal(result.groups.find(g => g.id === 0)?.revision,1);
    assert.equal(result.groups.find(g => g.id === 0)?.atlasPoolIndex,0);
    assert.equal(result.groups.find(g => g.id === partner.id)?.revision,1);
    assert.equal(result.groups.find(g => g.id === partner.id)?.atlasPoolIndex,poolIndex(partner,1));
  } finally { f.finish(); }
});
