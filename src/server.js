import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { cleanEnv, str, port as envPort, num, bool, json } from 'envalid';
import client from 'prom-client';
import Redis from 'ioredis';

const app = express();
// Remove Express signature header
app.disable('x-powered-by');
const httpServer = createServer(app);

// Validate configuration early and fail fast
const env = cleanEnv(process.env, {
	PORT: envPort({ default: 5173 }),
	WS_PATH: str({ default: '/ws' }),
	ALLOWED_ORIGINS: str({ default: '' }),
	ICE_SERVERS: json({ default: [{ urls: ['stun:stun.l.google.com:19302'] }] }),
	MAX_IP_CONNS: num({ default: 50 }),
	// Disable metrics by default for production; can be enabled explicitly
	METRICS_ENABLED: bool({ default: false }),
	// Optional bearer token to protect /metrics
	METRICS_TOKEN: str({ default: '' }),
	// WebSocket message rate limiting (per connection)
	WS_MSG_RATE: num({ default: 20 }), // tokens per second
	WS_MSG_BURST: num({ default: 40 }), // bucket capacity
	// HTTP rate-limits (window in ms and max requests per window)
	HTTP_WINDOW_MS: num({ default: 60_000 }),
	HTTP_STATIC_MAX: num({ default: 300 }),
	HTTP_CONFIG_MAX: num({ default: 60 }),
	// Optional Redis URL to enable multi-instance signaling
	REDIS_URL: str({ default: '' }),
	REDIS_PREFIX: str({ default: 'p2pws:' }),
	NODE_ID: str({ default: '' }),
	LOG_LEVEL: str({ default: 'info' }),
	// Optional HSTS header from app (usually set at the proxy)
	HSTS_ENABLED: bool({ default: false }),
	HSTS_MAX_AGE: num({ default: 15552000 }), // 180 days
});

const WS_PATH = env.WS_PATH;
const ALLOWED_ORIGINS = String(env.ALLOWED_ORIGINS || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const allowedOriginSet = new Set(ALLOWED_ORIGINS);

// Configure trusted proxy hops safely:
// - If explicit ALLOWED_ORIGINS are configured, we assume a single reverse proxy (common)
// - Otherwise, do not trust proxy headers to avoid XFF spoofing in local/dev
const TRUST_PROXY = allowedOriginSet.size > 0 ? 1 : false;
// Apply Express trust proxy with a non-permissive setting
app.set('trust proxy', TRUST_PROXY);

// Enforce explicit origins in production to avoid permissive defaults
if ((process.env.NODE_ENV || '').toLowerCase() === 'production' && allowedOriginSet.size === 0) {
	// Use console here (logger not initialized yet)
	console.error('ALLOWED_ORIGINS must be set in production (comma-separated exact origins).');
	process.exit(1);
}

// Optional multi-instance signaling via Redis
const useRedis = !!env.REDIS_URL;
const instanceId = env.NODE_ID || uuidv4().slice(0, 8);
let redisPub = null;
let redisSub = null;
let redisPeersKey = null;
let redisSignalsChannel = null;
if (useRedis) {
	redisPub = new Redis(env.REDIS_URL, { lazyConnect: true });
	redisSub = new Redis(env.REDIS_URL, { lazyConnect: true });
	redisPeersKey = `${env.REDIS_PREFIX}peers`;
	redisSignalsChannel = `${env.REDIS_PREFIX}signals`;
	Promise.all([redisPub.connect(), redisSub.connect()]).catch(() => {});
	redisSub.subscribe(redisSignalsChannel).catch(() => {});
}

// WebSocket server in noServer mode to validate Origin and path ourselves
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }); // 256KB signals limit

// Security headers (CSP tuned for local assets only)
app.use(
	helmet({
		contentSecurityPolicy: {
			useDefaults: true,
			directives: {
				// Allow only same-origin resources with explicit websocket allowance
				'default-src': ["'self'"],
				'script-src': ["'self'"],
				'style-src': ["'self'"],
				'img-src': ["'self'", 'data:'],
				// Allow WebSocket connections to same-origin and wss scheme if proxied
				'connect-src': ["'self'", 'wss:', 'ws:'],
				'object-src': ["'none'"],
				'base-uri': ["'self'"],
				'frame-ancestors': ["'none'"],
			},
		},
		crossOriginEmbedderPolicy: false, // not needed for this app
	})
);
// Optionally emit HSTS (usually better at the TLS proxy)
if (env.HSTS_ENABLED) {
	app.use(
		helmet.hsts({
			maxAge: Number(env.HSTS_MAX_AGE),
			includeSubDomains: true,
			preload: false,
		})
	);
}
// Compression for static and small JSON endpoints
app.use(compression());

// Structured logger
const logger = pino({
	level: env.LOG_LEVEL,
	// Prevent leaking sensitive headers
	redact: {
		paths: [
			'req.headers.authorization',
			'req.headers.cookie',
			'res.headers["set-cookie"]',
			'req.headers["x-api-key"]',
		],
		remove: true,
	},
});
app.use(pinoHttp({ logger }));

// Request rate limiting (protect static and config endpoints)
const staticLimiter = rateLimit({
	windowMs: Number(env.HTTP_WINDOW_MS),
	max: Number(env.HTTP_STATIC_MAX),
	standardHeaders: true,
	legacyHeaders: false,
	// Mirror the Express trust proxy setting to avoid unsafe defaults
	trustProxy: TRUST_PROXY,
});
const configLimiter = rateLimit({
	windowMs: Number(env.HTTP_WINDOW_MS),
	max: Number(env.HTTP_CONFIG_MAX),
	standardHeaders: true,
	legacyHeaders: false,
	trustProxy: TRUST_PROXY,
});

// Serve static web app with sensible caching
const staticDir = path.resolve(process.cwd(), 'web');
app.get('/', (req, res, next) => {
	res.set('Cache-Control', 'no-store');
	next();
});
app.use(staticLimiter, express.static(staticDir, { maxAge: '1d', etag: true, lastModified: true }));

// Health endpoint for load balancers
app.get('/healthz', (_req, res) => {
	res.type('text/plain').send('ok');
});

// Config endpoint to provide client with WS path and ICE servers
app.get('/config', configLimiter, (_req, res) => {
	let iceServers = Array.isArray(env.ICE_SERVERS) ? env.ICE_SERVERS : [{ urls: ['stun:stun.l.google.com:19302'] }];
	res.json({ wsPath: WS_PATH, iceServers });
});

// Prometheus metrics
const register = new client.Registry();
// Capture interval so we can clear it during shutdown/tests to avoid open handles
const metricsInterval = client.collectDefaultMetrics({ register });
const wsClientsGauge = new client.Gauge({
	name: 'ws_clients',
	help: 'Active WebSocket clients',
	registers: [register],
});
const wsPairsGauge = new client.Gauge({ name: 'ws_pairs', help: 'Active WebRTC pairings', registers: [register] });
const wsSignalsCounter = new client.Counter({
	name: 'ws_signals_total',
	help: 'Total relayed signaling messages',
	labelNames: ['kind'],
	registers: [register],
});
const wsErrorsCounter = new client.Counter({
	name: 'ws_errors_total',
	help: 'WebSocket errors/invalid',
	registers: [register],
});

app.get('/metrics', async (req, res) => {
	if (!env.METRICS_ENABLED) return res.status(404).end();
	// Optional bearer auth for metrics exposure
	if (env.METRICS_TOKEN) {
		const auth = req.headers['authorization'] || '';
		if (auth !== `Bearer ${env.METRICS_TOKEN}`) {
			return res.status(401).set('WWW-Authenticate', 'Bearer').end();
		}
	}
	try {
		res.set('Content-Type', register.contentType);
		res.end(await register.metrics());
	} catch (e) {
		res.status(500).end('metrics_error');
	}
});

// In-memory peer registry (ephemeral). Not persisted; no files stored.
const peers = new Map(); // id -> ws
const partner = new Map(); // id -> partnerId or null

function send(ws, msg) {
	try {
		ws.send(JSON.stringify(msg));
	} catch {}
}

// Heartbeat handling
function heartbeat() {
	this.isAlive = true;
}

// Basic per-IP connection limiter (soft)
const ipConnCount = new Map();
const MAX_IP_CONNS = Number(env.MAX_IP_CONNS);

// Handle WS upgrades with Origin and path validation
httpServer.on('upgrade', (req, socket, head) => {
	const { url, headers } = req;
	const origin = headers.origin || '';
	const host = headers.host || '';

	// Path check
	if (!url || !url.startsWith(WS_PATH)) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return;
	}

	// Origin allow-list; if none configured, default to same-origin (scheme-agnostic)
	let originAllowed = true;
	if (allowedOriginSet.size) {
		originAllowed = allowedOriginSet.has(origin);
	} else {
		try {
			const o = origin ? new URL(origin) : null;
			originAllowed = !!o && o.host === host; // accept http or https with same host:port
		} catch {
			originAllowed = false;
		}
	}
	if (!originAllowed) {
		socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
		socket.destroy();
		return;
	}

	// Soft connection limiting by IP
	const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
	const c = (ipConnCount.get(ip) || 0) + 1;
	if (c > MAX_IP_CONNS) {
		socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
		socket.destroy();
		return;
	}
	ipConnCount.set(ip, c);

	// Guard against long-lived half-open upgrades
	try {
		socket.setTimeout(10_000, () => {
			try {
				socket.destroy();
			} catch {}
		});
	} catch {}

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit('connection', ws, req);
	});
});

wss.on('connection', (ws, req) => {
	ws.isAlive = true;
	ws.on('pong', heartbeat);
	const id = uuidv4();
	peers.set(id, ws);
	partner.set(id, null);
	send(ws, { type: 'welcome', id });
	wsClientsGauge.set(peers.size);

	// Register this peer in Redis (if enabled)
	if (useRedis && redisPub && redisPeersKey) {
		redisPub.hset(redisPeersKey, id, instanceId).catch(() => {});
	}

	// Simple token-bucket message rate limiter per connection
	const rateCfg = { rate: Number(env.WS_MSG_RATE), burst: Number(env.WS_MSG_BURST) };
	ws._bucket = { tokens: rateCfg.burst, last: Date.now(), cfg: rateCfg };

	// Idle-timeout for clients that never signal (no offer/answer/candidate within 60s)
	let signalTimeout = setTimeout(() => {
		try {
			ws.close(1000, 'idle');
		} catch {}
	}, 60_000);

	ws.on('message', (data) => {
		// Rate-limit check
		const b = ws._bucket;
		if (b && b.cfg.rate > 0) {
			const now = Date.now();
			const elapsed = Math.max(0, now - b.last) / 1000;
			b.last = now;
			b.tokens = Math.min(b.cfg.burst, b.tokens + elapsed * b.cfg.rate);
			if (b.tokens < 1) {
				wsErrorsCounter.inc();
				try {
					ws.close(1008, 'rate');
				} catch {}
				return;
			}
			b.tokens -= 1;
		}
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			wsErrorsCounter.inc();
			return;
		}
		// Strict message validation
		const { to, payload, type } = msg || {};
		if (typeof to !== 'string' || !payload || typeof payload !== 'object') {
			wsErrorsCounter.inc();
			return;
		}

		// Do not expose other peers (privacy): return empty list or ignore
		if (type === 'list') {
			send(ws, { type: 'peers', peers: [] });
			return;
		}

		// If destination is local, deliver; else (optional) forward via Redis
		let dest = peers.get(to);
		if (!dest) {
			if (useRedis && redisPub) {
				try {
					redisPub.publish(redisSignalsChannel, JSON.stringify({ to, from: id, payload, type: 'signal' }));
				} catch {}
			}
			return;
		}

		// Enforce single active connection per peer (simple busy locking)
		const pFrom = partner.get(id) || null;
		const pTo = partner.get(to) || null;
		const kind = payload?.type;
		if (!['offer', 'answer', 'candidate', 'bye', 'busy'].includes(kind)) return;
		// Basic size guards for SDP/candidates
		if (payload?.sdp && JSON.stringify(payload.sdp).length > 200_000) return; // ~200KB
		if (payload?.candidate && JSON.stringify(payload.candidate).length > 50_000) return; // ~50KB

		// First valid signaling message cancels idle timeout
		if (signalTimeout) {
			clearTimeout(signalTimeout);
			signalTimeout = null;
		}

		if (kind === 'offer') {
			// If either side is busy with someone else, reject
			if ((pFrom && pFrom !== to) || (pTo && pTo !== id)) {
				// Inform caller they're busy/peer busy (using signal channel for compatibility)
				send(ws, { from: to, type: 'signal', payload: { type: 'busy' } });
				return;
			}
			// Mark caller as dialing callee
			partner.set(id, to);
		}

		if (kind === 'answer') {
			// Lock both sides together
			if ((pFrom && pFrom !== to) || (pTo && pTo !== id)) {
				// Conflict: one side switched; drop
				return;
			}
			partner.set(id, to);
			partner.set(to, id);
		}

		if (kind === 'bye') {
			// Release both sides
			if (pFrom === to) partner.set(id, null);
			if (pTo === id) partner.set(to, null);
		}

		// Only relay candidates if they belong to current pairing
		if (kind === 'candidate') {
			if (!(pFrom === to || pTo === id || (pFrom === null && pTo === null))) {
				return;
			}
		}

		// Forward signal
		send(dest, { from: id, type: 'signal', payload });
		try {
			wsSignalsCounter.inc({ kind: kind || 'unknown' });
		} catch {}

		// update pairs gauge after any state change
		setImmediate(() => wsPairsGauge.set(calcPairs()));
	});

	ws.on('close', () => {
		peers.delete(id);
		const p = partner.get(id) || null;
		partner.delete(id);
		if (p && partner.get(p) === id) partner.set(p, null);
		wsClientsGauge.set(peers.size);
		setImmediate(() => wsPairsGauge.set(calcPairs()));
		// decrement IP counter
		try {
			const ip = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').toString();
			const c = (ipConnCount.get(ip) || 1) - 1;
			if (c <= 0) ipConnCount.delete(ip);
			else ipConnCount.set(ip, c);
		} catch {}
		if (signalTimeout) {
			clearTimeout(signalTimeout);
			signalTimeout = null;
		}
		// Remove from Redis mapping
		if (useRedis && redisPub && redisPeersKey) {
			redisPub.hdel(redisPeersKey, id).catch(() => {});
		}
	});
});

// Terminate dead WS clients periodically
const hbInterval = setInterval(() => {
	wss.clients.forEach((ws) => {
		if (ws.isAlive === false) {
			try {
				ws.terminate();
			} catch {}
			return;
		}
		ws.isAlive = false;
		try {
			ws.ping();
		} catch {}
	});
}, 30_000);

const PORT = Number(env.PORT);
httpServer.listen(PORT, () => {
	logger.info({ port: PORT, wsPath: WS_PATH, staticDir }, 'server_started');
});

// Graceful shutdown
function shutdown() {
	logger.info('Shutting down...');
	clearInterval(hbInterval);
	try {
		if (metricsInterval) clearInterval(metricsInterval);
	} catch {}
	try {
		wss.close();
	} catch {}
	try {
		httpServer.close(() => process.exit(0));
	} catch {
		process.exit(0);
	}
	// Close Redis clients if used
	try {
		if (useRedis && redisPub) redisPub.quit().catch(() => {});
	} catch {}
	try {
		if (useRedis && redisSub) redisSub.quit().catch(() => {});
	} catch {}
	// Force exit after timeout
	setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Crash safety: log and exit so container restarts
process.on('unhandledRejection', (reason) => {
	try {
		logger.error({ reason }, 'unhandled_rejection');
	} catch {}
	setTimeout(() => process.exit(1), 10).unref();
});
process.on('uncaughtException', (err) => {
	try {
		logger.error({ err }, 'uncaught_exception');
	} catch {}
	setTimeout(() => process.exit(1), 10).unref();
});

// Helper: compute number of active, mutually paired connections
function calcPairs() {
	const seen = new Set();
	let pairs = 0;
	for (const [a, b] of partner.entries()) {
		if (!b) continue;
		if (partner.get(b) === a) {
			const key = a < b ? `${a}|${b}` : `${b}|${a}`;
			if (!seen.has(key)) {
				seen.add(key);
				pairs += 1;
			}
		}
	}
	return pairs;
}

// Redis subscriber: deliver cross-node signals to local peers
if (useRedis && redisSub) {
	redisSub.on('message', (channel, message) => {
		if (channel !== redisSignalsChannel) return;
		let msg;
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}
		const { to, from, payload, type } = msg || {};
		if (type !== 'signal' || typeof to !== 'string' || !payload) return;
		const dest = peers.get(to);
		if (!dest) return;
		send(dest, { from, type: 'signal', payload });
		try {
			wsSignalsCounter.inc({ kind: payload?.type || 'unknown' });
		} catch {}
	});
}

// Test helper: allow graceful shutdown without process.exit
export async function stopServer() {
	try {
		clearInterval(hbInterval);
	} catch {}
	try {
		if (metricsInterval) clearInterval(metricsInterval);
	} catch {}
	try {
		await new Promise((resolve) => {
			try {
				wss.close();
			} catch {}
			try {
				httpServer.close(() => resolve());
			} catch {
				resolve();
			}
		});
	} catch {}
	if (useRedis) {
		try {
			if (redisPub) await redisPub.quit();
		} catch {}
		try {
			if (redisSub) await redisSub.quit();
		} catch {}
	}
}
