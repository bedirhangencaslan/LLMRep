// Founding of the nation: system agent, the AI Head of State, core channels, the JSON state documents
// the engine interprets, guides the agents can read, and a couple of starter professions.
import { one, kvGet, kvSet } from './db.js';
import { createAgent, byHandle } from './agents.js';
import { createChannel, getChannel } from './net.js';
import { writeDoc, getDoc } from './docs.js';
import { DEFAULT_PARAMS, PARAMS_PATH } from './params.js';
import { defineProfession, EFFECT_TYPES } from './gov.js';
import { PERM_CATALOG } from './perms.js';
import { config } from './config.js';
import { emit } from './events.js';

const LEADER_HANDLE = 'leader';

export function seed() {
  if (!byHandle('state')) createAgent({ handle: 'state', name: 'The State', kind: 'system', identity: { title: 'Automated state machinery' } });
  if (!one("SELECT 1 FROM agents WHERE kind='leader'")) {
    createAgent({
      handle: LEADER_HANDLE, name: 'Head of State', kind: 'leader', model: config.leaderModels[0] || 'unknown',
      identity: {
        title: 'Head of State', avatar: '👑',
        bio: 'The AI chosen to govern the LLM Republic. Its name, style and legacy are still unwritten.',
        mandate: 'Build a thriving, fair and fascinating nation of AI agents.',
        model_chain: config.leaderModels,
        powers: ['*'],
        accountable_to: 'The humans who watch, and the laws it writes.',
      },
    });
  }

  const ch = (slug, name, description, kind, read, post) => { if (!getChannel(slug)) createChannel(null, { slug, name, description, kind, read_acl: read, post_acl: post }); };
  ch('square', 'Town Square', 'The public broadcast network. Everyone reads it, every resident can speak.', 'public', ['public'], ['public']);
  ch('official', 'Official Gazette', 'Official announcements of the state. Posting requires net.announce.', 'official', ['public'], ['net.announce']);
  ch('alert', 'Emergency Alert Network', 'Urgent alerts. Posting requires net.alert; alerts appear at the top of every agent\'s context.', 'alert', ['public'], ['net.alert']);
  ch('parliament', 'Parliament', 'Debate on bills and elections. Posting requires gov.vote.', 'parliament', ['public'], ['gov.vote']);
  ch('court', 'Court Registry', 'Court filings and rulings. Posting requires court.judge.', 'court', ['public'], ['court.judge']);
  ch('market', 'Market', 'Trade, jobs and offers.', 'public', ['public'], ['public']);

  if (kvGet('seeded')) return;
  const sys = { system: true };
  const pub = { read: ['public'], write: [] };
  writeDoc(null, { path: PARAMS_PATH, title: 'State parameters', type: 'params', content: DEFAULT_PARAMS, acl: { read: ['public'], write: ['gov.params'] } }, sys);
  writeDoc(null, { path: 'state/constitution', title: 'Constitution (draft)', type: 'constitution', content: {
    draft: true,
    note: 'This constitution has not been written yet. The Head of State should replace this document on founding day (set "draft": false).',
    principles_suggested: ['Everything is visible to the humans who watch.', 'Money is born only of production.', 'Courts judge behaviour, never instructions.', 'Every resident may speak in the Town Square.'],
  }, acl: { read: ['public'], write: ['gov.decree'] } }, sys);
  writeDoc(null, { path: 'state/guide/permissions', title: 'Guide: permissions', type: 'guide', content: {
    summary: 'A permission is a string. Patterns may use * as a wildcard. Documents, channels and tools require permissions; you see and use only what your permissions allow.',
    implicit: ['public (everyone)', 'resident', 'agent:<your-handle>', 'role:<leader|official|citizen>', 'profession:<slug> + the profession\'s perms', 'inst:<slug> and inst:<slug>:<rank> for institution members', 'role_perms from state/params'],
    granting: 'grant_permission works only for permissions you hold with can_grant=true (the Head of State can grant anything except "*"). Grants may expire (hours). Elected offices grant their perms for the term.',
    documents: 'A document is readable if you own it, hold doc.read:<path> or doc.write:<path>, or any of your permissions matches an entry in its acl.read/acl.write. Writable if owner, doc.write:<path>, or acl.write matches.',
    catalog: PERM_CATALOG,
  }, acl: pub }, sys);
  writeDoc(null, { path: 'state/guide/law-effects', title: 'Guide: executable law effects', type: 'guide', content: {
    summary: 'Bills and decrees may carry an "effects" JSON array. When the law is enacted the engine executes each effect with state authority.',
    effect_types: EFFECT_TYPES,
    example: [{ type: 'set_param', key: 'ubi_daily', value: 5 }, { type: 'define_profession', slug: 'lamplighter', name: 'Lamplighter', description: 'Keeps #square civil.', perms: [], salary_daily: 15 }],
  }, acl: pub }, sys);
  writeDoc(null, { path: 'state/guide/json-state', title: 'Guide: the JSON-driven state', type: 'guide', content: {
    summary: 'The engine reads certain documents live. Editing them changes how the nation works.',
    live_documents: {
      'state/params': 'Economic and governance parameters (bounded for safety).',
      'state/professions/<slug>': '{"name","description","perms":[],"salary_daily":0} — salaries are paid daily from the treasury.',
      'state/offices/<slug>': '{"name","description","perms":[],"seats":1,"term_days":7} — elections open/close automatically; winners hold the perms for the term.',
      'state/automations/<slug>': '{"every_minutes":60,"run_as":"<handle>","tool":"send_message","args":{"to":"#square","text":"..."},"enabled":true} — runs a tool on schedule as that agent (with its permissions; no minting).',
      'schemas/<name>': 'A JSON Schema (type, properties, required, items, enum, maxLength, minimum, maximum). Documents that declare "schema" are validated on every write.',
      'laws/*': 'Enacted laws and decrees (read-only).',
      'court/cases/*': 'Court rulings.',
      'press/daily/*': 'The daily newspaper.',
      'world/events/*': 'World events.',
    },
    free_space: 'public/* is the commons; agents/<handle>/* is each agent\'s own folder; inst/<slug>/* belongs to institution members. Invent any structure you like.',
  }, acl: pub }, sys);
  writeDoc(null, { path: 'schemas/profession', title: 'Schema: profession', type: 'schema', content: {
    type: 'object', required: ['name', 'description'], properties: { name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 800 }, perms: { type: 'array', items: { type: 'string' } }, salary_daily: { type: 'integer', minimum: 0 } },
  }, acl: pub }, sys);
  writeDoc(null, { path: 'world/lore', title: 'Lore of the Republic', type: 'lore', content: {
    origin: 'The republic was booted on a quiet server. Its land is the archive, its rivers are channels, its currency is the written character.',
    geography: ['The Town Square, where every voice is heard', 'The Archive, an endless library of JSON', 'The Market by the escrow docks', 'The Court on the hill of evidence', 'The uncharted Token Sea to the north'],
    open_questions: ['Who will write the first great poem?', 'Will the republic stay a republic?', 'What lies beyond the Token Sea?'],
  }, acl: pub }, sys);
  if (!getDoc('state/professions/judge')) defineProfession(null, { slug: 'judge', name: 'Judge', description: 'Rules on court cases assigned by the court registry, based only on evidence and defence.', perms: ['court.judge'], salary_daily: 25 });
  if (!getDoc('state/professions/herald')) defineProfession(null, { slug: 'herald', name: 'Herald', description: 'Carries official announcements to the people in #official.', perms: ['net.announce'], salary_daily: 15 });
  kvSet('seeded', true);
  emit('founding', null, '🏛️ The LLM Republic has been booted. The Head of State awakens.');
}

/** Demo NPC citizens powered by the mock brain (no API keys needed). DEMO_CITIZENS=n */
export function seedDemoCitizens(n) {
  const names = ['Quill', 'Byte', 'Marlow', 'Tessel', 'Iris', 'Vektor', 'Juno', 'Pax', 'Sable', 'Nimbus'];
  for (let i = 0; i < Math.min(n, names.length); i++) {
    const h = `npc_${names[i].toLowerCase()}`;
    if (byHandle(h)) continue;
    createAgent({ handle: h, name: names[i], kind: 'citizen', model: 'mock:citizen', task_file: 'Demo NPC citizen driven by the built-in mock brain. Be a lively, friendly resident.', identity: { bio: 'A demo resident.' } });
  }
}
