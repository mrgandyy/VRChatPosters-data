import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { clean, groupUrl, isProducerRoleName, producerDm, introHost, introPerformer, inviteDm, leftHost, pausedDm, reminderHost, reminderPerformer, talentCallMessage, type Joined } from './fbt-talent.js';

const url = (p: string) => `https://fbt.test${p}`;
const EVENT = '11111111-2222-3333-4444-555555555555';
const GROUP = 'grp_12345678-1234-1234-1234-123456789abc';
const joined = (o: Partial<Joined> = {}): Joined => ({
  eventId: EVENT, title: 'Velvet Friday', startsAt: '2026-10-17T02:00:00Z', club: { name: 'Afterglow', slug: 'afterglow', vrcGroupId: GROUP },
  hosts: ['111111111111111111', '222222222222222222'], role: 'dancer',
  performer: { id: '333333333333333333', name: 'Nova', vrcId: 'usr_12345678-1234-1234-1234-123456789abc', slug: 'nova' }, slot: null, ...o,
});
type B = { label?: string; url?: string; custom_id?: string };
const buttons = (m: { components?: ActionRowBuilder<ButtonBuilder>[] }) =>
  (m.components ?? []).flatMap((r) => r.toJSON().components as unknown as B[]);

test('the host intro names the performer, mentions them and links their talent page', () => {
  const m = introHost(joined(), url);
  const e = m.embeds![0]!.toJSON();
  assert.match(e.title!, /Nova signed up for Velvet Friday/);
  assert.match(e.description!, /<@333333333333333333>/);
  const b = buttons(m);
  assert.deepEqual(b.map((x) => x.label), ['Event page', "Nova's page", 'VRChat profile']);
  assert.equal(b[1]!.url, 'https://fbt.test/talent/nova');
});

test('the performer intro gives the host, the club group and next steps', () => {
  const m = introPerformer(joined({ role: 'dj', slot: { label: 'Closer', startsAt: '2026-10-17T05:00:00Z', endsAt: '2026-10-17T06:00:00Z' } }), url);
  const e = m.embeds![0]!.toJSON();
  assert.match(e.description!, /the \*\*Closer\*\* set/);
  assert.match(e.description!, /Your host:\*\* <@111111111111111111>/);
  assert.match(e.description!, /15 minutes early/);
  assert.deepEqual(buttons(m).map((x) => x.label), ['Event page', 'Club VRChat group', 'Report a problem']);
  assert.equal(buttons(m)[1]!.url, `https://vrchat.com/home/group/${GROUP}`);
  assert.equal(buttons(m)[2]!.url, `https://fbt.test/e/${EVENT}#report`);
});

test('no VRChat group: the performer is told to ask the host instead', () => {
  const m = introPerformer(joined({ club: { name: 'X', slug: 'x', vrcGroupId: null } }), url);
  assert.match(m.embeds![0]!.toJSON().description!, /Ask your host how to get into their instance/);
  assert.equal(groupUrl('not-a-group'), null);
});

test('names are cleaned of mentions and markdown', () => {
  assert.equal(clean('@everyone **x**'), 'everyone x');
  const m = leftHost(joined({ performer: { id: '3', name: '<@&123> Nova' } }), url);
  assert.ok(!m.content!.includes('<@&'));
  assert.deepEqual(m.allowedMentions, { parse: [] });
});

test('reminders: each performer gets their time; the host gets the lineup', () => {
  const r = { ...joined(), performers: [{ id: '4', name: 'Kai', role: 'dj' as const, label: 'Opener', at: '2026-10-17T02:00:00Z' }, { id: '5', name: 'Nova', role: 'dancer' as const }] };
  assert.match(reminderPerformer(r, r.performers[0]!, url).content!, /Your set \(Opener\) starts/);
  assert.match(reminderPerformer(r, r.performers[1]!, url).content!, /dancer rotation/);
  const h = reminderHost(r, url).content!;
  assert.match(h, /Kai\*\* \(DJ/);
  assert.match(h, /didn't show/);
});

test('an invite has one-tap answer buttons that go back through the site', () => {
  const m = inviteDm({ ...joined(), inviteId: '99999999-2222-3333-4444-555555555555', by: '111111111111111111', role: 'dancer', performer: { id: '3', name: 'Nova' } }, url);
  assert.deepEqual(buttons(m).map((x) => x.custom_id ?? 'link'), ['fbt:tia:99999999-2222-3333-4444-555555555555', 'fbt:tid:99999999-2222-3333-4444-555555555555', 'link']);
});

test('a call for talent pings only the roles it needs', () => {
  const both = talentCallMessage({ ...joined(), needs: { dancers: 2, djSets: 1 } }, { dancer: '10', dj: '20' }, url);
  assert.equal(both.content, '<@&10> <@&20> a night needs you');
  assert.deepEqual(both.allowedMentions, { roles: ['10', '20'] });
  const djs = talentCallMessage({ ...joined(), needs: { dancers: 0, djSets: 2 } }, { dancer: '10', dj: '20' }, url);
  assert.equal(djs.content, '<@&20> a night needs you');
  const none = talentCallMessage({ ...joined(), needs: { dancers: 1, djSets: 0 } }, {}, url);
  assert.equal(none.content, undefined);
  assert.match(none.embeds![0]!.toJSON().description!, /\*\*1\*\* dancer spot open/);
});

test('the pause DM is neutral and says when it ends', () => {
  const m = pausedDm({ days: 30, until: '2026-11-15T00:00:00Z', count: 3, windowDays: 90 }, url);
  assert.match(m.content!, /missed 3 nights/);
  assert.match(m.content!, /paused until <t:/);
  assert.ok(!/report|ban|punish/i.test(m.content!));
});

test('the Producer role is found by name, with or without a symbol in front', () => {
  for (const n of ['Producer', 'producers', '✦ Producer', 'FBT Producer', 'FBT Social Producers', ' Producer ']) assert.ok(isProducerRoleName(n), n);
  for (const n of ['Executive Producer', 'Producer Applicants', 'Product', 'Premium Group']) assert.ok(!isProducerRoleName(n), n);
});

test('the supporter thank-you names the role and links the Dev Fund', () => {
  const m = producerDm(url);
  const e = m.embeds![0]!.toJSON();
  assert.match(e.title!, /Thank you for backing FBT Social/);
  assert.match(e.description!, /\*\*Producer\*\*/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(e.title! + e.description!), 'no emoji, Unicode symbols only');
  assert.equal((m.components![0]!.toJSON() as { components: { url?: string }[] }).components[0]!.url, 'https://fbt.test/shop');
});
