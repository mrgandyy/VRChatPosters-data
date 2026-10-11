// Artwork submitted from the website (posters, billboard, backdrop). Goes through exactly the same
// checks, storage and Discord review card as /poster, /billboard and /backdrop, so reviewers see
// one queue whichever way the art arrived. Decisions can be made in Discord or on the website.
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import type { Store } from './db.js';
import { MAX_SOURCE_BYTES, saveSource } from './atlas.js';
import { decideBillboard, submitBillboard } from './billboard.js';
import { decideBackdrop, submitBackdrop } from './backdrop.js';
import { assertSlot } from './types.js';
import { slotInfo } from './slots.js';

export type ArtKind = 'poster' | 'billboard' | 'backdrop';
const BUTTONS: Record<ArtKind, [string, string]> = {
  poster: ['approve', 'reject'], billboard: ['bannerapprove', 'bannerreject'], backdrop: ['backdropapprove', 'backdropreject'],
};
/** Which kind a review button belongs to, from its action. */
export function kindOfAction(action: string): { kind: ArtKind; approve: boolean } | undefined {
  for (const kind of Object.keys(BUTTONS) as ArtKind[]) {
    const [yes, no] = BUTTONS[kind];
    if (action === yes || action === no) return { kind, approve: action === yes };
  }
  return undefined;
}

export interface ArtDeps {
  store: Store;
  dataDir: string;
  client: Client;
  guildId: string;
  auditLog: (guild: Guild | null, message: string) => Promise<void>;
}

export function createArt(d: ArtDeps) {
  const { store } = d;
  const guild = () => d.client.guilds.cache.get(d.guildId) ?? null;

  function approvals(): TextChannel {
    const ch = guild()?.channels.cache.get(store.setting('approval_channel') ?? '');
    if (!ch || ch.type !== ChannelType.GuildText) throw new Error('The approval channel is not configured in Discord (/ws-setup).');
    return ch as TextChannel;
  }

  /** Checks, stores and queues one image for review; posts the review card. Returns the review number. */
  async function submit(kind: ArtKind, groupId: number, slot: number | null, userId: string, bytes: Buffer, uploadId?: string): Promise<number> {
    const group = store.group(groupId);
    if (!group || groupId === 0) throw new Error('That group is not in the catalog.');
    if (!group.enabled) throw new Error('That group is suspended.');
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Image is over 12 MB.');
    if (kind !== 'poster' && group.tier !== 'premium') throw new Error(`The ${kind} is a Premium feature.`);
    if (kind === 'poster') assertSlot(group.tier, slot ?? 0);
    const channel = approvals();
    const paths = await saveSource(bytes, d.dataDir);
    let id: number, content: string;
    const files = [new AttachmentBuilder(paths.previewPath, { name: 'proposed.png' })];
    if (kind === 'poster') {
      const s = store.submit(groupId, slot!, userId, paths.sourcePath, paths.previewPath);
      id = s.id;
      const prior = s.previousId ? store.submission(s.previousId) : undefined;
      if (prior) files.push(new AttachmentBuilder(prior.previewPath, { name: 'previous.png' }));
      content = `**Poster #${id}** · ${group.name} · poster ${slot} (${slotInfo(slot!)?.where ?? '?'})\nSubmitted by <@${userId}> on the website. ${prior ? `Previous approved poster: #${prior.id}.` : 'Previous: default artwork.'}`;
    } else if (kind === 'billboard') {
      id = submitBillboard(store, groupId, userId, paths.sourcePath, paths.previewPath);
      content = `Billboard #${id} for ${group.name}. Wide 4:1 entrance banner. Submitted by <@${userId}> on the website.`;
    } else {
      id = submitBackdrop(store, groupId, userId, paths.sourcePath, paths.previewPath);
      content = `Backdrop #${id} for ${group.name}. 4:3 photo wall backdrop. Submitted by <@${userId}> on the website.`;
    }
    const [yes, no] = BUTTONS[kind];
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ws:${yes}:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ws:${no}:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
    const msg = await channel.send({ content, files, components: [row], allowedMentions: { parse: [] } });
    store.setSetting(`review-msg:${kind}:${id}`, `${channel.id}/${msg.id}`);
    if (uploadId) store.setSetting(`web-upload:${kind}:${id}`, uploadId);
    await d.auditLog(guild(), `${kind[0]!.toUpperCase()}${kind.slice(1)} #${id} for ${group.name} submitted on the website by <@${userId}>.`);
    return id;
  }

  /** Approve or reject from the website; the Discord review card is updated to match. */
  async function decide(kind: ArtKind, id: number, approve: boolean, by: string): Promise<void> {
    if (kind === 'poster') store.decide(id, by, approve);
    else if (kind === 'billboard') decideBillboard(store, id, by, approve);
    else decideBackdrop(store, id, by, approve);
    const where = store.setting(`review-msg:${kind}:${id}`);
    if (where) {
      const [channelId, messageId] = where.split('/');
      const ch = guild()?.channels.cache.get(channelId!);
      if (ch?.type === ChannelType.GuildText) {
        const msg = await (ch as TextChannel).messages.fetch(messageId!).catch(() => undefined);
        await msg?.edit({ content: `${msg.content}\n**${approve ? 'APPROVED' : 'REJECTED'}** by <@${by}> on the website`, components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
      }
    }
    await d.auditLog(guild(), `${kind[0]!.toUpperCase()}${kind.slice(1)} #${id} ${approve ? 'approved' : 'rejected'} by <@${by}> on the website.`);
  }

  /** The website upload behind a review, if it came from the website. */
  const uploadFor = (kind: ArtKind, id: number) => store.setting(`web-upload:${kind}:${id}`);

  /** Current state of one review: who sent it, which group, and its status. */
  function reviewOf(kind: ArtKind, id: number): { groupId: number; submitter: string; status: string; slot: number | null } | undefined {
    if (kind === 'poster') {
      const s = store.submission(id);
      return s ? { groupId: s.groupId, submitter: s.submitterId, status: s.status, slot: s.slot } : undefined;
    }
    const row = store.db.prepare(`SELECT groupId, submitter, status FROM ${kind === 'billboard' ? 'billboards' : 'backdrops'} WHERE id=?`).get(id) as
      { groupId: number; submitter: string; status: string } | undefined;
    return row ? { ...row, slot: null } : undefined;
  }

  return { submit, decide, uploadFor, reviewOf };
}
export type Art = ReturnType<typeof createArt>;
