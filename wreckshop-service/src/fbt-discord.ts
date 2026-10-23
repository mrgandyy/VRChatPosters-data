// Discord housekeeping driven from the website's Control room: the channel list (so staff can spot
// duplicates and stale channels), deleting a channel staff picked, and posting an announcement.
// Nothing here acts on its own: every change comes from a staff click on the site.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, SnowflakeUtil, type Guild, type GuildBasedChannel, type TextChannel } from 'discord.js';
import type { Store } from './db.js';
import { SLOTS, ZONE_LABEL, ZONE_ORDER, slotList, zoneSlots } from './slots.js';

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
    .setFooter({ text: 'FBT Social · Where VRChat takes the stage' });
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

/** The four posts in #artwork-guide, in order: guide, poster map, Premium, activate & troubleshoot. */
export function guidePosts(siteUrl: string, submitId: string | null, helpId: string | null): string[] {
  const site = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const submit = submitId ? `<#${submitId}>` : '#wreckshop-submit';
  const help = helpId ? `<#${helpId}>` : '#wreckshop-help';
  const zones = ZONE_ORDER.map((z) => [
    `**${ZONE_LABEL[z]}** · ${slotList(zoneSlots(z))}`,
    ...SLOTS.filter((x) => x.zone === z).map((x) => `\`${String(x.slot).padStart(2, '0')}\` ${x.where}`),
  ].join('\n'));
  return [
    [
      '# FBT SOCIAL | ARTWORK GUIDE',
      'Customize your club\'s posters, entrance billboard and photo wall.',
      '',
      '## Easiest: the website',
      `Sign in at **${site}** → **My dashboard** → **Customize**. Pick a spot on the poster map and upload. You\'ll see each image\'s status there and get a DM when it\'s approved. Managers you invite to your team can upload too.`,
      '',
      '## Or here in Discord',
      `\`/poster submit\` one image · \`/poster batch\` up to **8** at once · \`/billboard submit\` · \`/backdrop submit\` · or the buttons in ${submit}.`,
      '',
      '## What you get',
      '**Every club:** posters **1–11** (entrance, sidewalk and arrival hall).',
      '**Premium & Headliner:** posters **1–32**, the entrance billboard, the photo-wall backdrop, the DJ booth front, the Join Group button and **Venue Studio** (finish, accent, glow and your own texture, saved as a theme).',
      '**Verified performers:** your own pole wrap, chair seat-back and catwalk deck logo, shown whenever you perform. Verify and upload on **My dashboard**.',
      '',
      '## Artwork sizes',
      '- **Posters:** 1024 × 1536, 2:3 portrait.',
      '- **Billboard (Premium):** 2048 × 512, 4:1 wide.',
      '- **Photo backdrop (Premium):** 2048 × 1536, 4:3. Keep key branding toward the top and sides so people posing don\'t cover it.',
      '- **DJ booth front (Premium):** 2400 × 400, 6:1 wide, on both DJ booths while your club is active. Website only; download the template from the upload card.',
      '- **Venue Studio texture (Premium):** 1024 × 1024 square, seamless if you can. Website only.',
      '- **Performer stage art:** pole wrap 512 × 1024 (tall 1:2, top of the image at the top of the pole) · chair seat-back 512 × 512 · deck logo 512 × 512 on a dark background (it glows on the catwalk floor).',
      'Static **PNG, JPG or WebP**: up to 10 MB on the website, 12 MB in Discord. Keep text large and match the aspect ratio to avoid borders. Upload single images, not a combined poster sheet.',
    ].join('\n'),
    [
      '# POSTER SLOT MAP: ALL 32 SPOTS',
      '**Checked spot by spot in the world, Oct 15, 2026.** Numbered in walking order. Left/right: as you walk in, facing the stage.',
      '**1–11:** every club. **12–32:** Premium & Headliner. 22 and 27 hang on the main-floor walls.',
      '',
      ...zones.flatMap((z) => [z, '']),
      `Photos of every spot: **${site}/help#posters** · \`/poster map\` any time.`,
    ].join('\n'),
    [
      '# PREMIUM & HEADLINER',
      '## 1. Apply',
      `Any verified club can apply, on **${site}/apply** or with \`/apply\`. Staff see your real numbers (season heat, nights hosted, best night) and decide; you get a DM either way.`,
      '',
      '## 2. The Premium promise',
      'Premium clubs run **age-verified (18+) instances** in VRChat and let our tracker **fbtheat** into their VRChat group. After approval fbtheat asks to join: accept it in VRChat → your group → Members → Requests (invite-only groups: invite fbtheat). Within **7 days** you need fbtheat in your group and an age-verified room, or the club goes back to Standard.',
      '',
      '## 3. Upload your Premium art',
      `Posters 12–32, the billboard and the photo backdrop: on **My dashboard → Customize**, or \`/poster submit group:<n> slot:17\`, \`/billboard submit group:<n>\`, \`/backdrop submit group:<n>\`. Your club number is in \`/group mine\`.`,
      '',
      '## 4. Link your VRChat group',
      'On **My dashboard**, or `/group link group:<n> vrchat_group:<group URL or grp_ id>`. The Join Group button in the world opens your group page; visitors choose whether to join.',
    ].join('\n'),
    [
      '# ACTIVATE & CHECK YOUR ARTWORK',
      '## Activate in-world',
      '1. Get your eight-digit code with `/group mine`.',
      '2. Have the authorized instance host enter it at the entrance.',
      '3. Wait for your published artwork to load.',
      '4. Check your posters, billboard, photo backdrop and Join Group button.',
      '5. Authorized host/staff can preview and apply venue accent presets.',
      '',
      '## Know your IDs',
      '- **Club number:** used in Discord upload commands.',
      '- **VRChat group ID:** starts with `grp_`; used for the Join Group link and for counting your nights.',
      '- **Eight-digit activation code:** selects your club\'s setup in-world. It does not grant staff or VIP roles.',
      '',
      '## Approval & troubleshooting',
      '**Submit → Review → Approve → Publish → Loads in-world**',
      'Uploads need a club owner or manager. Billboards and backdrops also need Premium. Approved art goes live with the next publish, usually within minutes; in-world downloads can take a moment.',
      `Missing something? Check **My dashboard → Customize** or \`/poster list\`, then ask in ${help} with your club number, the spot and a screenshot.`,
      '`/poster remove group:<n> slot:<n>` restores the default artwork. `/ws-help` for every command.',
    ].join('\n'),
  ];
}

const HEADINGS = ['# FBT SOCIAL | ARTWORK GUIDE', '# POSTER SLOT MAP', '# PREMIUM', '# ACTIVATE & CHECK'];

/**
 * Keeps the four bot-written posts in #artwork-guide current: edits them in place (adopting the
 * older posts by their headings), posts any that are missing. Messages other people wrote are left alone.
 */
export async function ensureArtworkGuide(guild: Guild, store: Store, siteUrl: string): Promise<string> {
  const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'artworkguide') as TextChannel | undefined;
  if (!ch) return 'No #artwork-guide channel; skipped the artwork guide.';
  const me = guild.members.me?.id;
  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => undefined);
  const mine = recent ? [...recent.values()].filter((m) => m.author.id === me) : [];
  const saved = JSON.parse(store.setting('artwork_guide_ids') ?? '[]') as string[];
  const posts = guidePosts(siteUrl, store.setting('submission_channel') ?? null, store.setting('help_channel') ?? null);
  const ids: string[] = [];
  for (let i = 0; i < posts.length; i++) {
    let msg = saved[i] ? await ch.messages.fetch(saved[i]!).catch(() => undefined) : undefined;
    if (!msg) msg = mine.filter((m) => m.content.startsWith(HEADINGS[i]!)).sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
    const body = { content: posts[i]!, embeds: [], components: i === 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('My dashboard').setStyle(ButtonStyle.Link).setURL(`${siteUrl.replace(/\/$/, '')}/me`))] : [] };
    if (msg) await msg.edit(body);
    else msg = await ch.send(body);
    ids.push(msg.id);
  }
  store.setSetting('artwork_guide_ids', JSON.stringify(ids));
  // The short embed guide posted earlier today is replaced by the posts above.
  const extra = store.setting('artwork_guide_message');
  if (extra && !ids.includes(extra)) {
    const m = await ch.messages.fetch(extra).catch(() => undefined);
    if (m && m.author.id === me) await m.delete().catch(() => undefined);
    store.setSetting('artwork_guide_message', '');
  }
  const others = recent ? [...recent.values()].filter((m) => m.author.id !== me).length : 0;
  return `Artwork guide (4 posts) up to date in #${ch.name}.${others ? ` ${others} message(s) by others left alone.` : ''}`;
}
