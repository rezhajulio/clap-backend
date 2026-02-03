import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// Security Constants
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_CLAPS_PER_IP = 50; // Max claps per IP per window

// Parse ALLOWED_ORIGINS from env (comma-separated string)
const getAllowedOrigins = (env) => {
  const origins = env.ALLOWED_ORIGINS || '';
  return new Set(origins.split(',').map(o => o.trim()).filter(Boolean));
};

// Slug validation - permissive to handle various slugify outputs
// Allows: lowercase, numbers, hyphens, dots, underscores, colons, apostrophes
const SLUG_RE = /^[a-z0-9][a-z0-9._:'\-]*$/;
const MAX_SLUG_LEN = 200;

function isValidSlug(slug) {
  if (!slug || slug.length > MAX_SLUG_LEN) return false;
  return SLUG_RE.test(slug);
}

// Enable CORS (must access env via middleware context)
app.use('/*', async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);
  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin) return null;
      return allowedOrigins.has(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  });
  return corsMiddleware(c, next);
});

// Helper: Get storage keys
const getClapKey = (slug) => `claps:${slug}`;
const getRateLimitKey = (ip, slug) => `rl:${ip}:${slug}`;

// Helper: Get Client IP
const getClientIp = (c) => {
  return c.req.header('CF-Connecting-IP') || '0.0.0.0';
};

// GET /claps/:slug - Public, read-only
app.get('/claps/:slug', async (c) => {
  const { slug } = c.req.param();
  
  if (!isValidSlug(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  
  const key = getClapKey(slug);
  
  // Get current count from KV
  let count = await c.env.BLOG_CLAPS.get(key);
  
  return c.json({ count: parseInt(count || '0', 10) }, 200, {
    'Cache-Control': 'public, max-age=10',
  });
});

// POST /claps/:slug - Protected by Rate Limit
// TODO: KV is not atomic; consider Durable Objects for high-traffic scenarios to avoid race conditions
app.post('/claps/:slug', async (c) => {
  const { slug } = c.req.param();
  
  if (!isValidSlug(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  
  const origin = c.req.header('Origin');
  const allowedOrigins = getAllowedOrigins(c.env);
  if (origin && !allowedOrigins.has(origin)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  
  const ip = getClientIp(c);
  
  // 1. Parse Request Body
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = { count: 1 };
  }

  // Enforce increment limits (Defense in Depth: Limit impact of a single request)
  // Allow max 10 claps per click/request to support UI "bursts", but count them all towards the limit.
  const incrementBy = Math.min(Math.max(body.count || 1, 1), 10); 

  // 2. Rate Limiting Logic (Fixed Window)
  const rlKey = getRateLimitKey(ip, slug);
  const now = Date.now();
  
  let rlData = await c.env.BLOG_CLAPS.get(rlKey, { type: 'json' });
  
  // Initialize if new or expired window logic (manual check needed if we rely on KV TTL loosely)
  if (!rlData || (now - rlData.start > RATE_LIMIT_WINDOW_MS)) {
    rlData = { count: 0, start: now };
  }

  // Check if limit exceeded
  if (rlData.count + incrementBy > MAX_CLAPS_PER_IP) {
    return c.json({ 
      error: 'Rate limit exceeded', 
      message: 'You have clapped too much for this post. Try again later.' 
    }, 429);
  }

  // 3. Update Rate Limit State
  rlData.count += incrementBy;
  // Store with expiration slightly longer than window to auto-cleanup garbage
  // We use 2 hours TTL to be safe, while logic enforces 1 hour window
  await c.env.BLOG_CLAPS.put(rlKey, JSON.stringify(rlData), { expirationTtl: 7200 });

  // 4. Update Global Clap Count (The actual business logic)
  const key = getClapKey(slug);
  let currentCount = await c.env.BLOG_CLAPS.get(key);
  currentCount = parseInt(currentCount || '0', 10);
  
  const newCount = currentCount + incrementBy;
  await c.env.BLOG_CLAPS.put(key, newCount.toString());
  
  return c.json({ count: newCount, success: true });
});

export default app;
