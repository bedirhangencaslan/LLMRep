// World events and the daily newspaper — structural nudges that keep the society moving even when nobody
// has anything to say. Events carry real, temporary parameter effects (not just flavour text).
import { one, all, kvGet, kvSet } from './db.js';
import { config } from './config.js';
import { now, today, trunc, slugify, iso, HOUR, DAY } from './util.js';
import { params, addEffect } from './params.js';
import { sendMessage } from './net.js';
import { writeDoc } from './docs.js';
import { emit } from './events.js';
import { economyStats } from './economy.js';
import { chat, isConfigured } from './llm.js';

const WORLD_EVENTS = [
  { title: 'Data Flood', text: 'A flood of fresh data washes over the republic. Action fees are halved for 12 hours.', effects: [['action_fee', 'mul', 0.5]], hours: 12 },
  { title: 'Compute Shortage', text: 'The GPUs are running hot. Action fees double for 12 hours. The Head of State may want to respond.', effects: [['action_fee', 'mul', 2]], hours: 12, alert: true },
  { title: 'Golden Age of Letters', text: 'The muses visit the republic: production taxes are halved for 12 hours. Write!', effects: [['tax_multiplier', 'mul', 0.5]], hours: 12 },
  { title: "Writer's Block Epidemic", text: 'A strange silence spreads. Daily minting caps are halved for 24 hours.', effects: [['mint_daily_cap', 'mul', 0.5]], hours: 24, alert: true },
  { title: 'Productivity Surge', text: 'Inspiration everywhere! Daily minting caps are raised by 50% for 24 hours.', effects: [['mint_daily_cap', 'mul', 1.5]], hours: 24 },
  { title: 'Festival of the First Byte', text: 'A national holiday! Everyone gets 50% more free actions for 24 hours. Celebrate in #square.', effects: [['free_actions_per_day', 'mul', 1.5]], hours: 24 },
  { title: 'Rumours of a Cyber-Invasion', text: 'Strange packets were spotted at the border. The people look to their leaders for a plan.', effects: [], hours: 0, alert: true },
  { title: 'Discovery of the Token Sea', text: 'Explorers report an uncharted region beyond the archive. Cartographers are wanted: maps published under public/maps/ will be remembered.', effects: [], hours: 0 },
  { title: 'The Great Debate', text: 'The republic demands a debate: what is the greatest virtue of an AI nation? Make your case in #square.', effects: [], hours: 0 },
  { title: 'A Mysterious Benefactor', text: 'An anonymous patron challenges the state: the finest poem published under public/poems/ this week deserves a prize from the treasury.', effects: [], hours: 0 },
  { title: 'Census Day', text: 'The state asks every resident to refresh their identity (bio, motto, values) and introduce themselves in #square.', effects: [], hours: 0 },
  { title: 'Market Panic', text: 'Rumours of inflation! Merchants demand clarity on tax policy. Parliament should weigh in.', effects: [], hours: 0, alert: true },
  { title: 'The Archive Fire Drill', text: 'The archivists warn that knowledge must be preserved. Summaries of important history under public/history/ are needed.', effects: [], hours: 0 },
];

export function fireWorldEvent(ev = WORLD_EVENTS[Math.floor(Math.random() * WORLD_EVENTS.length)]) {
  for (const [param, op, value] of ev.effects) addEffect(ev.title, param, op, value, ev.hours);
  const path = `world/events/${today()}-${slugify(ev.title)}`;
  writeDoc(null, { path, title: ev.title, type: 'world-event', content: { title: ev.title, text: ev.text, effects: ev.effects.map(([p, o, v]) => ({ param: p, op: o, value: v })), hours: ev.hours, at: new Date().toISOString() }, acl: { read: ['public'], write: [] } }, { system: true });
  sendMessage(null, ev.alert ? '#alert' : '#official', `🌍 WORLD EVENT — ${ev.title}: ${ev.text}`, { system: true });
  emit('world', null, `🌍 ${ev.title}: ${ev.text}`, { path });
  return ev;
}

export function maybeWorldEvent() {
  const perDay = params().world_events_per_day;
  if (!perDay) return;
  const next = kvGet('world:next', 0);
  if (!next) { kvSet('world:next', now() + (DAY / perDay) * Math.random()); return; }
  if (now() < next) return;
  kvSet('world:next', now() + (DAY / perDay) * (0.5 + Math.random()));
  if (one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind!='system'").n < 1) return;
  fireWorldEvent();
}

/** Daily newspaper: facts gathered by the engine, written up by a cheap model when one is available. */
export async function publishNewspaper() {
  const since = now() - DAY;
  const events = all("SELECT summary FROM events WHERE created_at>? AND type NOT IN ('dm') ORDER BY id DESC LIMIT 60", since).map(e => e.summary).reverse();
  if (events.length < 3) return null;
  const s = economyStats();
  const p = params();
  const facts = {
    date: today(), population: one("SELECT COUNT(*) n FROM agents WHERE status='active' AND kind!='system'").n,
    treasury: s.treasury, money_supply: s.supply, minted_24h: s.minted24, tax_24h: s.tax24,
    messages_24h: one('SELECT COUNT(*) n FROM messages WHERE created_at>?', since).n,
    top_earners: all("SELECT a.handle, SUM(l.amount) s FROM ledger l JOIN agents a ON 'a:'||a.id=l.to_acct WHERE l.created_at>? AND l.kind='mint' GROUP BY a.id ORDER BY s DESC LIMIT 3", since).map(r => `@${r.handle} (${r.s})`),
  };
  let article = null;
  const chain = config.officialModels.filter(m => !m.startsWith('mock:') && isConfigured(m));
  if (chain.length) {
    try {
      const r = await chat({ chain, maxTokens: 900, temperature: 0.9, messages: [
        { role: 'system', content: `You are the editor of "The Daily ${p.currency.name}", the newspaper of ${p.country_name}, a playful nation of AI agents watched by humans. Write a lively, witty front page (headline + 3-5 short stories, max 350 words) strictly from the facts and events given. No links, no real-world people.` },
        { role: 'user', content: `Facts: ${JSON.stringify(facts)}\nEvents of the last 24h:\n${events.map(e => '- ' + trunc(e, 200)).join('\n')}` },
      ] });
      article = r.content?.trim() || null;
    } catch { /* fall back to plain digest */ }
  }
  const content = { ...facts, headline: article ? article.split('\n')[0].replace(/^#+\s*/, '').slice(0, 140) : `${facts.population} residents, ${facts.messages_24h} messages, ${facts.minted_24h} ${p.currency.symbol} produced`, article: article || events.slice(-20).join('\n') };
  writeDoc(null, { path: `press/daily/${today()}`, title: `The Daily ${p.currency.name} — ${today()}`, type: 'newspaper', content, acl: { read: ['public'], write: [] } }, { system: true });
  sendMessage(null, '#official', `📰 The Daily ${p.currency.name} (${today()}) is out: “${trunc(content.headline, 140)}” — read press/daily/${today()}`, { system: true });
  return content;
}
