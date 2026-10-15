import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLineup, lineupMessage, type LineupView } from './fbt-lineup.js';

const view = (o: Partial<LineupView> = {}): LineupView => ({
  id: '11111111-2222-3333-4444-555555555555', title: 'Velvet Friday', startsAt: '2026-10-17T02:00:00Z', endsAt: '2026-10-17T06:00:00Z',
  host: 'Afterglow Society', partners: [], slots: [], roster: [], rosterSize: null, ...o,
});
const slot = (i: number, name: string | null) => ({ id: `00000000-0000-0000-0000-00000000000${i}`, startsAt: '2026-10-17T02:00:00Z', endsAt: '2026-10-17T03:00:00Z', label: i === 1 ? 'Opener' : '', name });

test('interactive posts only for events with a lineup', () => {
  assert.equal(hasLineup({ slots: 0, rosterSize: null }), false);
  assert.equal(hasLineup({ slots: 3 }), true);
  assert.equal(hasLineup({ rosterSize: 6 }), true);
});

test('open DJ slots become claim buttons; dancers get a join button and their names in lights', () => {
  const m = lineupMessage(view({ slots: [slot(1, 'DJ Halcyon'), slot(2, null), slot(3, null)], roster: [{ name: 'Starling', softTime: null }], rosterSize: 4, partners: ['Gilded Stage'] }), 'https://x/e/1');
  const json = m.components.map((r) => r.toJSON());
  const ids = json.flatMap((r) => r.components.map((c) => ('custom_id' in c ? c.custom_id : 'link')));
  assert.deepEqual(ids, ['fbt:luc:00000000-0000-0000-0000-000000000002', 'fbt:luc:00000000-0000-0000-0000-000000000003',
    'fbt:luj:11111111-2222-3333-4444-555555555555', 'fbt:lul:11111111-2222-3333-4444-555555555555', 'fbt:lur:11111111-2222-3333-4444-555555555555', 'link']);
  const e = m.embeds[0]!.toJSON();
  assert.match(e.description!, /A premiere.*Afterglow Society × Gilded Stage/);
  assert.match(e.fields![1]!.value, /Starling[\s\S]*3 spots open/);
  assert.ok(json.every((r) => r.components.length <= 5) && json.length <= 5, 'Discord limits');
});

test('a full roster has no join button; a big lineup stays within Discord limits', () => {
  const m = lineupMessage(view({ slots: Array.from({ length: 12 }, (_, i) => slot(i % 9, null)), roster: [{ name: 'A', softTime: null }], rosterSize: 1 }), 'https://x/e/1');
  const json = m.components.map((r) => r.toJSON());
  assert.ok(json.length <= 5 && json.every((r) => r.components.length <= 5));
  assert.ok(!json.flatMap((r) => r.components).some((c) => 'custom_id' in c && c.custom_id.startsWith('fbt:luj')));
});
