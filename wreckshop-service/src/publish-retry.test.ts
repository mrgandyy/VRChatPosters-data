import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubPut, catalog, publishFile } from './publish.js';
import { Store } from './db.js';
test('identical upload retry does not create a commit or restart Pages', async()=>{
 const original=globalThis.fetch;const bytes=Buffer.from('approved artwork');
 const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 let writes=0;
 globalThis.fetch=async(_input,init)=>{if(init?.method==='PUT')writes++;return new Response(JSON.stringify({sha}),{status:200});};
 try {await githubPut({branch:'main',defaultsDir:'',dataDir:'',dryRun:false},'test.png',bytes,'retry');assert.equal(writes,0);}
 finally{globalThis.fetch=original;}
});
test('unchanged catalog remains byte-identical across retries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fbt-catalog-'));const store=new Store(join(dir,'test.sqlite'));
 try{store.registerGroup('Test');assert.deepEqual(catalog(store),catalog(store));assert.ok(!JSON.parse(catalog(store).toString()).generatedAt);}
 finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

for (const alreadyLive of [false,true]) test(`identical committed asset ${alreadyLive ? 'already live needs no build' : 'missing from Pages triggers a recovery build'}`,async()=>{
 const original=globalThis.fetch;const bytes=Buffer.from('approved artwork');
 const blobSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 const writes:string[]=[];let publicReads=0;
 globalThis.fetch=async(input,init)=>{
   const url=String(input);
   if(url.startsWith('https://feed.example/')){
     publicReads++;
     return !alreadyLive && publicReads===1 ? new Response('missing',{status:404}) : new Response(bytes);
   }
   if(init?.method==='PUT'){writes.push(url);return new Response('{}',{status:201});}
   if(url.includes('.pages-recovery.json'))return new Response('{}',{status:404});
   return new Response(JSON.stringify({sha:blobSha}));
 };
 try{
   await publishFile({branch:'main',owner:'test',repository:'feed',publicBase:'https://feed.example',defaultsDir:'',dataDir:'',dryRun:false},'atlas.png',bytes,'retry');
   assert.deepEqual(writes,alreadyLive ? [] : ['https://api.github.com/repos/test/feed/contents/.pages-recovery.json']);
 }finally{globalThis.fetch=original;}
});

test('transient publish failures retry after cooldown, behind fresh work, with a finite budget',()=>{
 const store=new Store(':memory:');
 try{
   const group=store.registerGroup('Retry');store.queuePublish(group.id);const job=store.nextJob()!;
   store.markJob(job.id,'publishing');
   store.markJob(job.id,'failed','Error: Public asset did not match the release hash: https://feed/atlas.png');
   assert.equal(store.nextJob(),undefined);
   store.db.prepare("UPDATE jobs SET updated_at=datetime('now','-3 minutes') WHERE id=?").run(job.id);
   assert.equal(store.nextJob()?.id,job.id);
   const other=store.registerGroup('Fresh');store.queuePublish(other.id);
   const fresh=store.nextJob()!;assert.equal(fresh.groupId,other.id);
   store.markJob(fresh.id,'live');
   store.db.prepare('UPDATE jobs SET attempts=3 WHERE id=?').run(job.id);
   assert.equal(store.nextJob(),undefined);
   store.db.prepare('UPDATE jobs SET attempts=1 WHERE id=?').run(job.id);
   const newer=store.queuePublish(group.id);store.markJob(newer,'live');
   assert.equal(store.nextJob(),undefined);
 }finally{store.close();}
});

test('configuration and capacity failures are not automatically retried',()=>{
 const store=new Store(':memory:');
 try{
   const group=store.registerGroup('Permanent');store.queuePublish(group.id);const job=store.nextJob()!;
   for(const error of ['GitHub upload failed: HTTP 403','Authored atlas URL capacity exhausted; extend and reupload the world.']){
     store.markJob(job.id,'failed',error);
     store.db.prepare("UPDATE jobs SET updated_at=datetime('now','-3 minutes') WHERE id=?").run(job.id);
     assert.equal(store.nextJob(),undefined);
   }
 }finally{store.close();}
});
