// Discord housekeeping driven from the website's Control room: the channel list (so staff can spot
// duplicates and stale channels), deleting a channel staff picked, and posting an announcement.
// Nothing here acts on its own: every change comes from a staff click on the site.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, SnowflakeUtil, type Guild, type GuildBasedChannel, type TextChannel } from 'discord.js';
import type { Store } from './db.js';

/** Settings that point at channels the bots depend on. These are never deleted from the site. */
export const PROTECTED_SETTINGS = ['fbt_start_channel', 'fbt_events_channel', 'approval_channel', 'log_channel', 'submission_channel', 'help_channel'];

export interface ChannelInfo {
  id: string; name: string; kind: 'text' | 'announcement' | 'voice' | 'stage' | 'forum' | 'category' | 'other';
  parentId: string | null; parentName: string | null; position: number; topic: string | null;
  lastMessageAt: string | null; protected: string | null; everyoneCanView: boolean; createdAt: string;
}

const KIND: Partial<Record<ChannelType, ChannelInfo['kind']>> = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildStageVoice]: 'stage', [ChannelType.GuildForum]: 'forum', [ChannelType.GuildCategory]: 'category',
};

export function protectedRole(store: Store, channelId: string): string | null {
  for (const key of PROTECTED_SETTINGS) if (store.setting(key) === channelId) return key;
  return null;
}

/** What staff see in the Control room's Discord tab. */
export function channelInventory(guild: Guild, store: Store): ChannelInfo[] {
  const everyone = guild.roles.everyone;
  return [...guild.channels.cache.values()].filter((c): c is GuildBasedChannel => !c.isThread()).map((c) => {
    const last = 'lastMessageId' in c && c.lastMessageId ? new Date(Number(SnowflakeUtil.timestampFrom(c.lastMessageId))).toISOString() : null;
    const parent = c.parent;
    return {
      id: c.id, name: c.name, kind: KIND[c.type] ?? 'other', parentId: parent?.id ?? null, parentName: parent?.name ?? null,
      position: 'rawPosition' in c ? c.rawPosition : 0, topic: 'topic' in c ? (c.topic ?? null) : null, lastMessageAt: last,
      protected: protectedRole(store, c.id), everyoneCanView: Boolean(c.permissionsFor(everyone)?.has('ViewChannel')),
      createdAt: c.createdAt?.toISOString() ?? new Date(0).toISOString(),
    };
  });
}

/** Delete one channel staff chose on the site. Refuses the channels the bots run on, and checks the name. */
export async function deleteChannel(guild: Guild, store: Store, channelId: string, expectName: string, by: string): Promise<string> {
  const c = guild.channels.cache.get(channelId);
  if (!c) return `Channel ${expectName} was already gone.`;
  const role = protectedRole(store, c.id);
  if (role) throw Object.assign(new Error(`#${c.name} is the bot's ${role.replace(/_/g, ' ')}; it can't be deleted from the site.`), { permanent: true });
  if (c.name !== expectName) throw Object.assign(new Error(`That channel is now called #${c.name}, not #${expectName}. Refresh and try again.`), { permanent: true });
  if (c.type === ChannelType.GuildCategory && guild.channels.cache.some((x) => x.parentId === c.id))
    throw Object.assign(new Error(`The ${c.name} category still has channels in it. Move or delete them first.`), { permanent: true });
  await c.delete(`Removed from the FBT Social Control room by ${by}`);
  return `#${expectName} deleted`;
}

export interface Announcement { channelId: string; title: string; body: string; everyone: boolean; links: { label: string; url: string }[]; image?: string | null }

/** Post an announcement staff wrote (and pressed Post on) in the Control room. */
export async function postAnnouncement(guild: Guild, a: Announcement): Promise<string> {
  const ch = guild.channels.cache.get(a.channelId);
  if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement))
    throw Object.assign(new Error('That channel is gone or isn\'t a text channel.'), { permanent: true });
  const embed = new EmbedBuilder().setColor(0xe8507a).setTitle(a.title.slice(0, 256)).setDescription(a.body.slice(0, 4000))
    .setFooter({ text: 'FBT Social · the after-dark Strip' });
  if (a.image) embed.setImage(a.image);
  const links = a.links.filter((l) => /^https:\/\//.test(l.url)).slice(0, 5);
  const components = links.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(links.map((l) => new ButtonBuilder().setLabel(l.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(l.url)))] : [];
  const msg = await (ch as TextChannel).send({
    content: a.everyone ? '@everyone' : undefined, embeds: [embed], components,
    allowedMentions: { parse: a.everyone ? ['everyone'] : [] },
  });
  if (ch.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => undefined);
  return msg.id;
}
