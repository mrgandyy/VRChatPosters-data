import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.js';
import { SLOT_COUNT } from './types.js';

export const ATLAS_SIZE = 2048;
export const CELL_SIZE = 512;
export const GUTTER = 8;
// The inspected scene display bounds are 0.80 m × 1.20 m.
export const DISPLAY_ASPECT = 2 / 3;
export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_PIXELS = 30_000_000;
const formats = new Set(['jpeg', 'png', 'webp']);

export interface AtlasResult { bytes: Buffer; sha256: string; sourceHash: string }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function normalizePoster(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error('Image must be 1 byte–12 MB.');
  const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
  if (!metadata.format || !formats.has(metadata.format)) throw new Error('Use a static JPEG, PNG, or WebP image.');
  if (!metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256 ||
      metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > MAX_PIXELS)
    throw new Error('Image dimensions must be at least 256 px and at most 8192 px / 30 MP.');
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated images are not supported.');
  // Rotate from EXIF and encode once; Sharp omits source metadata by default.
  return sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().png({ compressionLevel: 9 }).toBuffer();
}

export async function saveSource(bytes: Buffer, root: string): Promise<{ sourcePath: string; previewPath: string }> {
  const normalized = await normalizePoster(bytes);
  const hash = sha256(normalized);
  const sourcePath = join(root, 'sources', `${hash}.png`);
  const previewPath = join(root, 'previews', `${hash}.png`);
  await mkdir(join(root, 'sources'), { recursive: true });
  await mkdir(join(root, 'previews'), { recursive: true });
  await writeFile(sourcePath, normalized);
  await writeFile(previewPath, await sharp(normalized).resize(512, 512, {
    fit: 'contain', background: '#211c21', withoutEnlargement: true
  }).png().toBuffer());
  return { sourcePath, previewPath };
}

export async function defaultFiles(defaultsDir: string): Promise<string[]> {
  const names = await readdir(defaultsDir);
  const files: string[] = [];
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const stem = slot.toString().padStart(2, '0');
    const match = names.find(name => new RegExp(`^${stem}\\.(png|jpg|jpeg|webp)$`, 'i').test(name));
    if (!match) throw new Error(`Missing default artwork for slot ${slot} in ${defaultsDir}`);
    files.push(join(defaultsDir, match));
  }
  return files;
}

async function cell(bytes: Buffer): Promise<Buffer> {
  const inner = CELL_SIZE - GUTTER * 2;
  const oriented = await sharp(bytes).rotate().toBuffer({ resolveWithObject: true });
  const physicalSourceAspect = oriented.info.width / oriented.info.height;
  // Prewarp for the portrait mesh: a square atlas cell becomes 2:3 in world space.
  // The completed poster therefore retains the source aspect without cropping text.
  const pixelAspect = physicalSourceAspect / DISPLAY_ASPECT;
  const width = pixelAspect >= 1 ? inner : Math.max(1, Math.round(inner * pixelAspect));
  const height = pixelAspect >= 1 ? Math.max(1, Math.round(inner / pixelAspect)) : inner;
  const art = await sharp(oriented.data).resize(width,height,{ fit:'fill' }).removeAlpha().png().toBuffer();
  const fitted = await sharp({ create: { width:inner,height:inner,channels:3,
    background:'#211c21' } }).composite([{ input:art,left:Math.floor((inner-width)/2),
    top:Math.floor((inner-height)/2) }]).png().toBuffer();
  return sharp(fitted).extend({ top: GUTTER, bottom: GUTTER,
    left: GUTTER, right: GUTTER, extendWith: 'copy' }).png().toBuffer();
}

export async function buildAtlas(store: Store, groupId: number, defaultsDir: string): Promise<AtlasResult> {
  const group = store.group(groupId);
  if (!group) throw new Error('Group not found.');
  const defaults = await defaultFiles(defaultsDir);
  const assigned = store.assigned(groupId);
  const parts: { input: Buffer; left: number; top: number }[] = [];
  const contentHash = createHash('sha256');
  for (let i = 0; i < SLOT_COUNT; i++) {
    const chosen = i < (group.tier === 'premium' ? 16 : 8) ? assigned.get(i + 1)?.sourcePath : undefined;
    const source = await readFile(chosen ?? defaults[i]!);
    contentHash.update(source);
    parts.push({ input: await cell(source), left: (i % 4) * CELL_SIZE,
      top: Math.floor(i / 4) * CELL_SIZE });
  }
  const bytes = await sharp({ create: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels: 3,
    background: '#211c21' } }).composite(parts).png({ compressionLevel: 9 }).toBuffer();
  return { bytes, sha256: sha256(bytes), sourceHash: contentHash.digest('hex') };
}

// UVs address the inner 496 px of each 512 px cell; the 8 px extrusion handles mip filtering.
export function uvRect(slot: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isInteger(slot) || slot < 1 || slot > 16) throw new Error('Slot must be 1–16.');
  const index = slot - 1;
  return { x: ((index % 4) * CELL_SIZE + GUTTER) / ATLAS_SIZE,
    y: (Math.floor(index / 4) * CELL_SIZE + GUTTER) / ATLAS_SIZE,
    width: (CELL_SIZE - 2 * GUTTER) / ATLAS_SIZE,
    height: (CELL_SIZE - 2 * GUTTER) / ATLAS_SIZE };
}
