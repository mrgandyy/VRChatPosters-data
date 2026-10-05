import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubPut, catalog } from './publish.js';
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
