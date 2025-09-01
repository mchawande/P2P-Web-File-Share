# P2P Web File Share (production hardening)

This app serves a static web UI and a minimal WebSocket signaling service for browser-to-browser WebRTC file transfers.

What was improved for production:

-   Security headers via helmet (CSP, HSTS-ready) and compression
-   WebSocket origin and path validation with manual upgrade + idle timeouts
-   Heartbeat ping/pong to evict dead clients
-   Message validation and size guards
-   Health check endpoint (/healthz)
-   Runtime config endpoint (/config) providing `wsPath` and `iceServers`
-   Static file caching with ETag/Last-Modified
-   Graceful shutdown handling
-   Event-driven backpressure for large file sends
-   HTTP rate limiting for static and `/config`
-   Structured JSON logs (pino) for forwarding
-   Prometheus metrics at `/metrics` (disabled by default, optional bearer auth)
-   Optional Redis pub/sub for multi-instance signaling
-   Default Origin policy tightened (same-host if ALLOWED_ORIGINS not set)
-   Per-connection WebSocket rate limiting (token bucket)
-   Express signature header disabled

Note: In production (NODE_ENV=production), the server will refuse to start if ALLOWED_ORIGINS is not set. This prevents permissive defaults.

## Configuration

Environment variables:

-   PORT: HTTP port (default 5173)
-   WS_PATH: WebSocket path (default /ws)
-   ALLOWED_ORIGINS: Comma-separated allowed Origin values (e.g., `https://yourdomain.com,https://www.yourdomain.com`)
-   ICE_SERVERS: JSON array of ICE server objects for RTCPeerConnection, e.g.
    `[{"urls":"turns:turn.example.com:5349","username":"user","credential":"pass"}]`
-   ICE_FORCE_RELAY: When true, hints clients to use TURN-only (relay) connectivity. Helps on cellular/strict NATs.
-   MAX_IP_CONNS: Soft limit per IP for concurrent WS connections (default 50)
-   METRICS_ENABLED: Enable `/metrics` endpoint (default false)
-   METRICS_TOKEN: Optional bearer token required to access `/metrics`
-   WS_MSG_RATE: WS messages per second per connection (default 20)
-   WS_MSG_BURST: Token bucket capacity (default 40)
-   HTTP_WINDOW_MS: HTTP rate-limit window in ms (default 60000)
-   HTTP_STATIC_MAX: Max requests per window for static assets (default 300)
-   HTTP_CONFIG_MAX: Max requests per window for `/config` (default 60)
-   HSTS_ENABLED: Emit HSTS header from app (usually better at proxy) (default false)
-   HSTS_MAX_AGE: HSTS max-age seconds (default 15552000)
-   REDIS_URL: When set, enable cross-instance signaling via Redis pub/sub
-   REDIS_PREFIX: Redis keys/channel prefix (default `p2pws:`)
-   NODE_ID: Optional instance identifier (for logs)
-   LOG_LEVEL: pino log level (default `info`)

## Scripts

-   Start: `npm start`
-   Dev: `npm run start:dev` (sets NODE_ENV=development)

## Usage

1. Install dependencies: `npm install`
2. Optionally copy `.env.example` to `.env` and tweak settings (especially ALLOWED_ORIGINS for production).
3. Start the server, open the printed URL in two browsers/devices.
4. Copy your ID from one browser and paste it in the other, then Connect.
5. You can send a file, a text message, or both. Message-only sends are supported (no file selected).

## Deploying behind a reverse proxy

Recommended: put this behind Nginx, Caddy, or a cloud load balancer that terminates TLS.

-   Terminate HTTPS at the proxy, forward to Node over HTTP
-   Proxy WebSockets on `WS_PATH` (default `/ws`)
-   Add HSTS at the proxy layer
-   Set `ALLOWED_ORIGINS` to your site origin(s)
-   Provide TURN over TLS (`turns:` on 5349) if users connect via cellular networks
-   Restrict `/metrics` to trusted networks or require `Authorization: Bearer <token>`

## Health checks

-   GET `/healthz` -> `200 ok`

## Client runtime config

-   GET `/config` returns `{ wsPath, iceServers, iceTransportPolicy }` consumed by the web client.
    -   Provide TURN in `ICE_SERVERS` for restrictive networks (mobile/cellular, CGNAT, corporate Wi‑Fi).
    -   Set `ICE_FORCE_RELAY=true` to suggest clients use relay-only when needed.

## Security checklist

-   [ ] Serve over HTTPS, ensure `ALLOWED_ORIGINS` is set (or rely on tightened same-host default)
-   [ ] Provide TURN servers (set `ICE_SERVERS`)
-   [ ] Put behind a WAF or enable rate limits at the proxy
-   [ ] Monitor logs & metrics (ship pino JSON logs to your collector)
    -   Now emits JSON logs (pino) and Prometheus metrics
-   [ ] If enabling `/metrics`, set `METRICS_TOKEN` or protect at the proxy
-   [ ] If scaling to multiple instances, set `REDIS_URL` and ensure Redis availability

## Development

-   Sources: `src/server.js` (server), `web/*` (client)
-   Node 18+
-   Use a lockfile in CI for reproducible builds (commit package-lock.json and prefer `npm ci`)

This server is stateless: peers and sessions are in-memory only; files are never stored on the server.

## Troubleshooting mobile pairing

If pairing fails on phones or over cellular data:

-   Serve the site over HTTPS. Many mobile browsers limit WebRTC on insecure origins.
-   Configure a TURN server reachable over TLS, e.g. `turns:turn.example.com:5349` with username/credential.
-   Set environment variables:
    -   `ICE_SERVERS` to include your TURN server(s)
    -   `ICE_FORCE_RELAY=true` to force relay-only routing when needed
    -   Example:
        `ICE_SERVERS=[{"urls":["turns:turn.example.com:5349"],"username":"user","credential":"pass"}]`
-   Ensure your proxy forwards WebSocket upgrades on `WS_PATH` without buffering.
-   Check the in-page logs: it prints ICE states and candidate types (host/srflx/relay). If you see no relay candidates, the TURN config is not working.

## License

MIT
