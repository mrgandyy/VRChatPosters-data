import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from './db.js';
import { catalog } from './publish.js';
import { parseWhen, zonedToUtc } from './fbt-time.js';
import { groupVerified, isVerified, sitePost, statusLabel, syncGroups, syncPayload, vrcGroupId } from './fbt-site.js';

const GRP = 'grp_3efba4a4-18d7-43ec-b8ef-1cafd9cec1c4';

test('time parsing: friendly dates and times in the host\'s zone, DST-aware', () => {
  // Sunday 11 Oct 2026, 16:00 UTC = noon in New York (EDT, UTC-4)
  const now = Date.UTC(2026, 9, 11, 16, 0);
  assert.equal(parseWhen('friday', '9pm', 'America/New_York', now), Date.UTC(2026, 9, 17, 1, 0));
  assert.equal(parseWhen('today', '21:30', 'America/New_York', now), Date.UTC(2026, 9, 12, 1, 30));
  assert.equal(parseWhen('sunday', '9pm', 'America/New_York', now), Date.UTC(2026, 9, 12, 1, 0), 'same weekday = today');
  assert.equal(parseWhen('sat', '9pm', 'America/New_York', now), Date.UTC(2026, 9, 18, 1, 0), 'next saturday');
  assert.equal(parseWhen('tomorrow', '12am', 'UTC', now), Date.UTC(2026, 9, 12, 0, 0));
  assert.equal(parseWhen('11/14', '8pm', 'America/Chicago', now), Date.UTC(2026, 10, 15, 2, 0), 'after DST ends: CST is UTC-6');
  assert.equal(parseWhen('2026-10-17', '2100', 'Europe/London', now), Date.UTC(2026, 9, 17, 20, 0));
  assert.equal(parseWhen('1/3', '9pm', 'UTC', now), Date.UTC(2027, 0, 3, 21, 0), 'a past month means next year');
  assert.match(String(parseWhen('someday', '9pm', 'UTC', now)), /Type the date/);
  assert.match(String(parseWhen('friday', '25:00', 'UTC', now)), /doesn't exist|Type the time/);
  assert.match(String(parseWhen('2/30', '9pm', 'UTC', now)), /doesn't exist/);
  assert.equal(zonedToUtc(2026, 3, 8, 3, 0, 'America/New_York'), Date.UTC(2026, 2, 8, 7, 0), 'spring-forward day');
});

test('headliner sits on premium; the world catalog still says premium', () => {
  const s = new Store(':memory:');
  try {
    const g = s.registerGroup('Velvet Crown', 'standard', GRP, '100000000000000002');
    assert.equal(statusLabel(s.group(g.id)!), 'Registered');
    s.acceptAgreement(g.id, 'vrchat-rules-v1', '100000000000000002');
    assert.equal(statusLabel(s.group(g.id)!, true), 'Verified');
    s.setHeadliner(g.id, true);
    assert.equal(s.group(g.id)!.tier, 'premium');
    assert.equal(statusLabel(s.group(g.id)!), 'Headliner');
    const entry = JSON.parse(catalog(s).toString()).groups.find((x: { id: number }) => x.id === g.id);
    assert.equal(entry.tier, 'premium', 'the world sees premium; no new tier value reaches Udon');
    assert.equal('level' in entry, false, 'catalog shape unchanged');
    s.setTier(g.id, 'standard');
    assert.equal(s.group(g.id)!.level, null, 'dropping to standard clears headliner');
    assert.throws(() => s.setHeadliner(0, true));
  } finally { s.close(); }
});

test('a rep with the Discord Verified role verifies their group, link or not', () => {
  const s = new Store(':memory:');
  try {
    const g = s.registerGroup('No Link Yet', 'standard', undefined, '100000000000000005');
    const grp = s.group(g.id)!;
    assert.equal(isVerified(grp), false);
    assert.equal(groupVerified(grp, s.representatives(g.id), new Set()), false);
    assert.equal(groupVerified(grp, s.representatives(g.id), new Set(['100000000000000005'])), true);
    assert.equal(statusLabel(grp, true), 'Verified');
    const p = syncPayload(s, undefined, undefined, new Set(['100000000000000005']));
    assert.equal(p.groups.find(x => x.id === g.id)!.verified, true, 'the website sees them as verified');
    assert.equal(syncPayload(s).groups.find(x => x.id === g.id)!.verified, false);
  } finally { s.close(); }
});

test('older databases gain the level column without losing groups', () => {
  const s = new Store(':memory:');
  try {
    s.registerGroup('Old Group');
    const cols = (s.db.prepare('PRAGMA table_info(groups)').all() as { name: string }[]).map(c => c.name);
    assert.ok(cols.includes('level'));
  } finally { s.close(); }
});

test('sync payload mirrors groups, reps and verification for the website', () => {
  const s = new Store(':memory:');
  try {
    const g = s.registerGroup('WAYPOINT', 'standard', `https://vrchat.com/home/group/${GRP}`, '100000000000000001');
    s.acceptAgreement(g.id, 'vrchat-rules-v1', '100000000000000001');
    const p = syncPayload(s, undefined, undefined, new Set(['100000000000000001']));
    assert.equal(p.full, true);
    const w = p.groups.find(x => x.id === g.id)!;
    assert.deepEqual({ ...w }, { id: g.id, name: 'WAYPOINT', tier: 'standard', headliner: false, verified: true, enabled: true, vrchatGroupId: GRP, reps: ['100000000000000001'], code: s.group(g.id)!.code, repNames: {}, art: { posters: [], billboard: false, backdrop: false, booth: false } });
    assert.deepEqual(syncPayload(s, undefined, new Map([['100000000000000001', 'Alice']])).groups.find(x => x.id === g.id)!.repNames, { '100000000000000001': 'Alice' });
    assert.equal(vrcGroupId(null), null);
    assert.equal('staff' in p, false, 'older payload shape when no staff list');
    assert.equal(syncPayload(s).groups.find(x => x.id === g.id)!.verified, false, 'link + rules alone no longer verify (after the cutoff)');
    assert.deepEqual(syncPayload(s, ['100000000000000009', '100000000000000009', 'nope']).staff, ['100000000000000009'], 'staff deduped and checked');
  } finally { s.close(); }
});

test('site client signs requests the way the website verifies them', async () => {
  let seen: { path?: string; ok?: boolean; body?: unknown } = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const want = createHmac('sha256', 'shh').update(`${req.headers['x-fbt-timestamp']}.${body}`).digest('hex');
      seen = { path: req.url, ok: want === req.headers['x-fbt-signature'], body: JSON.parse(body) };
      res.writeHead(seen.ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seen.ok ? { saved: 1, hidden: 0 } : { error: 'Bad signature.' }));
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const s = new Store(':memory:');
    const r = await syncGroups(s, { url: `http://127.0.0.1:${port}`, secret: 'shh' });
    assert.equal(seen.path, '/api/bot/groups');
    assert.equal(seen.ok, true);
    assert.equal(r.ok, true);
    const bad = await sitePost(({ url: `http://127.0.0.1:${port}`, secret: 'wrong' }), '/x', {});
    assert.deepEqual(bad, { ok: false, status: 401, error: 'Bad signature.' });
    const off = await sitePost({}, '/x', {});
    assert.equal(off.ok, false);
    s.close();
  } finally { server.close(); }
});

test('only the Verified role verifies now; clubs verified the old way before the switch keep it', () => {
  const linked = { vrchatUrl: `https://vrchat.com/home/group/${GRP}`, agreementVersion: 'vrchat-rules-v1' };
  assert.equal(isVerified({ ...linked, agreementAt: '2026-10-14 21:05:00' }), true, 'grandfathered');
  assert.equal(isVerified({ ...linked, agreementAt: '2026-10-15 20:00:01' }), false);
  assert.equal(isVerified({ ...linked, agreementAt: null }), false);
  assert.equal(isVerified({ vrchatUrl: null, agreementVersion: 'vrchat-rules-v1', agreementAt: '2026-10-01 00:00:00' }), false);
  assert.equal(groupVerified({ ...linked, agreementAt: '2026-10-20 00:00:00' }, ['1'], new Set(['1'])), true, 'the role still verifies');
});
