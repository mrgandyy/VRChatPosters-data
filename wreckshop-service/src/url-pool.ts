import type { Store } from './db.js';

// Raise only after BOTH published world platforms contain the expanded arrays.
export const URL_POOL_CAPACITY = Number(process.env.WRECKSHOP_URL_POOL_CAPACITY ?? 256);
if (!Number.isInteger(URL_POOL_CAPACITY) || URL_POOL_CAPACITY < 256 || URL_POOL_CAPACITY > 8192)
  throw new Error('WRECKSHOP_URL_POOL_CAPACITY must be an integer between 256 and 8192.');
export type PoolKind = 'atlas' | 'billboard' | 'backdrop';

// The world already contains these URLs. Group identity is independent of URL ownership.
export function assetPath(kind: PoolKind, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= URL_POOL_CAPACITY) throw new Error('Invalid artwork pool index.');
  const directory = kind === 'atlas' ? 'atlases' : `${kind}s`;
  return `${directory}/g${String(Math.floor(index / 8)).padStart(2,'0')}-r${String(index % 8 + 1).padStart(2,'0')}.png`;
}

export function initializeUrlPool(store: Store, path: string): void {
  if (store.setting('shared-url-pool-v1')) return;
  if (path !== ':memory:') store.db.prepare('VACUUM INTO ?').run(`${path}.before-shared-url-pool-${Date.now()}.sqlite`);
  store.db.transaction(() => {
    store.db.exec(`CREATE TABLE IF NOT EXISTS url_reservations (
      kind TEXT NOT NULL, pool_index INTEGER NOT NULL CHECK(pool_index BETWEEN 0 AND 8191),
      content_key TEXT NOT NULL, PRIMARY KEY(kind,pool_index), UNIQUE(kind,content_key))`);
    const reserve = store.db.prepare('INSERT OR IGNORE INTO url_reservations VALUES(?,?,?)');
    const groups = store.db.prepare('SELECT id,atlas_slot FROM groups').all() as {id:number;atlas_slot:number}[];
    for (const group of groups) {
      const max = (store.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM releases WHERE group_id=?').get(group.id) as {n:number}).n;
      // Legacy uploads could reach GitHub before a release was recorded. Protect all
      // historical revisions AND the next attempted revision, including deleted groups.
      for (let revision = 1; revision <= Math.min(max + 1,8); revision++) {
        const index = group.atlas_slot * 8 + revision - 1;
        if (index < URL_POOL_CAPACITY) reserve.run('atlas',index,`legacy:${index}`);
      }
      for (const kind of ['billboard','backdrop'] as const) {
        const history = JSON.parse(store.setting(`${kind}-releases-${group.id}`) ?? '[]') as {poolIndex:number}[];
        for (const release of history) reserve.run(kind,release.poolIndex,`legacy:${release.poolIndex}`);
      }
    }
    const releases = store.db.prepare('SELECT group_id,revision,pool_index,sha256 FROM releases ORDER BY id').all() as {group_id:number;revision:number;pool_index:number;sha256:string}[];
    for (const release of releases) {
      reserve.run('atlas',release.pool_index,`legacy:${release.pool_index}`);
      const sheetB = JSON.parse(store.setting(`poster-sheet-b-${release.group_id}-${release.revision}`) ?? 'null') as {sha256B:string}|null;
      if (sheetB) store.db.prepare("UPDATE OR IGNORE url_reservations SET content_key=? WHERE kind='atlas' AND pool_index=?")
        .run(`${release.sha256}:${sheetB.sha256B}`,release.pool_index);
    }
    store.setSetting('shared-url-pool-v1','applied');
  })();
}

export function reserveUrl(store: Store, kind: PoolKind, contentKey: string): number {
  return store.db.transaction(() => {
    const existing = store.db.prepare('SELECT pool_index FROM url_reservations WHERE kind=? AND content_key=?').get(kind,contentKey) as {pool_index:number}|undefined;
    if (existing) {
      if (existing.pool_index >= URL_POOL_CAPACITY) throw new Error('Authored artwork URL capacity is below an existing reservation; restore the deployed capacity.');
      return existing.pool_index;
    }
    const used = new Set((store.db.prepare('SELECT pool_index FROM url_reservations WHERE kind=?').all(kind) as {pool_index:number}[]).map(row=>row.pool_index));
    for (let index=0;index<URL_POOL_CAPACITY;index++) {
      if (used.has(index)) continue;
      store.db.prepare('INSERT INTO url_reservations VALUES(?,?,?)').run(kind,index,contentKey);
      return index;
    }
    throw new Error(`Authored ${kind} URL capacity exhausted (${URL_POOL_CAPACITY} immutable artwork versions); extend and reupload the world.`);
  })();
}
