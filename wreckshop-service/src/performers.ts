// Verified performers (dancers) and their stage art: pole wrap, chair seat-back and catwalk deck logo.
//
// The website verifies a performer (VRChat profile + bio code + 18+ age verification) and tells the bot
// through the outbox. The bot keeps the roster keyed by VRChat user id, reviews each performer's art
// with the usual Discord cards, and publishes:
//
//   performers/g{i/8:00}-r{i%8+1:00}.png   one 1024 × 1024 atlas per performer, pool index i = 0..63
//   performers.json                         {version:1, updated, performers:[{vrcId,name,pool,pole,chair,deck}]}
//
// Atlas layout (origin top-left), the world contract:
//   x 0–511,    y 0–1023   POLE WRAP   (tall, wraps a vertical pole; top of image = top of pole)
//   x 512–1023, y 0–511    CHAIR SEAT-BACK
//   x 512–1023, y 512–1023 DECK LOGO   (glows on the catwalk floor; dark backgrounds read best)
// A missing kind is left transparent black and its flag is false, so the world shows its default.
//
// Each performer keeps the same pool slot for good (re-uploads overwrite it in place); removing a
// performer frees the slot. Udon can only match players by display name, so `name` is the current
// VRChat display name, refreshed by the website's poller and sent here as `performer.renamed`.
// Discord ids never leave the bot: the public files carry VRChat ids and display names only.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store } from './db.js';
import { publishFile, type PublishConfig } from './publish.js';
import { SLOT_POOL_CAPACITY, slotPoolPath } from './url-pool.js';

export const PERFORMER_KINDS = ['pole', 'chair', 'deck'] as const;
export type PerformerKind = typeof PERFORMER_KINDS[number];
export const isPerformerKind = (k: string): k is PerformerKind => (PERFORMER_KINDS as readonly string[]).includes(k);
export const PERFORMER_ATLAS_SIZE = 1024;
export const PERFORMERS_JSON = 'performers.json';
const HALF = PERFORMER_ATLAS_SIZE / 2;
/** Where each kind sits in the atlas, and how the art is fitted into it. */
export const PERFORMER_REGIONS: Record<PerformerKind, { left: number; top: number; width: number; height: number; fit: 'cover' | 'contain' }> = {
  pole: { left: 0, top: 0, width: HALF, height: PERFORMER_ATLAS_SIZE, fit: 'cover' },
  chair: { left: HALF, top: 0, width: HALF, height: HALF, fit: 'cover' },
  deck: { left: HALF, top: HALF, width: HALF, height: HALF, fit: 'contain' },
};
export const PERFORMER_LABEL: Record<PerformerKind, string> = { pole: 'Pole wrap', chair: 'Chair seat-back', deck: 'Deck logo' };

export interface Performer { vrcId: string; discordId: string; name: string; active: number }
export interface PerformerArt { id: number; vrcId: string; kind: PerformerKind; sourcePath: string; previewPath: string; submitter: string; status: string }

export function initializePerformers(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS performers (
      vrc_id TEXT PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS performer_pool (
      pool_index INTEGER PRIMARY KEY CHECK(pool_index BETWEEN 0 AND ${SLOT_POOL_CAPACITY - 1}), vrc_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS performer_art (
      id INTEGER PRIMARY KEY, vrc_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pole','chair','deck')),
      sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS performer_art_assignments (
      vrc_id TEXT NOT NULL, kind TEXT NOT NULL, submissionId INTEGER NOT NULL REFERENCES performer_art(id),
      PRIMARY KEY(vrc_id, kind));`);
}

/** A VRChat user id: `usr_` + UUID, or the short id some very old accounts still have. */
export function validateVrcId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
  if (/^[A-Za-z0-9]{10}$/.test(id)) return id;
  throw Object.assign(new Error('That is not a VRChat user id.'), { permanent: true });
}
/** The display name as VRChat shows it (the world compares it exactly), trimmed and without control characters. */
export function cleanPerformerName(raw: unknown): string {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || [...name].length > 64) throw Object.assign(new Error('That VRChat display name is empty or too long.'), { permanent: true });
  return name;
}
const dirty = (store: Store) => store.setSetting('performers-dirty', '1');

export function performer(store: Store, vrcId: string): Performer | undefined {
  return store.db.prepare('SELECT vrc_id AS vrcId, discord_id AS discordId, name, active FROM performers WHERE vrc_id=?').get(vrcId) as Performer | undefined;
}
export function performerByDiscord(store: Store, discordId: string): Performer | undefined {
  return store.db.prepare('SELECT vrc_id AS vrcId, discord_id AS discordId, name, active FROM performers WHERE discord_id=?').get(discordId) as Performer | undefined;
}

/**
 * The website verified this performer. A Discord account has one performer identity: if it re-verified
 * with another VRChat account, its pool slot and art move to the new id.
 */
export function upsertPerformer(store: Store, discordId: string, vrcIdIn: string, nameIn: string): Performer {
  if (!/^\d{5,25}$/.test(discordId)) throw Object.assign(new Error('Performers belong to a Discord account.'), { permanent: true });
  const vrcId = validateVrcId(vrcIdIn), name = cleanPerformerName(nameIn);
  store.db.transaction(() => {
    const holder = performer(store, vrcId);
    if (holder && holder.discordId !== discordId) throw Object.assign(new Error('That VRChat account is already a performer on another Discord account.'), { permanent: true });
    const mine = performerByDiscord(store, discordId);
    if (mine && mine.vrcId !== vrcId) {
      for (const table of ['performers', 'performer_pool', 'performer_art', 'performer_art_assignments'])
        store.db.prepare(`UPDATE ${table} SET vrc_id=? WHERE vrc_id=?`).run(vrcId, mine.vrcId);
    }
    store.db.prepare(`INSERT INTO performers(vrc_id,discord_id,name,active) VALUES(?,?,?,1)
      ON CONFLICT(vrc_id) DO UPDATE SET name=excluded.name, active=1, updated_at=CURRENT_TIMESTAMP`).run(vrcId, discordId, name);
    dirty(store);
  })();
  return performer(store, vrcId)!;
}

/** The poller saw a new display name on the VRChat profile. Returns true when it changed. */
export function renamePerformer(store: Store, vrcIdIn: string, nameIn: string): boolean {
  const vrcId = validateVrcId(vrcIdIn), name = cleanPerformerName(nameIn);
  const changed = store.db.prepare('UPDATE performers SET name=?, updated_at=CURRENT_TIMESTAMP WHERE vrc_id=? AND name<>?').run(name, vrcId, name).changes > 0;
  if (changed) dirty(store);
  return changed;
}

/** Off the roster: the pool slot is freed for the next performer. Their art stays on file. */
export function removePerformer(store: Store, vrcIdIn: string): Performer | undefined {
  const p = performer(store, validateVrcId(vrcIdIn));
  if (!p) return undefined;
  store.db.transaction(() => {
    store.db.prepare('UPDATE performers SET active=0, updated_at=CURRENT_TIMESTAMP WHERE vrc_id=?').run(p.vrcId);
    store.db.prepare('DELETE FROM performer_pool WHERE vrc_id=?').run(p.vrcId);
    dirty(store);
  })();
  return p;
}

export function submitPerformerArt(store: Store, discordId: string, kind: PerformerKind, source: string, preview: string): number {
  const p = performerByDiscord(store, discordId);
  if (!p?.active) throw Object.assign(new Error('Only verified performers can send stage art. Verify on the website first.'), { permanent: true });
  return Number(store.db.prepare('INSERT INTO performer_art(vrc_id,kind,sourcePath,previewPath,submitter) VALUES(?,?,?,?,?)')
    .run(p.vrcId, kind, source, preview, discordId).lastInsertRowid);
}
export function performerArt(store: Store, id: number): PerformerArt | undefined {
  return store.db.prepare('SELECT id, vrc_id AS vrcId, kind, sourcePath, previewPath, submitter, status FROM performer_art WHERE id=?').get(id) as PerformerArt | undefined;
}
export function decidePerformerArt(store: Store, id: number, reviewer: string, approve: boolean): void {
  store.db.transaction(() => {
    const art = performerArt(store, id);
    if (!art || art.status !== 'submitted') throw new Error('Stage art missing or already reviewed.');
    if (approve && !performer(store, art.vrcId)?.active) throw new Error('That performer is no longer on the roster.');
    store.db.prepare('UPDATE performer_art SET status=?, reviewer=? WHERE id=?').run(approve ? 'approved' : 'rejected', reviewer, id);
    if (approve) {
      store.db.prepare(`INSERT INTO performer_art_assignments(vrc_id,kind,submissionId) VALUES(?,?,?)
        ON CONFLICT(vrc_id,kind) DO UPDATE SET submissionId=excluded.submissionId`).run(art.vrcId, art.kind, id);
      dirty(store);
    }
  })();
}
/** The performer took one piece down on the website: that surface goes back to the world's default. */
export function removePerformerArt(store: Store, discordId: string, kind: PerformerKind): boolean {
  const p = performerByDiscord(store, discordId);
  if (!p) return false;
  const removed = store.db.prepare('DELETE FROM performer_art_assignments WHERE vrc_id=? AND kind=?').run(p.vrcId, kind).changes > 0;
  if (removed) dirty(store);
  return removed;
}

/** This performer's pool slot: the same one for good, else the lowest free one (undefined when all 64 are taken). */
export function performerSlot(store: Store, vrcId: string): number | undefined {
  return store.db.transaction(() => {
    const own = store.db.prepare('SELECT pool_index AS i FROM performer_pool WHERE vrc_id=?').get(vrcId) as { i: number } | undefined;
    if (own) return own.i;
    const used = new Set((store.db.prepare('SELECT pool_index AS i FROM performer_pool').all() as { i: number }[]).map(r => r.i));
    for (let i = 0; i < SLOT_POOL_CAPACITY; i++) {
      if (used.has(i)) continue;
      store.db.prepare('INSERT INTO performer_pool(pool_index,vrc_id) VALUES(?,?)').run(i, vrcId);
      return i;
    }
    return undefined;
  })();
}

/**
 * One performer's atlas. Art is flattened onto black (opaque), pole and chair fill their region, the
 * deck logo is fitted whole. Encoded as a palette ("crunched") PNG with alpha for the empty regions.
 */
export async function buildPerformerAtlas(sources: Partial<Record<PerformerKind, Buffer>>): Promise<Buffer> {
  const parts: { input: Buffer; left: number; top: number }[] = [];
  for (const kind of PERFORMER_KINDS) {
    const src = sources[kind];
    if (!src) continue;
    const r = PERFORMER_REGIONS[kind];
    const input = await sharp(src, { limitInputPixels: 64_000_000 }).rotate().flatten({ background: '#000000' })
      .resize(r.width, r.height, { fit: r.fit, position: 'centre', background: '#000000', kernel: 'lanczos3' })
      .ensureAlpha(1).png().toBuffer();
    parts.push({ input, left: r.left, top: r.top });
  }
  return sharp({ create: { width: PERFORMER_ATLAS_SIZE, height: PERFORMER_ATLAS_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer();
}

export interface RosterEntry { vrcId: string; name: string; pool: number; pole: boolean; chair: boolean; deck: boolean }
/** performers.json exactly as the world reads it. */
export function rosterJson(entries: RosterEntry[], updated: string): Buffer {
  const performers = [...entries].sort((a, b) => a.pool - b.pool)
    .map(e => ({ vrcId: e.vrcId, name: e.name, pool: e.pool, pole: e.pole, chair: e.chair, deck: e.deck }));
  return Buffer.from(JSON.stringify({ version: 1, updated, performers }));
}

export interface PreparedPerformer { entry: RosterEntry; path: string; bytes: Buffer; sha256: string }
/** Every active performer with at least one approved piece, with their slot and atlas. */
export async function preparePerformers(store: Store): Promise<{ prepared: PreparedPerformer[]; full: string[] }> {
  const rows = store.db.prepare(`SELECT p.vrc_id AS vrcId, p.name, a.kind, s.sourcePath
      FROM performers p JOIN performer_art_assignments a ON a.vrc_id=p.vrc_id JOIN performer_art s ON s.id=a.submissionId
      WHERE p.active=1 ORDER BY p.rowid, a.kind`).all() as { vrcId: string; name: string; kind: PerformerKind; sourcePath: string }[];
  const byPerformer = new Map<string, { name: string; files: Partial<Record<PerformerKind, string>> }>();
  for (const r of rows) {
    const p = byPerformer.get(r.vrcId) ?? { name: r.name, files: {} };
    p.files[r.kind] = r.sourcePath;
    byPerformer.set(r.vrcId, p);
  }
  const prepared: PreparedPerformer[] = [], full: string[] = [];
  for (const [vrcId, p] of byPerformer) {
    const sources: Partial<Record<PerformerKind, Buffer>> = {};
    for (const kind of PERFORMER_KINDS) {
      const file = p.files[kind];
      if (!file) continue;
      try { sources[kind] = await readFile(file); }
      catch (error) { console.error(`Performer ${kind} art is missing on disk; that surface shows the default:`, error instanceof Error ? error.message : error); }
    }
    if (!Object.keys(sources).length) continue;
    const pool = performerSlot(store, vrcId);
    if (pool === undefined) { full.push(vrcId); continue; }
    const bytes = await buildPerformerAtlas(sources);
    prepared.push({
      entry: { vrcId, name: p.name, pool, pole: Boolean(sources.pole), chair: Boolean(sources.chair), deck: Boolean(sources.deck) },
      path: slotPoolPath('performers', pool), bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { prepared, full };
}

/**
 * Publishes changed performer atlases, then performers.json. Nothing is committed when nothing but the
 * timestamp would change. Returns a log line, or undefined when there was nothing to do.
 */
export async function publishPerformers(store: Store, config: PublishConfig, now = new Date()): Promise<string | undefined> {
  const { prepared, full } = await preparePerformers(store);
  const body = JSON.parse(rosterJson(prepared.map(p => p.entry), '').toString()).performers;
  const bodyKey = JSON.stringify(body);
  const changed = prepared.filter(p => store.setting(`performer-live-${p.entry.pool}`) !== p.sha256);
  const note = full.length ? ` ${full.length} performer(s) left out: all ${SLOT_POOL_CAPACITY} performer slots are taken.` : '';
  if (!changed.length && store.setting('performers-roster') === bodyKey) return full.length ? `Performer roster unchanged.${note}` : undefined;
  const json = rosterJson(prepared.map(p => p.entry), now.toISOString());
  if (config.dryRun) {
    const out = join(config.dataDir, 'dry-run');
    for (const p of prepared) {
      await mkdir(dirname(join(out, p.path)), { recursive: true });
      await writeFile(join(out, p.path), p.bytes);
    }
    await mkdir(out, { recursive: true });
    await writeFile(join(out, PERFORMERS_JSON), json);
    return `dry-run: ${prepared.length} performer(s) in ${join(out, 'performers')}.${note}`;
  }
  if (!config.token || !config.owner || !config.repository || !config.publicBase)
    throw new Error('GitHub credentials and repository settings are required.');
  // Commit messages carry slot numbers only: names stay out of the public history.
  for (const p of changed) await publishFile(config, p.path, p.bytes, `Publish FBT Social performer slot ${p.entry.pool}`);
  await publishFile(config, PERFORMERS_JSON, json, 'Update FBT Social performer roster');
  store.db.transaction(() => {
    for (const p of changed) store.setSetting(`performer-live-${p.entry.pool}`, p.sha256);
    store.setSetting('performers-roster', bodyKey);
  })();
  return `Published the performer roster: ${prepared.length} performer(s), ${changed.length} atlas(es) updated.${note}`;
}
