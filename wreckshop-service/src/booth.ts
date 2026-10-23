// DJ booth fronts: one wide 6:1 image per premium group, shown on both DJ booths while the
// group's code is active. Same review, immutable URL pool and retry rules as the billboard.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import { assetPath, reserveUrl } from './url-pool.js';

// VRChat refuses downloaded images wider or taller than 2048 px, so the 6:1 front is published at 2048 x 341.
// Uploads can still be 2400 x 400 (the template size); they are fitted down.
export const BOOTH_WIDTH = 2048;
export const BOOTH_HEIGHT = 341;
export interface Booth { id:number; groupId:number; sourcePath:string; previewPath:string; status:string }
export interface BoothRelease { poolIndex:number; sha256:string; path:string }
export function initializeBooths(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS booths (
    id INTEGER PRIMARY KEY, groupId INTEGER NOT NULL REFERENCES groups(id),
    sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS booth_assignments (
    groupId INTEGER PRIMARY KEY REFERENCES groups(id), submissionId INTEGER NOT NULL REFERENCES booths(id));`);
}
export function submitBooth(store:Store, groupId:number, user:string, source:string, preview:string):number {
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium' || groupId===0) throw new Error('DJ booth fronts require an enabled premium partner group.');
  return Number(store.db.prepare('INSERT INTO booths(groupId,sourcePath,previewPath,submitter) VALUES(?,?,?,?)')
    .run(groupId,source,preview,user).lastInsertRowid);
}
export function decideBooth(store:Store,id:number,reviewer:string,approve:boolean):void {
  store.db.transaction(()=>{
    const booth=store.db.prepare('SELECT * FROM booths WHERE id=?').get(id) as Booth|undefined;
    if(!booth || booth.status!=='submitted')throw new Error('DJ booth front missing or already reviewed.');
    const group=store.group(booth.groupId);
    if(approve && (!group?.enabled || group.tier!=='premium'))throw new Error('Group is no longer an enabled premium partner.');
    store.db.prepare('UPDATE booths SET status=?,reviewer=? WHERE id=?').run(approve?'approved':'rejected',reviewer,id);
    if(approve){
      store.db.prepare('INSERT INTO booth_assignments(groupId,submissionId) VALUES(?,?) ON CONFLICT(groupId) DO UPDATE SET submissionId=excluded.submissionId').run(booth.groupId,id);
      store.queuePublish(booth.groupId);
    }
  })();
}
export function liveBooth(store:Store,groupId:number):BoothRelease|undefined {
  const value=store.setting(`booth-live-${groupId}`);
  return value?JSON.parse(value) as BoothRelease:undefined;
}
export async function prepareBooth(store:Store,groupId:number):Promise<{release:BoothRelease;bytes:Buffer}|undefined>{
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium')return undefined;
  const booth=store.db.prepare('SELECT b.* FROM booths b JOIN booth_assignments a ON a.submissionId=b.id WHERE a.groupId=?').get(groupId) as Booth|undefined;
  if(!booth)return undefined;
  const bytes=await sharp(await readFile(booth.sourcePath)).resize(BOOTH_WIDTH,BOOTH_HEIGHT,{fit:'fill'}).removeAlpha().png().toBuffer();
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const history=JSON.parse(store.setting(`booth-releases-${groupId}`)??'[]') as BoothRelease[];
  let release=history.find(r=>r.sha256===sha256);
  if(!release){
    const index=reserveUrl(store,'booth',`${groupId}:${sha256}`);
    release={poolIndex:index,sha256,path:assetPath('booth',index)};
    history.push(release);
    // Reserve immutable URL even if publication later fails; retries reuse the same bytes.
    store.setSetting(`booth-releases-${groupId}`,JSON.stringify(history));
  }
  return {release,bytes};
}
