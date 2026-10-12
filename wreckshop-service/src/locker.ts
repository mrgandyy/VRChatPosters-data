// Dancer lockers: one portrait 5:7 image per dancer (a Discord user), shown only to the player whose
// VRChat display name matches. Approved art goes into the immutable lockers/ URL pool and is listed in
// lockers/lockers.json as {"lockers":[{"name":"<VRChat display name>","pool":<slot>}]}.
// Lockers belong to people, not groups, so they publish on their own (the "lockers-dirty" flag),
// not through the per-group job queue.
import sharp from 'sharp';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Store } from './db.js';
import { assetPath, reserveUrl } from './url-pool.js';
import { publishFile, type PublishConfig } from './publish.js';

export const LOCKER_WIDTH = 500;
export const LOCKER_HEIGHT = 700;
export const LOCKERS_JSON = 'lockers/lockers.json';
export interface Locker { id:number; userId:string; vrcName:string; sourcePath:string; previewPath:string; submitter:string; status:string }
export interface LockerRelease { poolIndex:number; sha256:string; path:string }

export function initializeLockers(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS lockers (
    id INTEGER PRIMARY KEY, userId TEXT NOT NULL, vrcName TEXT NOT NULL,
    sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS locker_assignments (
    userId TEXT PRIMARY KEY, submissionId INTEGER NOT NULL REFERENCES lockers(id), vrcName TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS locker_assignment_names ON locker_assignments(vrcName COLLATE NOCASE);`);
}

/** The VRChat display name exactly as the dancer typed it (trimmed). The world compares it to the local player's name. */
export function validateVrcName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('Enter your VRChat display name.');
  if ([...name].length > 64) throw new Error('That VRChat display name is too long.');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('That VRChat display name has characters VRChat doesn\'t use.');
  return name;
}

function nameHolder(store: Store, vrcName: string, exceptUser: string): string | undefined {
  const row = store.db.prepare('SELECT userId FROM locker_assignments WHERE vrcName=? COLLATE NOCASE AND userId<>?').get(vrcName, exceptUser) as { userId: string } | undefined;
  return row?.userId;
}
const taken = () => new Error('That VRChat display name already has a locker. If it\'s yours, ask staff.');

export function submitLocker(store: Store, userId: string, vrcName: string, source: string, preview: string): number {
  if (!/^\d{5,25}$/.test(userId)) throw new Error('Lockers belong to a Discord account.');
  const name = validateVrcName(vrcName);
  if (nameHolder(store, name, userId)) throw taken();
  return Number(store.db.prepare('INSERT INTO lockers(userId,vrcName,sourcePath,previewPath,submitter) VALUES(?,?,?,?,?)')
    .run(userId, name, source, preview, userId).lastInsertRowid);
}

export function locker(store: Store, id: number): Locker | undefined {
  return store.db.prepare('SELECT * FROM lockers WHERE id=?').get(id) as Locker | undefined;
}

export function decideLocker(store: Store, id: number, reviewer: string, approve: boolean): void {
  store.db.transaction(() => {
    const l = locker(store, id);
    if (!l || l.status !== 'submitted') throw new Error('Locker missing or already reviewed.');
    if (approve && nameHolder(store, l.vrcName, l.userId)) throw taken();
    store.db.prepare('UPDATE lockers SET status=?,reviewer=? WHERE id=?').run(approve ? 'approved' : 'rejected', reviewer, id);
    if (approve) {
      store.db.prepare(`INSERT INTO locker_assignments(userId,submissionId,vrcName) VALUES(?,?,?)
        ON CONFLICT(userId) DO UPDATE SET submissionId=excluded.submissionId, vrcName=excluded.vrcName`).run(l.userId, id, l.vrcName);
      store.setSetting('lockers-dirty', '1');
    }
  })();
}

/** The dancer changed their VRChat display name: the same art follows them. */
export function renameLocker(store: Store, userId: string, vrcName: string): boolean {
  const name = validateVrcName(vrcName);
  return store.db.transaction(() => {
    if (nameHolder(store, name, userId)) throw taken();
    // Reviews still waiting carry the new name too, so approving them later doesn't undo the change.
    store.db.prepare("UPDATE lockers SET vrcName=? WHERE userId=? AND status='submitted'").run(name, userId);
    const changed = store.db.prepare('UPDATE locker_assignments SET vrcName=? WHERE userId=? AND vrcName<>?').run(name, userId, name).changes > 0;
    if (changed) store.setSetting('lockers-dirty', '1');
    return changed;
  })();
}

/** Takes a dancer's locker out of the world (the art stays on file; its URL stays reserved). */
export function removeLocker(store: Store, userId: string): boolean {
  const removed = store.db.prepare('DELETE FROM locker_assignments WHERE userId=?').run(userId).changes > 0;
  if (removed) store.setSetting('lockers-dirty', '1');
  return removed;
}

export function liveLocker(store: Store, userId: string): LockerRelease | undefined {
  const value = store.setting(`locker-live-${userId}`);
  return value ? JSON.parse(value) as LockerRelease : undefined;
}

export interface PreparedLocker { userId: string; vrcName: string; release: LockerRelease; bytes: Buffer }
/** Every approved locker, rendered at 500 × 700 with its reserved immutable URL. A broken one is skipped, not fatal. */
export async function prepareLockers(store: Store): Promise<PreparedLocker[]> {
  const rows = store.db.prepare(`SELECT a.userId, a.vrcName, l.sourcePath FROM locker_assignments a JOIN lockers l ON l.id=a.submissionId
    ORDER BY a.submissionId`).all() as { userId: string; vrcName: string; sourcePath: string }[];
  const out: PreparedLocker[] = [];
  for (const row of rows) {
    let bytes: Buffer;
    try {
      bytes = await sharp(await readFile(row.sourcePath)).resize(LOCKER_WIDTH, LOCKER_HEIGHT, { fit: 'contain', background: '#18151c' }).removeAlpha().png().toBuffer();
    } catch (error) {
      console.error(`Locker for Discord user ${row.userId} could not be rendered; skipped:`, error instanceof Error ? error.message : error);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const history = JSON.parse(store.setting(`locker-releases-${row.userId}`) ?? '[]') as LockerRelease[];
    let release = history.find(r => r.sha256 === sha256);
    if (!release) {
      const index = reserveUrl(store, 'locker', `${row.userId}:${sha256}`);
      release = { poolIndex: index, sha256, path: assetPath('locker', index) };
      history.push(release);
      // Reserve the immutable URL even if publication later fails; retries reuse the same bytes.
      store.setSetting(`locker-releases-${row.userId}`, JSON.stringify(history));
    }
    out.push({ userId: row.userId, vrcName: row.vrcName, release, bytes });
  }
  return out;
}

/** The exact list file the world reads. Only approved lockers are listed. */
export function lockersJson(list: { vrcName: string; release: { poolIndex: number } }[]): Buffer {
  const lockers = list.map(l => ({ name: l.vrcName, pool: l.release.poolIndex })).sort((a, b) => a.pool - b.pool);
  return Buffer.from(JSON.stringify({ lockers }));
}

/** Publishes new locker images, then lockers.json. Returns a log line, or undefined when nothing changed. */
export async function publishLockers(store: Store, config: PublishConfig): Promise<string | undefined> {
  const prepared = await prepareLockers(store);
  const list = lockersJson(prepared);
  if (config.dryRun) {
    const out = join(config.dataDir, 'dry-run');
    for (const l of prepared) {
      await mkdir(dirname(join(out, l.release.path)), { recursive: true });
      await writeFile(join(out, l.release.path), l.bytes);
    }
    await mkdir(join(out, 'lockers'), { recursive: true });
    await writeFile(join(out, LOCKERS_JSON), list);
    return `dry-run: ${prepared.length} locker(s) in ${join(out, 'lockers')}`;
  }
  if (!config.token || !config.owner || !config.repository || !config.publicBase)
    throw new Error('GitHub credentials and repository settings are required.');
  for (const l of prepared) {
    if (liveLocker(store, l.userId)?.sha256 === l.release.sha256) continue;
    // Commit messages name the slot only: dancers' names stay out of the public history.
    await publishFile(config, l.release.path, l.bytes, `Publish FBT Social dancer locker ${l.release.poolIndex}`);
  }
  await publishFile(config, LOCKERS_JSON, list, 'Update FBT Social dancer lockers');
  store.db.transaction(() => { for (const l of prepared) store.setSetting(`locker-live-${l.userId}`, JSON.stringify(l.release)); })();
  return `Published ${prepared.length} dancer locker(s).`;
}
