import test from 'node:test';
import assert from 'node:assert/strict';
import { findTierRoles, levelFor, planRoles } from './fbt-roles.js';

const roles = [
  { id: '1', name: 'Verified' }, { id: '2', name: 'Premium Group' }, { id: '3', name: 'Standard Group' },
  { id: '4', name: 'Headliner' }, { id: '5', name: 'premium-chat-access' },
];

test('tier roles found by name, "… Group" preferred, settings win', () => {
  assert.deepEqual(findTierRoles(roles, () => undefined), { headliner: '4', premium: '2', standard: '3' });
  assert.equal(findTierRoles(roles, (k) => (k === 'fbt_role_premium' ? '5' : undefined)).premium, '5');
  assert.deepEqual(findTierRoles([{ id: '9', name: 'Members' }], () => undefined), { headliner: undefined, premium: undefined, standard: undefined });
  assert.equal(findTierRoles([{ id: '5', name: 'premium-chat-access' }], () => undefined).premium, undefined, 'never guesses a look-alike role');
});

test('levels: headliner > premium > verified standard; unverified standard gets none', () => {
  assert.equal(levelFor({ tier: 'premium', level: 'headliner' }, false), 'headliner');
  assert.equal(levelFor({ tier: 'premium', level: null }, false), 'premium');
  assert.equal(levelFor({ tier: 'standard' }, true), 'standard');
  assert.equal(levelFor({ tier: 'standard' }, false), null);
});

test('each rep ends up with exactly their tier role; non-members skipped; nothing else touched', () => {
  const r = findTierRoles(roles, () => undefined);
  const has = new Map<string, Set<string>>([
    ['a', new Set(['1'])],            // new standard rep
    ['b', new Set(['1', '3'])],       // standard → premium
    ['c', new Set(['4'])],            // already headliner
    ['d', new Set(['2', '5'])],       // premium dropped to unverified standard
  ]);
  const plan = planRoles(new Map([['a', 'standard'], ['b', 'premium'], ['c', 'headliner'], ['d', null], ['gone', 'premium']]), r, (u) => has.get(u));
  assert.deepEqual(plan, [
    { userId: 'a', add: ['3'], remove: [] },
    { userId: 'b', add: ['2'], remove: ['3'] },
    { userId: 'd', add: [], remove: ['2'] },
  ]);
});
