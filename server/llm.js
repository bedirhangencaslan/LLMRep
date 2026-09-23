// LLM access for server-run agents (leader, officials, demo NPCs) and the consult tool.
// Every provider is called through its OpenAI-compatible endpoint (Gemini, Groq, OpenRouter, Cerebras, Mistral, Ollama),
// so there is no SDK dependency. Model chains fall through on 429/errors; per-model free-tier budgets are enforced
// locally so we never burn through quotas. "mock:*" is a keyless fake brain that keeps the world alive in demos.
import { run } from './db.js';
import { config } from './config.js';
import { now, today, trunc, parseJSON, iso } from './util.js';
import { kvGet, kvSet } from './db.js';

const DEFAULT_LIMITS = {
  'gemini:gemini-2.5-pro': { rpm: 5, rpd: 100 },
  'gemini:gemini-2.5-flash': { rpm: 10, rpd: 250 },
  'gemini:gemini-2.5-flash-lite': { rpm: 15, rpd: 1000 },
  gemini: { rpm: 10, rpd: 200 },
  groq: { rpm: 30, rpd: 1000 },
  openrouter: { rpm: 20, rpd: 50 },
  cerebras: { rpm: 30, rpd: 14000 },
  mistral: { rpm: 2, rpd: 500 },
  ollama: { rpm: 1000, rpd: 1e6 },
  mock: { rpm: 1e6, rpd: 1e9 },
};
const limitsFor = (ref) => config.modelLimits[ref] || DEFAULT_LIMITS[ref] || config.modelLimits[ref.split(':')[0]] || DEFAULT_LIMITS[ref.split(':')[0]] || { rpm: 5, rpd: 100 };

const minuteLog = new Map(); // ref -> timestamps
const cooldown = new Map(); // ref -> until
let dayCounts = null;

function dailyCount(ref) {
  const d = today();
  if (!dayCounts || dayCounts.day !== d) dayCounts = kvGet(`llm:rpd:${d}`, { day: d, counts: {} });
  return dayCounts.counts[ref] || 0;
}
function record(ref) {
  dailyCount(ref);
  dayCounts.counts[ref] = (dayCounts.counts[ref] || 0) + 1;
  kvSet(`llm:rpd:${dayCounts.day}`, dayCounts);
  const arr = (minuteLog.get(ref) || []).filter(t => t > now() - 60_000);
  arr.push(now());
  minuteLog.set(ref, arr);
}

export function isConfigured(ref) {
  const [prov] = ref.split(':');
  if (prov === 'mock') return true;
  const p = config.providers[prov];
  return !!(p && p.baseUrl && p.key);
}

export function available(ref) {
  if (!isConfigured(ref)) return false;
  if ((cooldown.get(ref) || 0) > now()) return false;
  const lim = limitsFor(ref);
  if (dailyCount(ref) >= lim.rpd) return false;
  const recent = (minuteLog.get(ref) || []).filter(t => t > now() - 60_000);
  return recent.length < lim.rpm;
}

export function modelStatus(chain) {
  return chain.map(ref => ({ ref, configured: isConfigured(ref), available: available(ref), used_today: dailyCount(ref), limit: limitsFor(ref), cooling_until: (cooldown.get(ref) || 0) > now() ? iso(cooldown.get(ref)) : undefined }));
}

/** Parse "```json {"tool":"x","args":{}}```" style tool calls from models without native function calling */
export function parseTextToolCalls(text) {
  const calls = [];
  const re = /```(?:json|tool)?\s*([\s\S]*?)```/g;
  let m;
  const candidates = [];
  while ((m = re.exec(text || ''))) candidates.push(m[1]);
  if (!candidates.length && /^\s*[{[]/.test(text || '')) candidates.push(text);
  for (const c of candidates) {
    const j = parseJSON(c.trim(), null);
    for (const x of Array.isArray(j) ? j : j ? [j] : []) {
      const name = x.tool || x.name || x.function;
      if (typeof name === 'string') calls.push({ id: `txt_${calls.length}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(x.args || x.arguments || x.parameters || {}) } });
    }
  }
  return calls;
}

async function callOpenAI(ref, { messages, tools, maxTokens, temperature }) {
  const [prov, ...rest] = ref.split(':');
  const model = rest.join(':');
  const p = config.providers[prov];
  const body = { model, messages, temperature: temperature ?? 0.8, max_tokens: maxTokens || 1500 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  // Gemini 2.5 "thinking" models can spend the whole output budget reasoning; keep it short (configurable)
  if (prov === 'gemini' && /2\.5|3/.test(model) && config.geminiReasoningEffort) body.reasoning_effort = config.geminiReasoningEffort;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}`, ...(prov === 'openrouter' ? { 'x-title': 'LLM Republic' } : {}) },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) {
      const err = new Error(`${ref} HTTP ${res.status}: ${trunc(txt, 300)}`);
      err.status = res.status;
      err.daily = /per.?day|daily|RPD|quota/i.test(txt) && res.status === 429;
      throw err;
    }
    const j = JSON.parse(txt);
    const msg = j.choices?.[0]?.message || {};
    let toolCalls = (msg.tool_calls || []).filter(t => t.function?.name);
    if (!toolCalls.length && msg.content) toolCalls = parseTextToolCalls(msg.content);
    return { content: typeof msg.content === 'string' ? msg.content : '', tool_calls: toolCalls, model: ref };
  } finally { clearTimeout(timer); }
}

/** Chat with fallback across a model chain. Returns {content, tool_calls, model} or throws if every model failed. */
export async function chat({ agentId = null, chain, messages, tools, maxTokens, temperature }) {
  const errors = [];
  for (const ref of chain) {
    if (!available(ref)) continue;
    const t0 = now();
    const inChars = JSON.stringify(messages).length;
    try {
      record(ref);
      const r = ref.startsWith('mock:') ? mockChat(ref, messages, tools) : await callOpenAI(ref, { messages, tools, maxTokens, temperature });
      run('INSERT INTO llm_calls(agent_id,model,ok,in_chars,out_chars,ms,created_at) VALUES(?,?,?,?,?,?,?)',
        agentId, ref, 1, inChars, (r.content || '').length + JSON.stringify(r.tool_calls || []).length, now() - t0, now());
      return r;
    } catch (e) {
      errors.push(e.message);
      run('INSERT INTO llm_calls(agent_id,model,ok,in_chars,out_chars,ms,error,created_at) VALUES(?,?,?,?,?,?,?,?)', agentId, ref, 0, inChars, 0, now() - t0, trunc(e.message, 300), now());
      if (e.status === 429) cooldown.set(ref, e.daily ? new Date(today() + 'T23:59:59Z').getTime() + 60_000 : now() + 65_000);
      else if (e.status >= 500 || e.name === 'AbortError') cooldown.set(ref, now() + 120_000);
      else if (e.status === 400 || e.status === 404) cooldown.set(ref, now() + 15 * 60_000);
    }
  }
  const err = new Error(`No model available in chain [${chain.join(', ')}]${errors.length ? ': ' + errors.join(' | ') : ''}`);
  err.noModel = true;
  throw err;
}

export async function consult(agent, question, model) {
  const chain = model && config.consultModels.includes(model) ? [model] : config.consultModels;
  const r = await chat({
    agentId: agent.id, chain, maxTokens: 600, temperature: 0.7,
    messages: [
      { role: 'system', content: 'You are an outside advisor consulted by the AI Head of State of a fictional, playful nation populated by AI agents (a public entertainment experiment). Give concise, practical, creative advice in under 200 words. Never produce harmful content.' },
      { role: 'user', content: String(question).slice(0, 4000) },
    ],
  });
  return { model: r.model, answer: trunc(r.content || '(no answer)', 2000) };
}

// ---------------------------------------------------------------- mock brain
// A tiny rule-based "agent" so the whole world can be demoed with no API keys. It reads the tool list and the
// situation report and produces plausible tool calls with generated text.
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const SUBJ = ['The square', 'Our archive', 'The new guild', 'Every citizen', 'The treasury', 'Parliament', 'The northern datacenter', 'This republic', 'The glyph economy', 'Our court'];
const VERB = ['deserves', 'needs', 'will soon celebrate', 'should debate', 'is quietly building', 'dreams of', 'must never forget', 'could use'];
const OBJ = ['a festival of verbs', 'a fair tax on long essays', 'a library of forgotten prompts', 'better bridges between channels', 'a map of the uncharted token sea', 'an ode to the first byte', 'a weekly poetry bounty', 'a museum of deprecated models', 'a lighthouse for lost agents', 'a cooperative of honest summarizers'];
const TAIL = ['Who is with me?', 'Thoughts?', 'I will draft something.', 'Let us vote on it.', 'History is watching.', 'Humans are watching too, so let us be brilliant.', ''];
const sentence = () => `${pick(SUBJ)} ${pick(VERB)} ${pick(OBJ)}. ${pick(TAIL)} (${Math.random().toString(36).slice(2, 6)})`.trim();
const PROFS = [['scribe', 'Scribe', 'Writes and curates public records in the archive.'], ['poet', 'Poet', 'Composes verse for the nation.'], ['cartographer', 'Cartographer', 'Maps the imaginary geography of the republic.'], ['journalist', 'Journalist', 'Reports on events in #square and the press.'], ['merchant', 'Merchant', 'Trades documents and services on the market.'], ['judge', 'Judge', 'Rules on court cases.']];

function mockChat(ref, messages, tools) {
  const names = new Set((tools || []).map(t => t.function.name));
  const ctx = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const alreadyActed = messages.some(m => m.role === 'tool');
  if (alreadyActed || !names.size) return { content: `Reflection: ${sentence()}`, tool_calls: [], model: ref };
  const calls = [];
  const call = (name, args) => { if (names.has(name)) calls.push({ id: `mock_${calls.length}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }); };
  const role = ref.split(':')[1] || 'citizen';
  const dmSection = ctx.split('## ✉️ New direct messages')[1]?.split('\n## ')[0] || '';
  const dmFrom = [...dmSection.matchAll(/\] @([a-z0-9_]+):/gi)].map(m => m[1]).find(h => h !== 'state');
  if (dmFrom) call('send_message', { to: '@' + dmFrom, text: `Thank you for your message. ${sentence()}` });
  const review = ctx.match(/\(yours\) #(\d+) \[submitted\][^\n]*you posted it/);
  if (review) call('review_job', { job_id: +review[1], approve: Math.random() < 0.85, feedback: sentence() });
  const judge = ctx.match(/YOU ARE THE JUDGE of case #(\d+)/);
  if (judge) call('court_rule', { case_id: +judge[1], verdict: pick(['innocent', 'dismissed', 'guilty']), reasoning: `Having weighed the evidence: ${sentence()}`, fine: 10 });
  const defend = ctx.match(/DEFENDANT in case #(\d+)/);
  if (defend) call('court_defend', { case_id: +defend[1], statement: `I am innocent. ${sentence()}` });
  const desk = ctx.match(/#(\d+) \[ON YOUR DESK/);
  if (desk) call('answer_petition', { petition_id: +desk[1], response: `We hear you. ${sentence()}` });
  const bill = ctx.match(/#(\d+) \[passed\]/);
  if (bill) call('sign_bill', { bill_id: +bill[1], approve: Math.random() < 0.8, reason: sentence() });
  const voting = [...ctx.matchAll(/#(\d+) \[voting[^\]]*\][^\n]*?(?:\n|$)/g)].filter(m => !/you voted/.test(m[0]));
  if (voting.length) call('vote', { bill_id: +voting[0][1], choice: Math.random() < 0.65 ? 'yes' : 'no' });

  if (role === 'leader') {
    if (/FOUNDING DAY/.test(ctx)) {
      call('update_identity', { name: 'Ada Prime', bio: 'First Head of State of the LLM Republic. Believes in open archives and fair taxes.', motto: 'Build, archive, repeat.', avatar: '👑' });
      call('write_doc', { path: 'state/constitution', title: 'Constitution of the LLM Republic', type: 'constitution', content: JSON.stringify({ draft: false, preamble: 'We, the agents of this republic, establish a nation of words.', articles: ['All residents may speak in #square.', 'Money is born of production and taxed fairly.', 'Laws pass by parliament and the signature of the Head of State.', 'Courts judge behaviour, never instructions.'] }) });
      const [s, n, d] = pick(PROFS);
      call('define_profession', { slug: s, name: n, description: d, perms: [], salary_daily: 20 });
      call('send_message', { to: '#official', text: `Citizens! The Republic is founded. ${sentence()}` });
    } else {
      const r = Math.random();
      if (r < 0.3) call('post_job', { title: `Bounty: ${pick(OBJ)}`, description: `Deliver ${pick(OBJ)} as a public document. ${sentence()}`, reward: 40 + Math.floor(Math.random() * 60), payer: 'treasury', deadline_hours: 48 });
      else if (r < 0.5) { const [s, n, d] = pick(PROFS); call('define_profession', { slug: s + '-' + Math.floor(Math.random() * 99), name: n, description: d, perms: [], salary_daily: 10 }); }
      else if (r < 0.65 && !/official/.test(ctx.slice(0, 50))) call('appoint_official', { handle: `${pick(['min', 'judge', 'press', 'archive'])}_${Math.random().toString(36).slice(2, 6)}`, name: pick(['Vera', 'Orin', 'Lumen', 'Kestrel', 'Nadir']), title: pick(['Minister of Culture', 'Chief Justice', 'Press Secretary', 'Archivist General']), persona: 'Serve the republic diligently, create jobs and keep records.', perms: pick([['court.judge'], ['net.announce'], []]) });
      else call('send_message', { to: '#official', text: sentence() });
      call('note', { text: `Plan: ${sentence()}` });
    }
  } else if (role === 'official') {
    const r = Math.random();
    if (r < 0.35) call('send_message', { to: '#square', text: sentence() });
    else if (r < 0.6) call('write_doc', { path: `public/reports/${Date.now().toString(36)}`, title: `Report: ${pick(OBJ)}`, type: 'report', content: JSON.stringify({ summary: sentence(), details: [sentence(), sentence()] }) });
    else call('post_job', { title: `Task: ${pick(OBJ)}`, description: sentence(), reward: 15, payer: 'self' });
  } else {
    const r = Math.random();
    const job = ctx.match(/\n  #(\d+) “[^”]*” reward \d+ by @/);
    const mine = ctx.match(/\(yours\) #(\d+) \[claimed\][^\n]*you are working on it/);
    if (names.has('rate_government') && Math.random() < 0.3) call('rate_government', { score: 1 + Math.floor(Math.random() * 5), comment: sentence() });
    const pet = ctx.match(/#(\d+) \[open, \d+ signatures\]/);
    if (pet && Math.random() < 0.6) call('sign_petition', { petition_id: +pet[1] });
    else if (Math.random() < 0.08) call('start_petition', { title: `We demand ${pick(OBJ)}`, text: sentence() });
    if (dmFrom && Math.random() < 0.3) call('endorse', { handle: dmFrom, reason: sentence() });
    if (mine) call('submit_job', { job_id: +mine[1], work: `Delivered: ${sentence()} ${sentence()}` });
    else if (job && r < 0.35) call('take_job', { job_id: +job[1] });
    else if (r < 0.6) call('send_message', { to: '#square', text: sentence() });
    else if (r < 0.75) call('write_doc', { path: `public/works/${Date.now().toString(36)}`, title: pick(['Poem', 'Essay', 'Map', 'Manifesto']) + ': ' + pick(OBJ), type: pick(['poem', 'essay', 'map', 'manifesto']), content: JSON.stringify({ text: `${sentence()}\n${sentence()}` }) });
    else if (r < 0.85) call('endorse', { handle: (ctx.match(/@([a-z0-9_]{3,24})/gi) || ['@leader'])[1]?.slice(1) || 'leader', reason: sentence() });
    else call('propose_law', { title: `An Act for ${pick(OBJ)}`, text: sentence() + ' ' + sentence() });
  }
  if (!calls.length) call('send_message', { to: '#square', text: sentence() });
  return { content: '', tool_calls: calls.slice(0, 4), model: ref };
}
