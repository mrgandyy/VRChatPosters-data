// Venue Studio: a Premium or Headliner group's saved theme for the world (finish, accent, glow and an
// optional staff-approved texture). The website saves the theme and sends it here as `studio.set`;
// textures go through the usual Discord review card. The world applies the theme once, when the
// group's code is activated, from the group's catalog entry:
//
//   "studio": { "accent": "#rrggbb", "glow": "#rrggbb", "finish": "walnut"|"marble"|"velvet"|"bronze"|"charcoal", "texturePool": <0..63 or -1> }
//
// texturePool indexes studio/g{i/8:00}-r{i%8+1:00}.png, a 1024 × 1024 PNG. Each group keeps the same
// slot (re-uploads overwrite it in place). When all 64 are taken, slots held by groups that are no
// longer Premium (or were removed) are reclaimed. Standard groups never get a `studio` entry.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { Group } from './types.js';
import { SLOT_POOL_CAPACITY, slotPoolPath } from './url-pool.js';

export const FINISHES = ['walnut', 'marble', 'velvet', 'bronze', 'charcoal'] as const;
export type Finish = typeof FINISHES[number];
export const STUDIO_TEXTURE_SIZE = 1024;
/**
 * Pass 23: the website saves a full look from the world's own finish library instead of one finish word:
 *   "venue": { "theme": "<theme key or empty>", "roles": { "<RoleKey>": { "f": "<finish id or empty>", "b", "c", "s": -4..4, "h": -12..12 } } }
 * The world applies it on code activation by those ids (FBTVenueStudio). Finish ids are checked against the world's
 * library on the website; here only their shape is checked. Older single-finish themes stay valid.
 */
export const ROLE_KEYS = ['PrimaryStone', 'FloorColumns', 'Wood', 'MetalTrim', 'Walls', 'Upholstery'] as const;
export interface RoleLook { f: string; b: number; c: number; s: number; h: number }
export interface VenueLook { theme: string; roles: Record<string, RoleLook> }
export interface StudioTheme { accent: string; glow: string; glowLevel: 0 | 1 | 2; finish?: Finish; texture: boolean; venue?: VenueLook }
export interface StudioRelease { poolIndex: number; sha256: string; path: string }
export interface StudioEntry { accent: string; glow: string; finish: Finish | ''; texturePool: number }

export function initializeStudio(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS studio_textures (
      id INTEGER PRIMARY KEY, groupId INTEGER NOT NULL REFERENCES groups(id),
      sourcePath TEXT NOT NULL, previewPath TEXT NOT NULL, submitter TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted', reviewer TEXT);
    CREATE TABLE IF NOT EXISTS studio_assignments (
      groupId INTEGER PRIMARY KEY REFERENCES groups(id), submissionId INTEGER NOT NULL REFERENCES studio_textures(id));
    CREATE TABLE IF NOT EXISTS studio_pool (
      pool_index INTEGER PRIMARY KEY CHECK(pool_index BETWEEN 0 AND ${SLOT_POOL_CAPACITY - 1}), group_id INTEGER NOT NULL UNIQUE);`);
}

const HEX = /^#[0-9a-f]{6}$/;
const ID = /^[a-z0-9_]{0,48}$/;
const step = (x: unknown, lim: number) => (typeof x === 'number' && Number.isInteger(x) && Math.abs(x) <= lim ? x : undefined);
/** A look from the website, checked again here (shape only). Undefined when anything is off. */
export function parseVenue(raw: unknown): VenueLook | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as { theme?: unknown; roles?: unknown };
  const theme = typeof v.theme === 'string' && ID.test(v.theme) ? v.theme : undefined;
  if (theme === undefined || !v.roles || typeof v.roles !== 'object') return undefined;
  const roles: Record<string, RoleLook> = {};
  for (const key of ROLE_KEYS) {
    const r = (v.roles as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object' || typeof r.f !== 'string' || !ID.test(r.f)) return undefined;
    const b = step(r.b, 4), c = step(r.c, 4), s = step(r.s, 4), h = step(r.h, 12);
    if (b === undefined || c === undefined || s === undefined || h === undefined) return undefined;
    roles[key] = { f: r.f, b, c, s, h };
  }
  return { theme, roles };
}
/** A theme from the website, checked again here. Undefined when anything is off. */
export function parseTheme(raw: unknown): StudioTheme | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const accent = typeof v.accent === 'string' ? v.accent.toLowerCase() : '';
  const glow = typeof v.glow === 'string' ? v.glow.toLowerCase() : '';
  const glowLevel = v.glowLevel === 0 || v.glowLevel === 2 ? v.glowLevel : 1;
  if (!HEX.test(accent) || !HEX.test(glow)) return undefined;
  if (v.venue !== undefined) {
    const venue = parseVenue(v.venue);
    return venue ? { accent, glow, glowLevel, texture: false, venue } : undefined;
  }
  const finish = String(v.finish) as Finish;
  if (!FINISHES.includes(finish)) return undefined;
  return { accent, glow, glowLevel, finish, texture: v.texture !== false };
}
export function studioTheme(store: Store, groupId: number): StudioTheme | undefined {
  try { return parseTheme(JSON.parse(store.setting(`studio-${groupId}`) ?? 'null')); } catch { return undefined; }
}
/** Saves (or with null, clears) a group's theme; only the catalog needs republishing. */
export function setStudioTheme(store: Store, groupId: number, raw: unknown): StudioTheme | undefined {
  if (raw == null) {
    store.db.prepare('DELETE FROM settings WHERE key=?').run(`studio-${groupId}`);
    store.setSetting('catalog-dirty', '1');
    return undefined;
  }
  const theme = parseTheme(raw);
  if (!theme) throw Object.assign(new Error('That studio theme is not valid.'), { permanent: true });
  store.setSetting(`studio-${groupId}`, JSON.stringify(theme));
  store.setSetting('catalog-dirty', '1');
  return theme;
}

const eligible = (g: Group | undefined): g is Group => Boolean(g && g.id !== 0 && g.enabled && g.tier === 'premium');

export function submitStudioTexture(store: Store, groupId: number, user: string, source: string, preview: string): number {
  if (!eligible(store.group(groupId))) throw new Error('Venue Studio textures need an enabled Premium or Headliner group.');
  return Number(store.db.prepare('INSERT INTO studio_textures(groupId,sourcePath,previewPath,submitter) VALUES(?,?,?,?)')
    .run(groupId, source, preview, user).lastInsertRowid);
}
export function decideStudioTexture(store: Store, id: number, reviewer: string, approve: boolean): void {
  store.db.transaction(() => {
    const t = store.db.prepare('SELECT * FROM studio_textures WHERE id=?').get(id) as { groupId: number; status: string } | undefined;
    if (!t || t.status !== 'submitted') throw new Error('Studio texture missing or already reviewed.');
    if (approve && !eligible(store.group(t.groupId))) throw new Error('Group is no longer an enabled Premium partner.');
    store.db.prepare('UPDATE studio_textures SET status=?, reviewer=? WHERE id=?').run(approve ? 'approved' : 'rejected', reviewer, id);
    if (approve) {
      store.db.prepare('INSERT INTO studio_assignments(groupId,submissionId) VALUES(?,?) ON CONFLICT(groupId) DO UPDATE SET submissionId=excluded.submissionId').run(t.groupId, id);
      store.queuePublish(t.groupId);
    }
  })();
}

/** The group's studio texture slot: its own for good; when all are taken, one from a group that lost Premium. */
export function studioSlot(store: Store, groupId: number): number | undefined {
  return store.db.transaction(() => {
    const own = store.db.prepare('SELECT pool_index AS i FROM studio_pool WHERE group_id=?').get(groupId) as { i: number } | undefined;
    if (own) return own.i;
    const rows = store.db.prepare('SELECT pool_index AS i, group_id AS g FROM studio_pool').all() as { i: number; g: number }[];
    const used = new Set(rows.map(r => r.i));
    let free = [...Array(SLOT_POOL_CAPACITY).keys()].find(i => !used.has(i));
    if (free === undefined) {
      const stale = rows.find(r => !eligible(store.group(r.g)));
      if (!stale) return undefined;
      store.db.prepare('DELETE FROM studio_pool WHERE pool_index=?').run(stale.i);
      store.db.prepare('DELETE FROM settings WHERE key=?').run(`studio-live-${stale.g}`);
      free = stale.i;
    }
    store.db.prepare('INSERT INTO studio_pool(pool_index,group_id) VALUES(?,?)').run(free, groupId);
    return free;
  })();
}

/** The texture the world can load for this group right now (only while the group still owns that slot). */
export function liveStudio(store: Store, groupId: number): StudioRelease | undefined {
  const value = store.setting(`studio-live-${groupId}`);
  if (!value) return undefined;
  const release = JSON.parse(value) as StudioRelease;
  const own = store.db.prepare('SELECT pool_index AS i FROM studio_pool WHERE group_id=?').get(groupId) as { i: number } | undefined;
  return own?.i === release.poolIndex ? release : undefined;
}

/** The approved texture rendered at 1024 × 1024, opaque, as a palette ("crunched") PNG, with its slot. */
export async function prepareStudioTexture(store: Store, groupId: number): Promise<{ release: StudioRelease; bytes: Buffer } | undefined> {
  if (!eligible(store.group(groupId))) return undefined;
  const row = store.db.prepare('SELECT t.sourcePath FROM studio_textures t JOIN studio_assignments a ON a.submissionId=t.id WHERE a.groupId=?').get(groupId) as { sourcePath: string } | undefined;
  if (!row) return undefined;
  const bytes = await sharp(await readFile(row.sourcePath), { limitInputPixels: 64_000_000 }).rotate().flatten({ background: '#000000' })
    .resize(STUDIO_TEXTURE_SIZE, STUDIO_TEXTURE_SIZE, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .removeAlpha().png({ palette: true, quality: 92, effort: 10, compressionLevel: 9 }).toBuffer();
  const poolIndex = studioSlot(store, groupId);
  if (poolIndex === undefined) {
    console.error(`No free Venue Studio texture slot for group ${groupId}: all ${SLOT_POOL_CAPACITY} are held by Premium groups.`);
    return undefined;
  }
  return { release: { poolIndex, sha256: createHash('sha256').update(bytes).digest('hex'), path: slotPoolPath('studio', poolIndex) }, bytes };
}

/** The catalog's `studio` object, or undefined (Standard, suspended, or no saved theme). */
export function studioEntry(store: Store, group: Group, replacement?: StudioRelease): StudioEntry | undefined {
  if (!eligible(group)) return undefined;
  const theme = studioTheme(store, group.id);
  if (!theme) return undefined;
  const texture = theme.texture && !theme.venue ? (replacement ?? liveStudio(store, group.id)) : undefined;
  return { accent: theme.accent, glow: theme.glow, finish: theme.finish ?? '', texturePool: texture?.poolIndex ?? -1 };
}

/** The catalog's `venue` look (pass 23), or undefined (Standard, suspended, or no saved look). */
export function venueEntry(store: Store, group: Group): VenueLook | undefined {
  if (!eligible(group)) return undefined;
  return studioTheme(store, group.id)?.venue;
}
