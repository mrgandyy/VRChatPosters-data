// heat.json: a small, read-only snapshot for the world's entrance boards, fetched once per instance.
// The website owns the heat numbers (venue nights from the tracker), so it builds the snapshot and the
// bot publishes it next to catalog.json, the same way catalog data already flows site ↔ bot ↔ Pages.
// Momentum words only: no ranks, no scores, never a negative label.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.js';
import { publishFile, type PublishConfig } from './publish.js';
import { siteEnabled, sitePost, type SiteConfig } from './fbt-site.js';

export const HEAT_PATH = 'heat.json';
export const MOMENTUM = ['Rising', 'Heating up', 'On the way up', 'Steady glow'] as const;
export type Momentum = typeof MOMENTUM[number];
export const MAX_CLUBS = 40;
const MAX_NAMES = 40;
const MAX_NAME = 48;

export interface HeatClub { id: number; name: string; momentum: Momentum; tier: 'standard' | 'premium'; headliner: boolean; nights: number }
export interface HeatSnapshot {
  schema: 1; generated: string; windowDays: number; clubs: HeatClub[];
  supporters: { headliners: string[]; premium: string[]; vip: string[] };
}

const cleanName = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
const names = (v: unknown) => (Array.isArray(v) ? v : []).map(cleanName).filter(Boolean).slice(0, MAX_NAMES);
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Re-checks the website's snapshot before it goes public: exact field set and order, positive
 * momentum labels only, bounded sizes. The order of clubs (strongest momentum first) is kept.
 */
export function sanitizeHeat(data: unknown, now = new Date()): HeatSnapshot {
  if (!data || typeof data !== 'object') throw new Error('The website sent no heat snapshot.');
  const d = data as Record<string, unknown>;
  if (d.schema !== 1 || !Array.isArray(d.clubs)) throw new Error('The website sent a heat snapshot in an unknown format.');
  const generated = typeof d.generated === 'string' && !Number.isNaN(Date.parse(d.generated)) ? new Date(d.generated).toISOString() : now.toISOString();
  const seen = new Set<number>();
  const clubs: HeatClub[] = [];
  for (const raw of d.clubs as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const id = Number(c.id), name = cleanName(c.name);
    if (!Number.isInteger(id) || id < 1 || seen.has(id) || !name) continue;
    seen.add(id);
    const tier = c.tier === 'premium' ? 'premium' : 'standard';
    clubs.push({
      id, name,
      momentum: (MOMENTUM as readonly string[]).includes(String(c.momentum)) ? c.momentum as Momentum : 'Steady glow',
      tier, headliner: tier === 'premium' && c.headliner === true,
      nights: int(c.nights, 0, 999, 0),
    });
    if (clubs.length >= MAX_CLUBS) break;
  }
  const s = (d.supporters ?? {}) as Record<string, unknown>;
  return {
    schema: 1, generated, windowDays: int(d.windowDays, 1, 365, 30), clubs,
    // TODO(owner): VIP buyer names stay empty until the source and opt-in for VIP names are decided.
    supporters: { headliners: names(s.headliners), premium: names(s.premium), vip: [] },
  };
}

/** What counts as a change worth a commit: everything except the timestamp. */
export function heatKey(s: HeatSnapshot): string {
  const { generated: _ignored, ...rest } = s;
  return JSON.stringify(rest);
}

/** Fetches the snapshot from the website and publishes heat.json when it changed. */
export async function publishHeat(store: Store, config: PublishConfig, site: SiteConfig): Promise<string | undefined> {
  if (!siteEnabled(site)) return undefined;
  const r = await sitePost<unknown>(site, '/api/bot/heat', {}, 30_000);
  if (!r.ok && r.status === 404) return undefined; // the website hasn't been updated with /api/bot/heat yet
  if (!r.ok) throw new Error(`Heat snapshot unavailable: ${r.error}`);
  const snapshot = sanitizeHeat(r.data);
  const key = heatKey(snapshot);
  if (store.setting('heat-published-key') === key) return undefined;
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (config.dryRun) {
    const out = join(config.dataDir, 'dry-run');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, HEAT_PATH), bytes);
  } else {
    if (!config.token || !config.owner || !config.repository || !config.publicBase)
      throw new Error('GitHub credentials and repository settings are required.');
    await publishFile(config, HEAT_PATH, bytes, 'Update FBT Social heat board');
  }
  store.setSetting('heat-published-key', key);
  return `${config.dryRun ? 'dry-run: ' : ''}Published the heat board (${snapshot.clubs.length} club(s)).`;
}

/** Minutes between heat board checks (FBT_HEAT_INTERVAL_MINUTES, default 60). */
export function heatIntervalMs(): number {
  const n = Number(process.env.FBT_HEAT_INTERVAL_MINUTES ?? 60);
  return (Number.isFinite(n) && n >= 5 ? n : 60) * 60_000;
}
export function heatDue(store: Store, now = Date.now()): boolean {
  const last = store.setting('heat-checked-at');
  return last === undefined || now - Number(last) >= heatIntervalMs();
}
