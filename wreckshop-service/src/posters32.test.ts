import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from './db.js';
import { buildAtlas } from './atlas.js';
import { catalog, publishGroup } from './publish.js';

test('legacy 16-slot database migrates transactionally with history and assignments intact', () => {
 const dir=mkdtempSync(join(tmpdir(),'posters32-migration-')), path=join(dir,'test.sqlite');
 let store=new Store(path);store.close();const legacy=new Database(path);
 for(const name of ['assignments','submissions']){
  const row=legacy.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as {sql:string};
  legacy.exec(`DROP TABLE ${name}`);legacy.exec(row.sql.replace('BETWEEN 1 AND 32','BETWEEN 1 AND 16'));
 }
 legacy.exec("INSERT INTO submissions(id,group_id,slot,submitter_id,source_path,preview_path,status) VALUES(7,0,16,'u','a','b','approved'); INSERT INTO submissions(id,group_id,slot,submitter_id,source_path,preview_path,status,previous_id) VALUES(8,0,16,'u','c','d','live',7); INSERT INTO assignments VALUES(0,16,8);");legacy.close();
 try{
  store=new Store(path);assert.equal(store.assigned(0).get(16)?.id,8);assert.equal(store.submissions(0).find(s=>s.id===8)?.previousId,7);
  assert.doesNotThrow(()=>store.submit(0,32,'u','x','y'));assert.throws(()=>store.submit(0,33,'u','x','y'));
  assert.deepEqual(store.db.pragma('foreign_key_check'),[]);assert.equal(store.db.pragma('foreign_keys',{simple:true}),1);
  assert.ok(readdirSync(dir).some(n=>n.includes('before-32-posters')));
  store.close();store=new Store(path);assert.equal(store.assigned(0).get(16)?.id,8);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('slot 32 changes only sheet B; dry run emits both sheets and advertises B without publishing', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'posters32-atlas-'));const store=new Store(join(dir,'db.sqlite'));
 try{
  const defaults=resolve('defaults');const before=await buildAtlas(store,0,defaults);
  const source=join(dir,'pink.png');writeFileSync(source,await sharp({create:{width:256,height:384,channels:3,background:'#ff0055'}}).png().toBuffer());
  const submission=store.submit(0,32,'u',source,source);store.decide(submission.id,'reviewer',true);
  assert.equal((await buildAtlas(store,0,defaults)).sha256,before.sha256);
  const b=await buildAtlas(store,0,defaults,1);const pixel=await sharp(b.bytes).extract({left:1792,top:1792,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[255,0,85]);
  await publishGroup(store,0,{branch:'main',publicBase:'https://example.test',defaultsDir:defaults,dataDir:dir,dryRun:true});
  const output=JSON.parse(readFileSync(join(dir,'dry-run/catalog.json'),'utf8'));assert.equal(output.groups[0].atlasBPoolIndex,0);
  assert.ok(readFileSync(join(dir,'dry-run/group-0-atlas-b.png')).length>0);assert.equal(store.activeRelease(0),undefined);
  const legacy=JSON.parse(catalog(store).toString());assert.equal(legacy.groups[0].atlasBPoolIndex,-1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
