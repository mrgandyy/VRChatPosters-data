// Discord tier roles for group representatives: Headliner, Premium, or Standard (verified groups).
// Pure planning here; fbt.ts applies the changes. Only reps are managed: anyone else's roles are
// never touched, so roles staff hand out by hand stay put.

export type Level = 'standard' | 'premium' | 'headliner';
export const LEVELS: Level[] = ['headliner', 'premium', 'standard'];

/** Finds each tier's role: a stored setting first, else by name ("Headliner", "Premium Group", "Standard Group"). */
export function findTierRoles(roles: { id: string; name: string }[], setting: (key: string) => string | undefined): Record<Level, string | undefined> {
  const out = {} as Record<Level, string | undefined>;
  for (const level of LEVELS) {
    const set = setting(`fbt_role_${level}`);
    if (set && roles.some(r => r.id === set)) { out[level] = set; continue; }
    const re = new RegExp(`\\b${level}`, 'i');
    const named = roles.filter(r => re.test(r.name));
    // Prefer "… group" roles ("Premium Group") over others that merely mention the word.
    // Never guess: only a "… Group" role or one named exactly after the tier counts.
    out[level] = (named.find(r => /group/i.test(r.name)) ?? named.find(r => new RegExp(`^${level}s?$`, 'i').test(r.name.trim())))?.id;
  }
  return out;
}

/** The tier a group's reps should wear, or null (an unverified Standard group gets no tier role yet). */
export function levelFor(g: { tier: string; level?: string | null }, verified: boolean): Level | null {
  if (g.tier === 'premium' && g.level === 'headliner') return 'headliner';
  if (g.tier === 'premium') return 'premium';
  return verified ? 'standard' : null;
}

export interface RoleChange { userId: string; add: string[]; remove: string[] }

/**
 * Role changes so each rep wears exactly their group's tier role. `has` gives a member's current
 * roles (undefined when they're not in the server, so they're skipped).
 */
export function planRoles(desired: Map<string, Level | null>, roles: Record<Level, string | undefined>, has: (userId: string) => Set<string> | undefined): RoleChange[] {
  const out: RoleChange[] = [];
  for (const [userId, level] of desired) {
    const current = has(userId);
    if (!current) continue;
    const want = level ? roles[level] : undefined;
    const add = want && !current.has(want) ? [want] : [];
    const remove = LEVELS.map(l => roles[l]).filter((r): r is string => !!r && r !== want && current.has(r));
    if (add.length || remove.length) out.push({ userId, add, remove });
  }
  return out;
}
