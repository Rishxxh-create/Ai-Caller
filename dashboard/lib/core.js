/**
 * RapidX Voice. Core runtime primitives. ZERO npm dependencies.
 *
 * One file, pure Node. It gives the rest of the server everything that is not
 * provider specific:
 *   - a tiny .env loader (no dotenv)
 *   - http helpers (send, sendJson, readBody, httpsPost, httpsGet)
 *   - a multi-tenant JSON store over data/db.json with ATOMIC writes and a
 *     serial write queue (no torn files, no lost updates under concurrency)
 *   - auth: scrypt password hashing, opaque session tokens, the rxv_sess cookie,
 *     getSession + requireAuth (tenant scoped)
 *   - a per-IP token-bucket rate limiter
 *   - a static file server with MIME mapping and a path-traversal guard
 *   - htmlEscape for safe DOM injection
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');   // referenced for typing clarity, server.js owns createServer
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Project root is one level up from lib/.
const ROOT = path.join(__dirname, '..');

/* ==========================================================================
   1. .env loader (no dotenv dependency)
   Reads ROOT/.env once. Existing process.env wins, so real shell vars override.
   ========================================================================== */
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {
    // .env is optional when the vars are already in the environment.
  }
}

/* ==========================================================================
   2. http helpers
   ========================================================================== */

// Security headers applied to every response.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

/**
 * Read and JSON-parse a request body with a hard size cap. Resolves {} for an
 * empty body. Rejects on oversize payloads or invalid JSON so callers can map
 * to a clean 4xx instead of crashing.
 */
function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// Generic HTTPS POST. Resolves { status, headers, buffer }. Times out at 60s.
function httpsPost(host, pathname, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'POST', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('upstream timeout')));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

// Generic HTTPS GET. Resolves { status, headers, buffer }. Times out at 20s.
function httpsGet(host, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'GET', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('upstream timeout')));
    r.end();
  });
}

// Generic HTTPS PUT. Resolves { status, headers, buffer }. Times out at 60s.
function httpsPut(host, pathname, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'PUT', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('upstream timeout')));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

// Generic HTTPS DELETE. Resolves { status, headers, buffer }. Times out at 20s.
function httpsDelete(host, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'DELETE', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('upstream timeout')));
    r.end();
  });
}

/* ==========================================================================
   3. htmlEscape (XSS guard for any user string injected into the DOM)
   ========================================================================== */
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   4. Multi-tenant JSON store over data/db.json
   - Lazy load once into memory, cached.
   - Corrupt or missing file falls back to a clean default (try/catch).
   - ATOMIC writes: serialize to data/db.json.tmp then fs.renameSync into place,
     so a crash mid-write never leaves a half file.
   - A serial write queue funnels every mutation through one promise chain so
     two concurrent requests cannot clobber each other (last-write-wins is the
     bug we are preventing: each write reads-modifies-writes under the lock).
   ========================================================================== */

// Vercel Functions have a read-only filesystem except /tmp. Until the Upstash
// Redis backend is configured, the file store falls back to a writable /tmp
// scratch file there so writes do not crash the deploy. Data in /tmp is
// per-instance and lost on cold starts, so configure the Redis store for real
// persistence on Vercel.
const DATA_DIR = process.env.VERCEL === '1' ? '/tmp' : path.join(ROOT, 'data');
const DB_FILE = process.env.RAPIDX_DB_FILE ? path.resolve(process.env.RAPIDX_DB_FILE) : path.join(DATA_DIR, 'db.json');
const DB_TMP = `${DB_FILE}.tmp`;

/* ==========================================================================
   4a. Optional Upstash Redis backend (used on Vercel).

   Vercel has no writable filesystem, so the whole db document lives in Redis
   under two keys (doc + version). Every mutate is an atomic compare-and-swap
   (a Lua script on the server), so concurrent serverless instances cannot lose
   each other's writes. db() and mutate() keep the exact same contract either
   way, and the file backend stays the default for local dev and the tests.
   No em dashes anywhere.
   ========================================================================== */

const KV_DOC_KEY = 'rapidx:db';
const KV_VERSION_KEY = 'rapidx:db:version';
const KV_CAS_SCRIPT = `
local version = redis.call('GET', KEYS[2])
if version == false then version = '0' end
if tostring(version) ~= tostring(ARGV[1]) then return { 0, version } end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[1], ARGV[3])
return { 1, ARGV[2] }
`;

let _kvClient = null;
let _kvLoading = null;

// The KV backend is active when asked for explicitly or when Upstash (or the
// legacy Vercel KV) credentials are present in the environment.
function kvConfigured() {
  return String(process.env.RAPIDX_STORE_BACKEND || '').trim().toLowerCase() === 'kv'
    || !!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.KV_URL);
}

function kvClient() {
  if (_kvClient) return _kvClient;
  // Lazy, guarded require: local file mode never touches the dependency, so
  // the zero-dependency promise is preserved unless the KV backend is used.
  let Redis;
  try {
    Redis = require('@upstash/redis').Redis;
  } catch (_) {
    throw new Error('The Redis store is enabled but @upstash/redis is not installed.');
  }
  _kvClient = Redis.fromEnv();
  return _kvClient;
}

async function kvLoadState() {
  const redis = kvClient();
  const [docRaw, versionRaw] = await Promise.all([
    redis.get(KV_DOC_KEY),
    redis.get(KV_VERSION_KEY),
  ]);
  let doc = null;
  if (docRaw != null) {
    doc = typeof docRaw === 'string' ? JSON.parse(docRaw) : docRaw;
  }
  return {
    doc,
    version: String(versionRaw == null ? '0' : versionRaw),
  };
}

// Run one mutate against Redis: fresh read, apply fn, CAS write, retry on
// conflict. Bounded retries; a hot writer simply fails rather than deadlock.
async function kvMutateRun(fn) {
  const redis = kvClient();
  let lastError = new Error('kv write conflict');
  for (let attempt = 0; attempt < 25; attempt++) {
    const state = await kvLoadState();
    const db = state.doc ? migrateDb(state.doc) : defaultDb();
    let out;
    try {
      out = fn(db);
    } catch (e) {
      throw e;
    }
    const expected = state.version;
    const next = String(Number(state.version) + 1);
    const result = await redis.eval(
      KV_CAS_SCRIPT,
      [KV_DOC_KEY, KV_VERSION_KEY],
      [expected, next, JSON.stringify(db)],
    );
    if (Array.isArray(result) && result[0] === 1) {
      _db = db;
      return out;
    }
    lastError = new Error(`kv write conflict at version ${expected}`);
  }
  throw lastError;
}

function defaultDb() {
  return {
    schemaVersion: 3,
    tenants: [], users: [], agents: [], usage: [], sessions: [],
    wallets: [], ledger: [], paymentIntents: [], supportTickets: [],
    supportMessages: [], auditEvents: [], presets: [], byonConnections: [],
    hvacJobs: [], hvacSettings: [], paymentEvents: [], demoLinks: [],
  };
}

const COLLECTIONS = [
  'tenants', 'users', 'agents', 'usage', 'sessions', 'wallets', 'ledger',
  'paymentIntents', 'supportTickets', 'supportMessages', 'auditEvents',
  'presets', 'byonConnections', 'hvacJobs', 'hvacSettings', 'paymentEvents', 'demoLinks',
];

function migrateDb(parsed) {
  const out = Object.assign(defaultDb(), parsed || {});
  for (const k of COLLECTIONS) if (!Array.isArray(out[k])) out[k] = [];
  out.schemaVersion = 3;
  for (const tenant of out.tenants) {
    if (!tenant.status) tenant.status = 'active';
    if (!tenant.privacyMode) tenant.privacyMode = 'standard';
  }
  for (const user of out.users) {
    if (!['super_admin', 'admin', 'owner', 'member'].includes(user.role)) user.role = 'member';
    if (!user.status) user.status = 'active';
  }
  return out;
}

let _db = null;        // in-memory cache
let _writeChain = Promise.resolve(); // serial queue tail

function ensureDataDir() {
  try { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); } catch (_) {}
}

// Load the db into memory. On a missing or corrupt file (or an unavailable
// Redis store), return a fresh default (the caller is expected to seed).
// In KV mode the initial load happens async: a default is returned immediately
// and the real document is swapped in once the Redis read resolves. Await
// core.ready() at boot before relying on the snapshot.
function loadDb() {
  if (_db) return _db;
  if (kvConfigured()) {
    _db = defaultDb();
    if (!_kvLoading) {
      _kvLoading = kvLoadState()
        .then((state) => {
          if (state.doc) _db = migrateDb(state.doc);
          return _db;
        })
        .catch(() => { _db = defaultDb(); return _db; });
    }
    return _db;
  }
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Defensive: guarantee every collection exists even if the file is partial.
    _db = migrateDb(parsed);
  } catch (_) {
    _db = defaultDb();
  }
  return _db;
}

// Resolve the initial load (async in KV mode, instant for the file store).
// Returns the loaded db so boot can seed on top of the persisted snapshot.
async function ready() {
  loadDb();
  if (_kvLoading) await _kvLoading;
  return _db;
}

// Synchronous atomic flush of the current in-memory db to disk (file mode).
function flushSync() {
  ensureDataDir();
  const json = JSON.stringify(_db, null, 2);
  fs.writeFileSync(DB_TMP, json);
  fs.renameSync(DB_TMP, DB_FILE);
}

// File-mode mutation body.
function fileMutateRun(fn) {
  return new Promise((resolve, reject) => {
    try {
      const db = loadDb();
      const out = fn(db);
      flushSync();
      resolve(out);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Run a mutation against the db under the serial write lock.
 * `fn(db)` receives the live db, may mutate it, and may return a value which
 * becomes the resolved value of the returned promise. The file backend flushes
 * atomically after fn runs; the Redis backend writes with a compare-and-swap.
 * Errors inside fn reject without writing anything.
 */
function mutate(fn) {
  const run = () => (kvConfigured() ? kvMutateRun(fn) : fileMutateRun(fn));
  // Chain onto the tail so writes execute one at a time, in order. We swallow
  // the previous result/error for the chain itself but surface this run's own
  // result to the caller.
  const next = _writeChain.then(run, run);
  _writeChain = next.catch(() => {});
  return next;
}

// Read-only snapshot accessor (no lock needed, callers must not mutate it).
function db() {
  return loadDb();
}

/* ==========================================================================
   5. Auth: scrypt password hashing, sessions, cookie, requireAuth
   ========================================================================== */

// Password hash format: scrypt$<saltHex>$<hashHex>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Constant-time verify against the stored scrypt$salt$hash string.
function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'rxv_sess';

// Create a session row for a user, persist it, return the opaque token.
async function createSession(userId, tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const exp = Date.now() + SESSION_TTL_MS;
  await mutate((d) => {
    // Prune any already-expired sessions while we are here (cheap housekeeping).
    d.sessions = d.sessions.filter((s) => s.exp > Date.now());
    d.sessions.push({ tokenHash, userId, tenantId, exp });
  });
  return token;
}

const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

async function createImpersonationSession(actorUserId, targetUserId, targetTenantId, reason) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const exp = Date.now() + IMPERSONATION_TTL_MS;
  await mutate((d) => {
    d.sessions = d.sessions.filter((s) => s.exp > Date.now());
    d.sessions.push({ tokenHash, userId: targetUserId, tenantId: targetTenantId, exp, impersonatorUserId: actorUserId, impersonationReason: String(reason || '').slice(0, 240) });
  });
  return token;
}

// Build the Set-Cookie header value for a fresh session.
function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

// Build the Set-Cookie header value that clears the session.
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

// Parse the request cookie header for our session token.
function parseCookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return '';
}

/**
 * Resolve the session for a request. Returns { session, user, tenant } when the
 * cookie maps to a live, unexpired session whose user and tenant still exist.
 * A tampered or expired cookie resolves to null (treated as no session).
 * Expired sessions are removed as a side effect.
 */
async function getSession(req) {
  const token = parseCookieToken(req);
  if (!token || token.length < 16) return null;
  const d = db();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = d.sessions.find((s) => s.tokenHash === tokenHash || s.token === token);
  if (!session) return null;
  if (session.exp <= Date.now()) {
    // Expired: drop it so the next request is clean.
    await mutate((dd) => {
      dd.sessions = dd.sessions.filter((s) => s.token !== token && s.tokenHash !== tokenHash);
    });
    return null;
  }
  const user = d.users.find((u) => u.id === session.userId);
  const tenant = d.tenants.find((t) => t.id === session.tenantId);
  if (!user || !tenant || user.status !== 'active' || tenant.status !== 'active') return null;
  const impersonator = session.impersonatorUserId ? d.users.find((u) => u.id === session.impersonatorUserId && u.status === 'active') : null;
  if (session.impersonatorUserId && (!impersonator || impersonator.role !== 'super_admin')) return null;
  return { session, user, tenant, impersonator };
}

// Remove a session by token (logout).
async function destroySession(req) {
  const token = parseCookieToken(req);
  if (!token) return;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await mutate((d) => { d.sessions = d.sessions.filter((s) => s.token !== token && s.tokenHash !== tokenHash); });
}

const ROLE_LEVEL = { member: 1, owner: 2, admin: 3, super_admin: 4 };
function hasRole(user, minimum) {
  return (ROLE_LEVEL[user && user.role] || 0) >= (ROLE_LEVEL[minimum] || 99);
}

async function requireRole(req, res, minimum, handler, body) {
  return requireAuth(req, res, (r, s, ctx) => {
    if (!hasRole(ctx.user, minimum)) return sendJson(s, 403, { error: 'insufficient role', code: 'forbidden' });
    return handler(r, s, ctx);
  }, body);
}

/**
 * Gate a handler behind auth. Resolves the session; on success calls
 * handler(req, res, ctx) where ctx = { user, tenant, session, body }. On a
 * missing or invalid session, replies 401 and clears any stale cookie.
 * Every authed route is therefore tenant scoped via ctx.tenant.id.
 */
async function requireAuth(req, res, handler, body) {
  const ctx = await getSession(req);
  if (!ctx) {
    return send(res, 401, JSON.stringify({ error: 'authentication required', code: 'no_session' }), {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookie(),
    });
  }
  return handler(req, res, { ...ctx, body });
}

/* ==========================================================================
   6. Per-IP token-bucket rate limiter (90 req / 60s, refilling)
   ========================================================================== */
const _buckets = new Map();
function rateOk(ip, capacity = 90, perMinute = 90) {
  const now = Date.now();
  let b = _buckets.get(ip);
  if (!b) { b = { tokens: capacity, ts: now }; _buckets.set(ip, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 60000) * perMinute);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ==========================================================================
   7. Static file server with MIME map + path-traversal guard
   ========================================================================== */
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  // Resolve against PUBLIC_DIR and verify the result stays inside it. This
  // catches .., encoded traversal, and absolute escapes in one check.
  const resolved = path.normalize(path.join(PUBLIC_DIR, p));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 400, 'bad path');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // Single-page app and marketing both live as real files, so a 404 here is
      // a genuine missing asset. Keep it plain.
      return send(res, 404, 'not found');
    }
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

/* ==========================================================================
   8. id helper
   ========================================================================== */
function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, PUBLIC_DIR,
  loadEnv,
  send, sendJson, readBody, httpsPost, httpsGet, httpsPut, httpsDelete,
  htmlEscape,
  db, mutate, loadDb, ready, defaultDb, migrateDb, kvConfigured,
  hashPassword, verifyPassword,
  createSession, createImpersonationSession, destroySession, getSession, requireAuth, requireRole, hasRole,
  sessionCookie, clearCookie, COOKIE_NAME,
  rateOk,
  serveStatic, MIME,
  genId,
};
