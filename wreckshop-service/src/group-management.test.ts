import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './db.js';
import {catalog} from './publish.js';
import {validateGroupName} from './group-link.js';
const id='grp_3efba4a4-18d7-43ec-b8ef-1cafd9cec1c4';
test('registration is idempotent, one user/group and one VRChat ID, deletion retains history',()=>{
 const s=new Store(':memory:'); try {
  const a=s.registerGroup('Devilish','standard',id,'cherry');
  assert.equal(s.registerGroup('wrong name','standard',id,'cherry').id,a.id);
  assert.throws(()=>s.registerGroup('Other','standard',undefined,'cherry'));
  assert.throws(()=>s.registerGroup('Steal','standard',id,'other'));
  const b=s.registerGroup('Second');
  assert.throws(()=>s.addRepresentative(b.id,'cherry'));
  assert.throws(()=>s.setUrl(b.id,id));
  s.renameGroup(a.id,'Renamed'); assert.equal(s.group(a.id)?.name,'Renamed');
  const art=s.submit(a.id,1,'cherry','saved','preview');
  s.deleteGroup(a.id);
  assert.equal(s.group(a.id),undefined); assert.equal(s.groupByCode(a.code),undefined);
  assert.equal(s.submission(art.id)?.sourcePath,'saved');
  assert.equal(JSON.parse(catalog(s).toString()).groups.some((g:{id:number})=>g.id===a.id),false);
  const c=s.registerGroup('Replacement','standard',id,'cherry');
  assert.notEqual(c.atlasSlot,a.atlasSlot); assert.notEqual(c.id,a.id);
  assert.throws(()=>s.deleteGroup(0));
 } finally {s.close();}
});
test('legacy duplicates archive safely, distinct namesake groups are retained',()=>{
 const s=new Store(':memory:'); try {
  s.db.exec('DROP INDEX one_group_per_discord_user; DROP INDEX one_vrchat_group');
  const a=s.registerGroup('Devilish'), b=s.registerGroup('devilish'), c=s.registerGroup('Devilish');
  s.db.prepare('INSERT INTO representatives VALUES(?,?)').run(a.id,'cherry');
  s.db.prepare('INSERT INTO representatives VALUES(?,?)').run(b.id,'cherry');
  s.db.prepare('INSERT INTO representatives VALUES(?,?)').run(c.id,'someone-else');
  assert.equal(s.cleanupDuplicates(),1);
  assert.equal(s.group(b.id),undefined); assert.ok(s.group(a.id)); assert.ok(s.group(c.id));
  assert.equal(s.cleanupDuplicates(),0);
 } finally {s.close();}
});
test('name field rejects pasted URLs/IDs with guidance; real names work without lookup',()=>{
 assert.equal(validateGroupName('  Lustfull Luxury  '),'Lustfull Luxury');
 for(const value of [id,`https://vrchat.com/home/group/${id}`,`[https://vrchat.com/home/group/${id}](https://vrchat.com/home/group/${id})`])
   assert.throws(()=>validateGroupName(value),/actual group name/);
 const s=new Store(':memory:');try{
  assert.throws(()=>s.registerGroup(id));
  const g=s.registerGroup('Real name','standard',id,'user');
  assert.throws(()=>s.renameGroup(g.id,`https://vrchat.com/home/group/${id}`));
  assert.equal(s.group(g.id)?.name,'Real name');
 }finally{s.close();}
});
test('empty unrepresented seed duplicate is archived in favor of a linked real group',()=>{
 const s=new Store(':memory:');try{
  const seed=s.registerGroup('SHXTTY','premium');
  const real=s.registerGroup('SHxTTY','premium',id,'owner');
  assert.equal(s.cleanupDuplicates(),1);
  assert.equal(s.group(seed.id),undefined);assert.ok(s.group(real.id));
 }finally{s.close();}
});
