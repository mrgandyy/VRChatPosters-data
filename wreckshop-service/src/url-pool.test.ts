import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './db.js';
import { reserveUrl, assetPath } from './url-pool.js';
import { publishGroup, catalog } from './publish.js';

test('1000 groups register independently of immutable artwork URLs; identical posters share one URL', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pool-scale-'));const store=new Store(':memory:');
  try {
    for(let i=1;i<=1000;i++) store.registerGroup(`Partner ${i}`);
    assert.equal(store.groups().length,1001);
    const config={branch:'main',publicBase:'https://example.test',defaultsDir:resolve('defaults'),dataDir:dir,dryRun:true};
    await publishGroup(store,32,config);
    const first=JSON.parse(readFileSync(join(dir,'dry-run/catalog.json'),'utf8')).groups.find((g:{id:number})=>g.id===32);
    await publishGroup(store,1000,config);
    const last=JSON.parse(readFileSync(join(dir,'dry-run/catalog.json'),'utf8')).groups.find((g:{id:number})=>g.id===1000);
    assert.equal(first.atlasPoolIndex,last.atlasPoolIndex);
    assert.ok(last.atlasPoolIndex>=0 && last.atlasPoolIndex<256);
    assert.equal(last.atlasBPoolIndex,last.atlasPoolIndex);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy migration protects archived releases and partial uploads and preserves catalog across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pool-migration-'));const path=join(dir,'test.sqlite');let store=new Store(path);
  try {
    const old=store.registerGroup('Archived');
    store.recordRelease(old.id,1,8,'old','https://example.test/atlases/g01-r01.png');store.deleteGroup(old.id);
    store.recordRelease(0,1,0,'default','https://example.test/atlases/g00-r01.png');
    store.setSetting('poster-sheet-b-0-1',JSON.stringify({sha256B:'sheetB'}));
    store.db.exec("DROP TABLE url_reservations; DELETE FROM settings WHERE key='shared-url-pool-v1'");
    const before=catalog(store);store.close();store=new Store(path);
    assert.deepEqual(catalog(store),before);
    assert.equal(reserveUrl(store,'atlas','default:sheetB'),0);
    const protectedIndices=[0,1,8,9];
    for(let i=0;i<20;i++) assert.ok(!protectedIndices.includes(reserveUrl(store,'atlas',`new:${i}`)));
    const retry=reserveUrl(store,'atlas','retry');store.close();store=new Store(path);
    assert.equal(reserveUrl(store,'atlas','retry'),retry);
    assert.notEqual(reserveUrl(store,'atlas','changed-after-failure'),retry);
    assert.deepEqual(catalog(store),before);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('all three pools stay within authored URLs, never recycle, and fail explicitly when full',()=>{
  const store=new Store(':memory:');
  try {
    for(const kind of ['atlas','billboard','backdrop'] as const) {
      const indices=new Set<number>();
      const existing=kind==='atlas'?1:0;
      for(let i=existing;i<256;i++) indices.add(reserveUrl(store,kind,`bytes:${i}`));
      assert.equal(indices.size,256-existing);
      for(const index of indices) assert.match(assetPath(kind,index),/g\d{2}-r0[1-8]\.png$/);
      assert.throws(()=>reserveUrl(store,kind,'overflow'),/capacity exhausted/);
      assert.equal(reserveUrl(store,kind,'bytes:255'),255);
    }
    assert.throws(()=>assetPath('atlas',256));
  } finally {store.close();}
});
