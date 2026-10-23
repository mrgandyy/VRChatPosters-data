import type { Guild } from 'discord.js';
import type { Store } from './db.js';

export function representativeNames(store: Store, groupId: number): string[] {
  const rows = store.db.prepare('SELECT user_id FROM representatives WHERE group_id=? ORDER BY user_id').all(groupId) as {user_id:string}[];
  return [...new Set(rows.map(row => store.setting(`representative-name-${row.user_id}`) ?? '').filter(Boolean))];
}

// Only assigned group representatives are published, never the member roster or IDs.
export async function refreshRepresentativeNames(store: Store, guild: Guild): Promise<boolean> {
  const rows = store.db.prepare('SELECT DISTINCT user_id FROM representatives').all() as {user_id:string}[];
  let changed = false;
  for (const row of rows) {
    try {
      const member = await guild.members.fetch(row.user_id);
      const name = '@' + member.user.username;
      if (name !== store.setting(`representative-name-${row.user_id}`)) {
        store.setSetting(`representative-name-${row.user_id}`,name); changed = true;
      }
    } catch { /* Preserve the last verified display name through transient Discord failures. */ }
  }
  return changed;
}
