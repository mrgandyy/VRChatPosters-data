import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import { assetPath, reserveUrl } from './url-pool.js';

export interface Banner { id:number; groupId:number; sourcePath:string; previewPath:string; status:string }
export interface BannerRelease { poolIndex:number; sha256:string; path:string }
export function initializeBillboards(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS billboards (
    id INTEGER PRIMARY KEY, groupId INTEGER NOT NULL REFERENCES groups(id),
    sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS billboard_assignments (
    groupId INTEGER PRIMARY KEY REFERENCES groups(id), submissionId INTEGER NOT NULL REFERENCES billboards(id));`);
}
export function submitBillboard(store:Store, groupId:number, user:string, source:string, preview:string):number {
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium' || groupId===0) throw new Error('Billboards require an enabled premium partner group.');
  return Number(store.db.prepare('INSERT INTO billboards(groupId,sourcePath,previewPath,submitter) VALUES(?,?,?,?)')
    .run(groupId,source,preview,user).lastInsertRowid);
}
export function decideBillboard(store:Store,id:number,reviewer:string,approve:boolean):void {
  store.db.transaction(()=>{
    const banner=store.db.prepare('SELECT * FROM billboards WHERE id=?').get(id) as Banner|undefined;
    if(!banner || banner.status!=='submitted')throw new Error('Billboard missing or already reviewed.');
    const group=store.group(banner.groupId);
    if(approve && (!group?.enabled || group.tier!=='premium'))throw new Error('Group is no longer an enabled premium partner.');
    store.db.prepare('UPDATE billboards SET status=?,reviewer=? WHERE id=?').run(approve?'approved':'rejected',reviewer,id);
    if(approve){
      store.db.prepare('INSERT INTO billboard_assignments(groupId,submissionId) VALUES(?,?) ON CONFLICT(groupId) DO UPDATE SET submissionId=excluded.submissionId').run(banner.groupId,id);
      store.queuePublish(banner.groupId);
    }
  })();
}
export function liveBillboard(store:Store,groupId:number):BannerRelease|undefined {
  const value=store.setting(`billboard-live-${groupId}`);
  return value?JSON.parse(value) as BannerRelease:undefined;
}
export async function prepareBillboard(store:Store,groupId:number):Promise<{release:BannerRelease;bytes:Buffer}|undefined>{
  const group=store.group(groupId);
  if(!group?.enabled || group.tier!=='premium')return undefined;
  const banner=store.db.prepare('SELECT b.* FROM billboards b JOIN billboard_assignments a ON a.submissionId=b.id WHERE a.groupId=?').get(groupId) as Banner|undefined;
  if(!banner)return undefined;
  const bytes=await sharp(await readFile(banner.sourcePath)).resize(2048,512,{fit:'contain',background:'#18151c'}).removeAlpha().png().toBuffer();
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const history=JSON.parse(store.setting(`billboard-releases-${groupId}`)??'[]') as BannerRelease[];
  let release=history.find(r=>r.sha256===sha256);
  if(!release){
    const index=reserveUrl(store,'billboard',`${groupId}:${sha256}`);
    release={poolIndex:index,sha256,path:assetPath('billboard',index)};
    history.push(release);
    // Reserve immutable URL even if publication later fails; retries reuse the same bytes.
    store.setSetting(`billboard-releases-${groupId}`,JSON.stringify(history));
  }
  return {release,bytes};
}
