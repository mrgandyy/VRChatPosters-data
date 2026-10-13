// Interactive event posts (events hub, Oct 2026). "DJs get time, dancers get glamour": open DJ
// slots are one-tap Claim buttons, dancers join the roster with one tap. The website owns the
// lineup; this module only draws the Discord message from the site's `view` of the event.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { discordTime } from './fbt-time.js';

export interface LineupView {
  id: string; title: string; startsAt: string; endsAt: string; host: string; partners: string[];
  slots: { id: string; startsAt: string; endsAt: string; label: string; name: string | null }[];
  roster: { name: string; softTime: string | null }[]; rosterSize: number | null;
}

const GOLD = 0xf2c94c, BRONZE = 0xb98a4e;
const MAX_CLAIM_BUTTONS = 15; // three rows of five; the fourth row holds the roster and page buttons

/** Custom ids: fbt:<action>:<id>. luc = claim slot, lur = give up my slot, luj = join roster, lul = leave roster. */
export const LINEUP_ACTIONS = ['luc', 'lur', 'luj', 'lul'] as const;

/** Whether an event.created payload has a lineup worth an interactive post. */
export function hasLineup(p: { slots?: unknown; rosterSize?: unknown }): boolean {
  return Number(p.slots ?? 0) > 0 || Number(p.rosterSize ?? 0) > 0;
}

export function lineupMessage(v: LineupView, pageUrl: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const premiere = v.partners.length > 0;
  const who = [v.host, ...v.partners].join(' × ');
  const start = Date.parse(v.startsAt);
  const embed = new EmbedBuilder()
    .setColor(premiere ? GOLD : BRONZE)
    .setTitle(v.title.slice(0, 256))
    .setURL(pageUrl)
    .setDescription(`${premiere ? '✦ **A premiere** · ' : ''}**${who}** · ${discordTime(start)} (${discordTime(start, 'R')})`.slice(0, 4000));
  if (v.slots.length) {
    const lines = v.slots.map((s, i) => {
      const t = `${discordTime(Date.parse(s.startsAt), 't')}–${discordTime(Date.parse(s.endsAt), 't')}`;
      return `\`${i + 1}\` ${t}${s.label ? ` · ${s.label}` : ''} · ${s.name ? `**${s.name}**` : '_open_'}`;
    });
    embed.addFields({ name: '🎧 DJ lineup', value: lines.join('\n').slice(0, 1024) });
  }
  if (v.rosterSize) {
    const names = v.roster.map((r) => `✦ **${r.name}**${r.softTime ? ` · around ${discordTime(Date.parse(r.softTime), 't')}` : ''}`);
    const open = Math.max(0, v.rosterSize - v.roster.length);
    const value = [...names, open ? `_${open} spot${open === 1 ? '' : 's'} open: your name in lights_` : '_Roster full_'].join('\n');
    embed.addFields({ name: '💃 Tonight\'s dancers · a rotation, no clock', value: value.slice(0, 1024) });
  }
  embed.setFooter({ text: 'Verified FBT Social performers tap to claim · not verified yet? Open the event page' });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const openSlots = v.slots.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => !s.name).slice(0, MAX_CLAIM_BUTTONS);
  for (let r = 0; r < openSlots.length; r += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(openSlots.slice(r, r + 5).map(({ s, n }) =>
      new ButtonBuilder().setCustomId(`fbt:luc:${s.id}`).setLabel(`Claim set ${n}${s.label ? ` · ${s.label}` : ''}`.slice(0, 80)).setStyle(ButtonStyle.Primary))));
  }
  const tail = new ActionRowBuilder<ButtonBuilder>();
  if (v.rosterSize && v.roster.length < v.rosterSize) tail.addComponents(new ButtonBuilder().setCustomId(`fbt:luj:${v.id}`).setLabel('Join the roster').setStyle(ButtonStyle.Success));
  if (v.rosterSize) tail.addComponents(new ButtonBuilder().setCustomId(`fbt:lul:${v.id}`).setLabel('Leave the roster').setStyle(ButtonStyle.Secondary));
  if (v.slots.length) tail.addComponents(new ButtonBuilder().setCustomId(`fbt:lur:${v.id}`).setLabel('Give up my set').setStyle(ButtonStyle.Secondary));
  tail.addComponents(new ButtonBuilder().setLabel('Event page & share link').setStyle(ButtonStyle.Link).setURL(pageUrl));
  components.push(tail);
  return { embeds: [embed], components };
}
