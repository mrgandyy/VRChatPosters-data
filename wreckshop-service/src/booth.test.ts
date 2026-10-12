import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { submitBooth, decideBooth, prepareBooth, liveBooth } from './booth.js';
import { catalog, publishGroup } from './publish.js';
import { assetPath } from './url-pool.js';

test('premium DJ booth front: review, 2400 x 400 output, immutable retry, catalog boothPoolIndex, downgrade and suspension', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wreckshop-booth-'));
  const store=new Store(join(dir,'test.sqlite'));
  try {
    const standard=store.registerGroup('Standard');
    const premium=store.registerGroup('Premium','premium');
    const source=join(dir,'wide.png');
    writeFileSync(source,await sharp({create:{width:1200,height:200,channels:3,background:'#228844'}}).png().toBuffer());
    assert.throws(()=>submitBooth(store,standard.id,'user',source,source),/premium/);
    assert.throws(()=>submitBooth(store,0,'user',source,source));
    const id=submitBooth(store,premium.id,'user',source,source);
    assert.equal(await prepareBooth(store,premium.id),undefined,'nothing until approved');
    decideBooth(store,id,'reviewer',true);
    assert.throws(()=>decideBooth(store,id,'reviewer',true),/already reviewed/);
    const result=(await prepareBooth(store,premium.id))!;
    const meta=await sharp(result.bytes).metadata();
    assert.equal(meta.width,2400); assert.equal(meta.height,400);
    assert.match(result.release.path,/^booths\/g\d{2}-r0[1-8]\.png$/);
    assert.equal(result.release.path,assetPath('booth',result.release.poolIndex));
    assert.deepEqual((await prepareBooth(store,premium.id))!.release,result.release,'retries reuse the reserved URL');
    const get=()=>JSON.parse(catalog(store).toString()).groups.find((g:{id:number})=>g.id===premium.id);
    assert.equal(get().boothPoolIndex,-1,'not live until published');
    store.setSetting(`booth-live-${premium.id}`,JSON.stringify(result.release));
    assert.equal(liveBooth(store,premium.id)!.poolIndex,result.release.poolIndex);
    assert.equal(get().boothPoolIndex,result.release.poolIndex);
    const rejected=submitBooth(store,premium.id,'user',source,source);
    decideBooth(store,rejected,'reviewer',false);
    assert.deepEqual((await prepareBooth(store,premium.id))!.release,result.release,'a rejection keeps the live art');
    store.setEnabled(premium.id,false); assert.equal(get().boothPoolIndex,-1);
    store.setEnabled(premium.id,true); store.setTier(premium.id,'standard');
    assert.equal(get().boothPoolIndex,-1); assert.equal(await prepareBooth(store,premium.id),undefined);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('catalog: every group has boothPoolIndex and a headliner flag; tier stays premium for headliners', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wreckshop-headliner-'));
  const store=new Store(':memory:');
  try {
    const plain=store.registerGroup('Plain');
    const prem=store.registerGroup('Prem','premium');
    const head=store.registerGroup('Head','premium');
    store.setHeadliner(head.id,true);
    const groups=JSON.parse(catalog(store).toString()).groups as {id:number;tier:string;headliner:boolean;boothPoolIndex:number}[];
    for(const g of groups){ assert.equal(typeof g.headliner,'boolean'); assert.equal(g.boothPoolIndex,-1); }
    const by=(id:number)=>groups.find(g=>g.id===id)!;
    assert.equal(by(plain.id).headliner,false);
    assert.equal(by(prem.id).headliner,false);
    assert.equal(by(head.id).headliner,true);
    assert.equal(by(head.id).tier,'premium');
    store.setTier(head.id,'standard');
    assert.equal(JSON.parse(catalog(store).toString()).groups.find((g:{id:number})=>g.id===head.id).headliner,false,'dropping to standard clears headliner');

    // A dry-run publish carries the approved booth into the catalog and writes the PNG.
    const source=join(dir,'wide.png');
    writeFileSync(source,await sharp({create:{width:2400,height:400,channels:3,background:'#884422'}}).png().toBuffer());
    const id=submitBooth(store,prem.id,'user',source,source); decideBooth(store,id,'reviewer',true);
    await publishGroup(store,prem.id,{branch:'main',publicBase:'https://example.test',defaultsDir:resolve('defaults'),dataDir:dir,dryRun:true});
    const entry=JSON.parse(readFileSync(join(dir,'dry-run/catalog.json'),'utf8')).groups.find((g:{id:number})=>g.id===prem.id);
    assert.ok(entry.boothPoolIndex>=0 && entry.boothPoolIndex<256);
    assert.ok(existsSync(join(dir,`dry-run/group-${prem.id}-booth.png`)));
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
