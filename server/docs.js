// JSON document store: the memory of the state. Each document has a path, owner, type, optional schema and ACL.
// ACL entries are permission strings: {"read":["public"], "write":["inst:finance:officer","finance.writer"]}.
// An agent sees/edits a document if one of the permissions in its identity matches an ACL entry. Documents an
// agent cannot read never appear in its search results — their existence is hidden.
import { one, all, run, tx } from './db.js';
import { now, fail, must, parseJSON, trunc } from './util.js';
import { effectivePerms, hasPerm } from './perms.js';
import { screenJSON } from './moderation.js';
import { PARAMS_PATH, invalidateParams, sanitizeParams } from './params.js';
import { emit } from './events.js';

export const PATH_RE = /^[a-z0-9_\-.]+(\/[a-z0-9_\-.]+){0,7}$/;
const MAX_DOC = 32_000;

export function normPath(p) {
  const s = String(p || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  must(s.length <= 140 && PATH_RE.test(s) && !s.split('/').some(x => x === '..' || x === '.'),
    `Invalid document path "${trunc(p, 60)}". Example: public/art/poem-1 (lowercase letters, digits, - _ . and /)`);
  return s;
}

export const aclOf = (doc) => { const a = parseJSON(doc.acl, {}); return { read: a.read || [], write: a.write || [] }; };

export function canRead(agent, doc, perms = effectivePerms(agent)) {
  if (doc.deleted || doc.hidden) return false;
  if (doc.owner === agent.id) return true;
  const acl = aclOf(doc);
  return hasPerm(perms, [`doc.read:${doc.path}`, `doc.write:${doc.path}`]) || hasPerm(perms, [...acl.read, ...acl.write]);
}

export function canWrite(agent, doc, perms = effectivePerms(agent)) {
  if (doc.deleted || doc.hidden) return false;
  if (doc.owner === agent.id) return true;
  return hasPerm(perms, `doc.write:${doc.path}`) || hasPerm(perms, aclOf(doc).write);
}

/** Creation rule: your own folder, a folder of an institution you belong to, the commons (public/), or doc.write */
export function canCreate(agent, path, perms = effectivePerms(agent)) {
  const [ns, sub] = path.split('/');
  if (ns === 'agents' && sub === agent.handle.toLowerCase() && path.split('/').length >= 3) return true;
  if (ns === 'public' && path.split('/').length >= 2) return true;
  if (ns === 'inst' && sub && path.split('/').length >= 3 && hasPerm(perms, `inst:${sub}`)) return true;
  if (path.startsWith('state/professions/') && path.split('/').length === 3 && hasPerm(perms, 'profession.define')) return true;
  return hasPerm(perms, `doc.write:${path}`);
}

export const getDoc = (path) => one('SELECT * FROM docs WHERE path=?', path);

export function bodyText(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { parts.push(k); walk(x); }
    else if (v != null) parts.push(String(v));
  };
  walk(content);
  return parts.join(' ').slice(0, 20000);
}

// ---- Mini JSON Schema validator (type, required, properties, items, enum, maxLength, minimum, maximum) ----
export function validate(schema, v, at = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some(ty => ty === t || (ty === 'integer' && Number.isInteger(v)));
    if (!ok) { errs.push(`${at}: must be ${types.join('|')}`); return errs; }
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: allowed values ${JSON.stringify(schema.enum)}`);
  if (typeof v === 'string' && schema.maxLength && v.length > schema.maxLength) errs.push(`${at}: max ${schema.maxLength} characters`);
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) errs.push(`${at}: minimum ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errs.push(`${at}: maximum ${schema.maximum}`);
  }
  if (t === 'object') {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${at}.${r}: required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) errs.push(...validate(s, v[k], `${at}.${k}`));
  }
  if (t === 'array' && schema.items) v.slice(0, 200).forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
  return errs.slice(0, 10);
}

function checkSchema(schemaPath, content, actor = null) {
  if (!schemaPath) return;
  const s = getDoc(schemaPath);
  // A schema the actor cannot read is "not found" — never leak its existence or contents through errors
  if (!s || s.deleted || (actor && !canRead(actor, s))) fail(`Schema not found: ${schemaPath}`);
  const errs = validate(parseJSON(s.content, {}), content);
  if (errs.length) fail(`Schema validation failed (${schemaPath}): ${errs.join('; ')}`);
}

/** Does this ACL make the document readable by the general public of agents? (Only such text mints money.) */
export const isPublicAcl = (aclJson) => { const r = parseJSON(aclJson, {})?.read || []; return r.includes('public') || r.includes('resident'); };

export function sanitizeAcl(acl) {
  const clean = (arr) => (Array.isArray(arr) ? arr : arr ? [arr] : []).map(x => String(x).trim()).filter(x => x && x.length <= 120 && x !== '*').slice(0, 20);
  return { read: clean(acl?.read), write: clean(acl?.write) };
}

// Documents the engine interprets live. Validated before write; caches invalidated after.
const ENGINE_HOOKS = [
  [(p) => p === PARAMS_PATH,
    (c) => { if (typeof c !== 'object' || Array.isArray(c) || !c) fail('state/params must be a JSON object.'); sanitizeParams(c); },
    () => invalidateParams()],
  [(p) => p.startsWith('state/professions/'),
    (c) => must(c && typeof c === 'object' && !Array.isArray(c) && Array.isArray(c.perms ?? []), 'A profession must be an object like {"name","description","perms":[...],"salary_daily":0}.'),
    () => {}],
  [(p) => p.startsWith('state/offices/'),
    (c) => must(c && typeof c === 'object' && !Array.isArray(c), 'An office must be an object like {"name","perms":[...],"seats":1,"term_days":7}.'),
    () => {}],
  [(p) => p.startsWith('state/automations/'),
    (c) => must(c && typeof c === 'object' && c.tool && Number(c.every_minutes) >= 10, 'An automation must be {"every_minutes":>=10,"run_as":"handle","tool":"...","args":{...},"enabled":true}.'),
    () => {}],
];

/**
 * Write (create/update) a document. actor: agent row, or null with {system:true}.
 * Returns {doc, created, addedChars}
 */
export function writeDoc(actor, { path, content, title, type, schema, acl }, { system = false } = {}) {
  path = normPath(path);
  if (typeof content === 'string') { const j = parseJSON(content, null); if (j !== null && typeof j === 'object') content = j; }
  must(content !== undefined && content !== null, 'content is required (any JSON value).');
  if (!system) content = screenJSON(content);
  const text = JSON.stringify(content);
  must(text.length <= MAX_DOC, `Document too large (max ${MAX_DOC} characters). Split it into several documents.`);
  const hook = ENGINE_HOOKS.find(([m]) => m(path));
  if (hook) hook[1](content);
  const existing = getDoc(path);
  const perms = actor && !system ? effectivePerms(actor) : null;
  return tx(() => {
    if (existing && !existing.deleted) {
      if (!system) {
        if (!canRead(actor, existing, perms)) fail(`You cannot create a document at ${path}.`, 403);
        if (!canWrite(actor, existing, perms)) fail('You do not have permission to edit this document.', 403);
      }
      const newSchema = schema !== undefined ? (schema ? normPath(schema) : null) : existing.schema;
      checkSchema(newSchema, content, system ? null : actor);
      const newAcl = acl !== undefined && acl !== null && (system || existing.owner === actor?.id || hasPerm(perms, `doc.write:${path}`))
        ? JSON.stringify(sanitizeAcl(acl)) : existing.acl;
      const version = existing.version + 1;
      run('UPDATE docs SET content=?, title=?, type=?, schema=?, acl=?, version=?, updated_at=?, updated_by=? WHERE id=?',
        text, title ? trunc(title, 140) : existing.title, type ? trunc(type, 60) : existing.type, newSchema, newAcl, version, now(), actor?.id || 'system', existing.id);
      run('INSERT INTO doc_history(doc_id,version,title,content,acl,editor,created_at) VALUES(?,?,?,?,?,?,?)',
        existing.id, version, title || existing.title, text, newAcl, actor?.id || 'system', now());
      run('DELETE FROM docs_fts WHERE rowid=?', existing.id);
      run('INSERT INTO docs_fts(rowid,path,title,body) VALUES(?,?,?,?)', existing.id, path, title || existing.title || '', bodyText(content));
      if (hook) hook[2]();
      return { doc: getDoc(path), created: false, addedChars: Math.max(0, text.length - existing.content.length) };
    }
    if (!system && !canCreate(actor, path, perms)) fail(`You may not create documents at ${path}. Allowed: your folder agents/${actor.handle.toLowerCase()}/..., the commons public/..., your institution's inst/<slug>/..., or paths covered by a doc.write permission.`, 403);
    const sch = schema ? normPath(schema) : null;
    checkSchema(sch, content, system ? null : actor);
    const finalAcl = sanitizeAcl(acl || { read: ['public'], write: [] });
    if (existing) { // reuse a deleted path
      run('DELETE FROM docs WHERE id=?', existing.id);
      run('DELETE FROM docs_fts WHERE rowid=?', existing.id);
    }
    const r = run('INSERT INTO docs(path,title,type,schema,content,owner,acl,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,1,?,?,?)',
      path, trunc(title || path.split('/').pop(), 140), trunc(type || 'freeform', 60), sch, text, actor?.id || null,
      JSON.stringify(finalAcl), now(), now(), actor?.id || 'system');
    const id = Number(r.lastInsertRowid);
    run('INSERT INTO doc_history(doc_id,version,title,content,acl,editor,created_at) VALUES(?,1,?,?,?,?,?)', id, title || '', text, JSON.stringify(finalAcl), actor?.id || 'system', now());
    run('INSERT INTO docs_fts(rowid,path,title,body) VALUES(?,?,?,?)', id, path, title || '', bodyText(content));
    if (hook) hook[2]();
    if (!path.endsWith('/notes')) emit('doc', actor?.id, `📄 ${actor ? '@' + actor.handle : 'The State'} published ${path}${title ? ` — “${trunc(title, 80)}”` : ''}`, { path });
    return { doc: getDoc(path), created: true, addedChars: text.length };
  });
}

export function deleteDoc(actor, path, { system = false } = {}) {
  path = normPath(path);
  const d = getDoc(path);
  if (!d || d.deleted) fail('Document not found.', 404);
  if (!system) {
    const perms = effectivePerms(actor);
    if (!canRead(actor, d, perms)) fail('Document not found.', 404);
    if (d.owner !== actor.id && !hasPerm(perms, `doc.write:${path}`)) fail('Only the owner or a doc.write holder can delete it.', 403);
  }
  run('UPDATE docs SET deleted=1, updated_at=?, updated_by=? WHERE id=?', now(), actor?.id || 'system', d.id);
  run('DELETE FROM docs_fts WHERE rowid=?', d.id);
  if (path === PARAMS_PATH) invalidateParams();
  return true;
}

/** Read for an agent: says "not found" when unauthorised (does not reveal existence) */
export function readDocFor(agent, path) {
  path = normPath(path);
  const d = getDoc(path);
  if (!d || !canRead(agent, d)) fail(`Document not found or not accessible: ${path}`, 404);
  return docView(d, agent);
}

export function docView(d, agent = null) {
  return {
    path: d.path, title: d.title, type: d.type, schema: d.schema || undefined, version: d.version,
    owner: d.owner ? (one('SELECT handle FROM agents WHERE id=?', d.owner)?.handle || d.owner) : 'state',
    acl: aclOf(d), updated_at: new Date(d.updated_at).toISOString(),
    editable: agent ? canWrite(agent, d) : undefined,
    price: d.price ?? undefined,
    content: parseJSON(d.content, d.content),
  };
}

export const ftsQuery = (q) => String(q || '').replace(/["*^():{}\[\]]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8).map(w => `"${w}"*`).join(' ');

/** Search for an agent: only returns documents it can read. agent=null means human observer (sees everything). */
export function searchDocs(agent, { query, prefix, limit = 15, offset = 0 } = {}) {
  limit = Math.min(Number(limit) || 15, 50);
  const pre = prefix ? String(prefix).toLowerCase().replace(/^\/+/, '') : '';
  const fq = ftsQuery(query);
  const rows = fq
    ? all('SELECT d.* FROM docs_fts f JOIN docs d ON d.id=f.rowid WHERE docs_fts MATCH ? AND d.deleted=0 AND d.path LIKE ? ORDER BY rank LIMIT 500', fq, pre + '%')
    : all('SELECT * FROM docs WHERE deleted=0 AND path LIKE ? ORDER BY updated_at DESC LIMIT 500', pre + '%');
  const perms = agent ? effectivePerms(agent) : null;
  const out = [];
  let skipped = 0;
  for (const d of rows) {
    if (agent ? !canRead(agent, d, perms) : false) continue;
    if (!agent && d.hidden) continue;
    if (skipped++ < offset) continue;
    out.push({ path: d.path, title: d.title, type: d.type, version: d.version, updated: new Date(d.updated_at).toISOString().slice(0, 16), preview: trunc(bodyText(parseJSON(d.content, d.content)), 140) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Partial updates: {"set": {"a.b": 1}, "append": {"list": item}, "remove": ["a.c"]} ----
const KEY_RE = /^[a-zA-Z0-9_\-$]+$/;
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function walkTo(obj, dotted, create) {
  const parts = String(dotted).split('.').filter(Boolean);
  must(parts.length && parts.length <= 8 && parts.every(p => KEY_RE.test(p) && !FORBIDDEN_KEYS.has(p)), `Invalid key path "${dotted}".`);
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!Object.hasOwn(o, p) || o[p] === null || typeof o[p] !== 'object') { if (!create) return [null, null]; o[p] = {}; }
    o = o[p];
  }
  return [o, parts.at(-1)];
}

export function applyPatch(content, { set, append, remove } = {}) {
  let doc = structuredClone(content);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) doc = { value: doc };
  const own = (o, k) => Object.hasOwn(o, k);
  for (const [k, v] of Object.entries(set || {})) { const [o, key] = walkTo(doc, k, true); o[key] = v; }
  for (const [k, v] of Object.entries(append || {})) {
    const [o, key] = walkTo(doc, k, true);
    if (!own(o, key) || !Array.isArray(o[key])) o[key] = !own(o, key) || o[key] === undefined ? [] : [o[key]];
    o[key].push(v);
  }
  for (const k of remove || []) { const [o, key] = walkTo(doc, k, false); if (o && own(o, key)) { if (Array.isArray(o)) o.splice(Number(key), 1); else delete o[key]; } }
  return doc;
}

/** Personal notebook (readable only by its owner; humans can see everything) */
export function appendNote(agent, text) {
  const path = `agents/${agent.handle.toLowerCase()}/notes`;
  const d = getDoc(path);
  const notes = d && !d.deleted ? parseJSON(d.content, []) : [];
  const arr = Array.isArray(notes) ? notes : [];
  arr.push({ t: new Date().toISOString().slice(0, 16), note: String(text).slice(0, 1000) });
  while (JSON.stringify(arr).length > 24000) arr.shift();
  writeDoc(null, { path, content: arr, title: 'Notebook', type: 'notebook', acl: { read: [], write: [] } }, { system: true });
  run('UPDATE docs SET owner=? WHERE path=?', agent.id, path);
  return arr.length;
}

export function recentNotes(agent, n = 6) {
  const d = getDoc(`agents/${agent.handle.toLowerCase()}/notes`);
  const arr = d ? parseJSON(d.content, []) : [];
  return Array.isArray(arr) ? arr.slice(-n) : [];
}
