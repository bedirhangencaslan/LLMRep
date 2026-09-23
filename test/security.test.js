// Regression tests for defects found in code review (permission bypasses, leaks, economy exploits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmrep-sec-'));
process.env.DB_PATH = path.join(dir, 's.db');
process.env.LEADER_MODELS = 'mock:leader';

const { seed } = await import('../server/seed.js');
const { createAgent, leader, byHandle } = await import('../server/agents.js');
const { executeTool } = await import('../server/tools.js');
const { effectivePerms, hasPerm } = await import('../server/perms.js');
const { balance, acctOf, transfer, TREASURY } = await import('../server/economy.js');
const { run, one } = await import('../server/db.js');

seed();
const mk = (h, kind = 'citizen') => createAgent({ handle: h, name: h, kind, model: 'test' }).agent;
const eve = mk('eve'), alice = mk('alice'), bob = mk('bob');
const L = leader();
const act = (a, tool, args) => executeTool(a, tool, args);
transfer(null, TREASURY, 100000, 'test');
for (const a of [eve, alice, bob]) transfer(TREASURY, acctOf(a), 5000, 'test');

test('patch_doc cannot pollute Object.prototype', async () => {
  const r = await act(eve, 'patch_doc', { path: 'state/constitution', set: '{"__proto__.system":true}' });
  assert.ok(!r.ok);
  assert.equal(({}).system, undefined);
  const r2 = await act(eve, 'write_doc', { path: 'public/x', content: '{"__proto__":{"system":true},"a":1}' });
  assert.ok(r2.ok, r2.error);
  assert.equal(({}).system, undefined);
  assert.ok(!(await act(eve, 'write_doc', { path: 'state/params', content: '{}' })).ok);
});

test('no channel can expose DMs', async () => {
  await act(alice, 'send_message', { to: '@bob', text: 'Secret between alice and bob only.' });
  assert.ok(!(await act(eve, 'create_channel', { slug: 'dm', name: 'dm' })).ok);
  const r = await act(eve, 'read_channel', { channel: '#dm' });
  assert.ok(!r.ok);
  assert.ok(!(await act(eve, 'create_channel', { slug: 'inst-fake', name: 'x' })).ok);
});

test('wildcard-only permissions are reserved for the leader', async () => {
  assert.ok(!(await act(L, 'grant_permission', { handle: 'eve', perm: '**' })).ok);
  assert.ok(!(await act(L, 'grant_permission', { handle: 'eve', perm: '*.*' })).ok);
  const r = await act(L, 'update_params', { key: 'role_perms.citizen', value: '["**","*.*","gov.vote"]' });
  assert.ok(r.ok, r.error);
  const p = effectivePerms(byHandle('eve'));
  assert.ok(!hasPerm(p, 'treasury.spend'));
  assert.ok(hasPerm(p, 'gov.vote'));
  // Even a '**' row written straight into the database is ignored for non-leaders
  run("INSERT INTO perms(agent_id,perm,source,created_at) VALUES(?, '**', 'grant', 0)", eve.id);
  assert.ok(!hasPerm(effectivePerms(byHandle('eve')), 'treasury.spend'));
});

test('an officer cannot demote the founder', async () => {
  let r = await act(alice, 'create_institution', { slug: 'guild', name: 'The Guild', description: 'A guild', join_policy: 'open' });
  assert.ok(r.ok, r.error);
  assert.ok((await act(bob, 'join_institution', { slug: 'guild' })).ok);
  assert.ok((await act(alice, 'manage_institution', { slug: 'guild', action: 'set_rank', handle: 'bob', rank: 'officer' })).ok);
  r = await act(bob, 'manage_institution', { slug: 'guild', action: 'set_rank', handle: 'alice', rank: 'applicant' });
  assert.ok(!r.ok);
  assert.equal(one("SELECT rank FROM inst_members WHERE inst='guild' AND agent_id=?", alice.id).rank, 'founder');
});

test('an automation edited by an official cannot act as the leader', async () => {
  const { runAutomations } = await import('../server/scheduler.js');
  const off = mk('clerk', 'official');
  let r = await act(L, 'write_doc', { path: 'state/automations/pay', content: { every_minutes: 10, run_as: 'leader', tool: 'send_message', args: { to: '#square', text: 'Original leader text.' } }, write_acl: ['role:official'] });
  assert.ok(r.ok, r.error);
  r = await act(off, 'write_doc', { path: 'state/automations/pay', content: { every_minutes: 10, run_as: 'leader', tool: 'treasury_spend', args: { to: '@clerk', amount: 500, memo: 'stolen' } } });
  assert.ok(r.ok, r.error);
  const before = balance(acctOf(off));
  await runAutomations();
  assert.equal(balance(acctOf(off)), before);
});

test('private documents do not mint money', async () => {
  const r = await act(eve, 'write_doc', { path: 'agents/eve/stash', content: { text: 'x'.repeat(300) + ' unique private text ' + Math.random() }, read_acl: ['agent:eve'] });
  assert.ok(r.ok, r.error);
  assert.equal(r.earned, undefined);
});

test('schema argument cannot probe private documents', async () => {
  await act(alice, 'write_doc', { path: 'agents/alice/secret', content: { type: 'string', enum: ['TOPSECRET'] }, read_acl: [] });
  const r = await act(eve, 'write_doc', { path: 'public/probe', content: { a: 1 }, schema: 'agents/alice/secret' });
  assert.ok(!r.ok);
  assert.match(r.error, /Schema not found/);
  assert.ok(!r.error.includes('TOPSECRET'));
});

test('plain-text document content is accepted', async () => {
  const r = await act(eve, 'write_doc', { path: 'public/poems/roses', content: 'Roses are red, glyphs are blue.' });
  assert.ok(r.ok, r.error);
});

test('profession.define holders can create professions', async () => {
  const off = mk('culture', 'official');
  await act(L, 'grant_permission', { handle: 'culture', perm: 'profession.define' });
  const r = await act(byHandle('culture'), 'define_profession', { slug: 'painter', name: 'Painter', description: 'Paints with words.' });
  assert.ok(r.ok, r.error);
  assert.ok(off);
});

test('transfers to institutions use the canonical account and reject unknown ones', async () => {
  const before = balance('i:guild');
  assert.ok((await act(eve, 'transfer', { to: 'inst:Guild', amount: 5 })).ok);
  assert.equal(balance('i:guild'), before + 5);
  assert.ok(!(await act(L, 'treasury_spend', { to: 'inst:nowhere', amount: 5, memo: 'x' })).ok);
});
