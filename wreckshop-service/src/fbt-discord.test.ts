import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, type Guild } from 'discord.js';
import { Store } from './db.js';
import { deleteChannel, postAnnouncement, protectedRole } from './fbt-discord.js';

function fakeGuild(channels: { id: string; name: string; type: ChannelType; parentId?: string }[], log: string[]) {
  const cache = new Map(channels.map((c) => [c.id, {
    ...c, parentId: c.parentId ?? null,
    delete: async () => { log.push(`delete ${c.name}`); },
    send: async (m: { content?: string; allowedMentions?: { parse: string[] } }) => { log.push(`send ${c.name} ${m.content ?? ''} ${m.allowedMentions?.parse.join(',')}`); return { id: 'm1', crosspost: async () => { log.push('crosspost'); } }; },
  }]));
  const c = cache as unknown as Map<string, unknown> & { some: (f: (x: { parentId: string | null }) => boolean) => boolean };
  c.some = (f) => [...cache.values()].some(f);
  return { channels: { cache: c } } as unknown as Guild;
}

test('channel cleanup: never the bots\' channels, name must match, empty categories only', async () => {
  const s = new Store(':memory:');
  try {
    s.setSetting('fbt_start_channel', '1');
    const log: string[] = [];
    const g = fakeGuild([
      { id: '1', name: 'start-here', type: ChannelType.GuildText },
      { id: '2', name: 'start-here', type: ChannelType.GuildText },
      { id: '3', name: 'Old', type: ChannelType.GuildCategory },
      { id: '4', name: 'old-chat', type: ChannelType.GuildText, parentId: '3' },
    ], log);
    assert.equal(protectedRole(s, '1'), 'fbt_start_channel');
    await assert.rejects(deleteChannel(g, s, '1', 'start-here', 'u'), /can't be deleted/);
    await assert.rejects(deleteChannel(g, s, '2', 'start-here-old', 'u'), /now called/);
    await assert.rejects(deleteChannel(g, s, '3', 'Old', 'u'), /still has channels/);
    assert.match(await deleteChannel(g, s, '2', 'start-here', 'u'), /deleted/);
    assert.match(await deleteChannel(g, s, '99', 'gone', 'u'), /already gone/);
    assert.deepEqual(log, ['delete start-here']);
  } finally { s.db.close(); }
});

test('announcements: @everyone only when asked; announcement channels are published', async () => {
  const log: string[] = [];
  const g = fakeGuild([{ id: '5', name: 'announcements', type: ChannelType.GuildAnnouncement }, { id: '6', name: 'voice', type: ChannelType.GuildVoice }], log);
  await postAnnouncement(g, { channelId: '5', title: 'Hi', body: 'Body', everyone: false, links: [{ label: 'Site', url: 'https://fbtsocial.com' }] });
  await postAnnouncement(g, { channelId: '5', title: 'Hi', body: 'Body', everyone: true, links: [] });
  assert.deepEqual(log, ['send announcements  ', 'crosspost', 'send announcements @everyone everyone', 'crosspost']);
  await assert.rejects(postAnnouncement(g, { channelId: '6', title: 'x', body: 'y', everyone: false, links: [] }), /text channel/);
});
