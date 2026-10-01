import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAtlas } from './atlas.js';
import type { Store } from './db.js';
import type { Group } from './types.js';

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
export interface ReleaseRef { groupId: number; revision: number; poolIndex: number; sha256: string; publicUrl: string }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function atlasPath(group: Group, revision: number): string {
  return `atlases/g${group.atlasSlot.toString().padStart(2,'0')}-r${revision.toString().padStart(2,'0')}.png`;
}
export function poolIndex(group: Group, revision: number): number {
  if (group.atlasSlot < 0 || group.atlasSlot >= GROUP_CAPACITY ||
      revision < 1 || revision > RELEASES_PER_GROUP)
    throw new Error('Authored atlas URL capacity exhausted; extend and reupload the world.');
  return group.atlasSlot * RELEASES_PER_GROUP + revision - 1;
}
export function catalog(store: Store, replacement?: ReleaseRef): Buffer {
  const groups = store.groups().map(group => {
    const active = replacement?.groupId === group.id ? replacement : store.activeRelease(group.id);
    return {
      id: group.id, name: group.name, tier: group.tier, code: group.code,
      enabled: !!group.enabled, vrchatGroupUrl: group.tier === 'premium' ? group.vrchatUrl : null,
      atlasPoolIndex: active?.poolIndex ?? -1, revision: active?.revision ?? 0,
      atlasSha256: active?.sha256 ?? ''
    };
  });
  return Buffer.from(JSON.stringify({ schema: 1, brand: 'ChainWreck Worlds',
    publisher: 'TwerkTaco & Resolve', generatedAt: new Date().toISOString(), groups }));
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

async function githubPut(config: PublishConfig, path: string, bytes: Buffer, message: string): Promise<void> {
  const existing = await githubGetSha(config,path);
  const endpoint = `https://api.github.com/repos/${config.owner}/${config.repository}/contents/${path}`;
  const response = await fetch(endpoint, { method: 'PUT', headers: {
    Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
  }, body: JSON.stringify({ message, content: bytes.toString('base64'), branch: config.branch,
    ...(existing ? { sha: existing } : {}) }), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`GitHub upload failed: HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
}

async function verifyPublic(url: string, expectedSha: string, attempts = 12): Promise<void> {
  for (let n = 0; n < attempts; n++) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      if (response.ok && sha(Buffer.from(await response.arrayBuffer())) === expectedSha) return;
    } catch { /* bounded retry; old catalog remains active */ }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  throw new Error(`Public asset did not match the release hash: ${url}`);
}

export async function publishGroup(store: Store, groupId: number, config: PublishConfig): Promise<string> {
  const group = store.group(groupId);
  if (!group) throw new Error('Group missing.');
  const atlas = await buildAtlas(store, groupId, config.defaultsDir);
  const previous = store.activeRelease(groupId);
  const sameArtwork = previous?.sha256 === atlas.sha256;
  const revision = sameArtwork ? previous!.revision :
    ((store.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM releases WHERE group_id=?')
      .get(groupId) as { n: number }).n + 1);
  const index = sameArtwork ? previous!.poolIndex : poolIndex(group,revision);
  const relative = atlasPath(group,revision);
  const publicBase = config.publicBase?.replace(/\/$/, '');
  if (!publicBase) throw new Error('GITHUB_PUBLIC_BASE is required.');
  const url = `${publicBase}/${relative}`;
  const candidate: ReleaseRef = { groupId, revision, poolIndex: index,
    sha256: atlas.sha256, publicUrl: sameArtwork ? previous!.publicUrl : url };
  const nextCatalog = catalog(store,candidate);

  if (config.dryRun) {
    const out = join(config.dataDir,'dry-run');
    await mkdir(out,{recursive:true});
    await writeFile(join(out,`group-${groupId}-atlas.png`),atlas.bytes);
    await writeFile(join(out,'catalog.json'),nextCatalog);
    return `dry-run: ${out}`;
  }
  if (!config.token || !config.owner || !config.repository)
    throw new Error('GitHub credentials and repository settings are required.');
  if (!sameArtwork) {
    await githubPut(config,relative,atlas.bytes,`Publish ChainWreck group ${groupId} atlas r${revision}`);
    await verifyPublic(url,atlas.sha256);
  }
  const catalogPath = 'catalog.json';
  const oldCatalog = catalog(store);
  try {
    await githubPut(config,catalogPath,nextCatalog,`Activate ChainWreck group ${groupId} r${revision}`);
    // JSON includes a generation timestamp, so hash verification also catches stale Pages responses.
    await verifyPublic(`${publicBase}/${catalogPath}`,sha(nextCatalog));
  } catch (error) {
    await githubPut(config,catalogPath,oldCatalog,`Rollback ChainWreck catalog after failed activation`);
    throw error;
  }
  if (!sameArtwork) store.recordRelease(groupId,revision,index,atlas.sha256,url);
  store.db.prepare(`UPDATE submissions SET status='live',updated_at=CURRENT_TIMESTAMP
    WHERE id IN (SELECT submission_id FROM assignments WHERE group_id=?)`).run(groupId);
  return `live: group ${groupId}, revision ${revision}, pool ${index}`;
}

export async function processOneJob(store: Store, config: PublishConfig): Promise<string | undefined> {
  const job = store.nextJob();
  if (!job) return undefined;
  store.markJob(job.id,'publishing');
  try {
    const message = await publishGroup(store,job.groupId,config);
    store.markJob(job.id,config.dryRun ? 'dry-run' : 'live');
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
  const old = catalog(store);
  const next = catalog(store,{groupId,revision,poolIndex:target.poolIndex,
    sha256:target.sha256,publicUrl:target.publicUrl});
  try {
    await githubPut(config,'catalog.json',next,`Rollback ChainWreck group ${groupId} to r${revision}`);
    await verifyPublic(`${config.publicBase.replace(/\/$/,'')}/catalog.json`,sha(next));
  } catch (error) {
    await githubPut(config,'catalog.json',old,'Restore ChainWreck catalog after failed rollback');
    throw error;
  }
  store.revert(groupId,revision);
  return `Rolled group ${groupId} back to revision ${revision}.`;
}
