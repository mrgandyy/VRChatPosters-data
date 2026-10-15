// Talks to the FBT Social website (Railway). Every request is signed with FBT_BOT_SECRET:
// x-fbt-signature = hex(HMAC_SHA256(secret, `${timestamp}.${body}`)).
import { createHmac } from 'node:crypto';
import type { Store } from './db.js';
import type { Group } from './types.js';

export interface SiteConfig { url?: string; secret?: string }
export type SiteResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export function siteEnabled(c: SiteConfig): boolean { return Boolean(c.url && c.secret); }

export async function sitePost<T>(c: SiteConfig, path: string, payload: unknown, timeoutMs = 15_000): Promise<SiteResult<T>> {
  if (!siteEnabled(c)) return { ok: false, status: 503, error: 'The website link is not configured yet.' };
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const sig = createHmac('sha256', c.secret!).update(`${ts}.${body}`).digest('hex');
  try {
    const res = await fetch(c.url!.replace(/\/$/, '') + path, {
      method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-fbt-timestamp': ts, 'x-fbt-signature': sig },
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error ?? `The website said ${res.status}.`) };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, error: 'Couldn\'t reach the website. Try again in a minute.' };
  }
}

/** Signed POST that returns raw bytes (artwork uploaded on the website). Throws on failure. */
export async function siteBytes(c: SiteConfig, path: string, payload: unknown, timeoutMs = 30_000): Promise<Buffer> {
  if (!siteEnabled(c)) throw new Error('The website link is not configured yet.');
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const sig = createHmac('sha256', c.secret!).update(`${ts}.${body}`).digest('hex');
  const res = await fetch(c.url!.replace(/\/$/, '') + path, {
    method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'x-fbt-timestamp': ts, 'x-fbt-signature': sig },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    const err = new Error(String(json.error ?? `The website said ${res.status}.`)) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface GroupArt { posters: number[]; billboard: boolean; backdrop: boolean; booth: boolean }
/** Which custom art each group has approved: poster numbers, billboard, backdrop, DJ booth front. */
export function artOf(store: Store): Map<number, GroupArt> {
  const out = new Map<number, GroupArt>();
  const get = (g: number) => { let a = out.get(g); if (!a) out.set(g, a = { posters: [], billboard: false, backdrop: false, booth: false }); return a; };
  for (const r of store.db.prepare('SELECT group_id AS g, slot FROM assignments ORDER BY slot').all() as { g: number; slot: number }[]) get(r.g).posters.push(r.slot);
  const flag = (table: string, key: 'billboard' | 'backdrop' | 'booth') => {
    try { for (const r of store.db.prepare(`SELECT groupId AS g FROM ${table}`).all() as { g: number }[]) get(r.g)[key] = true; } catch { /* table not created yet */ }
  };
  flag('billboard_assignments', 'billboard');
  flag('backdrop_assignments', 'backdrop');
  flag('booth_assignments', 'booth');
  return out;
}

/**
 * Since 15 Oct 2026, 20:00 UTC a club is verified only through the Discord Verified role, which the 18+ verify
 * bot gives in the verify channel; this bot never verifies anyone. Before that, a linked VRChat group
 * plus the accepted hosting rules also counted: clubs that got there before the cutoff keep it.
 */
export const ROLE_ONLY_SINCE = '2026-10-15 20:00:00'; // SQLite UTC timestamp format
export function isVerified(g: Pick<Group, 'vrchatUrl' | 'agreementVersion' | 'agreementAt'>): boolean {
  return Boolean(g.vrchatUrl && g.agreementVersion && g.agreementAt && g.agreementAt < ROLE_ONLY_SINCE);
}

export function vrcGroupId(url: string | null): string | null {
  const m = url ? /grp_[0-9a-f-]{36}/i.exec(url) : null;
  return m ? m[0].toLowerCase() : null;
}

/**
 * The group counts as verified when one of its reps holds the Discord server's Verified role
 * (the owner's rule, Oct 2026), or the old way: VRChat group linked and rules accepted.
 */
export function groupVerified(g: Pick<Group, 'vrchatUrl' | 'agreementVersion' | 'agreementAt'>, reps: string[], verifiedUsers?: Set<string>): boolean {
  return isVerified(g) || (!!verifiedUsers && reps.some(u => verifiedUsers.has(u)));
}

export function statusLabel(g: Pick<Group, 'tier' | 'level' | 'vrchatUrl' | 'agreementVersion' | 'agreementAt'>, roleVerified = false): 'Headliner' | 'Premium' | 'Verified' | 'Registered' {
  if (g.tier === 'premium' && g.level === 'headliner') return 'Headliner';
  if (g.tier === 'premium') return 'Premium';
  return roleVerified || isVerified(g) ? 'Verified' : 'Registered';
}

/**
 * The group list the website mirrors. Group #0 (the house default) is included but never shown.
 * `staff` (Discord ids of server managers and the admin role) unlocks the website's staff pages.
 */
export interface People { members: string[]; verified: string[] }
export function syncPayload(store: Store, staff?: string[], names?: Map<string, string>, verifiedUsers?: Set<string>, people?: People) {
  const reps = store.db.prepare('SELECT group_id AS g, user_id AS u FROM representatives').all() as { g: number; u: string }[];
  const byGroup = new Map<number, string[]>();
  for (const r of reps) byGroup.set(r.g, [...(byGroup.get(r.g) ?? []), r.u]);
  const art = artOf(store);
  return {
    full: true,
    groups: store.groups().map(g => ({
      id: g.id, name: g.name, tier: g.tier, headliner: g.tier === 'premium' && g.level === 'headliner',
      verified: groupVerified(g, byGroup.get(g.id) ?? [], verifiedUsers), enabled: !!g.enabled, vrchatGroupId: vrcGroupId(g.vrchatUrl),
      reps: (byGroup.get(g.id) ?? []).filter(u => /^\d{5,25}$/.test(u)),
      code: /^\d{8}$/.test(g.code) ? g.code : undefined,
      repNames: Object.fromEntries((byGroup.get(g.id) ?? []).flatMap(u => names?.get(u) ? [[u, names.get(u)!.slice(0, 64)]] : [])),
      art: art.get(g.id) ?? { posters: [], billboard: false, backdrop: false, booth: false },
    })),
    ...(staff ? { staff: [...new Set(staff)].filter(u => /^\d{5,25}$/.test(u)).slice(0, 200) } : {}),
    // Who is in the Discord server and who has the Verified role: the website uses it to guide
    // newcomers (join → verify → register) and to let verified members register a club there.
    ...(people ? { people: { members: people.members.slice(0, 20000), verified: people.verified.slice(0, 20000) } } : {}),
  };
}

export async function syncGroups(store: Store, c: SiteConfig, staff?: string[], names?: Map<string, string>, verifiedUsers?: Set<string>, people?: People): Promise<SiteResult<{ saved: number; hidden: number }>> {
  return sitePost(c, '/api/bot/groups', syncPayload(store, staff, names, verifiedUsers, people), 30_000);
}

export interface OutboxItem { id: number; kind: string; payload: Record<string, unknown>; attempts: number }
/** A delivery failure reported back to the website. Permanent ones (bad input) aren't retried. */
export interface OutboxFailure { id: number; error: string; permanent: boolean }
