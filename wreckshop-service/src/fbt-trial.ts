// Headliner trial (owner, 17 Oct 2026): any Premium club can type /redeem and be a Headliner until the
// end of October. When it ends the club goes back to Premium by itself. A real tier change by staff
// (or an approved Headliner application) ends the trial record, so it never undoes an approval.
//
// Also here: the one-time update DM to club owners and the "Premium & Headliner" explainer posted
// in #start-here for new members.
import type { Store } from './db.js';
import type { Group } from './types.js';
import { setLevel } from './fbt-admin.js';

/** Midnight Mountain time at the end of Oct 31 (same moment the Founder badge closes). */
export const TRIAL_ENDS = Date.parse('2026-11-01T06:00:00Z');
export const TRIAL_END_TEXT = 'October 31';
const KEY = 'fbt-headliner-trials';

/** groupId → when its trial ends (ms). */
export function trials(store: Store): Record<string, number> {
  try { return JSON.parse(store.setting(KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}
function saveTrials(store: Store, t: Record<string, number>): void { store.setSetting(KEY, JSON.stringify(t)); }

export function onTrial(store: Store, groupId: number): boolean { return trials(store)[String(groupId)] != null; }

/** Forget a club's trial (called on every level change, so staff decisions always win). */
export function endTrialRecord(store: Store, groupId: number): void {
  const t = trials(store);
  if (t[String(groupId)] == null) return;
  delete t[String(groupId)];
  saveTrials(store, t);
}

export interface RedeemResult { granted: Group[]; reply: string }

/** /redeem: every Premium club the person runs becomes a Headliner until the end of October. */
export function redeemTrial(store: Store, userId: string, now = Date.now()): RedeemResult {
  const mine = store.representedGroups(userId).filter(g => g.enabled && g.id !== 0);
  if (now >= TRIAL_ENDS) return { granted: [], reply: `The Headliner trial ended on ${TRIAL_END_TEXT}. To be a Headliner, apply with \`/apply level:Headliner\`.` };
  if (!mine.length) return { granted: [], reply: 'You don\'t run a club yet. Register one with `/start`, then apply for Premium to try Headliner.' };
  const granted: Group[] = [];
  const lines: string[] = [];
  for (const g of mine) {
    if (g.tier === 'premium' && g.level === 'headliner') {
      lines.push(onTrial(store, g.id) ? `**${g.name}** is already on the Headliner trial until ${TRIAL_END_TEXT}.` : `**${g.name}** is already a Headliner.`);
      continue;
    }
    if (g.tier !== 'premium') { lines.push(`**${g.name}** is Standard. The Headliner trial is for Premium clubs: apply for Premium with \`/apply level:Premium\`.`); continue; }
    setLevel(store, g.id, 'headliner'); // clears any old record first
    const t = trials(store); t[String(g.id)] = TRIAL_ENDS; saveTrials(store, t);
    granted.push(store.group(g.id)!);
    lines.push(`👑 **${g.name}** is a Headliner until ${TRIAL_END_TEXT}! Gold billing on the Marquee, your venue page and your nights. After that it goes back to Premium on its own.`);
  }
  return { granted, reply: lines.join('\n') };
}

/** Trials that have run out go back to Premium. Returns the clubs that changed. */
export function expireTrials(store: Store, now = Date.now()): Group[] {
  const ended: Group[] = [];
  for (const [id, ends] of Object.entries(trials(store))) {
    if (now < ends) continue;
    const g = store.group(Number(id));
    if (g && g.tier === 'premium' && g.level === 'headliner') { setLevel(store, g.id, 'premium'); ended.push(store.group(g.id)!); }
    else endTrialRecord(store, Number(id));
  }
  return ended;
}

export function trialEndedDm(groupName: string, applyUrl: string): string {
  return [
    `Your Headliner trial for **${groupName}** has ended, and the club is back on Premium. Everything else stays the same.`,
    `Want to stay a Headliner? Apply with \`/apply level:Headliner\` or at ${applyUrl}.`,
  ].join('\n');
}

/** The one-time "we've updated" DM, worded for the best tier among the person's clubs. */
export function updateNotice(clubs: Group[], startHereId: string | null): string {
  const names = clubs.map(g => `**${g.name}**`).join(', ');
  const premium = clubs.some(g => g.tier === 'premium' && g.level !== 'headliner');
  const headliner = clubs.some(g => g.tier === 'premium' && g.level === 'headliner');
  const where = startHereId ? `<#${startHereId}>` : '#start-here';
  return [
    '🎭 **FBT Social has been updated and improved.**',
    `The world got a round of upgrades, and your club's tier is intact (${names}).`,
    '',
    premium
      ? `👑 **Try Headliner free until ${TRIAL_END_TEXT}.** Type \`/redeem\` in the FBT Social Discord and your Premium club becomes a Headliner right away: gold billing on the Marquee, your venue page and your nights. It goes back to Premium on its own afterwards.`
      : headliner
        ? 'You\'re a Headliner: thanks for being top of the bill.'
        : `Want more? Premium unlocks all 32 posters, the billboard and the photo wall, and Premium clubs can try Headliner free until ${TRIAL_END_TEXT}. See how in ${where}.`,
    '',
    'Thanks for building FBT Social with us. See you on the floor.',
  ].join('\n');
}

/** Pick each person's clubs once, so nobody gets the notice twice. */
export function noticeRecipients(store: Store): Map<string, Group[]> {
  const out = new Map<string, Group[]>();
  for (const g of store.groups()) {
    if (!g.enabled || g.id === 0) continue;
    for (const rep of store.representatives(g.id)) out.set(rep, [...(out.get(rep) ?? []), g]);
  }
  return out;
}

/** The "Premium & Headliner" explainer in #start-here. */
export function tiersExplainer(now = Date.now()): { title: string; description: string; fields: { name: string; value: string }[] } {
  return {
    title: 'Club levels: Standard, Premium and Headliner',
    description: 'Every club starts free. Levels change your badge and what you unlock, never how much heat you earn.',
    fields: [
      { name: '🎟️ Standard (free)', value: [
        'Register with the **Register my group** button above.',
        '• Posters **1–11** on the sidewalk, entrance and arrival hall',
        '• Your own venue page and a place in the Marquee race',
        '• Get the **Verified** role and you can host collab nights too',
      ].join('\n') },
      { name: '💎 Premium (apply, staff approve)', value: [
        '• All **32 posters**, from the sidewalk to the balconies',
        '• The **billboard** over the entrance and the **photo-wall backdrop**',
        '• **Venue Studio**: your club\'s own look in the world',
        '• A Join Group button in the world and Premium styling on the site',
        '**The Premium promise:** run your nights as **age-verified (18+)** group instances and accept our tracker **fbtheat** into your VRChat group.',
      ].join('\n') },
      { name: '👑 Headliner (apply, staff approve)', value: [
        'Everything in Premium, plus **gold Headliner billing** on the Marquee, your venue page and your nights, and the rooftop on your nights.',
        ...(now < TRIAL_ENDS ? [`**Premium clubs: type \`/redeem\` to try Headliner free until ${TRIAL_END_TEXT}.**`] : []),
      ].join('\n') },
      { name: 'How to apply', value: 'Press **Apply: Premium / Headliner** above or type `/apply`. Your club\'s numbers go to staff with it, and you get a DM with the answer.' },
    ],
  };
}
