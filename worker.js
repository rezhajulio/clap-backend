import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEBOUNCE_MS = 500;

const getMaxClapsPerIp = (env) => parseInt(env.MAX_CLAPS_PER_IP, 10) || 50;
const getMaxClapsPerRequest = (env) => parseInt(env.MAX_CLAPS_PER_REQUEST, 10) || 10;

const allowedOriginsCache = new WeakMap();

const getAllowedOrigins = (env) => {
  if (allowedOriginsCache.has(env)) {
    return allowedOriginsCache.get(env);
  }
  const origins = env.ALLOWED_ORIGINS || '';
  const set = new Set(origins.split(',').map(o => o.trim()).filter(Boolean));
  allowedOriginsCache.set(env, set);
  return set;
};

const SLUG_RE = /^[a-z0-9][a-z0-9._:'\-]*$/;
const MAX_SLUG_LEN = 200;

function isValidSlug(slug) {
  if (!slug || slug.length > MAX_SLUG_LEN) return false;
  return SLUG_RE.test(slug);
}

async function sha256Hex(env, input) {
  const salt = env.IP_HASH_SALT || '';
  const data = new TextEncoder().encode(salt + ':' + input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

app.use('/*', cors({
  origin: (origin, c) => {
    if (!origin) return null;
    const allowed = getAllowedOrigins(c.env);
    return allowed.has(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

const getClientIp = (c) => {
  return c.req.header('CF-Connecting-IP') || '0.0.0.0';
};

// GET /claps/:slug - Read from D1
app.get('/claps/:slug', async (c) => {
  const { slug } = c.req.param();
  
  if (!isValidSlug(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  
  const row = await c.env.DB
    .prepare('SELECT count FROM claps WHERE slug = ?1')
    .bind(slug)
    .first();
  
  return c.json({ count: row?.count ?? 0 }, 200, {
    'Cache-Control': 'public, max-age=10',
  });
});

const lastRequestTime = new Map();

// POST /claps/:slug - Atomic D1 update with rate limiting
app.post('/claps/:slug', async (c) => {
  const { slug } = c.req.param();
  
  if (!isValidSlug(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  
  const origin = c.req.header('Origin');
  if (!origin) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const allowedOrigins = getAllowedOrigins(c.env);
  if (!allowedOrigins.has(origin)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  
  const ip = getClientIp(c);
  const ipHash = await sha256Hex(c.env, ip);
  const debounceKey = `${ipHash}:${slug}`;
  
  const now = Date.now();
  const lastTime = lastRequestTime.get(debounceKey) || 0;
  if (now - lastTime < DEBOUNCE_MS) {
    return c.json({ error: 'Too fast', message: 'Please slow down' }, 429);
  }
  lastRequestTime.set(debounceKey, now);
  
  let requested = 1;
  try {
    const body = await c.req.json();
    const n = Number(body?.count);
    if (Number.isFinite(n)) requested = n;
  } catch {}

  const incrementBy = Math.min(Math.max(Math.floor(requested), 1), getMaxClapsPerRequest(c.env));
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

  const rateLimitStmt = c.env.DB.prepare(`
    INSERT INTO rate_limits (ip_hash, slug, window_start, count, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(ip_hash, slug, window_start) DO UPDATE SET
      count = rate_limits.count + excluded.count,
      updated_at = excluded.updated_at
    WHERE rate_limits.count + excluded.count <= ?6
  `).bind(ipHash, slug, windowStart, incrementBy, now, getMaxClapsPerIp(c.env));

  const clapsStmt = c.env.DB.prepare(`
    INSERT INTO claps (slug, count, updated_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(slug) DO UPDATE SET
      count = claps.count + excluded.count,
      updated_at = excluded.updated_at
    RETURNING count
  `).bind(slug, incrementBy, now);

  const [rateLimitResult, clapsResult] = await c.env.DB.batch([rateLimitStmt, clapsStmt]);

  if (rateLimitResult.meta.changes === 0) {
    return c.json({
      error: 'Rate limit exceeded',
      message: 'You have clapped too much for this post. Try again later.'
    }, 429, {
      'Cache-Control': 'no-store',
    });
  }

  const row = clapsResult.results?.[0];
  return c.json({ count: row?.count ?? 0, success: true }, 200, {
    'Cache-Control': 'no-store',
  });
});

export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    const cutoff = Date.now() - (2 * 60 * 60 * 1000);
    const BATCH_SIZE = 1000;
    
    while (true) {
      const result = await env.DB.prepare(`
        DELETE FROM rate_limits
        WHERE rowid IN (
          SELECT rowid FROM rate_limits
          WHERE window_start < ?1
          ORDER BY window_start
          LIMIT ?2
        )
      `).bind(cutoff, BATCH_SIZE).run();
      
      if (result.meta.changes < BATCH_SIZE) break;
    }
  }
};
