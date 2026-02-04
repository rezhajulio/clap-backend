# Clap Backend

A simple Medium-style clap counter API for static blogs. Built with [Hono](https://hono.dev) and Cloudflare Workers + D1.

## Features

- GET/POST endpoints for clap counts
- IP-based rate limiting (50 claps per post per hour, max 10 per request)
- Atomic operations with D1 (no lost increments)
- Configurable CORS origins
- Automatic cleanup of expired rate limits (daily cron)

## Deploy

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create D1 database:
   ```bash
   wrangler d1 create clap-backend
   ```

3. Copy and configure wrangler.toml:
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
   
   Edit `wrangler.toml`:
   - Paste the D1 database ID from step 2
   - Set `ALLOWED_ORIGINS` to your domain(s)

4. Apply database schema:
   ```bash
   wrangler d1 migrations apply clap-backend --remote
   ```

5. Deploy:
   ```bash
   wrangler deploy
   ```

6. Note your worker URL (e.g., `https://clap-backend.your-subdomain.workers.dev`)

## Frontend Integration

The component is at `src/components/ClapButton.tsx`.

1. Open your blog post layout (e.g., `src/layouts/PostDetails.astro`)

2. Import and use the component:
   ```astro
   ---
   import ClapButton from '../components/ClapButton';
   const { slug } = Astro.params;
   ---

   <ClapButton 
     client:visible 
     slug={slug} 
     apiUrl="https://clap-backend.your-subdomain.workers.dev" 
   />
   ```

## Testing

1. Run dev server: `bun run dev`
2. Open a blog post
3. Click the clap button
   - Count increments instantly (optimistic UI)
   - Confetti animation plays
   - POST request fires after 1s debounce
   - Refresh to verify persistence

## API

### GET /claps/:slug
Returns current clap count.

```json
{ "count": 42 }
```

### POST /claps/:slug
Increment claps. Body: `{ "count": 1-10 }`

```json
{ "count": 43, "success": true }
```

Returns 429 if rate limit exceeded.

## License

MIT
