// FBT Social: the Verified-role gate (15 Oct 2026).
//
// The Verified role comes only from the separate 18+ verify bot in the verify channel; this bot
// never verifies anyone. A club's door code works in the world only while at least one of its reps
// holds that role, once the owner switches the gate on (FBT_CODE_GATE=on). Until then the bot
// only reports: /verify-audit lists every club whose reps don't have the role, so the owner can
// reach out personally first.
//
// The lock rides on the world catalog's `enabled` flag (the same switch that pauses an inactive
// club), so nothing changes in the world build: a locked club's code simply isn't accepted.
import type { Group } from './types.js';

export type Tier = 'Headliner' | 'Premium' | 'Standard';
export const tierOf = (g: Pick<Group, 'tier' | 'level'>): Tier => g.tier === 'premium' ? (g.level === 'headliner' ? 'Headliner' : 'Premium') : 'Standard';

export interface AuditRow {
  id: number; name: string; tier: Tier;
  reps: { id: string; name: string | null; verified: boolean; inServer: boolean }[];
}

/**
 * Every live club (enabled, not the house default #0) with at least one rep missing the Verified
 * role. `none` = no rep has it (the club's code would lock); the rest have a verified rep already.
 */
export function verifyAudit(groups: Pick<Group, 'id' | 'name' | 'tier' | 'level' | 'enabled'>[], repsOf: (id: number) => string[],
  verified: Set<string>, members: Set<string>, names: Map<string, string>): { none: AuditRow[]; partial: AuditRow[] } {
  const order: Record<Tier, number> = { Headliner: 0, Premium: 1, Standard: 2 };
  const rows = groups.filter(g => g.id !== 0 && g.enabled).map(g => ({
    id: g.id, name: g.name, tier: tierOf(g),
    reps: repsOf(g.id).map(id => ({ id, name: names.get(id) ?? null, verified: verified.has(id), inServer: members.has(id) })),
  })).sort((a, b) => order[a.tier] - order[b.tier] || a.name.localeCompare(b.name));
  return {
    none: rows.filter(r => !r.reps.some(x => x.verified)),
    partial: rows.filter(r => r.reps.some(x => x.verified) && r.reps.some(x => !x.verified)),
  };
}

/** Clubs whose code locks under the gate: live clubs with no verified rep. */
export function lockedGroups(audit: { none: AuditRow[] }): number[] {
  return audit.none.map(r => r.id).sort((a, b) => a - b);
}

/** Saved lock list (setting verify_locked) → set. Bad or missing values lock nothing. */
export function parseLocked(raw: string | undefined | null): Set<number> {
  try {
    const list = JSON.parse(raw ?? '[]') as unknown;
    return new Set(Array.isArray(list) ? list.map(Number).filter(n => Number.isInteger(n) && n > 0) : []);
  } catch { return new Set(); }
}

/** What changed between two lock lists. */
export function lockDiff(before: Set<number>, after: number[]): { locked: number[]; unlocked: number[] } {
  const now = new Set(after);
  return { locked: after.filter(id => !before.has(id)), unlocked: [...before].filter(id => !now.has(id)) };
}

const rep = (r: AuditRow['reps'][number]) =>
  `${r.name ? `${r.name.replace(/[`*_~|<>@\\]/g, '')} ` : ''}(${r.id})${r.verified ? ' ✓' : ''}${r.inServer ? '' : ' [not in the server]'}`;

/** The audit as a plain-text file for staff. */
export function auditText(a: { none: AuditRow[]; partial: AuditRow[] }, at = new Date()): string {
  const lines = [`FBT Social: clubs whose reps don't have the Verified role (${at.toISOString().slice(0, 16).replace('T', ' ')} UTC)`, ''];
  lines.push(`NO VERIFIED REP (${a.none.length}): these clubs' codes would lock when the gate is on`);
  for (const r of a.none) lines.push(`- ${r.tier} · ${r.name} (#${r.id}) · reps: ${r.reps.length ? r.reps.map(rep).join(', ') : 'none on file'}`);
  if (!a.none.length) lines.push('- none');
  lines.push('', `SOME REPS NOT VERIFIED (${a.partial.length}): the club is fine (another rep is verified), listed so you know`);
  for (const r of a.partial) lines.push(`- ${r.tier} · ${r.name} (#${r.id}) · not verified: ${r.reps.filter(x => !x.verified).map(rep).join(', ')}`);
  if (!a.partial.length) lines.push('- none');
  lines.push('', '✓ = has the Verified role. The Verified role comes from the 18+ verify bot in the verify channel.');
  return lines.join('\n');
}

/** Short summary for the slash command reply. */
export function auditSummary(a: { none: AuditRow[]; partial: AuditRow[] }, gateOn: boolean): string {
  const count = (t: Tier) => a.none.filter(r => r.tier === t).length;
  return [
    `**Verified-role audit:** ${a.none.length} club${a.none.length === 1 ? '' : 's'} with no verified rep (Headliner ${count('Headliner')}, Premium ${count('Premium')}, Standard ${count('Standard')}), and ${a.partial.length} with some reps unverified. Full list attached.`,
    gateOn ? 'The code gate is **on**: clubs with no verified rep can\'t use their door code until a rep verifies.'
      : 'The code gate is **off**: nothing is locked. Set FBT_CODE_GATE=on on the bot when you\'re ready.',
  ].join('\n');
}

/** The DM a rep gets when their club's code locks (only after the gate is on, never for the first sweep). */
export function lockedDm(club: string, verifyWhere: string): string {
  return [
    `Hey! We noticed you're not verified yet, so **${club.replace(/[`*_~|<>@\\]/g, '')}**'s door code is paused in FBT Social.`,
    `To keep using our services, verify in ${verifyWhere} with our 18+ verify bot. Your code works again within a few minutes of getting the **Verified** role.`,
  ].join('\n\n');
}
