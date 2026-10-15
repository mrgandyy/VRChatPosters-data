// FBT Social's automatic rules (decided on the website, applied here) and the Premium welcome.
//  - Premium promise: age-verified (18+) instances, with fbtheat let into the club's VRChat group.
//    A club out of line for 7 days drops to Standard (enforce.demote).
//  - Inactivity: 30 days without a counted night and the club comes off the Strip (enforce.deactivate).
import type { Store } from './db.js';
import { setLevel } from './fbt-admin.js';

export const TRACKER_NAME = 'fbtheat';

/** Drop a club to Standard for the age-verified promise. Returns the audit line. */
export function demoteForAge(store: Store, groupId: number): string | null {
  const g = store.group(groupId);
  if (!g || !g.enabled || g.tier !== 'premium') return null; // already handled, or staff changed it
  setLevel(store, groupId, 'standard');
  return `${g.name} (#${groupId}) dropped to Standard: the Premium age-verified promise wasn't met for 7 days.`;
}

/** Take a club off the Strip for inactivity: Standard, and disabled until it comes back. */
export function deactivateForInactivity(store: Store, groupId: number): string | null {
  const g = store.group(groupId);
  if (!g || !g.enabled || groupId === 0) return null;
  if (g.tier !== 'standard') setLevel(store, groupId, 'standard');
  store.setEnabled(groupId, false);
  return `${g.name} (#${groupId}) came off the Strip: no counted night in 30 days. A rep can bring it back from My club.`;
}

export function demoteDm(groupName: string, reason: string, applyUrl: string): string {
  return [
    `**${groupName}** has moved from Premium back to Standard.`,
    `Premium clubs promise to run **age-verified (18+) instances** in VRChat and let our tracker **${TRACKER_NAME}** into their VRChat group so we can confirm it. For the last 7 days, ${reason}.`,
    '',
    '**To get Premium back:**',
    `1. Accept ${TRACKER_NAME}'s join request in your VRChat group (or invite ${TRACKER_NAME} if your group is invite-only).`,
    '2. Host your nights as group instances with age verification (18+) turned on.',
    `3. Apply again: ${applyUrl}`,
    '',
    'Your posters 1–11, history and honors are all kept.',
  ].join('\n');
}

export interface Welcome { title: string; description: string; fields: { name: string; value: string }[] }

/** The congratulations + getting-started DM for a club approved to Premium or Headliner. */
export function premiumWelcome(groupName: string, level: 'premium' | 'headliner', opts: { linked: boolean; manageUrl: string; hostUrl: string; pageUrl: string }): Welcome {
  const headliner = level === 'headliner';
  const label = headliner ? 'Headliner' : 'Premium';
  return {
    title: headliner ? `👑 ${groupName} is a Headliner!` : `🎉 ${groupName} is now Premium!`,
    description: headliner
      ? 'Congratulations: you\'re at the top of the Strip. You get Headliner billing in gold on the Marquee, your venue page and in #fbt-events, and everything Premium has.'
      : 'Congratulations, and welcome to the top tier of the Strip. Your club just unlocked the full FBT Social experience.',
    fields: [
      { name: 'What you unlocked', value: [
        '• All **32 poster spots**, from the sidewalk to the balconies',
        '• The **billboard** over the entrance and the **photo-wall backdrop**',
        `• ${label} styling on the Strip, the leaderboard and your venue page`,
        '• A Discord role to match',
      ].join('\n') },
      { name: 'Step 1 · Let our tracker in (the Premium promise)', value: [
        opts.linked
          ? `We've sent **${TRACKER_NAME}** a request to join your VRChat group. Accept it under your group's member requests (or invite ${TRACKER_NAME} if your group is invite-only).`
          : `Link your VRChat group first (\`/group link\` or on the website), then accept **${TRACKER_NAME}**'s join request.`,
        `Then run your nights as **age-verified (18+) group instances**. ${TRACKER_NAME} checks automatically. You have **7 days** to have both in place, or the club goes back to Standard.`,
      ].join('\n') },
      { name: 'Step 2 · Make it yours', value: `Sign in at fbtsocial.com and open **My dashboard** (top right): it's your club's control panel. Upload your posters, billboard, backdrop, logo and banner, and pick your colour: ${opts.manageUrl}` },
      { name: 'Step 3 · Book your nights', value: `Post your nights at ${opts.hostUrl} or with \`/event create\`. They land on the Strip, in #fbt-events and on your page: ${opts.pageUrl}. Collab nights pay both clubs the full heat.` },
    ],
  };
}
