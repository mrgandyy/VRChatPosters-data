// FBT Social features: welcome + Start Here panel, one-tap verification, Premium/Headliner
// applications with staff review, events and collabs. The website (fbt-social-web on Railway)
// holds events, collabs and applications; this bot is the Discord front door to all of it.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, LabelBuilder, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Guild,
  type GuildMember, type ModalSubmitInteraction, type TextChannel, type User,
} from 'discord.js';
import type { Store } from './db.js';
import { normalizeGroupLink, validateGroupName } from './group-link.js';
import { groupVerified, siteBytes, sitePost, siteEnabled, statusLabel, syncGroups, type OutboxFailure, type OutboxItem, type SiteConfig } from './fbt-site.js';
import { applyAdmin, setLevel, type AdminAction } from './fbt-admin.js';
import { findTierRoles, levelFor, planRoles } from './fbt-roles.js';
import { discordTime, parseWhen, TIMEZONES } from './fbt-time.js';
import type { Group } from './types.js';
import type { Art, ArtKind } from './fbt-art.js';
import { channelInventory, deleteChannel, ensureArtworkGuide, postAnnouncement } from './fbt-discord.js';
import { deactivateForInactivity, demoteDm, demoteForAge, premiumWelcome } from './fbt-rules.js';
import { removeLocker, renameLocker } from './locker.js';

const EPHEMERAL = 64; // MessageFlags.Ephemeral
const RULES_VERSION = 'vrchat-rules-v1';
const ROSE = 0xe8507a, BRONZE = 0xb98a4e, EMERALD = 0x2fbf83, GOLD = 0xf2c94c;

export interface FbtDeps {
  client: Client;
  store: Store;
  guildId: string;
  site: SiteConfig;
  publicUrl: string;
  welcome: boolean;
  isAdmin: (i: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction) => boolean;
  auditLog: (guild: Guild | null, message: string) => Promise<void>;
  /** Artwork reviews (posters, billboard, backdrop) shared with the slash commands. */
  art?: Art;
}

type Reply = ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction;
type Whois = { mine: { id: number; name: string; status: string }[]; partners: { id: number; name: string }[] };

export function createFbt(d: FbtDeps) {
  const { store } = d;
  const url = (path: string) => `${d.publicUrl.replace(/\/$/, '')}${path}`;
  const groupOf = (userId: string): Group | undefined => store.representedGroups(userId)[0];
  const tzOf = (userId: string) => store.setting(`fbt-tz-${userId}`);

  // ── Website sync ─────────────────────────────────────────────────────────────────────────
  let syncTimer: NodeJS.Timeout | undefined;
  // One scan of the member list feeds both the website's staff list and the Verified-role rule.
  let scan: { at: number; staff: string[]; verified: Set<string> } | undefined;
  let roleNote = '';
  /** The verify bot's role: setting fbt_verified_role, else a role named "Verified". */
  function verifiedRoleId(guild: Guild): string | undefined {
    const set = store.setting('fbt_verified_role');
    if (set && guild.roles.cache.has(set)) return set;
    const roles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id);
    const role = roles.find(r => /^verified$/i.test(r.name.trim()))
      ?? roles.find(r => /\bverified\b/i.test(r.name) && !/un-?verified|not verified|pending/i.test(r.name));
    return role?.id;
  }
  async function memberScan(): Promise<typeof scan> {
    const guild = d.client.guilds.cache.get(d.guildId);
    if (!guild) return scan;
    if (scan && Date.now() - scan.at < 10 * 60_000) return scan;
    const adminRole = store.setting('admin_role');
    const staff = new Set<string>([guild.ownerId]);
    const verified = new Set<string>();
    const roleId = verifiedRoleId(guild);
    try {
      // The full member list needs the Server Members intent, which is on while welcomes are on.
      const members = d.welcome ? await guild.members.fetch() : guild.members.cache;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        if (m.permissions.has(PermissionFlagsBits.ManageGuild) || (adminRole && m.roles.cache.has(adminRole))) staff.add(m.id);
        if (roleId && m.roles.cache.has(roleId)) verified.add(m.id);
      }
    } catch (error) {
      console.error('Member scan for the website fell back to cached members:', error);
    }
    const note = roleId ? `Verified role "${guild.roles.cache.get(roleId)?.name}": ${verified.size} members` : 'No Verified role found (set fbt_verified_role)';
    if (note !== roleNote) { roleNote = note; console.log(note); }
    scan = { at: Date.now(), staff: [...staff], verified };
    return scan;
  }
  /** Server owner, members who can Manage Server, and the bot's admin role: staff on the website. */
  async function staffIds(): Promise<string[] | undefined> {
    return (await memberScan())?.staff;
  }
  /** Everyone holding the Verified role right now (the member cache follows role changes live). */
  function currentVerified(): Set<string> {
    const guild = d.client.guilds.cache.get(d.guildId);
    const roleId = guild && verifiedRoleId(guild);
    const out = new Set<string>(scan?.verified ?? []);
    if (guild && roleId) for (const m of guild.members.cache.values()) if (m.roles.cache.has(roleId)) out.add(m.id); else out.delete(m.id);
    return out;
  }
  /** A group is verified when one of its reps has the Discord Verified role, or the old link + rules way. */
  function verifiedGroup(g: Group): boolean {
    return groupVerified(g, store.representatives(g.id), currentVerified());
  }
  // ── Tier roles: reps wear their group's level in Discord ─────────────────────────────────
  let rolesNote = '';
  async function syncTierRoles(): Promise<void> {
    const guild = d.client.guilds.cache.get(d.guildId);
    if (!guild) return;
    const roles = findTierRoles([...guild.roles.cache.values()].map(r => ({ id: r.id, name: r.name })), (k) => store.setting(k));
    const note = `Tier roles: ${(['headliner', 'premium', 'standard'] as const).map(l => `${l}=${roles[l] ? `"${guild.roles.cache.get(roles[l]!)?.name}"` : 'missing'}`).join(', ')}`;
    if (note !== rolesNote) { rolesNote = note; console.log(note); }
    if (!roles.headliner && !roles.premium && !roles.standard) return;
    const verified = currentVerified();
    const desired = new Map<string, ReturnType<typeof levelFor>>();
    for (const g of store.groups()) {
      if (g.id === 0 || !g.enabled) continue;
      const reps = store.representatives(g.id);
      const level = levelFor(g, groupVerified(g, reps, verified));
      for (const u of reps) desired.set(u, level);
    }
    const changes = planRoles(desired, roles, (u) => {
      const m = guild.members.cache.get(u);
      return m ? new Set(m.roles.cache.keys()) : undefined;
    });
    let done = 0;
    for (const c of changes.slice(0, 25)) {
      const m = guild.members.cache.get(c.userId);
      if (!m) continue;
      try {
        if (c.add.length) await m.roles.add(c.add, 'FBT Social: group tier');
        if (c.remove.length) await m.roles.remove(c.remove, 'FBT Social: group tier changed');
        done++;
      } catch (e) { console.error(`Couldn't update tier roles for ${c.userId}:`, e instanceof Error ? e.message : e); }
    }
    if (done) console.log(`Tier roles updated for ${done} rep(s)${changes.length > 25 ? `, ${changes.length - 25} more next round` : ''}.`);
  }

  /** Display names of representatives the bot can see, so the website shows names, not ids. */
  function memberNames(): Map<string, string> {
    const guild = d.client.guilds.cache.get(d.guildId);
    const names = new Map<string, string>();
    for (const g of store.groups()) for (const id of store.representatives(g.id)) {
      const name = guild?.members.cache.get(id)?.displayName ?? d.client.users.cache.get(id)?.username;
      if (name) names.set(id, name);
    }
    return names;
  }
  /** "@name", a name or an id → a Discord id of someone in the server. */
  async function resolveUser(q: string): Promise<string> {
    const text = q.trim().replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '');
    if (/^\d{5,25}$/.test(text)) return text;
    const guild = d.client.guilds.cache.get(d.guildId);
    if (!guild || !text) throw new Error('Give their Discord id or exact username.');
    const found = await guild.members.search({ query: text, limit: 5 });
    const exact = [...found.values()].filter(m => [m.user.username, m.displayName, m.user.globalName].some(n => n?.toLowerCase() === text.toLowerCase()));
    const pick = exact.length === 1 ? exact[0] : found.size === 1 ? found.first() : undefined;
    if (!pick) throw new Error(found.size ? `"${text}" matches more than one member. Use their exact username or id.` : `No member named "${text}" in the server.`);
    return pick.id;
  }
  function scheduleSync(delayMs = 4000) {
    if (!siteEnabled(d.site)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      const guild = d.client.guilds.cache.get(d.guildId);
      const verified = currentVerified();
      // Only send the member list once it's complete (the member scan fetches everyone).
      const people = guild && scan && guild.members.cache.size >= Math.min(guild.memberCount, 20000) * 0.95
        ? { members: [...guild.members.cache.keys()], verified: [...verified] } : undefined;
      const r = await syncGroups(store, d.site, await staffIds().catch(() => undefined), memberNames(), verified, people);
      await syncTierRoles().catch((e) => console.error('Tier role sync failed:', e));
      if (!r.ok) console.error('Website group sync failed:', r.error);
    }, delayMs);
  }

  const whoisCache = new Map<string, { at: number; data: Whois }>();
  async function whois(userId: string): Promise<Whois> {
    const hit = whoisCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const r = await sitePost<Whois>(d.site, '/api/bot/whois', { actor: userId });
    const data = r.ok ? r.data : { mine: [], partners: [] };
    whoisCache.set(userId, { at: Date.now(), data });
    return data;
  }

  // ── Channels ─────────────────────────────────────────────────────────────────────────────
  async function ensureChannel(guild: Guild, key: string, name: string, readOnly: boolean): Promise<TextChannel> {
    const saved = store.setting(key);
    const existing = (saved && guild.channels.cache.get(saved)) ||
      guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
    if (existing?.type === ChannelType.GuildText) { store.setSetting(key, existing.id); return existing as TextChannel; }
    const created = await guild.channels.create({
      name, type: ChannelType.GuildText,
      permissionOverwrites: readOnly ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
        { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
      ] : undefined,
    });
    store.setSetting(key, created.id);
    return created;
  }
  const channel = (key: string): TextChannel | undefined => {
    const id = store.setting(key);
    const c = id ? d.client.guilds.cache.get(d.guildId)?.channels.cache.get(id) : undefined;
    return c?.type === ChannelType.GuildText ? c as TextChannel : undefined;
  };

  // ── The Start Here panel ─────────────────────────────────────────────────────────────────
  function startEmbed() {
    return new EmbedBuilder().setColor(ROSE).setTitle('Welcome to FBT Social')
      .setDescription([
        'Any club can host at FBT Social. Every club gets its own building on **The Strip**, and the bigger your crowd, the brighter it burns.',
        '',
        '**1 · Get the Verified role:** run our verify bot. Verified members can register a club and host.',
        '**2 · Register your club:** free, one minute. You get a club number and a door code for the world.',
        '**3 · Make it yours:** posters, logo, banner, gallery and your colour. Sign in at fbtsocial.com and open **My dashboard** (top right): it\'s your club\'s control panel.',
        '**4 · Host a night:** post it and it\'s announced here and lit up on the Strip. Crowds earn heat for the season.',
        '**5 · Collab:** team up with another club and you both earn the night\'s heat, plus a bonus.',
        '**6 · Premium or Headliner:** apply any time. Premium clubs run **age-verified (18+) rooms** and let our tracker **fbtheat** into their VRChat group.',
        '',
        '**Season 1 · Founders** runs Oct 12–31: every club that earns heat keeps a **Founding Venue** badge for good.',
        'Just here to party? Find tonight\'s nights on the Strip.',
      ].join('\n'))
      .setURL(url('/start'));
  }
  function startRows() {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('fbt:reg').setLabel('Register my group').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fbt:verify').setLabel('Get verified').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fbt:apply').setLabel('Apply: Premium / Headliner').setStyle(ButtonStyle.Secondary)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('fbt:host').setLabel('Host a night').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fbt:collab').setLabel('Start a collab').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('fbt:posters').setLabel('Posters & billboards').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('The Strip').setStyle(ButtonStyle.Link).setURL(url('/'))),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('My dashboard').setStyle(ButtonStyle.Link).setURL(url('/me')),
        new ButtonBuilder().setLabel('Leaderboard').setStyle(ButtonStyle.Link).setURL(url('/leaderboard')),
        new ButtonBuilder().setLabel('Dancers & DJs').setStyle(ButtonStyle.Link).setURL(url('/join'))),
    ];
  }

  async function onReady(guild: Guild): Promise<void> {
    await Promise.all([guild.channels.fetch(), guild.members.fetchMe()]);
    const start = await ensureChannel(guild, 'fbt_start_channel', 'start-here', true);
    await ensureChannel(guild, 'fbt_events_channel', 'fbt-events', true);
    const panel = { embeds: [startEmbed()], components: startRows() };
    const old = store.setting('fbt_start_panel');
    const msg = old ? await start.messages.fetch(old).catch(() => undefined) : undefined;
    if (msg) await msg.edit(panel);
    else store.setSetting('fbt_start_panel', (await start.send(panel)).id);
    console.log(await ensureArtworkGuide(guild, store, d.publicUrl).catch(e => `Artwork guide failed: ${e.message}`));
    scheduleSync(1000);
  }

  // ── Welcome ──────────────────────────────────────────────────────────────────────────────
  async function onMemberAdd(member: GuildMember): Promise<void> {
    if (!d.welcome || member.user.bot || member.guild.id !== d.guildId) return;
    const start = channel('fbt_start_channel');
    const where = member.guild.systemChannel ?? start;
    if (where) await where.send({
      content: `Welcome to FBT Social, <@${member.id}>! Head to ${start ? `<#${start.id}>` : 'the start-here channel'} to register your group, host a night, or find tonight's parties.`,
      allowedMentions: { users: [member.id] },
    }).catch(e => console.error('Welcome post failed:', e));
    const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('fbt:reg').setLabel('Register my group').setStyle(ButtonStyle.Primary),
      ...(start ? [new ButtonBuilder().setLabel('Open start-here').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${member.guild.id}/${start.id}`)] : []),
      new ButtonBuilder().setLabel('The Strip').setStyle(ButtonStyle.Link).setURL(url('/start')))];
    await member.send({ embeds: [startEmbed()], components: rows }).catch(() => undefined); // closed DMs are fine
  }

  // ── Small helpers ────────────────────────────────────────────────────────────────────────
  const say = (i: Reply, content: string, components: ActionRowBuilder<ButtonBuilder>[] = []) =>
    (i.deferred || i.replied ? i.editReply({ content, components }) : i.reply({ content, components, flags: EPHEMERAL }));
  const linkRow = (...links: [string, string][]) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(links.map(([label, href]) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(href)));
  const textInput = (id: string, label: string, style: TextInputStyle, opts: { required?: boolean; max?: number; min?: number; placeholder?: string; value?: string } = {}) => {
    const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(opts.required ?? true);
    if (opts.max) input.setMaxLength(opts.max);
    if (opts.min) input.setMinLength(opts.min);
    if (opts.placeholder) input.setPlaceholder(opts.placeholder);
    if (opts.value) input.setValue(opts.value);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
  };

  function verifyStatus(g: Group) {
    const linked = Boolean(g.vrchatUrl), rules = Boolean(g.agreementVersion);
    const lines = [
      `**${g.name}** (#${g.id}) · ${statusLabel(g, verifiedGroup(g))}`,
      '',
      `✅ Registered · your code is \`${g.code}\``,
      `${linked ? '✅' : '⬜'} VRChat group linked${linked ? '' : ': paste your VRChat group page link'}`,
      `${rules ? '✅' : '⬜'} Hosting rules accepted`,
      '',
      verifiedGroup(g)
        ? `You're **verified**. Your resort gets bronze trim on the Strip, and collabs are unlocked.${linked ? '' : ' Link your VRChat group too: it adds the Join button in the world and lets us count your group rooms.'}`
        : 'Get the **Verified** role from the verify bot, or finish both steps above. Either way it\'s instant.',
    ];
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (!linked) row.addComponents(new ButtonBuilder().setCustomId('fbt:link').setLabel('Link VRChat group').setStyle(ButtonStyle.Primary));
    if (!rules) row.addComponents(new ButtonBuilder().setCustomId('fbt:rules').setLabel('Read & accept hosting rules').setStyle(ButtonStyle.Primary));
    if (verifiedGroup(g)) row.addComponents(new ButtonBuilder().setCustomId('fbt:apply').setLabel('Apply: Premium / Headliner').setStyle(ButtonStyle.Secondary));
    return { content: lines.join('\n'), components: row.components.length ? [row] : [] };
  }

  function needGroup(i: Reply): boolean {
    if (groupOf(i.user.id)) return false;
    void say(i, 'You don\'t represent a group yet. Register one first; it takes a minute.', [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('fbt:reg').setLabel('Register my group').setStyle(ButtonStyle.Primary))]);
    return true;
  }

  function applyChoices(g: Group) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (g.tier !== 'premium') row.addComponents(new ButtonBuilder().setCustomId('fbt:applyp').setLabel('Apply for Premium').setStyle(ButtonStyle.Success));
    if (g.level !== 'headliner') row.addComponents(new ButtonBuilder().setCustomId('fbt:applyh').setLabel('Apply for Headliner').setStyle(ButtonStyle.Primary));
    row.addComponents(new ButtonBuilder().setLabel('What you get').setStyle(ButtonStyle.Link).setURL(url('/apply')));
    return row;
  }

  function applyModal(level: 'premium' | 'headliner') {
    return new ModalBuilder().setCustomId(`fbt:applym:${level}`).setTitle(level === 'premium' ? 'Apply for Premium' : 'Apply for Headliner')
      .addLabelComponents(
        textInput('about', 'Your group and your nights', TextInputStyle.Paragraph, { min: 20, max: 800, placeholder: 'What kind of nights you throw, who\'s on your team' }),
        textInput('schedule', 'How often you host', TextInputStyle.Short, { max: 200, placeholder: 'Every Friday and Saturday' }),
        textInput('crowd', 'Typical crowd', TextInputStyle.Short, { max: 100, placeholder: '30–50 people' }),
        textInput('links', 'Links (optional)', TextInputStyle.Short, { required: false, max: 300, placeholder: 'Socials, VRChat group' }),
        textInput('agree', 'Type AGREE: we run 18+ age-verified rooms', TextInputStyle.Short, { min: 5, max: 5, placeholder: 'AGREE (and we let fbtheat into our VRChat group)' }));
  }

  // ── Buttons ──────────────────────────────────────────────────────────────────────────────
  async function handleButton(i: ButtonInteraction): Promise<boolean> {
    const [prefix, action, arg] = i.customId.split(':');
    if (prefix !== 'fbt') return false;
    const g = groupOf(i.user.id);
    switch (action) {
      case 'reg': {
        if (g) { await i.reply({ ...verifyStatus(g), flags: EPHEMERAL }); return true; }
        await i.showModal(new ModalBuilder().setCustomId('fbt:regm').setTitle('Register your group').addLabelComponents(
          textInput('name', 'Group name (the real name, not a link)', TextInputStyle.Short, { max: 80 }),
          textInput('vrc', 'VRChat group link or grp_ ID (optional)', TextInputStyle.Short, { required: false, max: 200, placeholder: 'https://vrchat.com/home/group/grp_…' })));
        return true;
      }
      case 'verify':
        if (needGroup(i)) return true;
        await i.reply({ ...verifyStatus(g!), flags: EPHEMERAL });
        return true;
      case 'link':
        if (needGroup(i)) return true;
        await i.showModal(new ModalBuilder().setCustomId('fbt:linkm').setTitle('Link your VRChat group').addLabelComponents(
          textInput('vrc', 'VRChat group page link or grp_ ID', TextInputStyle.Short, { max: 200, placeholder: 'https://vrchat.com/home/group/grp_…' })));
        return true;
      case 'rules':
        if (needGroup(i)) return true;
        await i.reply({
          content: [
            '**FBT Social hosting rules**',
            '• Follow VRChat\'s Terms of Service and Community Guidelines at every event you host here.',
            '• FBT Social is an 18+ venue. Run your nights accordingly.',
            '• Handle problems with VRChat\'s own moderation and reporting tools.',
            '• Your posters and billboards are reviewed by staff before they go live.',
            '',
            'This is an agreement, not age verification.',
          ].join('\n'),
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('fbt:rulesok').setLabel('I agree').setStyle(ButtonStyle.Success))],
          flags: EPHEMERAL,
        });
        return true;
      case 'rulesok':
        if (needGroup(i)) return true;
        store.acceptAgreement(g!.id, RULES_VERSION, i.user.id);
        scheduleSync();
        await i.update(verifyStatus(store.group(g!.id)!));
        await d.auditLog(i.guild, `Group #${g!.id} accepted the hosting rules (<@${i.user.id}>).`);
        return true;
      case 'apply':
        if (needGroup(i)) return true;
        if (!verifiedGroup(g!)) { await i.reply({ ...verifyStatus(g!), flags: EPHEMERAL }); return true; }
        if (g!.level === 'headliner') { await say(i, `${g!.name} is already a Headliner. Nothing to apply for.`); return true; }
        await i.reply({ content: 'Apply any time. Staff review it here in Discord, and I\'ll DM you the answer.', components: [applyChoices(g!)], flags: EPHEMERAL });
        return true;
      case 'applyp': case 'applyh':
        if (needGroup(i)) return true;
        await i.showModal(applyModal(action === 'applyp' ? 'premium' : 'headliner'));
        return true;
      case 'host':
        await say(i, 'Post your event on the website (easiest), or here with `/event create`. It shows up on the Strip\'s Coming Up view and gets announced in Discord.',
          [linkRow(['Host a night', url('/host')])]);
        return true;
      case 'collab':
        await say(i, 'Start a collab on the website, or here with `/collab start`. The other group confirms with one tap, and you both earn the night\'s heat in full, plus a bonus. Works before the night or up to 24 hours after.',
          [linkRow(['Collabs', url('/collabs')])]);
        return true;
      case 'posters':
        await say(i, 'Every registered group gets posters 1–11, at the entrance and in the arrival hall; Premium gets all 32 (the whole club), plus an entrance billboard, a photo-wall backdrop and a DJ booth front. Use `/poster submit` (one image) or `/poster batch` (up to eight); `/poster map` shows where each number is. Posters: portrait 2:3, ideally 1024 × 1536. Billboard: 2048 × 512. Backdrop: 2048 × 1536. DJ booth front: 2400 × 400 (upload it on the website, template included). Dancers can upload their own locker (500 × 700) on the website too. Staff review everything before it goes live. `/ws-help` has the details.');
        return true;
      case 'cy': case 'cn': {
        await i.deferUpdate();
        const r = await sitePost<{ status: string; title: string }>(d.site, '/api/bot/collab', { action: action === 'cy' ? 'accept' : 'decline', actor: i.user.id, collabId: arg });
        const line = !r.ok ? `⚠️ ${r.error}` : r.data.status === 'confirmed' ? '✅ **Accepted. The collab is on.** You both earn the night\'s heat.' :
          r.data.status === 'declined' ? 'Declined. They\'ve been told.' : '✅ Accepted. Waiting on the other groups.';
        await i.editReply({ content: `${i.message.content}\n\n${line}`, components: r.ok ? [] : i.message.components });
        return true;
      }
      case 'appok': case 'appno': {
        if (!d.isAdmin(i)) { await say(i, 'Only Wreckshop admins can decide applications.'); return true; }
        if (action === 'appno') {
          await i.showModal(new ModalBuilder().setCustomId(`fbt:appnom:${arg}`).setTitle('Decline application').addLabelComponents(
            textInput('note', 'Note for the applicant (optional)', TextInputStyle.Paragraph, { required: false, max: 500, placeholder: 'What would help them next time' })));
          return true;
        }
        await i.deferUpdate();
        await decideApplication(i, Number(arg), true);
        return true;
      }
    }
    return false;
  }

  async function decideApplication(i: ButtonInteraction | ModalSubmitInteraction, id: number, approve: boolean, note?: string) {
    const r = await sitePost<{ groupId: number; level: string; applicant: string; groupName: string }>(d.site, '/api/bot/decision', { applicationId: id, approve, by: i.user.id, note });
    if (!r.ok) { await i.followUp({ content: r.error, flags: EPHEMERAL }); return; }
    const { groupId, level, applicant, groupName } = r.data;
    if (approve) {
      if (!store.group(groupId)) { await i.followUp({ content: `Group #${groupId} no longer exists here.`, flags: EPHEMERAL }); return; }
      setLevel(store, groupId, level === 'headliner' ? 'headliner' : 'premium');
      scheduleSync();
    }
    const verdict = approve ? `**APPROVED** by <@${i.user.id}>` : `**DECLINED** by <@${i.user.id}>${note ? ` · "${note}"` : ''}`;
    if (i.message) await i.message.edit({ content: `${i.message.content ?? ''}\n${verdict}`.trim(), components: [] }).catch(() => undefined);
    await d.auditLog(i.guild, `Application #${id} (${groupName}, ${level}) ${approve ? 'approved' : 'declined'} by <@${i.user.id}>.`);
    const label = level === 'headliner' ? 'Headliner' : 'Premium';
    if (approve) await sendWelcome(applicant, groupId, groupName, level);
    else await dm(applicant, `Your ${label} application for **${groupName}** wasn't approved this time.${note ? `\nStaff note: ${note}` : ''}\nYou can apply again in 14 days. Keep hosting: consistent nights count the most.`);
  }

  // ── Modals ───────────────────────────────────────────────────────────────────────────────
  async function handleModal(i: ModalSubmitInteraction): Promise<boolean> {
    const [prefix, action, arg] = i.customId.split(':');
    if (prefix !== 'fbt') return false;
    const v = (id: string) => { try { return i.fields.getTextInputValue(id).trim(); } catch { return ''; } };
    if (action === 'regm') {
      const name = validateGroupName(v('name'));
      const vrc = v('vrc') || undefined;
      const g = store.registerGroup(name, 'standard', vrc, i.user.id);
      store.setSetting(`representative-name-${i.user.id}`, '@' + i.user.username);
      store.queuePublish(g.id);
      scheduleSync();
      await d.auditLog(i.guild ?? d.client.guilds.cache.get(d.guildId) ?? null, `Group #${g.id} ${g.name} registered by <@${i.user.id}> from the Start Here panel.`);
      const status = verifyStatus(g);
      await i.reply({ content: `🎉 **${g.name}** is registered as group #${g.id}.\n\n${status.content}`, components: status.components, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'linkm') {
      const g = groupOf(i.user.id);
      if (!g) throw new Error('You don\'t represent a group yet.');
      store.setUrl(g.id, normalizeGroupLink(v('vrc')));
      scheduleSync();
      const status = verifyStatus(store.group(g.id)!);
      if (i.isFromMessage()) await i.update(status); else await i.reply({ ...status, flags: EPHEMERAL });
      return true;
    }
    if (action === 'applym') {
      const g = groupOf(i.user.id);
      if (!g) throw new Error('You don\'t represent a group yet.');
      if (v('agree').trim().toUpperCase() !== 'AGREE') throw new Error('Premium clubs run age-verified (18+) instances and let fbtheat into their VRChat group. Type AGREE in the last box to apply.');
      await i.deferReply({ flags: EPHEMERAL });
      scheduleSync(0);
      await new Promise(r => setTimeout(r, 1500)); // let the website see the latest verification first
      const r = await sitePost(d.site, '/api/bot/apply', {
        actor: i.user.id, group: g.id, level: arg, about: v('about'), schedule: v('schedule'), crowd: v('crowd'), links: v('links'),
        ageAgree: v('agree').trim().toUpperCase() === 'AGREE',
      });
      await i.editReply(r.ok ? 'Application sent. Staff review it here in Discord, and I\'ll DM you the answer.' : `⚠️ ${r.error}`);
      return true;
    }
    if (action === 'appnom') {
      if (!d.isAdmin(i)) throw new Error('Only Wreckshop admins can decide applications.');
      await i.deferUpdate();
      await decideApplication(i, Number(arg), false, v('note') || undefined);
      return true;
    }
    return false;
  }

  // ── Slash commands ───────────────────────────────────────────────────────────────────────
  const tzOption = (o: import('discord.js').SlashCommandStringOption) =>
    o.setName('timezone').setDescription('Your time zone (remembered after the first time)').addChoices(...TIMEZONES);
  const commands = [
    new SlashCommandBuilder().setName('start').setDescription('New here? Register, get verified, host and collab'),
    new SlashCommandBuilder().setName('apply').setDescription('Apply for Premium or Headliner')
      .addStringOption(o => o.setName('level').setDescription('What you are applying for').setRequired(true)
        .addChoices({ name: 'Premium', value: 'premium' }, { name: 'Headliner', value: 'headliner' })),
    new SlashCommandBuilder().setName('event').setDescription('Your group\'s events on the Strip')
      .addSubcommand(s => s.setName('create').setDescription('Post an event (announced here and on the Strip)')
        .addStringOption(o => o.setName('title').setDescription('Show name').setRequired(true).setMaxLength(60))
        .addStringOption(o => o.setName('date').setDescription('friday, tomorrow, 10/17 …').setRequired(true).setMaxLength(20))
        .addStringOption(o => o.setName('time').setDescription('9pm, 21:00 …').setRequired(true).setMaxLength(10))
        .addIntegerOption(o => o.setName('hours').setDescription('How long (default 4)').setMinValue(1).setMaxValue(12))
        .addStringOption(tzOption)
        .addIntegerOption(o => o.setName('partner').setDescription('Collab partner group (optional)').setAutocomplete(true))
        .addStringOption(o => o.setName('description').setDescription('DJs, dress code, who\'s dancing').setMaxLength(500)))
      .addSubcommand(s => s.setName('list').setDescription('Your upcoming events'))
      .addSubcommand(s => s.setName('cancel').setDescription('Cancel one of your events')
        .addStringOption(o => o.setName('event').setDescription('Which event').setRequired(true).setAutocomplete(true))),
    new SlashCommandBuilder().setName('collab').setDescription('Team up with another group: both earn the night\'s heat')
      .addSubcommand(s => s.setName('start').setDescription('Ask another group to collab (before the night or up to 24h after)')
        .addIntegerOption(o => o.setName('partner').setDescription('Partner group').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('date').setDescription('friday, tomorrow, 10/17 …').setRequired(true).setMaxLength(20))
        .addStringOption(o => o.setName('time').setDescription('9pm, 21:00 …').setRequired(true).setMaxLength(10))
        .addIntegerOption(o => o.setName('hours').setDescription('How long (default 4)').setMinValue(1).setMaxValue(12))
        .addStringOption(tzOption)
        .addStringOption(o => o.setName('title').setDescription('Show name (optional)').setMaxLength(60)))
      .addSubcommand(s => s.setName('list').setDescription('Your collabs, with Accept buttons for requests')),
  ];

  function resolveWhen(i: ChatInputCommandInteraction): { start: number; end: number } | string {
    const tz = i.options.getString('timezone') ?? tzOf(i.user.id);
    if (!tz) return 'Pick your time zone once with the `timezone` option. I\'ll remember it after that.';
    store.setSetting(`fbt-tz-${i.user.id}`, tz);
    const at = parseWhen(i.options.getString('date', true), i.options.getString('time', true), tz);
    if (typeof at === 'string') return at;
    return { start: at, end: at + (i.options.getInteger('hours') ?? 4) * 3600_000 };
  }

  async function handleCommand(i: ChatInputCommandInteraction): Promise<boolean> {
    if (i.commandName === 'start') {
      const g = groupOf(i.user.id);
      await i.reply({ embeds: [startEmbed()], components: startRows(), flags: EPHEMERAL });
      if (g) await i.followUp({ ...verifyStatus(g), flags: EPHEMERAL });
      return true;
    }
    if (i.commandName === 'apply') {
      const g = groupOf(i.user.id);
      if (!g) { await say(i, 'Register your group first with `/start` → Register my group.'); return true; }
      if (!verifiedGroup(g)) { await i.reply({ ...verifyStatus(g), flags: EPHEMERAL }); return true; }
      await i.showModal(applyModal(i.options.getString('level', true) as 'premium' | 'headliner'));
      return true;
    }
    if (i.commandName === 'event') {
      const sub = i.options.getSubcommand();
      const g = groupOf(i.user.id);
      if (!g) { await say(i, 'Register your group first with `/start` → Register my group.'); return true; }
      if (sub === 'create') {
        const when = resolveWhen(i);
        if (typeof when === 'string') { await say(i, when); return true; }
        await i.deferReply({ flags: EPHEMERAL });
        const partner = i.options.getInteger('partner');
        const r = await sitePost<{ id: string; collabId: string | null; collabError: string | null }>(d.site, '/api/bot/event', {
          action: 'create', actor: i.user.id, group: g.id, title: i.options.getString('title', true),
          description: i.options.getString('description') ?? '', start: new Date(when.start).toISOString(), end: new Date(when.end).toISOString(),
          partners: partner ? [partner] : [],
        });
        await i.editReply(!r.ok ? `⚠️ ${r.error}` : `Posted for ${discordTime(when.start)}. It'll be announced in the events channel and is on the Strip's Coming Up view.${
          r.data.collabError ? `\nThe collab request didn't go out: ${r.data.collabError}` : r.data.collabId ? '\nYour partner has been asked to confirm the collab.' : ''}`);
        return true;
      }
      if (sub === 'list') {
        const r = await sitePost<{ events: { id: string; title: string; startsAt: string; group: string }[] }>(d.site, '/api/bot/event', { action: 'list', actor: i.user.id });
        await say(i, !r.ok ? `⚠️ ${r.error}` : r.data.events.length ? r.data.events.map(e => `• **${e.title}** · ${discordTime(Date.parse(e.startsAt))}`).join('\n') : 'No upcoming events. Post one with `/event create`.');
        return true;
      }
      if (sub === 'cancel') {
        const r = await sitePost(d.site, '/api/bot/event', { action: 'cancel', actor: i.user.id, eventId: i.options.getString('event', true) });
        await say(i, r.ok ? 'Event cancelled. It\'s off the Strip and the events channel has been told.' : `⚠️ ${r.error}`);
        return true;
      }
    }
    if (i.commandName === 'collab') {
      const sub = i.options.getSubcommand();
      const g = groupOf(i.user.id);
      if (!g) { await say(i, 'Register your group first with `/start` → Register my group.'); return true; }
      if (sub === 'start') {
        if (!verifiedGroup(g)) { await i.reply({ ...verifyStatus(g), flags: EPHEMERAL }); return true; }
        const when = resolveWhen(i);
        if (typeof when === 'string') { await say(i, when); return true; }
        await i.deferReply({ flags: EPHEMERAL });
        const r = await sitePost(d.site, '/api/bot/collab', {
          action: 'propose', actor: i.user.id, group: g.id, partners: [i.options.getInteger('partner', true)],
          start: new Date(when.start).toISOString(), end: new Date(when.end).toISOString(), title: i.options.getString('title') ?? '',
        });
        await i.editReply(r.ok ? `Collab request sent for ${discordTime(when.start)}. Their representatives get a DM with Accept and Decline buttons.` : `⚠️ ${r.error}`);
        return true;
      }
      if (sub === 'list') {
        await i.deferReply({ flags: EPHEMERAL });
        const r = await sitePost<{ items: { id: string; status: string; title: string; windowStart: string; host: string; partners: string[]; needsMyAnswer: boolean }[] }>(d.site, '/api/bot/collab', { action: 'list', actor: i.user.id });
        if (!r.ok) { await i.editReply(`⚠️ ${r.error}`); return true; }
        const items = r.data.items.slice(0, 10);
        if (!items.length) { await i.editReply('No collabs yet. Start one with `/collab start`.'); return true; }
        const pending = items.filter(c => c.needsMyAnswer).slice(0, 2);
        await i.editReply({
          content: items.map(c => `• **${[c.host, ...c.partners].join(' × ')}** · ${c.title || 'Collab night'} · ${discordTime(Date.parse(c.windowStart), 'f')} · ${c.status}`).join('\n'),
          components: pending.map(c => new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`fbt:cy:${c.id}`).setLabel(`Accept ${c.host}`.slice(0, 80)).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`fbt:cn:${c.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger))),
        });
        return true;
      }
    }
    return false;
  }

  async function handleAutocomplete(i: AutocompleteInteraction): Promise<boolean> {
    if (!['event', 'collab'].includes(i.commandName)) return false;
    const focused = i.options.getFocused(true);
    const q = String(focused.value).toLowerCase();
    if (focused.name === 'partner') {
      const w = await whois(i.user.id);
      await i.respond(w.partners.filter(p => p.name.toLowerCase().includes(q)).slice(0, 25).map(p => ({ name: p.name.slice(0, 100), value: p.id })));
    } else if (focused.name === 'event') {
      const r = await sitePost<{ events: { id: string; title: string; startsAt: string }[] }>(d.site, '/api/bot/event', { action: 'list', actor: i.user.id });
      const list = r.ok ? r.data.events : [];
      await i.respond(list.filter(e => e.title.toLowerCase().includes(q)).slice(0, 25).map(e => ({
        name: `${e.title} · ${new Date(e.startsAt).toUTCString().slice(0, 22)} UTC`.slice(0, 100), value: e.id })));
    } else await i.respond([]);
    return true;
  }

  // ── Outbox: things the website asks the bot to do ────────────────────────────────────────
  async function dm(userId: string, payload: Parameters<User['send']>[0]): Promise<boolean> {
    const user = await d.client.users.fetch(userId).catch(() => undefined);
    return Boolean(user && await user.send(payload).catch(() => undefined));
  }

  const ART_NOUN: Record<ArtKind, string> = { poster: 'poster', billboard: 'billboard', backdrop: 'photo-wall backdrop', booth: 'DJ booth front', locker: 'dancer locker' };
  /** A review finished (in Discord or on the website): tell the website and the person who sent it. */
  async function artDecided(kind: ArtKind, id: number, approve: boolean, note?: string): Promise<void> {
    const uploadId = d.art?.uploadFor(kind, id);
    if (uploadId) await sitePost(d.site, '/api/bot/upload/status', { uploadId, status: approve ? 'approved' : 'rejected', reviewId: id, note: note ?? null });
    const r = d.art?.reviewOf(kind, id);
    if (r && uploadId && kind === 'locker') {
      await dm(r.submitter, approve
        ? `✅ Your dancer locker was approved. It shows in the backstage studio after the next publish, usually within a few minutes. Only you see it, when your VRChat display name matches the one you entered. ${url('/me')}`
        : `Your dancer locker wasn't approved.${note ? `\nStaff note: ${note}` : ''}\nYou can upload a new one any time: ${url('/me')}`);
      return;
    }
    const g = r ? store.group(r.groupId) : undefined;
    if (!r || !g || !uploadId) return; // Discord submitters already see the card outcome in /poster list
    const what = kind === 'poster' ? `poster ${r.slot}` : ART_NOUN[kind];
    await dm(r.submitter, approve
      ? `✅ Your ${what} for **${g.name}** was approved. It goes live in the world with the next publish, usually within a few minutes. ${url(`/manage`)}`
      : `Your ${what} for **${g.name}** wasn't approved.${note ? `\nStaff note: ${note}` : ''}\nYou can upload a new one any time: ${url('/manage')}`);
  }

  /** Congratulations + getting started, for a club approved to Premium or Headliner. */
  async function sendWelcome(userId: string, groupId: number, groupName: string, level: string): Promise<void> {
    const g = store.group(groupId);
    const w = premiumWelcome(groupName, level === 'headliner' ? 'headliner' : 'premium', {
      linked: Boolean(g?.vrchatUrl), manageUrl: url(`/manage?group=${groupId}`), hostUrl: url('/host'), pageUrl: url('/'),
    });
    const embed = new EmbedBuilder().setColor(level === 'headliner' ? GOLD : EMERALD).setTitle(w.title).setDescription(w.description)
      .addFields(w.fields.map(f => ({ name: f.name, value: f.value.slice(0, 1024) }))).setFooter({ text: 'FBT Social · the after-dark Strip' });
    await dm(userId, { embeds: [embed], components: [linkRow(['My dashboard', url('/me')], ['Customize', url(`/manage?group=${groupId}`)], ['Host a night', url('/host')])] });
  }

  async function deliver(item: OutboxItem): Promise<void> {
    const p = item.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const guild = d.client.guilds.cache.get(d.guildId) ?? null;
    const events = channel('fbt_events_channel');
    switch (item.kind) {
      case 'admin.group': {
        const r = await applyAdmin(store, p as AdminAction, resolveUser);
        await d.auditLog(guild, `🛠️ ${r.summary} by <@${p.by}> on the website.`);
        scheduleSync(0);
        return;
      }
      case 'application.decided': {
        const label = p.level === 'headliner' ? 'Headliner' : 'Premium';
        await d.auditLog(guild, `Application #${p.applicationId} (${p.groupName}, ${label}) ${p.approve ? 'approved' : 'declined'} by <@${p.by}> on the website.`);
        const approvals = store.setting('approval_channel');
        const ch = approvals && guild ? guild.channels.cache.get(approvals) : undefined;
        if (ch?.type === ChannelType.GuildText) await (ch as TextChannel).send({ content: `Application #${p.applicationId} · ${p.groupName} · ${p.approve ? '**APPROVED**' : '**DECLINED**'} by <@${p.by}> on the website${!p.approve && p.note ? ` · "${p.note}"` : ''}.`, allowedMentions: { parse: [] } }).catch(() => undefined);
        if (p.approve) await sendWelcome(String(p.applicant), Number(p.groupId ?? store.groups().find(g => g.name === p.groupName)?.id ?? 0), String(p.groupName), String(p.level));
        else await dm(String(p.applicant), `Your ${label} application for **${p.groupName}** wasn't approved this time.${p.note ? `\nStaff note: ${p.note}` : ''}\nYou can apply again in 14 days. Keep hosting: consistent nights count the most.`);
        return;
      }
      case 'collab.request': {
        const when = Date.parse(p.start);
        for (const partner of p.partners as { id: number; name: string; reps: string[] }[]) {
          const content = `🤝 **${p.host.name}** wants to collab with **${partner.name}**${p.title ? ` on **${p.title}**` : ''} · ${discordTime(when)} (${discordTime(when, 'R')}).\nIf you say yes, both groups earn that night's heat in full, plus a collab bonus.`;
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`fbt:cy:${p.collabId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`fbt:cn:${p.collabId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setLabel('See collabs').setStyle(ButtonStyle.Link).setURL(url('/collabs')));
          let reached = false;
          for (const rep of partner.reps) reached = (await dm(rep, { content, components: [row] })) || reached;
          if (!reached && events) await events.send({ content: `${partner.reps.map(r => `<@${r}>`).join(' ')} ${content}`, components: [row], allowedMentions: { users: partner.reps } });
        }
        return;
      }
      case 'collab.answered': {
        const host = store.group(Number(p.hostId));
        const reps = host ? store.representatives(host.id) : [];
        const text = p.status === 'confirmed' ? `✅ Your collab **${p.title}** is confirmed. Both groups earn the night's heat.` : `Your collab request **${p.title}** was declined.`;
        for (const r of reps) await dm(r, text);
        if (p.status === 'confirmed' && events && Array.isArray(p.names)) await events.send(`🤝 **${(p.names as string[]).join(' × ')}** are teaming up: **${p.title}**.`);
        return;
      }
      case 'event.created': {
        const host = store.group(Number(p.groupId));
        const headliner = host?.tier === 'premium' && host.level === 'headliner';
        const start = Date.parse(p.start), end = Date.parse(p.end);
        if (events) {
          const embed = new EmbedBuilder().setColor(headliner ? GOLD : host?.tier === 'premium' ? EMERALD : BRONZE)
            .setTitle(p.title).setURL(url(`/v/${p.groupSlug}`))
            .setDescription(`${headliner ? '👑 **Headliner** · ' : ''}**${p.groupName}** · ${discordTime(start)} (${discordTime(start, 'R')})${p.description ? `\n\n${p.description}` : ''}`)
            .setFooter({ text: 'FBT Social · RSVP on the Strip' });
          await events.send({ embeds: [embed], components: [linkRow(['RSVP on the Strip', url(`/v/${p.groupSlug}`)])] });
        }
        if (guild?.members.me?.permissions.has(PermissionFlagsBits.ManageEvents) && start > Date.now() + 60_000) {
          const ev = await guild.scheduledEvents.create({
            name: `${p.title} · ${p.groupName}`.slice(0, 100), scheduledStartTime: new Date(start), scheduledEndTime: new Date(end),
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: 'FBT Social · VRChat' }, description: (p.description || `Hosted by ${p.groupName}. RSVP: ${url(`/v/${p.groupSlug}`)}`).slice(0, 1000),
          }).catch(e => { console.error('Scheduled event failed:', e.message); return undefined; });
          if (ev) await sitePost(d.site, '/api/bot/event', { action: 'linked', eventId: p.eventId, discordEventId: ev.id });
        }
        return;
      }
      case 'event.cancelled': {
        if (p.discordEventId && guild) await guild.scheduledEvents.delete(p.discordEventId).catch(() => undefined);
        if (events) await events.send(`**${p.title}** by ${p.groupName} has been cancelled.`);
        return;
      }
      case 'application.created': {
        const approvals = store.setting('approval_channel');
        const ch = approvals && guild ? guild.channels.cache.get(approvals) : undefined;
        if (ch?.type !== ChannelType.GuildText) throw new Error('Approval channel is not configured.');
        const s = p.stats ?? {};
        const a = p.answers ?? {};
        const label = p.level === 'headliner' ? 'Headliner' : 'Premium';
        const embed = new EmbedBuilder().setColor(p.level === 'headliner' ? GOLD : EMERALD)
          .setTitle(`${label} application · ${p.groupName}`).setURL(url(`/v/${p.groupSlug}`))
          .setDescription(String(a.about ?? '').slice(0, 1500))
          .addFields(
            { name: 'Applicant', value: `<@${p.applicant}>`, inline: true },
            { name: 'Now', value: String(p.current), inline: true },
            { name: 'Season heat', value: `${s.season_points ?? 0}${s.season_rank ? ` (#${s.season_rank})` : ''}`, inline: true },
            { name: 'Nights, last 30 days', value: String(s.nights_30d ?? 0), inline: true },
            { name: 'Best night', value: `${s.best_night ?? 0} heat`, inline: true },
            { name: 'Events · collabs', value: `${s.events_30d ?? 0} · ${s.collabs ?? 0}`, inline: true },
            { name: 'Hosts', value: String(a.schedule ?? '–').slice(0, 200), inline: true },
            { name: 'Typical crowd', value: String(a.crowd ?? '–').slice(0, 100), inline: true },
            { name: 'Links', value: String(a.links || '–').slice(0, 300), inline: true });
        await (ch as TextChannel).send({
          content: `**Application #${p.applicationId}**`, embeds: [embed], allowedMentions: { parse: [] },
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`fbt:appok:${p.applicationId}`).setLabel(`Approve ${label}`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`fbt:appno:${p.applicationId}`).setLabel('Decline').setStyle(ButtonStyle.Danger))],
        });
        return;
      }
      case 'upload.submit': {
        if (!d.art) throw new Error('Artwork reviews are not available.');
        let bytes: Buffer;
        try { bytes = await siteBytes(d.site, '/api/bot/upload/fetch', { uploadId: p.uploadId }); }
        catch (e) { if ((e as { status?: number }).status === 404) return; throw e; } // withdrawn on the site
        try {
          const id = await d.art.submit(p.kind as ArtKind, Number(p.groupId ?? 0), p.slot == null ? null : Number(p.slot), String(p.by), bytes, String(p.uploadId),
            p.vrcName == null ? undefined : String(p.vrcName));
          await sitePost(d.site, '/api/bot/upload/status', { uploadId: p.uploadId, status: 'in_review', reviewId: id });
        } catch (e) {
          const message = (e as Error).message;
          if (/approval channel/i.test(message)) throw e; // our setup problem: retry once it's fixed
          await sitePost(d.site, '/api/bot/upload/status', { uploadId: p.uploadId, status: 'failed', note: message.slice(0, 300) });
        }
        return;
      }
      case 'upload.pending': {
        // Page art (banner, logo, photo) is reviewed on the website; give reviewers a nudge.
        const approvals = store.setting('approval_channel');
        const ch = approvals && guild ? guild.channels.cache.get(approvals) : undefined;
        const what = p.kind === 'banner' ? 'page banner' : p.kind === 'logo' ? 'logo' : 'gallery photo';
        if (ch?.type === ChannelType.GuildText) await (ch as TextChannel).send({
          content: `🖼️ **${p.groupName}** uploaded a ${what} for their venue page (by <@${p.by}>). Review it in the Control room.`,
          components: [linkRow(['Review artwork', url('/staff?tab=reviews')])], allowedMentions: { parse: [] },
        });
        return;
      }
      case 'upload.decided': {
        const what = p.kind === 'banner' ? 'page banner' : p.kind === 'logo' ? 'logo' : 'gallery photo';
        await d.auditLog(guild, `${what[0]!.toUpperCase()}${what.slice(1)} for ${p.groupName} ${p.approve ? 'approved' : 'rejected'} by <@${p.by}> on the website.`);
        await dm(String(p.uploader), p.approve
          ? `✅ Your ${what} for **${p.groupName}** was approved and is on your venue page now. ${url('/manage')}`
          : `Your ${what} for **${p.groupName}** wasn't approved.${p.note ? `\nStaff note: ${p.note}` : ''}\nYou can upload a new one any time: ${url('/manage')}`);
        return;
      }
      case 'enforce.demote': {
        const line = demoteForAge(store, Number(p.groupId));
        if (!line) return;
        await d.auditLog(guild, `⚖️ ${line}`);
        for (const rep of store.representatives(Number(p.groupId))) await dm(rep, demoteDm(String(p.groupName), String(p.reason ?? 'we couldn\'t confirm your rooms were age-verified'), url('/apply')));
        scheduleSync(0);
        return;
      }
      case 'enforce.deactivate': {
        // No message to the club (owner's call): if they're interested, they'll come back.
        const line = deactivateForInactivity(store, Number(p.groupId));
        if (!line) return;
        await d.auditLog(guild, `💤 ${line}`);
        scheduleSync(0);
        return;
      }
      case 'look.set': {
        const groupId = Number(p.groupId);
        if (!store.group(groupId)) return;
        store.setSetting(`look-${groupId}`, JSON.stringify({ accent: p.accent ?? '', glow: Number(p.glow ?? 1) }));
        store.setSetting('catalog-dirty', '1');
        return;
      }
      case 'upload.decide': {
        if (!d.art) throw new Error('Artwork reviews are not available.');
        const kind = p.kind as ArtKind, id = Number(p.reviewId);
        try { await d.art.decide(kind, id, Boolean(p.approve), String(p.by)); }
        catch (e) {
          // Already decided in Discord, or the group changed tier: report what actually happened.
          const r = d.art.reviewOf(kind, id);
          if (r && r.status !== 'submitted') { await artDecided(kind, id, r.status === 'approved'); return; }
          await sitePost(d.site, '/api/bot/upload/status', { uploadId: p.uploadId, status: 'failed', note: (e as Error).message.slice(0, 300) });
          return;
        }
        await artDecided(kind, id, Boolean(p.approve), p.note ? String(p.note) : undefined);
        scheduleSync();
        return;
      }
      case 'locker.rename': {
        // A dancer edited the VRChat display name on their locker; the same art follows the new name.
        try { renameLocker(store, String(p.user), String(p.vrcName)); }
        catch (e) { throw Object.assign(new Error((e as Error).message), { permanent: true }); }
        return;
      }
      case 'locker.remove': {
        if (removeLocker(store, String(p.user))) await d.auditLog(guild, `Dancer locker for <@${p.user}> taken down${p.by && p.by !== p.user ? ` by <@${p.by}>` : ''} on the website.`);
        return;
      }
      case 'club.register': {
        // A verified member registered a club on the website (same as the Start Here button).
        const user = String(p.user);
        let g: Group;
        try {
          g = store.registerGroup(String(p.name), 'standard', p.vrchat ? String(p.vrchat) : undefined, user);
        } catch (e) {
          await sitePost(d.site, '/api/bot/club-register', { requestId: p.requestId, ok: false, error: (e as Error).message.slice(0, 300) });
          return;
        }
        if (p.userName) store.setSetting(`representative-name-${user}`, '@' + String(p.userName));
        store.queuePublish(g.id);
        await d.auditLog(guild, `Group #${g.id} ${g.name} registered by <@${user}> on the website.`);
        await sitePost(d.site, '/api/bot/club-register', { requestId: p.requestId, ok: true, groupId: g.id });
        await dm(user, `🎉 **${g.name}** is registered on FBT Social (club #${g.id}). Your door code for the world is \`${g.code}\`.\nNext: open **My dashboard** to get your nights counted and make it yours: ${url('/me')}`);
        scheduleSync(0);
        return;
      }
      case 'team.joined': {
        // Someone accepted a club's invite link on the website (the bot added them as a rep just before).
        const groupId = Number(p.groupId);
        await d.auditLog(guild, `👥 <@${p.user}> joined ${p.groupName} (#${groupId})'s team as a manager (invited by <@${p.by}>).`);
        await dm(String(p.by), `👥 **${String(p.userName ?? 'Someone')}** accepted your invite and now helps run **${p.groupName}** on FBT Social. You can manage your team on My dashboard: ${url('/me')}`);
        await dm(String(p.user), `Welcome to the team for **${p.groupName}**! Run the club from **My dashboard** at ${url('/me')}: customize its look, post nights and book collabs.`);
        scheduleSync(0);
        return;
      }
      case 'discord.channel.delete': {
        if (!guild) throw new Error('The server isn\'t available right now.');
        const line = await deleteChannel(guild, store, String(p.channelId), String(p.name), String(p.by));
        await d.auditLog(guild, `🧹 ${line} by <@${p.by}> from the Control room.`);
        scheduleChannels(2000);
        return;
      }
      case 'discord.announce': {
        if (!guild) throw new Error('The server isn\'t available right now.');
        await postAnnouncement(guild, { channelId: String(p.channelId), title: String(p.title), body: String(p.body), everyone: Boolean(p.everyone),
          links: Array.isArray(p.links) ? p.links : [], image: p.image ? String(p.image) : null });
        await d.auditLog(guild, `📣 Announcement "${String(p.title).slice(0, 80)}" posted in <#${p.channelId}> by <@${p.by}> from the Control room.`);
        return;
      }
      default:
        console.warn('Unknown outbox item', item.kind);
    }
  }

  // ── Channel list for the Control room ───────────────────────────────────────────────────
  let channelTimer: NodeJS.Timeout | undefined;
  let loggedChannels = false;
  function scheduleChannels(delayMs = 10_000) {
    if (!siteEnabled(d.site)) return;
    clearTimeout(channelTimer);
    channelTimer = setTimeout(() => {
      const guild = d.client.guilds.cache.get(d.guildId);
      if (!guild) return;
      const channels = channelInventory(guild, store);
      if (!loggedChannels) {
        // Once per start, for whoever reads the logs: the server's channels in order.
        loggedChannels = true;
        const day = (iso: string | null) => (iso ? `${Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)}d` : 'never');
        console.log(`Channels (${channels.length}):\n` + channels.filter(c => c.kind !== 'category').sort((a, b) => (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.position - b.position)
          .map(c => `  ${c.parentName ?? '(none)'} › ${c.kind === 'voice' ? '🔊' : '#'}${c.name}  last:${day(c.lastMessageAt)}${c.protected ? `  [bot:${c.protected}]` : ''}${c.everyoneCanView ? '' : '  private'}`).join('\n'));
      }
      void sitePost(d.site, '/api/bot/channels', { channels, guildId: d.guildId }, 30_000)
        .then(r => { if (!r.ok) console.error('Channel list sync failed:', r.error); });
    }, delayMs);
  }

  let polling = false;
  let pendingAck: number[] = [], pendingFailed: OutboxFailure[] = [];
  async function pollOutbox(): Promise<void> {
    if (polling || !siteEnabled(d.site)) return;
    polling = true;
    try {
      const r = await sitePost<{ items: OutboxItem[] }>(d.site, '/api/bot/outbox', { ack: pendingAck, failed: pendingFailed });
      if (!r.ok) return;
      pendingAck = []; pendingFailed = [];
      for (const item of r.data.items) {
        try { await deliver(item); pendingAck.push(item.id); }
        catch (e) {
          console.error(`Outbox item ${item.id} (${item.kind}) failed:`, e);
          // Staff actions fail on bad input (taken name, unknown user): retrying won't help.
          pendingFailed.push({ id: item.id, error: e instanceof Error ? e.message.slice(0, 300) : 'Failed.',
            permanent: item.kind.startsWith('admin.') || (e as { permanent?: boolean }).permanent === true });
        }
      }
    } finally { polling = false; }
  }

  function startLoops(): void {
    if (!siteEnabled(d.site)) { console.log('FBT website link not configured (FBT_SITE_URL / FBT_BOT_SECRET); website features are off.'); return; }
    setInterval(() => void pollOutbox(), 8_000);
    setInterval(() => scheduleSync(0), 3 * 60_000);
    scheduleChannels(15_000);
    setInterval(() => scheduleChannels(0), 15 * 60_000);
    setInterval(() => void sitePost(d.site, '/api/cron/rollup', {}, 60_000), 10 * 60_000);
  }

  return { commands, handleButton, handleModal, handleCommand, handleAutocomplete, onReady, onMemberAdd, scheduleSync, startLoops, pollOutbox, deliver, artDecided, scheduleChannels };
}
