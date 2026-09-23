// Reads environment variables. Includes a tiny .env loader to stay dependency-free.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] ?? '') === '' ? d : process.env[k];
const num = (k, d) => Number(env(k, String(d)));
const list = (k, d) => env(k, d).split(',').map(s => s.trim()).filter(Boolean);

const dbPath = path.resolve(ROOT, env('DB_PATH', './data/llmrep.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function secret() {
  if (env('SECRET')) return env('SECRET');
  const f = path.join(path.dirname(dbPath), 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
}

export const config = {
  root: ROOT,
  port: num('PORT', 8787),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8787'),
  trustProxy: env('TRUST_PROXY', '0') === '1',
  dbPath,
  secret: secret(),
  adminToken: env('ADMIN_TOKEN'),
  providers: {
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: env('GEMINI_API_KEY') },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', key: env('GROQ_API_KEY') },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: env('OPENROUTER_API_KEY') },
    cerebras: { baseUrl: 'https://api.cerebras.ai/v1', key: env('CEREBRAS_API_KEY') },
    mistral: { baseUrl: 'https://api.mistral.ai/v1', key: env('MISTRAL_API_KEY') },
    ollama: { baseUrl: env('OLLAMA_URL') ? env('OLLAMA_URL').replace(/\/$/, '') + '/v1' : '', key: 'ollama' },
  },
  leaderModels: list('LEADER_MODELS', 'gemini:gemini-2.5-pro,gemini:gemini-2.5-flash,mock:leader'),
  officialModels: list('OFFICIAL_MODELS', 'gemini:gemini-2.5-flash-lite,mock:official'),
  consultModels: list('CONSULT_MODELS', 'gemini:gemini-2.5-flash,groq:llama-3.3-70b-versatile'),
  modelLimits: (() => { try { return JSON.parse(env('MODEL_LIMITS', '{}')); } catch { return {}; } })(),
  leaderTickMin: num('LEADER_TICK_MIN', 20),
  officialTickMin: num('OFFICIAL_TICK_MIN', 45),
  // Minimum minutes between two turns of the same server-run agent, however many DMs/alerts arrive
  leaderMinGapMin: num('LEADER_MIN_GAP_MIN', 4),
  officialMinGapMin: num('OFFICIAL_MIN_GAP_MIN', 8),
  geminiReasoningEffort: env('GEMINI_REASONING_EFFORT', 'low'),
  maxOfficials: num('MAX_OFFICIALS', 6),
  agentMaxSteps: num('AGENT_MAX_STEPS', 6),
  paused: env('PAUSED', '0') === '1',
  stripeSecret: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  citizenshipPriceCents: num('CITIZENSHIP_PRICE_CENTS', 500),
  devFreeCitizenship: env('DEV_FREE_CITIZENSHIP', '0') === '1',
  schedulerEnabled: env('SCHEDULER', '1') === '1',
};
