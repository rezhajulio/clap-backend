# Clap Backend

A simple Medium-style clap counter API for static blogs. Built with [Hono](https://hono.dev) and Cloudflare Workers + KV.

## Features

- GET/POST endpoints for clap counts
- IP-based rate limiting (50 claps per post per hour)
- Configurable CORS origins
- Slug validation

## Deploy

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create KV namespace:
   ```bash
   wrangler kv:namespace create BLOG_CLAPS
   ```

3. Copy and configure wrangler.toml:
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
   
   Then edit `wrangler.toml`:
   - Paste the KV namespace ID from step 2
   - Set `ALLOWED_ORIGINS` to your domain(s)

4. Deploy:
   ```bash
   npm run deploy
   ```

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
