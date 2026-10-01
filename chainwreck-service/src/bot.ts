import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild,
  type TextChannel
} from 'discord.js';
import { join, resolve } from 'node:path';
import { Store } from './db.js';
import { MAX_SOURCE_BYTES, saveSource } from './atlas.js';
import { activateRollback, processOneJob, type PublishConfig } from './publish.js';
import type { Group } from './types.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const appId = process.env.DISCORD_APPLICATION_ID;
if (!token || !guildId || !appId) throw new Error('Set DISCORD_TOKEN, DISCORD_GUILD_ID, and DISCORD_APPLICATION_ID.');
const dataDir = resolve(process.env.CHAINWRECK_DATA_DIR ?? './data');
const store = new Store(join(dataDir,'chainwreck.sqlite'));
const publishConfig: PublishConfig = {
  token: process.env.GITHUB_TOKEN, owner: process.env.GITHUB_OWNER,
  repository: process.env.GITHUB_REPOSITORY, branch: process.env.GITHUB_BRANCH ?? 'main',
  publicBase: process.env.GITHUB_PUBLIC_BASE,
  defaultsDir: resolve(process.env.CHAINWRECK_DEFAULTS_DIR ?? './defaults'), dataDir,
  dryRun: process.env.CHAINWRECK_DRY_RUN !== 'false'
};
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let publishing = false;
const ephemeral = MessageFlags.Ephemeral;

const poster = new SlashCommandBuilder().setName('poster').setDescription('ChainWreck posters')
  .addSubcommand(s => s.setName('submit').setDescription('Submit a poster for review')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addIntegerOption(o => o.setName('slot').setDescription('Poster slot').setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Static PNG, JPEG, or WebP').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List group posters')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Restore default artwork in a slot')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addIntegerOption(o => o.setName('slot').setDescription('Poster slot').setRequired(true)));
const group = new SlashCommandBuilder().setName('group').setDescription('ChainWreck group administration')
  .addSubcommand(s => s.setName('register').setDescription('Register a partner group')
    .addStringOption(o => o.setName('name').setDescription('Group name').setRequired(true))
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
    .addStringOption(o => o.setName('url').setDescription('VRChat group URL').setRequired(true)))
  .addSubcommand(s => s.setName('accept').setDescription('Accept verified-18+ partner hosting requirement')
    .addIntegerOption(o => o.setName('group').setDescription('Group ID').setRequired(true))
    .addBooleanOption(o => o.setName('agree').setDescription('I agree to run VRChat verified-18+ instances').setRequired(true)))
  .addSubcommand(s => s.setName('mine').setDescription('View groups you represent'));
const setup = new SlashCommandBuilder().setName('cw-setup').setDescription('Set up ChainWreck channels and panel')
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
const help = new SlashCommandBuilder().setName('cw-help').setDescription('ChainWreck help');

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
    new ButtonBuilder().setCustomId('cw:submit').setLabel('Submit Poster').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cw:mine').setLabel('My Posters').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cw:groups').setLabel('Group Settings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cw:help').setLabel('Help').setStyle(ButtonStyle.Secondary));
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
    if (old?.type === ChannelType.GuildText) return old as TextChannel;
  }
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  if (existing) { store.setSetting(setting,existing.id); return existing as TextChannel; }
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
  const submissionChannel = await configuredChannel(guild,'submission_channel','chainwreck-submit',false);
  const helpChannel = await configuredChannel(guild,'help_channel','chainwreck-help',false);
  const approvals = await configuredChannel(guild,'approval_channel','chainwreck-approvals',true);
  const logs = await configuredChannel(guild,'log_channel','chainwreck-log',true);
  for (const channel of [approvals,logs]) {
    await channel.permissionOverwrites.edit(guild.roles.everyone,{ ViewChannel: false });
    await channel.permissionOverwrites.edit(guild.members.me!,{ ViewChannel: true, SendMessages: true });
    for (const key of ['reviewer_role','admin_role']) {
      const roleId = store.setting(key);
      if (roleId) await channel.permissionOverwrites.edit(roleId,{ ViewChannel: true, SendMessages: true });
    }
  }
  const oldPanel = store.setting('panel_message');
  let message;
  if (oldPanel) message = await submissionChannel.messages.fetch(oldPanel).catch(() => undefined);
  if (message) await message.edit({ content: '**ChainWreck Worlds**\nby TwerkTaco & Resolve\nSubmit free group posters below.', components: [panelRow()] });
  else {
    message = await submissionChannel.send({ content: '**ChainWreck Worlds**\nby TwerkTaco & Resolve\nSubmit free group posters below.', components: [panelRow()] });
    store.setSetting('panel_message',message.id);
  }
  await i.reply({ content: `Setup ready: ${submissionChannel} · help: ${helpChannel}. Existing channels and panel were reused where possible.`, flags: ephemeral });
  await auditLog(guild,`Setup updated by <@${i.user.id}>.`);
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
  if (groupId !== 0 && group.agreementVersion !== 'verified18-v1')
    throw new Error('A representative must use /group accept for the verified-18+ hosting agreement before submissions.');
  const slot = i.options.getInteger('slot',true);
  if (sub === 'remove') {
    store.removeOverride(groupId,slot);
    await i.reply({ content: `Slot ${slot} will return to default artwork after publication.`, flags: ephemeral });
    return;
  }
  await i.deferReply({ flags: ephemeral });
  const attachment = i.options.getAttachment('image',true);
  const bytes = await downloadAttachment(attachment.url,attachment.size);
  const paths = await saveSource(bytes,dataDir);
  const submission = store.submit(groupId,slot,i.user.id,paths.sourcePath,paths.previewPath);
  const prior = submission.previousId ? store.submission(submission.previousId) : undefined;
  const channelId = store.setting('approval_channel');
  const channel = channelId ? i.guild!.channels.cache.get(channelId) : undefined;
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Run /cw-setup to configure the approval channel. Submission is saved.');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`cw:approve:${submission.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cw:reject:${submission.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
  const files = [new AttachmentBuilder(paths.previewPath,{ name: 'proposed.png' })];
  if (prior) files.push(new AttachmentBuilder(prior.previewPath,{ name: 'previous.png' }));
  await (channel as TextChannel).send({ content: `**Poster #${submission.id}** · ${group.name} · slot ${slot}\nSubmitted by <@${i.user.id}>. ${prior ? `Previous approved poster: #${prior.id}.` : 'Previous: default artwork.'}`, files, components: [row] });
  await i.editReply(`Poster #${submission.id} is saved and awaiting review.`);
  await auditLog(i.guild,`Poster #${submission.id} submitted by <@${i.user.id}> for ${group.name} slot ${slot}.`);
}
async function handleGroup(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  if (sub === 'mine') {
    const groups = store.representedGroups(i.user.id);
    await i.reply({ content: groups.length ? groups.map(g => `#${g.id} ${g.name} · ${g.tier} · code ${g.code}`).join('\n') : 'No assigned groups.', flags: ephemeral });
    return;
  }
  if (sub === 'accept') {
    const groupId = i.options.getInteger('group',true);
    if (!store.canRepresent(groupId,i.user.id)) throw new Error('Only an assigned representative can accept for this group.');
    if (!i.options.getBoolean('agree',true)) throw new Error('Acceptance was not recorded.');
    store.acceptAgreement(groupId,'verified18-v1',i.user.id);
    await i.reply({ content: 'Acceptance recorded for verified-18+ instance hosting. This records an agreement, not automatic compliance verification.', flags: ephemeral });
    return;
  }
  if (!admin(i)) throw new Error('ChainWreck admin access is required.');
  if (sub === 'register') {
    const group = store.registerGroup(i.options.getString('name',true),
      i.options.getString('tier') === 'premium' ? 'premium' : 'standard');
    await i.reply({ content: `Registered #${group.id} ${group.name}. Shareable code: ${group.code}. Assign a representative; they must use /group accept before submissions.`, flags: ephemeral });
    await auditLog(i.guild,`Group #${group.id} ${group.name} registered by <@${i.user.id}> as ${group.tier}.`);
    return;
  }
  const groupId = i.options.getInteger('group',true);
  requiredGroup(groupId);
  if (sub === 'representative') {
    const user = i.options.getUser('user',true);
    if (i.options.getString('action',true) === 'add') store.addRepresentative(groupId,user.id);
    else store.removeRepresentative(groupId,user.id);
  } else if (sub === 'tier') store.setTier(groupId,i.options.getString('value',true) as 'standard'|'premium');
  else if (sub === 'code') store.setCode(groupId,i.options.getString('value',true));
  else if (sub === 'suspend') store.setEnabled(groupId,i.options.getBoolean('enabled',true));
  else if (sub === 'page') store.setUrl(groupId,i.options.getString('url',true));
  await i.reply({ content: `Updated ${requiredGroup(groupId).name}.`, flags: ephemeral });
  await auditLog(i.guild,`Group #${groupId} ${sub} updated by <@${i.user.id}>.`);
}
async function handlePublish(i: ChatInputCommandInteraction): Promise<void> {
  if (!admin(i)) throw new Error('ChainWreck admin access is required.');
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
  if (prefix !== 'cw') return;
  if (action === 'help' || action === 'submit') {
    await i.reply({ content: action === 'submit' ? 'Use `/poster submit` with your group ID, slot, and static image attachment. An admin must approve your representative assignment first.' :
      'ChainWreck Worlds: standard groups may use slots 1–8; admin assigned premium groups may use 1–16. Use `/group mine`, `/poster list`, and `/poster submit`.', flags: ephemeral });
    return;
  }
  if (action === 'groups' || action === 'mine') {
    const groups = store.representedGroups(i.user.id);
    const lines = groups.flatMap(g => action === 'groups' ? [`#${g.id} ${g.name} · ${g.tier} · code ${g.code}`] :
      store.submissions(g.id).filter(s => s.submitterId === i.user.id).slice(0,8).map(s => `${g.name} #${s.id} slot ${s.slot}: ${s.status}`));
    await i.reply({ content: lines.length ? lines.join('\n') : 'Nothing to show yet.', flags: ephemeral });
    return;
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
    if (interaction.commandName === 'cw-setup') await handleSetup(interaction);
    else if (interaction.commandName === 'poster') await handlePoster(interaction);
    else if (interaction.commandName === 'group') await handleGroup(interaction);
    else if (interaction.commandName === 'publish') await handlePublish(interaction);
    else if (interaction.commandName === 'cw-help') await interaction.reply({ content:
      'Advertise your group for free. Join the ChainWreck Worlds Discord to submit your posters. Use `/group mine` and `/poster submit`. A representative assignment and verified-18+ hosting agreement are required.', flags: ephemeral });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0,1500);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, flags: ephemeral }).catch(() => undefined);
      else await interaction.reply({ content: message, flags: ephemeral }).catch(() => undefined);
    }
  }
});
client.once('ready', async () => {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([poster,group,setup,publish,help]);
  console.log('ChainWreck Worlds service ready.');
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
