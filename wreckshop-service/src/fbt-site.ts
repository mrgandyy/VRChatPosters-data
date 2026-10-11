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

/** Verified = VRChat group linked and hosting rules accepted. No staff step. */
export function isVerified(g: Pick<Group, 'vrchatUrl' | 'agreementVersion'>): boolean {
  return Boolean(g.vrchatUrl && g.agreementVersion);
}

export function vrcGroupId(url: string | null): string | null {
  const m = url ? /grp_[0-9a-f-]{36}/i.exec(url) : null;
  return m ? m[0].toLowerCase() : null;
}

export function statusLabel(g: Pick<Group, 'tier' | 'level' | 'vrchatUrl' | 'agreementVersion'>): 'Headliner' | 'Premium' | 'Verified' | 'Registered' {
  if (g.tier === 'premium' && g.level === 'headliner') return 'Headliner';
  if (g.tier === 'premium') return 'Premium';
  return isVerified(g) ? 'Verified' : 'Registered';
}

/**
 * The group list the website mirrors. Group #0 (the house default) is included but never shown.
 * `staff` (Discord ids of server managers and the admin role) unlocks the website's staff pages.
 */
export function syncPayload(store: Store, staff?: string[]) {
  const reps = store.db.prepare('SELECT group_id AS g, user_id AS u FROM representatives').all() as { g: number; u: string }[];
  const byGroup = new Map<number, string[]>();
  for (const r of reps) byGroup.set(r.g, [...(byGroup.get(r.g) ?? []), r.u]);
  return {
    full: true,
    groups: store.groups().map(g => ({
      id: g.id, name: g.name, tier: g.tier, headliner: g.tier === 'premium' && g.level === 'headliner',
      verified: isVerified(g), enabled: !!g.enabled, vrchatGroupId: vrcGroupId(g.vrchatUrl),
      reps: (byGroup.get(g.id) ?? []).filter(u => /^\d{5,25}$/.test(u)),
    })),
    ...(staff ? { staff: [...new Set(staff)].filter(u => /^\d{5,25}$/.test(u)).slice(0, 200) } : {}),
  };
}

export async function syncGroups(store: Store, c: SiteConfig, staff?: string[]): Promise<SiteResult<{ saved: number; hidden: number }>> {
  return sitePost(c, '/api/bot/groups', syncPayload(store, staff), 30_000);
}

export interface OutboxItem { id: number; kind: string; payload: Record<string, unknown>; attempts: number }
