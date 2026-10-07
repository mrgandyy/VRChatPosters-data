import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGroupLink,groupLinkPrompt } from './group-link.js';
import { Store } from './db.js';
import { catalog } from './publish.js';
const id='grp_11111111-2222-3333-4444-555555555555';
test('group links accept IDs and official URLs while rejecting malformed and external destinations',()=>{
 const expected=`https://vrchat.com/home/group/${id}`;
 assert.equal(normalizeGroupLink(` ${id.toUpperCase()} `),expected);
 assert.equal(normalizeGroupLink(`${expected}/?utm_source=discord`),expected);
 for(const value of ['', 'grp_short','usr_11111111-2222-3333-4444-555555555555',`https://evil.example/home/group/${id}`,`https://vrchat.com.evil.example/home/group/${id}`,`https://user@vrchat.com/home/group/${id}`,`http://vrchat.com/home/group/${id}`,`https://vrchat.com/home/user/${id}`])assert.throws(()=>normalizeGroupLink(value));
});
test('registration stores validated link atomically; only premium destinations are published and prompted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ws-grouplink-'));const store=new Store(join(dir,'test.db'));
 try{
  const before=store.groups().length;assert.throws(()=>store.registerGroup('Invalid','premium','grp_no'));assert.equal(store.groups().length,before);
  const standard=store.registerGroup('Standard','standard','grp_aaaaaaaa-2222-3333-4444-555555555555');const premium=store.registerGroup('Premium','premium',id);
  const groups=JSON.parse(catalog(store).toString()).groups;
  assert.equal(groups.find((g:any)=>g.id===standard.id).vrchatGroupUrl,null);
  assert.equal(groups.find((g:any)=>g.id===premium.id).vrchatGroupUrl,normalizeGroupLink(id));
  assert.equal(groupLinkPrompt(standard),'Join group is a Premium feature.');
  store.setUrl(premium.id,null);assert.match(groupLinkPrompt(store.group(premium.id)!),/\/group link/);
  store.setUrl(premium.id,id);assert.equal(store.group(premium.id)!.vrchatUrl,normalizeGroupLink(id));assert.ok(store.nextJob());
  store.setTier(premium.id,'standard');assert.equal(JSON.parse(catalog(store).toString()).groups.find((g:any)=>g.id===premium.id).vrchatGroupUrl,null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
