import { parseLocked } from './verify-gate.js';
import { liveBackdrop, prepareBackdrop, type BackdropRelease } from './backdrop.js';
import { liveBillboard, prepareBillboard, type BannerRelease } from './billboard.js';
import { liveBooth, prepareBooth, type BoothRelease } from './booth.js';
import { liveStudio, prepareStudioTexture, studioEntry, studioTheme, venueEntry, type StudioRelease } from './studio.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAtlas } from './atlas.js';
import type { Store } from './db.js';
import type { Group } from './types.js';
import { assetPath, reserveUrl } from './url-pool.js';

export const RELEASES_PER_GROUP = 8;
export const GROUP_CAPACITY = 32;
export interface PublishConfig {
  token?: string;
  owner?: string;
  repository?: string;
  branch: string;
  publicBase?: string;
  defaultsDir: string;
  dataDir: string;
  dryRun: boolean;
}
export interface ReleaseRef { groupId: number; revision: number; poolIndex: number; sha256: string; publicUrl: string; sha256B?: string; publicUrlB?: string }
export function sheetBRelease(store: Store, groupId: number, revision: number): {sha256B:string;publicUrlB:string} | undefined {
  const value = store.setting(`poster-sheet-b-${groupId}-${revision}`);
  return value ? JSON.parse(value) as {sha256B:string;publicUrlB:string} : undefined;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function poolIndex(group: Group, revision: number): number {
  if (group.atlasSlot < 0 || group.atlasSlot >= GROUP_CAPACITY ||
      revision < 1 || revision > RELEASES_PER_GROUP)
    throw new Error('Authored atlas URL capacity exhausted; extend and reupload the world.');
  return group.atlasSlot * RELEASES_PER_GROUP + revision - 1;
}
/**
 * Brand look from the website: accent '#rrggbb' ('' = club default) and glow 0 soft, 1 standard, 2 bright.
 * A Premium group's saved Venue Studio theme feeds the same two fields, so worlds that only read
 * accent/glow still pick up the studio colour and glow level.
 */
export function lookOf(store: Store, groupId: number): { accent: string; glow: number } {
  const group = store.group(groupId);
  const studio = group?.enabled && group.tier === 'premium' ? studioTheme(store, groupId) : undefined;
  if (studio) return { accent: studio.accent, glow: studio.glowLevel };
  try {
    const v = JSON.parse(store.setting(`look-${groupId}`) ?? '{}') as { accent?: unknown; glow?: unknown };
    const accent = typeof v.accent === 'string' && /^#[0-9a-f]{6}$/.test(v.accent) ? v.accent : '';
    const glow = v.glow === 0 || v.glow === 2 ? v.glow : 1;
    return { accent, glow };
  } catch { return { accent: '', glow: 1 }; }
}

/** Republish only catalog.json (looks changed; no artwork changed). */
export async function publishCatalog(store: Store, config: PublishConfig): Promise<string | undefined> {
  if (config.dryRun || !config.token || !config.owner || !config.repository || !config.publicBase) return undefined;
  const next = catalog(store);
  const changed = await githubPut(config,'catalog.json',next,'Update Wreckshop venue looks');
  if (changed) await verifyPublic(`${config.publicBase.replace(/\/$/,'')}/catalog.json`,sha(next));
  return changed ? 'Published venue looks to the world catalog.' : undefined;
}

/** A group's not-yet-recorded release, used to build the catalog that activates it. */
export interface GroupOverride { release: ReleaseRef; banner?: BannerRelease; backdrop?: BackdropRelease; booth?: BoothRelease; studio?: StudioRelease }

export function catalog(store: Store, replacement?: ReleaseRef, bannerReplacement?: BannerRelease, backdropReplacement?: BackdropRelease, boothReplacement?: BoothRelease, studioReplacement?: StudioRelease): Buffer {
  const overrides = new Map<number, GroupOverride>();
  if (replacement) overrides.set(replacement.groupId, { release: replacement, banner: bannerReplacement, backdrop: backdropReplacement, booth: boothReplacement, studio: studioReplacement });
  return catalogWith(store, overrides);
}

/** The catalog with any number of groups' pending releases applied (a batch publishes several at once). */
export function catalogWith(store: Store, overrides: Map<number, GroupOverride>): Buffer {
  // Clubs with no rep holding the Verified role, while the code gate is on (verify-gate.ts): code not accepted.
  const locked = parseLocked(store.setting('verify_locked'));
  const groups = store.groups().map(group => {
    const o = overrides.get(group.id);
    const active = o ? o.release : store.activeRelease(group.id);
    const studio = studioEntry(store, group, o?.studio);
    const venue = venueEntry(store, group);
    return {
      id: group.id, name: group.name, tier: group.tier, code: group.code,
      // Public recognition is group-only; Discord identities remain private.
      representatives: [],
      enabled: !!group.enabled && !locked.has(group.id), vrchatGroupUrl: group.tier === 'premium' ? group.vrchatUrl : null,
      atlasPoolIndex: active?.poolIndex ?? -1, revision: active?.revision ?? 0,
      atlasBPoolIndex: active && (o?.release.sha256B || sheetBRelease(store,group.id,active.revision)) ? active.poolIndex : -1,
      billboardPoolIndex: group.enabled && group.tier === 'premium' ? ((o?.banner ?? liveBillboard(store,group.id))?.poolIndex ?? -1) : -1,
      backdropPoolIndex: group.enabled && group.tier === 'premium' ? ((o?.backdrop ?? liveBackdrop(store,group.id))?.poolIndex ?? -1) : -1,
      // DJ booth front (booths/ pool), shown on both DJ booths while this group is active.
      boothPoolIndex: group.enabled && group.tier === 'premium' ? ((o?.booth ?? liveBooth(store,group.id))?.poolIndex ?? -1) : -1,
      // Headliner rides on top of premium: tier stays 'premium' for older worlds.
      headliner: group.tier === 'premium' && group.level === 'headliner',
      atlasSha256: active?.sha256 ?? '',
      // The group's brand colour and glow (chosen on the website). The world may map it to its nearest accent.
      ...lookOf(store, group.id),
      // Venue Studio (Premium/Headliner with a saved theme only): applied once when the code is activated.
      ...(studio ? { studio } : {}),
      // Pass 23: the club's saved look from the world's finish library, applied by FBTVenueStudio on code activation.
      ...(venue ? { venue } : {}),
    };
  });
  return Buffer.from(JSON.stringify({ schema: 1, brand: 'Wreckshop Worlds',
    publisher: 'TwerkTaco & Resolve', groups }));
}

async function githubGetSha(config: PublishConfig, path: string): Promise<string | undefined> {
  const endpoint = `https://api.github.com/repos/${config.owner}/${config.repository}/contents/${path}?ref=${encodeURIComponent(config.branch)}`;
  const response = await fetch(endpoint, { headers: {
    Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub content lookup failed: HTTP ${response.status}`);
  const json = await response.json() as { sha: string };
  return json.sha;
}

export async function githubPut(config: PublishConfig, path: string, bytes: Buffer, message: string): Promise<boolean> {
  const existing = await githubGetSha(config,path);
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (existing === blobSha) return false;
  const endpoint = `https://api.github.com/repos/${config.owner}/${config.repository}/contents/${path}`;
  const response = await fetch(endpoint, { method: 'PUT', headers: {
    Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
  }, body: JSON.stringify({ message, content: bytes.toString('base64'), branch: config.branch,
    ...(existing ? { sha: existing } : {}) }), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`GitHub upload failed: HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
  return true;
}

async function publicMatches(url: string, expectedSha: string): Promise<boolean> {
  try {
    const verificationUrl = new URL(url); verificationUrl.searchParams.set('release',expectedSha);
    const response = await fetch(verificationUrl, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    return response.ok && sha(Buffer.from(await response.arrayBuffer())) === expectedSha;
  } catch { return false; }
}

// A committed file is not necessarily deployed: a Pages 5xx can leave it absent
// indefinitely. A hidden marker triggers a fresh build with Contents permission,
// without overwriting artwork or requiring broader Actions credentials.
export async function publishFile(config: PublishConfig, path: string, bytes: Buffer, message: string): Promise<void> {
  const changed = await githubPut(config,path,bytes,message);
  const url = `${config.publicBase!.replace(/\/$/,'')}/${path}`;
  const expected = sha(bytes);
  if (!changed) {
    if (await publicMatches(url,expected)) return;
    await githubPut(config,'.pages-recovery.json',Buffer.from(JSON.stringify({
      path, sha256: expected, requestedAt: new Date().toISOString()
    })),`Retry Pages publication for ${path}`);
  }
  await verifyPublic(url,expected);
}

async function verifyPublic(url: string, expectedSha: string, attempts = 90): Promise<void> {
  for (let n = 0; n < attempts; n++) {
    if (await publicMatches(url,expectedSha)) return;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  throw new Error(`Public asset did not match the release hash: ${url}`);
}

/** Everything one group's publication needs: built art, reserved URLs and the pending release. */
export interface PreparedGroup {
  groupId: number; revision: number; index: number; url: string; sameArtwork: boolean;
  atlas: { bytes: Buffer; sha256: string }; atlasB: { bytes: Buffer; sha256: string };
  relative: string; relativeB: string; candidate: ReleaseRef;
  banner?: { release: BannerRelease; bytes: Buffer }; backdrop?: { release: BackdropRelease; bytes: Buffer };
  booth?: { release: BoothRelease; bytes: Buffer }; studio?: { release: StudioRelease; bytes: Buffer };
}

export async function prepareGroup(store: Store, groupId: number, config: PublishConfig): Promise<PreparedGroup> {
  const group = store.group(groupId);
  if (!group) throw new Error('Group missing.');
  const atlas = await buildAtlas(store, groupId, config.defaultsDir);
  const atlasB = await buildAtlas(store, groupId, config.defaultsDir, 1);
  const previous = store.activeRelease(groupId);
  const sameArtwork = previous?.sha256 === atlas.sha256 && sheetBRelease(store,groupId,previous.revision)?.sha256B === atlasB.sha256;
  const revision = sameArtwork ? previous!.revision :
    ((store.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM releases WHERE group_id=?')
      .get(groupId) as { n: number }).n + 1);
  const index = sameArtwork ? previous!.poolIndex : reserveUrl(store,'atlas',`${atlas.sha256}:${atlasB.sha256}`);
  const relative = assetPath('atlas',index);
  const relativeB = relative.replace(/\.png$/, '-b.png');
  const publicBase = config.publicBase?.replace(/\/$/, '');
  if (!publicBase) throw new Error('GITHUB_PUBLIC_BASE is required.');
  const url = `${publicBase}/${relative}`;
  const candidate: ReleaseRef = { groupId, revision, poolIndex: index,
    sha256: atlas.sha256, publicUrl: sameArtwork ? previous!.publicUrl : url,
    sha256B: atlasB.sha256, publicUrlB: `${publicBase}/${relativeB}` };
  return { groupId, revision, index, url, sameArtwork, atlas, atlasB, relative, relativeB, candidate,
    banner: await prepareBillboard(store,groupId), backdrop: await prepareBackdrop(store,groupId),
    booth: await prepareBooth(store,groupId), studio: await prepareStudioTexture(store,groupId) };
}

const overrideOf = (p: PreparedGroup): GroupOverride => ({ release: p.candidate, banner: p.banner?.release,
  backdrop: p.backdrop?.release, booth: p.booth?.release, studio: p.studio?.release });

/** The files a prepared group still has to put on GitHub (unchanged art is skipped). */
export function uploadsOf(store: Store, p: PreparedGroup): { path: string; bytes: Buffer }[] {
  const files: { path: string; bytes: Buffer }[] = [];
  if (!p.sameArtwork) files.push({ path: p.relative, bytes: p.atlas.bytes }, { path: p.relativeB, bytes: p.atlasB.bytes });
  if (p.banner && liveBillboard(store,p.groupId)?.sha256 !== p.banner.release.sha256) files.push({ path: p.banner.release.path, bytes: p.banner.bytes });
  if (p.backdrop && liveBackdrop(store,p.groupId)?.sha256 !== p.backdrop.release.sha256) files.push({ path: p.backdrop.release.path, bytes: p.backdrop.bytes });
  if (p.booth && liveBooth(store,p.groupId)?.sha256 !== p.booth.release.sha256) files.push({ path: p.booth.release.path, bytes: p.booth.bytes });
  // Studio slots are overwritten in place (one per group), unlike the immutable artwork pools.
  if (p.studio && liveStudio(store,p.groupId)?.sha256 !== p.studio.release.sha256) files.push({ path: p.studio.release.path, bytes: p.studio.bytes });
  return files;
}

/** After the catalog that activates it is live: record the release and mark its submissions live. */
export function recordPrepared(store: Store, p: PreparedGroup): void {
  const groupId = p.groupId;
  if(p.banner)store.setSetting(`billboard-live-${groupId}`,JSON.stringify(p.banner.release));
  if(p.backdrop)store.setSetting(`backdrop-live-${groupId}`,JSON.stringify(p.backdrop.release));
  if(p.booth)store.setSetting(`booth-live-${groupId}`,JSON.stringify(p.booth.release));
  if(p.studio)store.setSetting(`studio-live-${groupId}`,JSON.stringify(p.studio.release));
  store.db.transaction(() => {
    if (!p.sameArtwork) store.recordRelease(groupId,p.revision,p.index,p.atlas.sha256,p.url);
    store.setSetting(`poster-sheet-b-${groupId}-${p.revision}`,JSON.stringify({sha256B:p.atlasB.sha256,publicUrlB:p.candidate.publicUrlB}));
  })();
  store.db.prepare(`UPDATE submissions SET status='live',updated_at=CURRENT_TIMESTAMP
    WHERE id IN (SELECT submission_id FROM assignments WHERE group_id=?)`).run(groupId);
}

/** One group, one file at a time (dry runs and tests). Live publishing goes through publishBatch. */
export async function publishGroup(store: Store, groupId: number, config: PublishConfig): Promise<string> {
  const p = await prepareGroup(store, groupId, config);
  const nextCatalog = catalogWith(store, new Map([[groupId, overrideOf(p)]]));
  if (config.dryRun) {
    const out = join(config.dataDir,'dry-run');
    await mkdir(out,{recursive:true});
    await writeFile(join(out,`group-${groupId}-atlas.png`),p.atlas.bytes);
    await writeFile(join(out,`group-${groupId}-atlas-b.png`),p.atlasB.bytes);
    if(p.banner)await writeFile(join(out,`group-${groupId}-billboard.png`),p.banner.bytes);
    if(p.backdrop)await writeFile(join(out,`group-${groupId}-backdrop.png`),p.backdrop.bytes);
    if(p.booth)await writeFile(join(out,`group-${groupId}-booth.png`),p.booth.bytes);
    if(p.studio)await writeFile(join(out,`group-${groupId}-studio.png`),p.studio.bytes);
    await writeFile(join(out,'catalog.json'),nextCatalog);
    return `dry-run: ${out}`;
  }
  if (!config.token || !config.owner || !config.repository)
    throw new Error('GitHub credentials and repository settings are required.');
  for (const f of uploadsOf(store, p)) await publishFile(config,f.path,f.bytes,`Publish Wreckshop group ${groupId} ${f.path}`);
  // Assets were verified before activation. A slow CDN is not a failed write.
  await publishFile(config,'catalog.json',nextCatalog,`Activate Wreckshop group ${groupId} r${p.revision}`);
  recordPrepared(store, p);
  return `live: group ${groupId}, revision ${p.revision}, pool ${p.index}`;
}

// ---- Batched publishing: one commit (one Pages deploy) for everything waiting -------------------------

/** How many groups one batch may carry (each adds up to ~10 MB of art). */
export const BATCH_GROUPS = Math.max(1, Math.min(20, Number(process.env.WRECKSHOP_BATCH_GROUPS ?? 8) || 8));
/** Immutable art folders the batch keeps lean: files no catalog entry points to are removed. */
export const PRUNE_DIRS = ['atlases', 'billboards', 'backdrops', 'booths'] as const;

const grid = (dir: string, i: number) => `${dir}/g${String(Math.floor(i / 8)).padStart(2,'0')}-r${String(i % 8 + 1).padStart(2,'0')}.png`;
/** Every pool file a catalog points to (both sheets of any atlas it uses). */
export function referencedArt(catalogBytes: Buffer): Set<string> {
  const keep = new Set<string>();
  const groups = (JSON.parse(catalogBytes.toString()) as { groups: Record<string, unknown>[] }).groups;
  for (const g of groups) {
    const idx = (k: string) => (typeof g[k] === 'number' && (g[k] as number) >= 0 ? g[k] as number : -1);
    for (const k of ['atlasPoolIndex', 'atlasBPoolIndex']) if (idx(k) >= 0) { keep.add(grid('atlases', idx(k))); keep.add(grid('atlases', idx(k)).replace(/\.png$/, '-b.png')); }
    if (idx('billboardPoolIndex') >= 0) keep.add(grid('billboards', idx('billboardPoolIndex')));
    if (idx('backdropPoolIndex') >= 0) keep.add(grid('backdrops', idx('backdropPoolIndex')));
    if (idx('boothPoolIndex') >= 0) keep.add(grid('booths', idx('boothPoolIndex')));
  }
  return keep;
}

async function gh<T>(config: PublishConfig, method: string, path: string, body?: unknown, allow422 = false): Promise<{ status: number; json: T }> {
  const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repository}/${path}`, { method, headers: {
    Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  if (!response.ok && !(allow422 && response.status === 422)) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: HTTP ${response.status}: ${text.slice(0,300)}`);
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as T };
}
const gitBlobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Write several files (and remove stale pool files) in ONE commit through the Git Data API.
 * Returns false when nothing changed. Retries if something else (the heat board, a look change) moved the branch.
 */
export async function githubCommit(config: PublishConfig, writes: { path: string; bytes: Buffer }[],
  shouldDelete: (path: string) => boolean, message: string, maxDeletes = 60): Promise<{ changed: boolean; deleted: number }> {
  const uploaded = new Map<string, string>();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ref = await gh<{ object: { sha: string } }>(config, 'GET', `git/ref/heads/${encodeURIComponent(config.branch)}`);
    const head = ref.json.object.sha;
    const commit = await gh<{ tree: { sha: string } }>(config, 'GET', `git/commits/${head}`);
    const tree = await gh<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(config, 'GET', `git/trees/${commit.json.tree.sha}?recursive=1`);
    const existing = new Map(tree.json.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
    const entries: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
    for (const w of writes) {
      const want = gitBlobSha(w.bytes);
      if (existing.get(w.path) === want) continue;
      if (!uploaded.has(w.path)) {
        const blob = await gh<{ sha: string }>(config, 'POST', 'git/blobs', { content: w.bytes.toString('base64'), encoding: 'base64' });
        uploaded.set(w.path, blob.json.sha);
      }
      entries.push({ path: w.path, mode: '100644', type: 'blob', sha: uploaded.get(w.path)! });
    }
    const writing = new Set(writes.map(w => w.path));
    // Never prune from a truncated listing, and never mass-delete: a bad catalog must not wipe the feed.
    const stale = tree.json.truncated ? [] : [...existing.keys()].filter(p => !writing.has(p) && shouldDelete(p));
    const deletions = stale.length <= maxDeletes ? stale : [];
    if (stale.length > maxDeletes) console.warn(`Pruning skipped: ${stale.length} stale files is more than the ${maxDeletes} safety limit.`);
    for (const path of deletions) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    if (!entries.length) return { changed: false, deleted: 0 };
    const newTree = await gh<{ sha: string }>(config, 'POST', 'git/trees', { base_tree: commit.json.tree.sha, tree: entries });
    const newCommit = await gh<{ sha: string }>(config, 'POST', 'git/commits', { message, tree: newTree.json.sha, parents: [head] });
    const moved = await gh<unknown>(config, 'PATCH', `git/refs/heads/${encodeURIComponent(config.branch)}`, { sha: newCommit.json.sha, force: false }, true);
    if (moved.status !== 422) return { changed: true, deleted: deletions.length };
    // 422: the branch moved underneath us; rebuild the commit on the new head.
    await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
  }
  throw new Error('GitHub commit failed: HTTP 5xx (branch kept moving; will retry)');
}

/**
 * Publish every waiting group together: build each group's art, write all of it plus the new catalog in one
 * commit (so GitHub Pages deploys once and the catalog goes live in the same deploy as its art), drop pool files
 * no catalog entry uses any more, then verify the catalog is public and record the releases.
 */
export async function publishBatch(store: Store, config: PublishConfig): Promise<string | undefined> {
  const jobs: { id: number; groupId: number }[] = [];
  const seen = new Set<number>();
  while (jobs.length < BATCH_GROUPS) {
    const job = store.nextJob();
    if (!job || seen.has(job.groupId)) break;
    store.markJob(job.id, 'publishing');
    jobs.push(job); seen.add(job.groupId);
  }
  if (!jobs.length) return undefined;
  const failJob = (job: { id: number; groupId: number }, error: unknown) => {
    store.markJob(job.id, 'failed', String(error));
    store.db.prepare(`UPDATE submissions SET status='failed',updated_at=CURRENT_TIMESTAMP
      WHERE id IN (SELECT submission_id FROM assignments WHERE group_id=?) AND status='approved'`).run(job.groupId);
  };
  if (!config.token || !config.owner || !config.repository || !config.publicBase) {
    const error = new Error('GitHub credentials and repository settings are required.');
    for (const job of jobs) failJob(job, error);
    throw error;
  }
  const ready: { job: { id: number; groupId: number }; p: PreparedGroup }[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    try { ready.push({ job, p: await prepareGroup(store, job.groupId, config) }); }
    catch (error) { failJob(job, error); failed.push(`group ${job.groupId}: ${String(error)}`); }
  }
  if (!ready.length) throw new Error(`Batch failed: ${failed.join('; ')}`);
  const nextCatalog = catalogWith(store, new Map(ready.map(r => [r.p.groupId, overrideOf(r.p)])));
  const keep = referencedArt(nextCatalog);
  const prune = process.env.WRECKSHOP_PRUNE !== 'false' && keep.size > 0;
  const shouldDelete = (path: string) => prune && PRUNE_DIRS.some(d => path.startsWith(`${d}/`)) && path.endsWith('.png') && !keep.has(path);
  const ids = ready.map(r => r.p.groupId);
  const message = ids.length === 1 ? `Activate Wreckshop group ${ids[0]} r${ready[0]!.p.revision}` : `Activate Wreckshop groups ${ids.join(', ')}`;
  let deleted = 0;
  try {
    const writes = [...ready.flatMap(r => uploadsOf(store, r.p)), { path: 'catalog.json', bytes: nextCatalog }];
    const result = await githubCommit(config, writes, shouldDelete, message);
    deleted = result.deleted;
    const url = `${config.publicBase.replace(/\/$/,'')}/catalog.json`;
    if (!result.changed && !(await publicMatches(url, sha(nextCatalog))))
      await githubPut(config,'.pages-recovery.json',Buffer.from(JSON.stringify({ path: 'catalog.json', sha256: sha(nextCatalog),
        requestedAt: new Date().toISOString() })),'Retry Pages publication for catalog.json');
    // Pages deploys the whole site at once, so a live catalog means its art in the same commit is live too.
    await verifyPublic(url, sha(nextCatalog));
  } catch (error) {
    for (const r of ready) failJob(r.job, error);
    throw error;
  }
  for (const r of ready) { recordPrepared(store, r.p); store.markJob(r.job.id, 'live'); }
  return `live: groups ${ready.map(r => `${r.p.groupId} r${r.p.revision}`).join(', ')} in one commit` +
    (deleted ? `; removed ${deleted} unused file${deleted === 1 ? '' : 's'}` : '') + (failed.length ? `; failed ${failed.join('; ')}` : '');
}

/** The bot's publishing tick: live mode publishes everything waiting as one batch; dry runs keep one group at a time. */
export async function processOneJob(store: Store, config: PublishConfig): Promise<string | undefined> {
  if (!config.dryRun) return publishBatch(store, config);
  const job = store.nextJob();
  if (!job) return undefined;
  store.markJob(job.id,'publishing');
  try {
    const message = await publishGroup(store,job.groupId,config);
    store.markJob(job.id,'dry-run');
    return message;
  } catch (error) {
    store.markJob(job.id,'failed',String(error));
    store.db.prepare(`UPDATE submissions SET status='failed',updated_at=CURRENT_TIMESTAMP
      WHERE id IN (SELECT submission_id FROM assignments WHERE group_id=?) AND status='approved'`)
      .run(job.groupId);
    throw error;
  }
}

export async function activateRollback(store: Store, groupId: number, revision: number,
  config: PublishConfig): Promise<string> {
  const target = store.release(groupId,revision);
  if (!target) throw new Error('Release not found.');
  if (config.dryRun) throw new Error('Rollback publication requires live publishing mode.');
  if (!config.token || !config.owner || !config.repository || !config.publicBase)
    throw new Error('GitHub publishing settings are required.');
  await verifyPublic(target.publicUrl,target.sha256);
  const sheetB = sheetBRelease(store,groupId,revision);
  if (sheetB) await verifyPublic(sheetB.publicUrlB,sheetB.sha256B);
  const old = catalog(store);
  const next = catalog(store,{groupId,revision,poolIndex:target.poolIndex,
    sha256:target.sha256,publicUrl:target.publicUrl});
  try {
    await githubPut(config,'catalog.json',next,`Rollback Wreckshop group ${groupId} to r${revision}`);
    await verifyPublic(`${config.publicBase.replace(/\/$/,'')}/catalog.json`,sha(next));
  } catch (error) {
    await githubPut(config,'catalog.json',old,'Restore Wreckshop catalog after failed rollback');
    throw error;
  }
  store.revert(groupId,revision);
  return `Rolled group ${groupId} back to revision ${revision}.`;
}
