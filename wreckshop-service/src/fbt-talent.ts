// The talent loop's Discord messages (talent agency, Oct 2026). The website owns lineups, invites and
// the quiet safety rules; this module only draws the DMs and posts from what the site sends:
// lineup.joined, lineup.left, lineup.reminder, talent.invite, talent.invite.answer, talent.call,
// talent.paused. Buttons on an invite go back through the site, so the same rules apply.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { discordTime } from './fbt-time.js';

const GOLD = 0xf2c94c, ICE = 0x8fdcff;

export interface Club { name: string; slug: string; vrcGroupId?: string | null }
export interface Night { eventId: string; title: string; startsAt: string; club: Club; hosts?: string[] }
export interface Joined extends Night {
  role: 'dancer' | 'dj';
  performer: { id: string; name: string; vrcId?: string | null; slug?: string | null };
  slot?: { label: string; startsAt: string; endsAt: string } | null;
}

type Msg = { content?: string; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[]; allowedMentions?: { parse?: []; users?: string[]; roles?: string[] } };

/** Strip Discord markdown and mentions from a name we print. */
export const clean = (s: unknown) => String(s ?? '').replace(/[`*_~|<>@\\]/g, '').slice(0, 64) || 'Someone';
const link = (label: string, href: string) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(href);
const row = (...b: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(b.slice(0, 5));
export const groupUrl = (id?: string | null) => (id && /^grp_[0-9a-f-]{36}$/.test(id) ? `https://vrchat.com/home/group/${id}` : null);
export const vrcUserUrl = (id?: string | null) => (id && /^usr_[0-9a-f-]{36}$/.test(id) ? `https://vrchat.com/home/user/${id}` : null);
const when = (iso: string) => `${discordTime(Date.parse(iso))} (${discordTime(Date.parse(iso), 'R')})`;
const what = (j: Pick<Joined, 'role' | 'slot'>) => j.role === 'dj'
  ? `play ${j.slot?.label ? `the **${clean(j.slot.label)}** set` : 'a DJ set'}${j.slot ? ` at ${discordTime(Date.parse(j.slot.startsAt), 't')}` : ''}`
  : 'dance on the roster';

/** To the host: who signed up and how to reach them. */
export function introHost(j: Joined, url: (p: string) => string): Msg {
  const who = clean(j.performer.name);
  const e = new EmbedBuilder().setColor(j.role === 'dj' ? ICE : GOLD)
    .setTitle(`${who} signed up for ${clean(j.title)}`.slice(0, 256)).setURL(url(`/e/${j.eventId}`))
    .setDescription([
      `✦ **${who}** will ${what(j)} at **${clean(j.title)}**, ${when(j.startsAt)}.`,
      '',
      `**Say hi:** <@${j.performer.id}>. Send them the details (dress code, when to arrive, the instance) and a VRChat friend request or invite.`,
    ].join('\n'))
    .setFooter({ text: 'FBT Social · the talent agency for every club' });
  const buttons = [link('Event page', url(`/e/${j.eventId}`))];
  if (j.performer.slug) buttons.push(link(`${who}'s page`, url(`/talent/${encodeURIComponent(j.performer.slug)}`)));
  const vrc = vrcUserUrl(j.performer.vrcId);
  if (vrc) buttons.push(link('VRChat profile', vrc));
  return { embeds: [e], components: [row(...buttons)] };
}

/** To the performer: the night, their host, and what to do next. */
export function introPerformer(j: Joined, url: (p: string) => string): Msg {
  const host = j.hosts?.[0];
  const group = groupUrl(j.club.vrcGroupId);
  const e = new EmbedBuilder().setColor(j.role === 'dj' ? ICE : GOLD)
    .setTitle(`You're on for ${clean(j.club.name)}`.slice(0, 256)).setURL(url(`/e/${j.eventId}`))
    .setDescription([
      `You'll ${what(j)} at **${clean(j.title)}**, ${when(j.startsAt)}.`,
      host ? `**Your host:** <@${host}>` : '',
      '',
      '**Next steps**',
      `1. Message your host to say hi and check the details.`,
      `2. ${group ? `Join **${clean(j.club.name)}**'s VRChat group (button below) so you can get into their instance.` : `Ask your host how to get into their instance.`}`,
      '3. Arrive about 15 minutes early.',
      '',
      `Can't make it? Give up your spot from the event page as early as you can, so someone else can take it.`,
    ].join('\n').replace(/\n{3,}/g, '\n\n'))
    .setFooter({ text: 'FBT Social · see you on stage' });
  const buttons = [link('Event page', url(`/e/${j.eventId}`))];
  if (group) buttons.push(link('Club VRChat group', group));
  buttons.push(link('Report a problem', url(`/e/${j.eventId}#report`)));
  return { embeds: [e], components: [row(...buttons)] };
}

/** To the host: someone gave their spot back. */
export function leftHost(j: Joined, url: (p: string) => string): Msg {
  return {
    content: `↩️ **${clean(j.performer.name)}** gave up their ${j.role === 'dj' ? 'DJ set' : 'dancer spot'} at **${clean(j.title)}** (${discordTime(Date.parse(j.startsAt))}). It's open again for anyone to claim.`,
    components: [row(link('Event page', url(`/e/${j.eventId}`)), link('Find talent', url('/talent')))],
    allowedMentions: { parse: [] },
  };
}

export interface Reminder extends Night { performers: { id: string; name: string; role: 'dancer' | 'dj'; label?: string | null; at?: string | null }[] }

/** To each performer, about two hours before. */
export function reminderPerformer(r: Reminder, p: Reminder['performers'][number], url: (x: string) => string): Msg {
  const group = groupUrl(r.club.vrcGroupId);
  const host = r.hosts?.[0];
  const slot = p.role === 'dj' && p.at ? `Your set${p.label ? ` (${clean(p.label)})` : ''} starts ${discordTime(Date.parse(p.at), 't')}.` : p.at ? `You said you'd perform around ${discordTime(Date.parse(p.at), 't')}.` : `You're in the dancer rotation.`;
  const buttons = [link('Event page', url(`/e/${r.eventId}`))];
  if (group) buttons.push(link('Club VRChat group', group));
  return {
    content: [
      `⏰ **${clean(r.title)}** at **${clean(r.club.name)}** starts ${when(r.startsAt)}.`,
      slot,
      host ? `Your host is <@${host}>. Arrive about 15 minutes early.` : 'Arrive about 15 minutes early.',
      `Can't make it after all? Give up your spot on the event page now so your host can fill it.`,
    ].join('\n'),
    components: [row(...buttons)],
    allowedMentions: { parse: [] },
  };
}

/** To the host: tonight's lineup. */
export function reminderHost(r: Reminder, url: (x: string) => string): Msg {
  const lines = r.performers.map((p) => `• **${clean(p.name)}** (${p.role === 'dj' ? `DJ${p.at ? `, ${discordTime(Date.parse(p.at), 't')}` : ''}` : 'dancer'}) <@${p.id}>`);
  return {
    content: [`⏰ **${clean(r.title)}** starts ${when(r.startsAt)}. Your lineup:`, ...lines.slice(0, 30), '', 'Afterwards, mark anyone who didn\'t show on the event page (private, for 48 hours).'].join('\n').slice(0, 1900),
    components: [row(link('Event page', url(`/e/${r.eventId}`)))],
    allowedMentions: { parse: [] },
  };
}

export interface Invite extends Night { inviteId: string; role: 'dancer' | 'dj'; by: string; performer: { id: string; name: string }; slot?: { label: string; startsAt: string } | null }

/** To the invited performer: one tap to say yes. */
export function inviteDm(v: Invite, url: (x: string) => string): Msg {
  const e = new EmbedBuilder().setColor(v.role === 'dj' ? ICE : GOLD)
    .setTitle(`${clean(v.club.name)} would love you on their lineup`.slice(0, 256)).setURL(url(`/e/${v.eventId}`))
    .setDescription([
      `<@${v.by}> invited you to ${v.role === 'dj' ? `play ${v.slot?.label ? `the **${clean(v.slot.label)}** set` : 'a DJ set'}${v.slot ? ` at ${discordTime(Date.parse(v.slot.startsAt), 't')}` : ''}` : 'dance on the roster'} at **${clean(v.title)}**, ${when(v.startsAt)}.`,
      '',
      'Tap **I\'m in** to take the spot, or **Not this time**. Either way is fine.',
    ].join('\n'))
    .setFooter({ text: 'FBT Social · you can turn invites off on My dashboard (Open to bookings)' });
  return {
    embeds: [e],
    components: [row(
      new ButtonBuilder().setCustomId(`fbt:tia:${v.inviteId}`).setLabel('I\'m in').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`fbt:tid:${v.inviteId}`).setLabel('Not this time').setStyle(ButtonStyle.Secondary),
      link('Event page', url(`/e/${v.eventId}`)),
    )],
  };
}

export function inviteDeclinedDm(p: { performer: string; title: string; eventId: string }, url: (x: string) => string): Msg {
  return {
    content: `**${clean(p.performer)}** can't make **${clean(p.title)}** this time. Plenty more on The Talent.`,
    components: [row(link('Find talent', url('/talent')), link('Event page', url(`/e/${p.eventId}`)))],
    allowedMentions: { parse: [] },
  };
}

export interface Call extends Night { needs: { dancers: number; djSets: number } }

/** The talent channel: a night with open spots, pinging the Dancer and/or DJ role. */
export function talentCallMessage(c: Call, roles: { dancer?: string; dj?: string }, url: (x: string) => string): Msg {
  const want = [c.needs.dancers ? `**${c.needs.dancers}** dancer spot${c.needs.dancers === 1 ? '' : 's'}` : '', c.needs.djSets ? `**${c.needs.djSets}** DJ set${c.needs.djSets === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const ping = [c.needs.dancers && roles.dancer ? `<@&${roles.dancer}>` : '', c.needs.djSets && roles.dj ? `<@&${roles.dj}>` : ''].filter(Boolean);
  const e = new EmbedBuilder().setColor(c.needs.djSets && !c.needs.dancers ? ICE : GOLD)
    .setTitle(`Talent wanted: ${clean(c.title)}`.slice(0, 256)).setURL(url(`/e/${c.eventId}`))
    .setDescription(`**${clean(c.club.name)}** · ${when(c.startsAt)}\n${want} open. Verified performers claim in one tap on the event page.`)
    .setFooter({ text: 'FBT Social · not verified yet? My dashboard → On stage' });
  return {
    content: ping.length ? `${ping.join(' ')} a night needs you` : undefined,
    embeds: [e],
    components: [row(link('Claim a spot', url(`/e/${c.eventId}`)), link('The Playbill', url('/playbill?needs=1')))],
    allowedMentions: { roles: [roles.dancer, roles.dj].filter((x): x is string => Boolean(x)) },
  };
}

/** One neutral DM when no-shows pause someone's sign-ups. */
export function pausedDm(p: { days: number; until: string; count: number; windowDays: number }, url: (x: string) => string): Msg {
  return {
    content: [
      `Hi! A heads-up from FBT Social: you've missed ${p.count} nights you signed up for in the last ${p.windowDays} days, so signing up for new spots is paused until ${discordTime(Date.parse(p.until), 'f')}.`,
      `You can still come and enjoy any night, and any spots you already have stay yours. After that, sign-ups open again automatically.`,
      `If you can't make a night in future, giving up your spot on the event page a couple of hours ahead never counts against you.`,
    ].join('\n\n'),
    components: [row(link('My dashboard', url('/me')))],
    allowedMentions: { parse: [] },
  };
}


// ── Dev Fund supporters (donor.thanked) ─────────────────────────────────────────────────────────

/** The supporter role: "Producer" (also "Producers", "FBT Producer", or with a symbol in front like "✦ Producer"). */
export const isProducerRoleName = (name: string) => /^[^\p{L}\p{N}]*(fbt\s*(social\s*)?)?producers?[^\p{L}\p{N}]*$/iu.test(name.trim());

/** Thank-you DM when the Producer role is given. */
export function producerDm(url: (x: string) => string): Msg {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle('✦ Thank you for backing FBT Social')
    .setDescription([
      'Your Dev Fund gift keeps the servers on and the next build coming.',
      "You're a **Producer** now: the role is yours in our Discord.",
      "Your thank-you world add-on is sent by hand when it drops, so keep an eye on your DMs.",
    ].join('\n\n'))
    .setFooter({ text: 'FBT Social · Where VRChat takes the stage' });
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('The Dev Fund').setStyle(ButtonStyle.Link).setURL(url('/shop')))] };
}
