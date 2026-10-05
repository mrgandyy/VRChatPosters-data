import { submitBackdrop, decideBackdrop } from './backdrop.js';
import { groupLinkPrompt } from './group-link.js';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type Attachment, type ButtonInteraction, type ChatInputCommandInteraction, type Guild,
  type TextChannel
} from 'discord.js';
import { submitBillboard, decideBillboard } from './billboard.js';
import { join, resolve } from 'node:path';
import { Store } from './db.js';
import { MAX_SOURCE_BYTES, saveSource } from './atlas.js';
import { activateRollback, processOneJob, type PublishConfig } from './publish.js';
import { assertSlot, type Group } from './types.js';
import { acceptsButtonPrefix, databasePath, legacyName, rebrand } from './branding.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const appId = process.env.DISCORD_APPLICATION_ID;
if (!token || !guildId || !appId) throw new Error('Set DISCORD_TOKEN, DISCORD_GUILD_ID, and DISCORD_APPLICATION_ID.');
const dataDir = resolve(process.env.WRECKSHOP_DATA_DIR ?? './data');
const store = new Store(await databasePath(dataDir));
const publishConfig: PublishConfig = {
  token: process.env.GITHUB_TOKEN, owner: process.env.GITHUB_OWNER,
  repository: process.env.GITHUB_REPOSITORY, branch: process.env.GITHUB_BRANCH ?? 'main',
  publicBase: process.env.GITHUB_PUBLIC_BASE,
  defaultsDir: resolve(process.env.WRECKSHOP_DEFAULTS_DIR ?? './defaults'), dataDir,
  dryRun: process.env.WRECKSHOP_DRY_RUN !== 'false'
};
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let publishing = false;
const ephemeral = MessageFlags.Ephemeral;

const poster = new SlashCommandBuilder().setName('poster').setDescription('Wreckshop posters')
  .addSubcommand(s => s.setName('submit').setDescription('Submit a poster for review')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addIntegerOption(o => o.setName('slot').setDescription('Poster slot').setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Static PNG, JPEG, or WebP').setRequired(true)))
  .addSubcommand(s => {
    s.setName('batch').setDescription('Submit up to eight posters for review at once')
      .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
      .addIntegerOption(o => o.setName('slot1').setDescription('First poster slot').setRequired(true))
      .addAttachmentOption(o => o.setName('image1').setDescription('First poster image').setRequired(true));
    for (let n = 2; n <= 8; n++) {
      s.addIntegerOption(o => o.setName(`slot${n}`).setDescription(`Poster ${n} slot`));
      s.addAttachmentOption(o => o.setName(`image${n}`).setDescription(`Poster ${n} image`));
    }
    return s;
  })
  .addSubcommand(s => s.setName('list').setDescription('List group posters')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Restore default artwork in a slot')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addIntegerOption(o => o.setName('slot').setDescription('Poster slot').setRequired(true)));
const billboard = new SlashCommandBuilder().setName('billboard').setDescription('Premium entrance billboard')
  .addSubcommand(s=>s.setName('submit').setDescription('Upload a wide 4:1 billboard for review')
    .addIntegerOption(o=>o.setName('group').setDescription('Premium group ID').setRequired(true))
    .addAttachmentOption(o=>o.setName('image').setDescription('Static PNG, JPEG or WebP, ideally 2048 x 512').setRequired(true)));
async function handleBillboard(i:ChatInputCommandInteraction):Promise<void>{
  const id=i.options.getInteger('group',true);
  const group=requiredGroup(id);
  if(!canManage(i,id))throw new Error('You do not represent this group.');
  if(!group.enabled || group.tier!=='premium' || id===0)throw new Error('Billboards require an enabled premium partner group.');
  const channel=i.guild!.channels.cache.get(store.setting('approval_channel')??'');
  if(!channel || channel.type!==ChannelType.GuildText)throw new Error('Approval channel is not configured.');
  await i.deferReply({flags:ephemeral});
  const attachment=i.options.getAttachment('image',true);
  const paths=await saveSource(await downloadAttachment(attachment.url,attachment.size),dataDir);
  const submission=submitBillboard(store,id,i.user.id,paths.sourcePath,paths.previewPath);
  const row=new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ws:bannerapprove:${submission}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ws:bannerreject:${submission}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
  await channel.send({content:`Billboard #${submission} for ${group.name}. Wide 4:1 entrance banner.`,files:[new AttachmentBuilder(paths.previewPath)],components:[row]});
  await i.editReply(`Billboard #${submission} saved for review. Approved artwork appears when your group code is selected in the world.`);
}
const backdrop = new SlashCommandBuilder().setName('backdrop').setDescription('Premium photo wall backdrop')
  .addSubcommand(s=>s.setName('submit').setDescription('Upload a 4:3 photo backdrop for review')
    .addIntegerOption(o=>o.setName('group').setDescription('Premium group ID').setRequired(true))
    .addAttachmentOption(o=>o.setName('image').setDescription('Static PNG, JPEG or WebP, ideally 2048 x 1536').setRequired(true)));
async function handleBackdrop(i:ChatInputCommandInteraction):Promise<void>{
  const id=i.options.getInteger('group',true);
  const group=requiredGroup(id);
  if(!canManage(i,id))throw new Error('You do not represent this group.');
  if(!group.enabled || group.tier!=='premium' || id===0)throw new Error('Backdrops require an enabled premium partner group.');
  const channel=i.guild!.channels.cache.get(store.setting('approval_channel')??'');
  if(!channel || channel.type!==ChannelType.GuildText)throw new Error('Approval channel is not configured.');
  await i.deferReply({flags:ephemeral});
  const attachment=i.options.getAttachment('image',true);
  const paths=await saveSource(await downloadAttachment(attachment.url,attachment.size),dataDir);
  const submission=submitBackdrop(store,id,i.user.id,paths.sourcePath,paths.previewPath);
  const row=new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ws:backdropapprove:${submission}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ws:backdropreject:${submission}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
  await channel.send({content:`Backdrop #${submission} for ${group.name}. 4:3 photo wall backdrop.`,files:[new AttachmentBuilder(paths.previewPath)],components:[row]});
  await i.editReply(`Backdrop #${submission} saved for review. Approved artwork appears when your group code is selected in the world.`);
}
const group = new SlashCommandBuilder().setName('group').setDescription('Wreckshop group administration')
  .addSubcommand(s => s.setName('register').setDescription('Register a partner group')
    .addStringOption(o => o.setName('name').setDescription('Group name').setRequired(true))
    .addStringOption(o => o.setName('vrchat_group').setDescription('Required for Premium: your VRChat grp_ UUID or official group page URL'))
    .addStringOption(o => o.setName('tier').setDescription('Tier').addChoices(
      { name: 'Standard', value: 'standard' },{ name: 'Premium', value: 'premium' })))
  .addSubcommand(s => s.setName('representative').setDescription('Add or remove a representative')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Add', value: 'add' },{ name: 'Remove', value: 'remove' })))
  .addSubcommand(s => s.setName('tier').setDescription('Assign tier')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addStringOption(o => o.setName('value').setDescription('Tier').setRequired(true).addChoices(
      { name: 'Standard', value: 'standard' },{ name: 'Premium', value: 'premium' })))
  .addSubcommand(s => s.setName('code').setDescription('Change shareable preset code')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addStringOption(o => o.setName('value').setDescription('Eight digits').setRequired(true)))
  .addSubcommand(s => s.setName('suspend').setDescription('Enable or suspend a group')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)))
  .addSubcommand(s => s.setName('page').setDescription('Set VRChat group page')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addStringOption(o => o.setName('url').setDescription('VRChat grp_ UUID or group page URL').setRequired(true)))
  .addSubcommand(s => s.setName('link').setDescription('Configure your in-world Join group button')
    .addIntegerOption(o => o.setName('group').setDescription('Your Wreckshop group number from /group mine').setRequired(true))
    .addStringOption(o => o.setName('vrchat_group').setDescription('Your VRChat grp_ UUID or official group page URL').setRequired(true)))
  .addSubcommand(s => s.setName('accept').setDescription('Acknowledge VRChat rules and hosting responsibilities')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addBooleanOption(o => o.setName('agree').setDescription('I agree to follow VRChat rules').setRequired(true)))
  .addSubcommand(s => s.setName('recognition').setDescription('Refresh representative names on the entrance board')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true)))
  .addSubcommand(s => s.setName('mine').setDescription('View groups you represent'));
const setup = new SlashCommandBuilder().setName('ws-setup').setDescription('Set up Wreckshop channels and panel')
  .addChannelOption(o => o.setName('submissions').setDescription('Existing public submission channel'))
  .addChannelOption(o => o.setName('help').setDescription('Existing public help channel'))
  .addChannelOption(o => o.setName('approvals').setDescription('Existing private approval channel'))
  .addChannelOption(o => o.setName('logs').setDescription('Existing private log channel'))
  .addRoleOption(o => o.setName('reviewer_role').setDescription('Role that can review submissions'))
  .addRoleOption(o => o.setName('admin_role').setDescription('Role that can manage partners'));
const publish = new SlashCommandBuilder().setName('publish').setDescription('Publishing status and recovery')
  .addSubcommand(s => s.setName('status').setDescription('Show recent publishing jobs'))
  .addSubcommand(s => s.setName('retry').setDescription('Retry a failed group publication')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true)))
  .addSubcommand(s => s.setName('rollback').setDescription('Restore an earlier published release')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addIntegerOption(o => o.setName('revision').setDescription('Published revision').setRequired(true)));
const help = new SlashCommandBuilder().setName('ws-help').setDescription('Wreckshop help');

function admin(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
  return !!(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    hasMemberRole(interaction,store.setting('admin_role')));
}
function reviewer(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
  return admin(interaction) || hasMemberRole(interaction,store.setting('reviewer_role'));
}
function hasMemberRole(interaction: ChatInputCommandInteraction | ButtonInteraction, roleId: string | undefined): boolean {
  if (!roleId || !interaction.member) return false;
  const roles = interaction.member.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : roles.cache.has(roleId);
}
function canManage(interaction: ChatInputCommandInteraction, groupId: number): boolean {
  return admin(interaction) || store.canRepresent(groupId,interaction.user.id);
}
function requiredGroup(id: number): Group {
  const found = store.group(id);
  if (!found) throw new Error('Group not found.');
  return found;
}
async function downloadAttachment(url: string, advertisedSize: number): Promise<Buffer> {
  if (advertisedSize > MAX_SOURCE_BYTES) throw new Error('Attachment exceeds 12 MB.');
  const response = await fetch(url,{ signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_SOURCE_BYTES) throw new Error('Attachment exceeds 12 MB.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Attachment exceeds 12 MB.');
  return bytes;
}
function panelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ws:submit').setLabel('Submit Poster').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ws:mine').setLabel('My Posters').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ws:groups').setLabel('Group Settings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ws:help').setLabel('Help').setStyle(ButtonStyle.Secondary));
}
async function auditLog(guild: Guild | null, message: string): Promise<void> {
  const id = store.setting('log_channel');
  const channel = id && guild ? guild.channels.cache.get(id) : undefined;
  if (channel?.type === ChannelType.GuildText)
    await (channel as TextChannel).send(message).catch(error => console.error('Audit log delivery failed:',error));
}
async function configuredChannel(guild: Guild, setting: string, name: string, privateChannel: boolean): Promise<TextChannel> {
  const saved = store.setting(setting);
  if (saved) {
    const old = guild.channels.cache.get(saved);
    if (old?.type === ChannelType.GuildText) {
      if (rebrand(old.name) !== old.name) await old.setName(rebrand(old.name),'Wreckshop Worlds rebrand');
      return old as TextChannel;
    }
  }
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (c.name === name || c.name === legacyName(name)));
  if (existing) {
    if (existing.name !== name) await existing.setName(name,'Wreckshop Worlds rebrand');
    store.setSetting(setting,existing.id); return existing as TextChannel;
  }
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText,
    permissionOverwrites: privateChannel ? [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] },
      ...(store.setting('reviewer_role') ? [{ id: store.setting('reviewer_role')!,
        allow: [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] }] : []),
      ...(store.setting('admin_role') ? [{ id: store.setting('admin_role')!,
        allow: [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages] }] : [])
    ] : undefined });
  store.setSetting(setting,channel.id);
  return channel;
}
async function handleSetup(i: ChatInputCommandInteraction): Promise<void> {
  if (!admin(i)) throw new Error('Manage Server or the configured admin role is required.');
  const guild = i.guild!;
  for (const [option,key] of [['submissions','submission_channel'],['help','help_channel'],
    ['approvals','approval_channel'],['logs','log_channel']] as const) {
    const chosen = i.options.getChannel(option);
    if (chosen) {
      if (chosen.type !== ChannelType.GuildText) throw new Error(`${option} must be a text channel.`);
      store.setSetting(key,chosen.id);
    }
  }
  const reviewerRole = i.options.getRole('reviewer_role');
  const adminRole = i.options.getRole('admin_role');
  if (reviewerRole) store.setSetting('reviewer_role',reviewerRole.id);
  if (adminRole) store.setSetting('admin_role',adminRole.id);
  const { submissionChannel, helpChannel } = await ensureGuildSetup(guild);
  await i.reply({ content: `Setup ready: ${submissionChannel} · help: ${helpChannel}. Existing channels and panel were reused where possible.`, flags: ephemeral });
  await auditLog(guild,`Setup updated by <@${i.user.id}>.`);
}
async function ensureGuildSetup(guild: Guild): Promise<{ submissionChannel: TextChannel; helpChannel: TextChannel }> {
  await Promise.all([guild.channels.fetch(),guild.roles.fetch(),guild.members.fetchMe()]);
  for (const [name,key] of [['Wreckshop Reviewer','reviewer_role'],['Wreckshop Admin','admin_role']] as const) {
    if (!store.setting(key)) {
      const role = guild.roles.cache.find(r => rebrand(r.name).toLowerCase() === name.toLowerCase());
      if (role) store.setSetting(key,role.id);
    }
  }
  const submissionChannel = await configuredChannel(guild,'submission_channel','wreckshop-submit',false);
  const helpChannel = await configuredChannel(guild,'help_channel','wreckshop-help',false);
  const approvals = await configuredChannel(guild,'approval_channel','wreckshop-approvals',true);
  const logs = await configuredChannel(guild,'log_channel','wreckshop-log',true);
  for (const channel of [approvals,logs]) {
    if (!channel.permissionOverwrites.cache.get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel))
      await channel.permissionOverwrites.edit(guild.roles.everyone,{ ViewChannel: false });
    const botOverwrite = channel.permissionOverwrites.cache.get(guild.members.me!.id);
    if (!botOverwrite?.allow.has(PermissionFlagsBits.ViewChannel) ||
        !botOverwrite.allow.has(PermissionFlagsBits.SendMessages))
      await channel.permissionOverwrites.edit(guild.members.me!,{ ViewChannel: true, SendMessages: true });
    for (const key of ['reviewer_role','admin_role']) {
      const roleId = store.setting(key);
      const overwrite = roleId ? channel.permissionOverwrites.cache.get(roleId) : undefined;
      if (roleId && (!overwrite?.allow.has(PermissionFlagsBits.ViewChannel) ||
          !overwrite.allow.has(PermissionFlagsBits.SendMessages)))
        await channel.permissionOverwrites.edit(roleId,{ ViewChannel: true, SendMessages: true });
    }
  }
  // The bot needs explicit access even if the server hides these channels from @everyone.
  for (const channel of [submissionChannel,helpChannel,approvals,logs]) {
    const needed = [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles];
    if (!needed.every(p=>channel.permissionsFor(guild.members.me!)?.has(p)))
      await channel.permissionOverwrites.edit(guild.members.me!,{ ViewChannel:true,SendMessages:true,
        ReadMessageHistory:true,EmbedLinks:true,AttachFiles:true });
  }
  const oldPanel = store.setting('panel_message');
  let message;
  if (oldPanel) message = await submissionChannel.messages.fetch(oldPanel).catch(() => undefined);
  const panel = {
    content: '**Wreckshop Worlds**\nby TwerkTaco & Resolve\nSubmit free group posters below.',
    components: [panelRow()],
    embeds: [{ color: 0xff0099, thumbnail: { url: 'attachment://wreckshoplogo.png' } }],
    files: [new AttachmentBuilder(resolve('branding/wreckshoplogo.png'))]
  };
  if (message) await message.edit({ ...panel, attachments: [] });
  else {
    message = await submissionChannel.send(panel);
    store.setSetting('panel_message',message.id);
  }
  return { submissionChannel, helpChannel };
}
async function handlePoster(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  const groupId = i.options.getInteger('group',true);
  const group = requiredGroup(groupId);
  if (sub === 'list') {
    if (!canManage(i,groupId)) throw new Error('You do not represent this group.');
    const list = store.submissions(groupId).slice(0,20);
    await i.reply({ content: list.length ? list.map(s => `#${s.id} · slot ${s.slot} · ${s.status}`).join('\n') : 'No submissions yet.', flags: ephemeral });
    return;
  }
  if (!canManage(i,groupId)) throw new Error('You do not represent this group.');
  if (!group.enabled) throw new Error('Group is suspended.');
  if (sub === 'remove') {
    const slot = i.options.getInteger('slot',true);
    store.removeOverride(groupId,slot);
    await i.reply({ content: `Slot ${slot} will return to default artwork after publication.`, flags: ephemeral });
    return;
  }
  const requested: { slot: number; attachment: Attachment }[] = [];
  if (sub === 'submit') requested.push({ slot: i.options.getInteger('slot',true), attachment: i.options.getAttachment('image',true) });
  else if (sub === 'batch') {
    for (let n = 1; n <= 8; n++) {
      const slot = i.options.getInteger(`slot${n}`);
      const attachment = i.options.getAttachment(`image${n}`);
      if ((slot === null) !== (attachment === null)) throw new Error(`Poster ${n} needs both a slot and an image.`);
      if (slot !== null && attachment) requested.push({ slot, attachment });
    }
  } else throw new Error('Unknown poster action.');
  const seen = new Set<number>();
  for (const item of requested) {
    assertSlot(group.tier,item.slot);
    if (seen.has(item.slot)) throw new Error(`Slot ${item.slot} appears more than once.`);
    if (item.attachment.size > MAX_SOURCE_BYTES) throw new Error(`Slot ${item.slot} attachment exceeds 12 MB.`);
    seen.add(item.slot);
  }
  const channelId = store.setting('approval_channel');
  const channel = channelId ? i.guild!.channels.cache.get(channelId) : undefined;
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Run /ws-setup to configure the approval channel.');
  await i.deferReply({ flags: ephemeral });
  const prepared = [];
  for (const item of requested) {
    const bytes = await downloadAttachment(item.attachment.url,item.attachment.size);
    prepared.push({ slot: item.slot, paths: await saveSource(bytes,dataDir) });
  }
  const submitted: number[] = [];
  let pendingReviewNotice: number | undefined;
  try {
    for (const item of prepared) {
      const submission = store.submit(groupId,item.slot,i.user.id,item.paths.sourcePath,item.paths.previewPath);
      pendingReviewNotice = submission.id;
      const prior = submission.previousId ? store.submission(submission.previousId) : undefined;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ws:approve:${submission.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ws:reject:${submission.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
      const files = [new AttachmentBuilder(item.paths.previewPath,{ name: 'proposed.png' })];
      if (prior) files.push(new AttachmentBuilder(prior.previewPath,{ name: 'previous.png' }));
      await (channel as TextChannel).send({ content: `**Poster #${submission.id}** · ${group.name} · slot ${item.slot}\nSubmitted by <@${i.user.id}>. ${prior ? `Previous approved poster: #${prior.id}.` : 'Previous: default artwork.'}`, files, components: [row] });
      submitted.push(submission.id);
      pendingReviewNotice = undefined;
      await auditLog(i.guild,`Poster #${submission.id} submitted by <@${i.user.id}> for ${group.name} slot ${item.slot}.`);
    }
  } catch (error) {
    await i.editReply(`${submitted.length} poster(s) reached review.${pendingReviewNotice ? ` Poster #${pendingReviewNotice} was saved but its review message failed; ask an admin to resolve it.` : ''} Remaining posters were not submitted. Error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await i.editReply(submitted.length === 1 ? `Poster #${submitted[0]} is saved and awaiting review.` :
    `${submitted.length} posters are saved and awaiting individual review: ${submitted.map(id => `#${id}`).join(', ')}.`);
}
async function handleGroup(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  if (sub === 'mine') {
    const groups = store.representedGroups(i.user.id);
    await i.reply({ content: groups.length ? groups.map(g => `#${g.id} ${g.name} · ${g.tier} · code ${g.code}\n${groupLinkPrompt(g)}`).join('\n\n') : 'No assigned groups. Use /group register and provide your VRChat group ID.', flags: ephemeral });
    return;
  }
  if (sub === 'accept') {
    const groupId = i.options.getInteger('group',true);
    if (!store.canRepresent(groupId,i.user.id)) throw new Error('Only an assigned representative can accept for this group.');
    if (!i.options.getBoolean('agree',true)) throw new Error('Acceptance was not recorded.');
    store.acceptAgreement(groupId,'vrchat-rules-v1',i.user.id);
    await i.reply({ content: 'Acknowledgment recorded. Follow VRChat rules and use VRChat moderation and reporting tools for issues. This is not age verification.', flags: ephemeral });
    return;
  }
  if (sub === 'register') {
    if (i.options.getString('tier') === 'premium' && !admin(i)) throw new Error('Premium is assigned by Wreckshop admins. Register a standard group first.');
    const vrchatGroup = i.options.getString('vrchat_group') ?? undefined;
    if (i.options.getString('tier') === 'premium' && !vrchatGroup) throw new Error('Premium groups need their VRChat group ID. Provide vrchat_group:grp_<your-group-UUID>, found in your VRChat group page URL.');
    const group = store.registerGroup(i.options.getString('name',true),
      i.options.getString('tier') === 'premium' ? 'premium' : 'standard', vrchatGroup);
    store.addRepresentative(group.id,i.user.id);
    store.setSetting(`representative-name-${i.user.id}`,'@'+i.user.username);
    store.queuePublish(group.id);
    await i.reply({ content: `Registered #${group.id} ${group.name}. Shareable code: ${group.code}. You are its representative. ${groupLinkPrompt(group)} Use /poster submit or /poster batch to upload artwork.`, flags: ephemeral });
    await auditLog(i.guild,`Group #${group.id} ${group.name} registered by <@${i.user.id}> as ${group.tier}.`);
    return;
  }
  const groupId = i.options.getInteger('group',true);
  requiredGroup(groupId);
  if ((sub === 'page' || sub === 'link') && requiredGroup(groupId).tier !== 'premium') throw new Error('Join group is available for Premium groups only.');
  if (sub === 'page' || sub === 'link' || sub === 'code' || sub === 'recognition') { if (!canManage(i,groupId)) throw new Error('You do not represent this group.'); }
  else if (!admin(i)) throw new Error('Wreckshop admin access is required.');
  if (sub === 'representative') {
    const user = i.options.getUser('user',true);
    if (i.options.getString('action',true) === 'add') store.addRepresentative(groupId,user.id);
    else store.removeRepresentative(groupId,user.id);
  } else if (sub === 'tier') store.setTier(groupId,i.options.getString('value',true) as 'standard'|'premium');
  else if (sub === 'code') store.setCode(groupId,i.options.getString('value',true));
  else if (sub === 'suspend') store.setEnabled(groupId,i.options.getBoolean('enabled',true));
  else if (sub === 'page') store.setUrl(groupId,i.options.getString('url',true));
  else if (sub === 'link') store.setUrl(groupId,i.options.getString('vrchat_group',true));
  if(sub === 'representative' || sub === 'recognition') {
    await i.deferReply({flags:ephemeral});
    store.queuePublish(groupId);
    await i.editReply(`Updated ${requiredGroup(groupId).name}; entrance recognition refresh queued.`);
  } else await i.reply({ content: `Updated ${requiredGroup(groupId).name}.${sub === 'page' || sub === 'link' || sub === 'tier' ? ` ${groupLinkPrompt(requiredGroup(groupId))} Publication queued.` : ''}`, flags: ephemeral });
  await auditLog(i.guild,`Group #${groupId} ${sub} updated by <@${i.user.id}>.`);
}
async function handlePublish(i: ChatInputCommandInteraction): Promise<void> {
  if (!admin(i)) throw new Error('Wreckshop admin access is required.');
  const sub = i.options.getSubcommand();
  if (sub === 'status') {
    const rows = store.db.prepare('SELECT id,group_id,status,attempts,error FROM jobs ORDER BY id DESC LIMIT 12').all() as
      { id:number; group_id:number; status:string; attempts:number; error:string|null }[];
    await i.reply({ content: rows.length ? rows.map(r => `#${r.id} group ${r.group_id}: ${r.status} · attempts ${r.attempts}${r.error ? ` · ${r.error.slice(0,100)}` : ''}`).join('\n') : 'No jobs.', flags: ephemeral });
    return;
  }
  const groupId = i.options.getInteger('group',true);
  requiredGroup(groupId);
  if (sub === 'retry') {
    store.queuePublish(groupId);
    await i.reply({ content: `Queued group ${groupId}.`, flags: ephemeral });
  } else {
    const revision = i.options.getInteger('revision',true);
    await i.deferReply({ flags: ephemeral });
    const message = await activateRollback(store,groupId,revision,publishConfig);
    await i.editReply(message);
  }
}
async function handleButton(i: ButtonInteraction): Promise<void> {
  const [prefix, action, rawId] = i.customId.split(':');
  if (!acceptsButtonPrefix(prefix)) return;
  if (action === 'help' || action === 'submit') {
    await i.reply({ content: action === 'submit' ? 'Use `/poster submit` for one image or `/poster batch` for up to eight. Choose a group and slot for each image. Register your group with `/group register`; you become its representative.' :
      'Wreckshop Worlds: standard groups may use slots 1–8; admin assigned premium groups may use 1–16. Use `/group mine`, `/poster list`, `/poster submit`, or `/poster batch`.', flags: ephemeral });
    return;
  }
  if (action === 'groups' || action === 'mine') {
    const groups = store.representedGroups(i.user.id);
    const lines = groups.flatMap(g => action === 'groups' ? [`#${g.id} ${g.name} · ${g.tier} · code ${g.code}\n${groupLinkPrompt(g)}`] :
      store.submissions(g.id).filter(s => s.submitterId === i.user.id).slice(0,8).map(s => `${g.name} #${s.id} slot ${s.slot}: ${s.status}`));
    await i.reply({ content: lines.length ? lines.join('\n') : 'Nothing to show yet.', flags: ephemeral });
    return;
  }
  if (action === 'backdropapprove' || action === 'backdropreject') {
    if (!reviewer(i)) throw new Error('Reviewer access is required.');
    decideBackdrop(store,Number(rawId),i.user.id,action === 'backdropapprove');
    await i.update({ content: `${i.message.content}\n${action === 'backdropapprove' ? 'APPROVED' : 'REJECTED'}`, components: [] }); return;
  }
  if (action === 'bannerapprove' || action === 'bannerreject') {
    if (!reviewer(i)) throw new Error('Reviewer access is required.');
    decideBillboard(store,Number(rawId),i.user.id,action === 'bannerapprove');
    await i.update({ content: `${i.message.content}\n${action === 'bannerapprove' ? 'APPROVED' : 'REJECTED'}`, components: [] }); return;
  }
  if (action === 'approve' || action === 'reject') {
    if (!reviewer(i)) throw new Error('Reviewer access is required.');
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) throw new Error('Invalid submission.');
    const result = store.decide(id,i.user.id,action === 'approve');
    await i.update({ content: `${i.message.content}\n**${result.status.toUpperCase()}** by <@${i.user.id}>`, components: [] });
    await auditLog(i.guild,`Poster #${id} ${result.status} by <@${i.user.id}>.`);
    return;
  }
}
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton()) { await handleButton(interaction); return; }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== guildId) throw new Error('Use this in the configured server.');
    if (interaction.commandName === 'ws-setup') await handleSetup(interaction);
    else if (interaction.commandName === 'backdrop') await handleBackdrop(interaction);
    else if (interaction.commandName === 'billboard') await handleBillboard(interaction);
    else if (interaction.commandName === 'poster') await handlePoster(interaction);
    else if (interaction.commandName === 'group') await handleGroup(interaction);
    else if (interaction.commandName === 'publish') await handlePublish(interaction);
    else if (interaction.commandName === 'ws-help') await interaction.reply({ content:
      'Advertise your group for free. Join the Wreckshop Worlds Discord to submit your posters. Use `/group mine`, `/poster submit`, or `/poster batch` for up to eight images. Anyone can use `/group register` to register a standard group and upload posters. Premium partners can use `/billboard submit` and `/backdrop submit group:<id> image:<upload>` for the photo wall. Follow VRChat rules and use its reporting tools for issues.', flags: ephemeral });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0,1500);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, flags: ephemeral }).catch(() => undefined);
      else await interaction.reply({ content: message, flags: ephemeral }).catch(() => undefined);
    }
  }
});
client.once('ready', async () => {
  if (process.env.WRECKSHOP_SEED_SHXTTY === 'true') {
    let pilot = store.groups().find(g => g.name.toUpperCase() === 'SHXTTY');
    if (!pilot) {
      pilot = store.registerGroup('SHXTTY','premium');
      store.queuePublish(pilot.id);
      console.log(`SHXTTY pilot registered as group ${pilot.id}.`);
    } else console.log(`SHXTTY pilot already registered as group ${pilot.id}.`);
  }
  const guild = await client.guilds.fetch(guildId);
  if(store.setting('recognition-privacy-v2')!=='applied'){store.queuePublish(0);store.setSetting('recognition-privacy-v2','applied');}
  await guild.commands.set([poster,group,setup,publish,help,billboard,backdrop]);
  if (process.env.WRECKSHOP_AUTO_SETUP === 'true') {
    try { await ensureGuildSetup(guild); console.log('Wreckshop channels and panel ready.'); }
    catch (error) { console.error('Automatic channel setup failed:',error); }
  }
  if (!publishConfig.dryRun && !store.activeRelease(0)) store.queuePublish(0);
  store.db.prepare("UPDATE jobs SET status='queued' WHERE status='publishing'").run();
  // One-time recovery of the most recent job affected by the Pages outage.
  if (!publishConfig.dryRun && !store.setting('pages-recovery-20261005')) {
    const failed = store.db.prepare(`SELECT group_id AS groupId FROM jobs j
      WHERE id=(SELECT MAX(id) FROM jobs WHERE group_id=j.group_id)
      AND (status='publishing' OR (status='failed' AND error LIKE '%Public asset did not match%'))`)
      .all() as { groupId: number }[];
    for (const row of failed) store.queuePublish(row.groupId);
    store.setSetting('pages-recovery-20261005','queued');
    console.log(`Queued ${failed.length} interrupted public-data publications for recovery.`);
  }
  console.log('Wreckshop Worlds service ready.');
  setInterval(async () => {
    if (publishing) return;
    publishing = true;
    try {
      const result = await processOneJob(store,publishConfig);
      if (result) { console.log(result); await auditLog(client.guilds.cache.get(guildId) ?? null,result); }
    } catch (error) { console.error('Publishing job failed:', error); }
    finally { publishing = false; }
  },30_000);
});
await client.login(token);

