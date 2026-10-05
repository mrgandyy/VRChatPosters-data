import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';

export interface Backdrop { id:number; groupId:number; sourcePath:string; previewPath:string; status:string }
export interface BackdropRelease { poolIndex:number; sha256:string; path:string }
export function initializeBackdrops(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backdrops (
    id INTEGER PRIMARY KEY, groupId INTEGER NOT NULL REFERENCES groups(id),
    sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS backdrop_assignments (
    groupId INTEGER PRIMARY KEY REFERENCES groups(id), submissionId INTEGER NOT NULL REFERENCES backdrops(id));`);
}
export function submitBackdrop(store:Store, groupId:number, user:string, source:string, preview:string):number {
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium' || groupId===0) throw new Error('Backdrops require an enabled premium partner group.');
  return Number(store.db.prepare('INSERT INTO backdrops(groupId,sourcePath,previewPath,submitter) VALUES(?,?,?,?)')
    .run(groupId,source,preview,user).lastInsertRowid);
}
export function decideBackdrop(store:Store,id:number,reviewer:string,approve:boolean):void {
  store.db.transaction(()=>{
    const banner=store.db.prepare('SELECT * FROM backdrops WHERE id=?').get(id) as Backdrop|undefined;
    if(!banner || banner.status!=='submitted')throw new Error('Backdrop missing or already reviewed.');
    const group=store.group(banner.groupId);
    if(approve && (!group?.enabled || group.tier!=='premium'))throw new Error('Group is no longer an enabled premium partner.');
    store.db.prepare('UPDATE backdrops SET status=?,reviewer=? WHERE id=?').run(approve?'approved':'rejected',reviewer,id);
    if(approve){
      store.db.prepare('INSERT INTO backdrop_assignments(groupId,submissionId) VALUES(?,?) ON CONFLICT(groupId) DO UPDATE SET submissionId=excluded.submissionId').run(banner.groupId,id);
      store.queuePublish(banner.groupId);
    }
  })();
}
export function liveBackdrop(store:Store,groupId:number):BackdropRelease|undefined {
  const value=store.setting(`backdrop-live-${groupId}`);
  return value?JSON.parse(value) as BackdropRelease:undefined;
}
export async function prepareBackdrop(store:Store,groupId:number):Promise<{release:BackdropRelease;bytes:Buffer}|undefined>{
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium')return undefined;
  const banner=store.db.prepare('SELECT b.* FROM backdrops b JOIN backdrop_assignments a ON a.submissionId=b.id WHERE a.groupId=?').get(groupId) as Backdrop|undefined;
  if(!banner)return undefined;
  const bytes=await sharp(await readFile(banner.sourcePath)).resize(2048,1536,{fit:'contain',background:'#18151c'}).removeAlpha().png().toBuffer();
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const history=JSON.parse(store.setting(`backdrop-releases-${groupId}`)??'[]') as BackdropRelease[];
  let release=history.find(r=>r.sha256===sha256);
  if(!release){
    if(history.length>=8)throw new Error('Backdrop release URL capacity exhausted; expand URL pool and reupload world.');
    const revision=history.length+1;
    release={poolIndex:group.atlasSlot*8+revision-1,sha256,path:`backdrops/g${String(group.atlasSlot).padStart(2,'0')}-r${String(revision).padStart(2,'0')}.png`};
    history.push(release);
    // Reserve immutable URL even if publication later fails; retries reuse the same bytes.
    store.setSetting(`backdrop-releases-${groupId}`,JSON.stringify(history));
  }
  return {release,bytes};
}
