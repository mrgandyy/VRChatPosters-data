import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.js';
import { catalog } from './publish.js';
test('recognition publishes assigned names only, skips empty and disabled groups',()=>{
 const store=new Store(':memory:');
 try {
  const group=store.registerGroup('Partner','premium');store.addRepresentative(group.id,'private-id');
  let output=JSON.parse(catalog(store).toString());assert.deepEqual(output.groups.find((g:any)=>g.id===group.id).representatives,[]);
  store.setSetting('representative-name-private-id','Public representative');
  output=JSON.parse(catalog(store).toString());assert.deepEqual(output.groups.find((g:any)=>g.id===group.id).representatives,['Public representative']);assert.ok(!catalog(store).toString().includes('private-id'));
  store.setEnabled(group.id,false);output=JSON.parse(catalog(store).toString());assert.deepEqual(output.groups.find((g:any)=>g.id===group.id).representatives,[]);
  store.setEnabled(group.id,true);store.removeRepresentative(group.id,'private-id');output=JSON.parse(catalog(store).toString());assert.deepEqual(output.groups.find((g:any)=>g.id===group.id).representatives,[]);
 } finally {store.db.close();}
});
