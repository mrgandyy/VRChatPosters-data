import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { submitBackdrop, decideBackdrop, prepareBackdrop, liveBackdrop } from './backdrop.js';
import { catalog } from './publish.js';

test('premium backdrop review, immutable retry, public catalog, downgrade and suspension', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wreckshop-banner-'));
  const store=new Store(join(dir,'test.sqlite'));
  try {
    const standard=store.registerGroup('Standard');
    const premium=store.registerGroup('Premium','premium');
    const source=join(dir,'wide.png');
    writeFileSync(source,await sharp({create:{width:1024,height:256,channels:3,background:'#883344'}}).png().toBuffer());
    assert.throws(()=>submitBackdrop(store,standard.id,'user',source,source));
    const id=submitBackdrop(store,premium.id,'user',source,source);
    assert.equal(await prepareBackdrop(store,premium.id),undefined);
    decideBackdrop(store,id,'reviewer',true);
    assert.throws(()=>decideBackdrop(store,id,'reviewer',true));
    const result=(await prepareBackdrop(store,premium.id))!;
    const meta=await sharp(result.bytes).metadata();
    assert.equal(meta.width,2048); assert.equal(meta.height,1536);
    assert.equal(liveBackdrop(store,premium.id),undefined);
    assert.deepEqual((await prepareBackdrop(store,premium.id))!.release,result.release);
    store.setSetting(`backdrop-live-${premium.id}`,JSON.stringify(result.release));
    const get=()=>JSON.parse(catalog(store).toString()).groups.find((g:{id:number})=>g.id===premium.id);
    assert.equal(get().backdropPoolIndex,result.release.poolIndex);
    const rejected=submitBackdrop(store,premium.id,'user',source,source);
    decideBackdrop(store,rejected,'reviewer',false);
    assert.deepEqual((await prepareBackdrop(store,premium.id))!.release,result.release);
    store.setEnabled(premium.id,false); assert.equal(get().backdropPoolIndex,-1);
    store.setEnabled(premium.id,true); store.setTier(premium.id,'standard');
    assert.equal(get().backdropPoolIndex,-1); assert.equal(await prepareBackdrop(store,premium.id),undefined);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
