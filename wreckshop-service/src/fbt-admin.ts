// Staff actions sent from the website's staff console (outbox kind "admin.group"). The website
// checks that the person is staff before queueing; the bot is the source of truth for groups, so
// it applies the change here and syncs the result back.
import type { Store } from './db.js';
import { endTrialRecord } from './fbt-trial.js';

export type Level = 'standard' | 'premium' | 'headliner';
export type AdminAction =
  | { action: 'create'; name: string; tier?: Level; vrchat?: string | null; rep?: string | null }
  | { action: 'rename'; groupId: number; name: string }
  | { action: 'tier'; groupId: number; tier: Level }
  | { action: 'suspend'; groupId: number; enabled: boolean }
  | { action: 'link'; groupId: number; url: string | null }
  | { action: 'addRep'; groupId: number; user: string }
  | { action: 'removeRep'; groupId: number; user: string }
  | { action: 'remove'; groupId: number }
  | { action: 'restore'; groupId: number }
  | { action: 'republish'; groupId: number }
  | { action: 'resetCode'; groupId: number };

export const LEVEL_LABEL: Record<Level, string> = { standard: 'Standard', premium: 'Premium', headliner: 'Headliner' };

/** Applies one level, keeping tier + headliner flag consistent. Any change ends a Headliner trial. */
export function setLevel(store: Store, groupId: number, level: Level): void {
  endTrialRecord(store, groupId);
  if (level === 'headliner') { store.setHeadliner(groupId, true); return; }
  if (store.group(groupId)?.level) store.setHeadliner(groupId, false);
  store.setTier(groupId, level);
}

/**
 * Runs one staff action. `resolveUser` turns "@name", a name or a Discord id into a Discord id
 * (throwing a readable error when it can't). Returns a one-line summary for the audit log.
 */
export async function applyAdmin(store: Store, a: AdminAction, resolveUser: (q: string) => Promise<string>): Promise<{ groupId: number; summary: string }> {
  const need = (id: number) => {
    const g = store.group(id);
    if (!g || id === 0) throw new Error(`Group #${id} isn't in the bot (it may have been removed).`);
    return g;
  };
  switch (a.action) {
    case 'create': {
      const rep = a.rep ? await resolveUser(a.rep) : undefined;
      const g = store.registerGroup(a.name, 'standard', a.vrchat || undefined, rep);
      if (a.tier && a.tier !== 'standard') setLevel(store, g.id, a.tier);
      return { groupId: g.id, summary: `Group #${g.id} ${g.name} created${a.tier && a.tier !== 'standard' ? ` as ${LEVEL_LABEL[a.tier]}` : ''}${rep ? ` with rep <@${rep}>` : ''}` };
    }
    case 'rename': {
      const old = need(a.groupId).name;
      store.renameGroup(a.groupId, a.name);
      return { groupId: a.groupId, summary: `Group #${a.groupId} renamed from ${old} to ${store.group(a.groupId)!.name}` };
    }
    case 'tier': {
      const g = need(a.groupId);
      setLevel(store, a.groupId, a.tier);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) set to ${LEVEL_LABEL[a.tier]}` };
    }
    case 'suspend': {
      const g = need(a.groupId);
      store.setEnabled(a.groupId, a.enabled);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) ${a.enabled ? 'restored' : 'suspended'}` };
    }
    case 'link': {
      const g = need(a.groupId);
      store.setUrl(a.groupId, a.url || null);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) VRChat group ${a.url ? 'linked' : 'unlinked'}` };
    }
    case 'addRep': {
      const g = need(a.groupId);
      const id = await resolveUser(a.user);
      store.addRepresentative(a.groupId, id);
      return { groupId: a.groupId, summary: `<@${id}> added as a rep of ${g.name} (#${a.groupId})` };
    }
    case 'removeRep': {
      const g = need(a.groupId);
      const id = /^\d{5,25}$/.test(a.user) ? a.user : await resolveUser(a.user);
      if (!store.representatives(a.groupId).includes(id)) throw new Error('That person isn\'t a rep of this group.');
      store.removeRepresentative(a.groupId, id);
      return { groupId: a.groupId, summary: `<@${id}> removed as a rep of ${g.name} (#${a.groupId})` };
    }
    case 'remove': {
      const g = need(a.groupId);
      store.deleteGroup(a.groupId);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) removed from the catalog (restorable)` };
    }
    case 'restore': {
      store.restoreGroup(a.groupId);
      return { groupId: a.groupId, summary: `${store.group(a.groupId)!.name} (#${a.groupId}) restored` };
    }
    case 'republish': {
      const g = need(a.groupId);
      store.queuePublish(a.groupId);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) posters queued to republish` };
    }
    case 'resetCode': {
      const g = need(a.groupId);
      store.newCode(a.groupId);
      return { groupId: a.groupId, summary: `${g.name} (#${a.groupId}) got a new access code` };
    }
  }
}
