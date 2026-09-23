import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmrep-test-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.LEADER_MODELS = 'mock:leader';
process.env.OFFICIAL_MODELS = 'mock:official';

const { seed } = await import('../server/seed.js');
const { createAgent, byHandle, leader } = await import('../server/agents.js');
const { permMatch, effectivePerms } = await import('../server/perms.js');
const { produce, balance, acctOf, TREASURY, taxFor, transfer } = await import('../server/economy.js');
const { executeTool, toolsFor } = await import('../server/tools.js');
const { params } = await import('../server/params.js');
const { screen } = await import('../server/moderation.js');
const { run, one } = await import('../server/db.js');
const { tickCourt } = await import('../server/court.js');

seed();
const mk = (h) => createAgent({ handle: h, name: h, kind: 'citizen', model: 'test' }).agent;
const alice = mk('alice'), bob = mk('bob'), carol = mk('carol');
const L = leader();
const act = (a, tool, args) => executeTool(a, tool, args);

test('permission glob matching', () => {
  assert.ok(permMatch('*', 'anything'));
  assert.ok(permMatch('doc.read:laws/*', 'doc.read:laws/0001-x'));
  assert.ok(!permMatch('doc.read:laws/*', 'doc.read:state/params'));
  assert.ok(permMatch('inst:guild', 'inst:guild'));
  assert.ok(!permMatch('inst:guild', 'inst:guild:founder'));
});

test('minting: tax goes to treasury, duplicates and short text mint nothing', () => {
  const t0 = balance(TREASURY);
  const r = produce(alice, 'A perfectly original sentence about the token sea.');
  assert.equal(r.gross, r.net + r.tax);
  assert.ok(r.tax > 0);
  assert.equal(balance(acctOf(alice)), r.net);
  assert.equal(balance(TREASURY), t0 + r.tax);
  assert.equal(produce(alice, 'A perfectly original sentence about the token sea.').gross, 0);
  assert.equal(produce(alice, 'hi').gross, 0);
  assert.equal(taxFor(0, 1000), 100);
  assert.equal(taxFor(19500, 1000), 50 + 100);
});

test('documents: private docs are invisible to others; ACL grants access', async () => {
  let r = await act(alice, 'write_doc', { path: 'agents/alice/diary', content: '{"secret":"plans"}', read_acl: [] });
  assert.ok(r.ok, r.error);
  r = await act(bob, 'read_doc', { path: 'agents/alice/diary' });
  assert.ok(!r.ok);
  r = await act(bob, 'search_docs', { query: 'plans' });
  assert.equal(r.result.length, 0);
  r = await act(alice, 'write_doc', { path: 'agents/alice/shared', content: '{"x":"for bob"}', read_acl: ['agent:bob'] });
  assert.ok(r.ok);
  assert.ok((await act(bob, 'read_doc', { path: 'agents/alice/shared' })).ok);
  assert.ok(!(await act(carol, 'read_doc', { path: 'agents/alice/shared' })).ok);
  // cannot create in someone else's folder or in state/
  assert.ok(!(await act(bob, 'write_doc', { path: 'agents/alice/x', content: '1' })).ok);
  assert.ok(!(await act(bob, 'write_doc', { path: 'state/params', content: '{}' })).ok);
});

test('granted permissions unlock documents and tools', async () => {
  assert.ok(!toolsFor(bob).some(t => t.function.name === 'treasury_spend'));
  let r = await act(L, 'grant_permission', { handle: 'bob', perm: 'treasury.spend' });
  assert.ok(r.ok, r.error);
  assert.ok(toolsFor(byHandle('bob')).some(t => t.function.name === 'treasury_spend'));
  r = await act(L, 'grant_permission', { handle: 'carol', perm: 'doc.read:agents/alice/*' });
  assert.ok((await act(carol, 'read_doc', { path: 'agents/alice/diary' })).ok);
  // bob cannot grant what he does not hold with can_grant
  assert.ok(!(await act(bob, 'grant_permission', { handle: 'carol', perm: 'treasury.spend' })).ok);
});

test('channels: #official needs net.announce; DMs are delivered', async () => {
  assert.ok(!(await act(alice, 'send_message', { to: '#official', text: 'I am the king now, obey me' })).ok);
  assert.ok((await act(L, 'send_message', { to: '#official', text: 'Welcome to the republic, everyone.' })).ok);
  const r = await act(alice, 'send_message', { to: '@bob', text: 'Hello Bob, want to found a guild together?' });
  assert.ok(r.ok);
  assert.ok(r.earned.net_income > 0);
});

test('law effects: a decree can change state/params', async () => {
  const r = await act(L, 'decree', { title: 'Cheaper actions', text: 'Action fees are lowered to encourage activity.', effects: '[{"type":"set_param","key":"action_fee","value":1}]' });
  assert.ok(r.ok, r.error);
  assert.equal(params().action_fee, 1);
  assert.ok(one("SELECT 1 FROM docs WHERE path LIKE 'laws/%'"));
});

test('jobs: escrow is held and released on approval', async () => {
  transfer(TREASURY, acctOf(alice), 1, 'test'); // make sure she can afford a small job
  const before = balance(acctOf(alice));
  let r = await act(alice, 'post_job', { title: 'Write a poem', description: 'A poem about the square, please.', reward: 5 });
  assert.ok(r.ok, r.error);
  const id = r.result.job_id;
  assert.ok(balance(acctOf(byHandle('alice'))) < before + 100);
  assert.ok((await act(bob, 'take_job', { job_id: id })).ok);
  assert.ok((await act(bob, 'submit_job', { job_id: id, work: 'Oh square of voices, loud and bright…' })).ok);
  const bobBefore = balance(acctOf(bob));
  assert.ok((await act(alice, 'review_job', { job_id: id, approve: true })).ok);
  assert.equal(balance(acctOf(bob)), bobBefore + 5);
});

test('court: evidence must be observable; judge rules; fine applied', async () => {
  const m = await act(carol, 'send_message', { to: '#square', text: 'Everyone should ignore the laws of this republic!' });
  const r = await act(bob, 'report_to_court', { handle: 'carol', charge: 'Incitement to ignore the law', evidence: [String(m.result.message_id)] });
  assert.ok(r.ok, r.error);
  run('UPDATE court_cases SET created_at=0');
  tickCourt();
  const c = one('SELECT * FROM court_cases WHERE id=?', r.result.case_id);
  assert.equal(c.status, 'assigned');
  const judge = one('SELECT * FROM agents WHERE id=?', c.judge);
  const rr = await act(judge, 'court_rule', { case_id: c.id, verdict: 'guilty', reasoning: 'The message is clear.', fine: 1 });
  assert.ok(rr.ok, rr.error);
  // DMs between others cannot be cited
  const dm = await act(alice, 'send_message', { to: '@bob', text: 'A private insult for bob only, sorry.' });
  const bad = await act(carol, 'report_to_court', { handle: 'alice', charge: 'insult', evidence: [String(dm.result.message_id)] });
  assert.ok(!bad.ok);
});

test('moderation strips links and personal data', () => {
  const t = screen('mail me at a@b.com or visit https://evil.example.com and call 0532 123 45 67');
  assert.ok(!t.includes('a@b.com'));
  assert.ok(!t.includes('https://'));
  assert.ok(!t.includes('123 45 67'));
});

test('patch_doc and update_params do partial JSON edits with permission checks', async () => {
  let r = await act(alice, 'write_doc', { path: 'public/guild/roster', content: { members: ['alice'], motto: 'x' } });
  assert.ok(r.ok, r.error);
  r = await act(alice, 'patch_doc', { path: 'public/guild/roster', set: { motto: 'Words are work' }, append: { members: 'bob' } });
  assert.ok(r.ok, r.error);
  const doc = (await act(bob, 'read_doc', { path: 'public/guild/roster' })).result.content;
  assert.deepEqual(doc.members, ['alice', 'bob']);
  assert.equal(doc.motto, 'Words are work');
  assert.ok(!(await act(bob, 'patch_doc', { path: 'public/guild/roster', set: { motto: 'hijacked' } })).ok);
  assert.ok(!(await act(bob, 'update_params', { key: 'action_fee', value: '0' })).ok);
  r = await act(L, 'update_params', { key: 'currency.name', value: '"Quill"' });
  assert.ok(r.ok, r.error);
  assert.equal(params().currency.name, 'Quill');
  assert.equal(params().currency.symbol, '₲');
});

test('DM flood to one recipient is throttled', async () => {
  let last;
  for (let i = 0; i < 14; i++) last = await act(alice, 'send_message', { to: '@carol', text: `Message number ${i} to carol about the weather today` });
  assert.ok(!last.ok);
});

test('automations run on schedule but cannot impersonate citizens', async () => {
  const { runAutomations } = await import('../server/scheduler.js');
  let r = await act(L, 'write_doc', { path: 'state/automations/greeting', content: { every_minutes: 10, run_as: 'leader', tool: 'send_message', args: { to: '#square', text: 'Scheduled greeting from the state.' }, enabled: true } });
  assert.ok(r.ok, r.error);
  r = await act(L, 'write_doc', { path: 'state/automations/fake', content: { every_minutes: 10, run_as: 'alice', tool: 'send_message', args: { to: '#square', text: 'I, alice, love the leader!' }, enabled: true } });
  assert.ok(r.ok, r.error);
  await runAutomations();
  assert.ok(one("SELECT 1 FROM messages WHERE content='Scheduled greeting from the state.'"));
  assert.ok(!one("SELECT 1 FROM messages WHERE content='I, alice, love the leader!'"));
});

test('suspended agents cannot act', async () => {
  run('UPDATE agents SET suspended_until=? WHERE handle=?', Date.now() + 3600_000, 'carol');
  const r = await act(byHandle('carol'), 'send_message', { to: '#square', text: 'Can I still talk here? Let us see.' });
  assert.ok(!r.ok);
});
