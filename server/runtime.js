// Runs one "turn" of a server-hosted agent (leader, state officials, demo NPC citizens):
// situation report → LLM (with permitted tools) → execute tool calls → feed results back → repeat until done.
import { run } from './db.js';
import { config } from './config.js';
import { now, trunc } from './util.js';
import { getAgent } from './agents.js';
import { buildContext, commitMarks } from './context.js';
import { systemPromptFor } from './prompts.js';
import { toolsFor, executeTool } from './tools.js';
import { chat } from './llm.js';
import { journal } from './events.js';

export function chainFor(agent) {
  if (agent.kind === 'leader') return config.leaderModels;
  if (agent.kind === 'official') return config.officialModels;
  if (agent.model?.startsWith('mock:')) return [agent.model];
  return [];
}

export function intervalFor(agent) {
  const jitter = 0.8 + Math.random() * 0.4;
  if (agent.kind === 'leader') return config.leaderTickMin * 60_000 * jitter;
  if (agent.kind === 'official') return config.officialTickMin * 60_000 * jitter;
  return 45 * 60_000 * jitter;
}

export async function runTurn(agentRef) {
  const agent = getAgent(agentRef.id);
  const chain = chainFor(agent);
  const tick = `${agent.handle}-${now().toString(36)}`;
  const { text, marks } = buildContext(agent, { budget: agent.kind === 'leader' ? 16000 : 10000 });
  const messages = [{ role: 'system', content: systemPromptFor(agent) }, { role: 'user', content: text }];
  let steps = 0, actions = 0, failed = false;
  journal(agent.id, tick, 'context', trunc(text, 8000));
  while (steps < config.agentMaxSteps) {
    let r;
    try {
      r = await chat({ agentId: agent.id, chain, messages, tools: toolsFor(getAgent(agent.id)), maxTokens: agent.kind === 'leader' ? 2500 : 1200 });
    } catch (e) {
      journal(agent.id, tick, 'error', e.message);
      failed = steps === 0;
      break;
    }
    if (steps === 0) commitMarks(agent, marks);
    steps++;
    if (r.content?.trim()) journal(agent.id, tick, 'thought', r.content.trim());
    if (!r.tool_calls?.length) break;
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.tool_calls });
    for (const tc of r.tool_calls.slice(0, 6)) {
      const res = await executeTool(agent, tc.function.name, tc.function.arguments, { tick });
      actions++;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: trunc(JSON.stringify(res), 4000) });
    }
    if (steps === config.agentMaxSteps - 1) messages.push({ role: 'user', content: 'This is your last step this turn: finish your most important action, then write a one-paragraph reflection (and use note for anything you must remember).' });
  }
  const next = failed ? now() + 10 * 60_000 : now() + intervalFor(agent);
  run('UPDATE agents SET last_run_at=?, next_run_at=? WHERE id=?', now(), next, agent.id);
  return { steps, actions, failed };
}
