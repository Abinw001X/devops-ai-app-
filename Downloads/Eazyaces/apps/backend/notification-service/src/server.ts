import 'dotenv/config';
import { createServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { Counter, Histogram, prometheusContentType, register } from '@prometheus-io/client';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as SocketServer } from 'socket.io';
import pg from 'pg';
import { createClient } from 'redis';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT ?? 4003);
const httpServer = createServer(app);
const io = new SocketServer(httpServer, { cors: { origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000', credentials: true } });
const accessSecret = process.env.JWT_ACCESS_SECRET;
const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redisPublisher = process.env.REDIS_URL ? createClient({ url: process.env.REDIS_URL }) : null;
const redisSubscriber = redisPublisher?.duplicate() ?? null;
const requestCount = new Counter({ name: 'kaamsetu_notification_http_requests_total', help: 'HTTP requests handled by notification-service.', labelNames: ['method', 'route', 'status_code'] });
const requestDuration = new Histogram({ name: 'kaamsetu_notification_http_request_duration_seconds', help: 'HTTP request duration in seconds for notification-service.', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });

if (!accessSecret || accessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be configured with at least 32 characters.');

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();
  response.once('finish', () => {
    const route = request.route?.path ? `${request.baseUrl}${request.route.path}` : 'unmatched';
    const labels = { method: request.method, route, status_code: String(response.statusCode) };
    const elapsed = Number(process.hrtime.bigint() - startedAt);
    requestCount.inc(labels);
    requestDuration.observe(labels, elapsed / 1_000_000_000);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: response.statusCode >= 500 ? 'error' : 'info', service: 'notification-service', ...labels, duration_ms: elapsed / 1_000_000 }));
  });
  next();
});

io.use((socket, next) => {
  const token = String(socket.handshake.auth.token ?? '');
  try {
    const payload = jwt.verify(token, accessSecret) as JwtPayload;
    if (!payload.sub) throw new Error('Missing subject.');
    socket.data.userId = String(payload.sub);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => socket.join(`user:${socket.data.userId}`));

type NotificationInput = { userId: string; eventType: string; title: string; body: string; referenceType?: string; referenceId?: string };

async function sendCriticalEmail(userId: string, eventType: string, title: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !['booking.confirmed', 'payment.received', 'verification.approved', 'verification.rejected'].includes(eventType)) return;
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = result.rows[0]?.email;
  if (!email) return;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: title, text: `${body}\n\nKaamSetu` }),
  });
  if (!response.ok) console.error(JSON.stringify({ level: 'error', service: 'notification-service', event: 'email_delivery_failed', status: response.status }));
}

async function pushNotification(input: NotificationInput): Promise<void> {
  const result = await pool.query(
    `INSERT INTO notifications (user_id, event_type, title, body, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, event_type, title, body, reference_type, reference_id, created_at, read_at`,
    [input.userId, input.eventType, input.title, input.body, input.referenceType ?? null, input.referenceId ?? null],
  );
  io.to(`user:${input.userId}`).emit('notification', result.rows[0]);
  try {
    await sendCriticalEmail(input.userId, input.eventType, input.title, input.body);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', service: 'notification-service', event: 'email_delivery_failed', message: error instanceof Error ? error.message : 'unknown error' }));
  }
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
}

type AuthRequest = Request & { authUser?: { id: string; role: string } };
function requireAuth(request: AuthRequest, response: Response, next: NextFunction): void {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return void response.status(401).json({ error: 'Sign in to continue.' });
  try {
    const payload = jwt.verify(token, accessSecret as string) as JwtPayload;
    if (!payload.sub || !['customer', 'technician', 'company', 'admin'].includes(String(payload.role))) throw new Error('Invalid token claims.');
    request.authUser = { id: String(payload.sub), role: String(payload.role) };
    next();
  } catch {
    response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
app.get('/health', asyncRoute(async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    const redisReady = !redisPublisher || Boolean(redisPublisher.isReady && redisSubscriber?.isReady);
    if (!redisReady) return response.status(503).json({ status: 'not_ready', database: 'ready', redis: 'unavailable' });
    response.json({ status: 'ok', database: 'ready', redis: redisPublisher ? 'ready' : 'disabled' });
  } catch {
    response.status(503).json({ status: 'not_ready', database: 'unavailable', redis: redisPublisher?.isReady ? 'ready' : redisPublisher ? 'unavailable' : 'disabled' });
  }
}));
app.get('/metrics', asyncRoute(async (_request, response) => {
  response.setHeader('Content-Type', prometheusContentType);
  response.end(await register.metrics());
}));

app.post('/internal/notifications', asyncRoute(async (request, response) => {
  if (!internalSecret || request.header('x-internal-service-secret') !== internalSecret) return response.status(403).json({ error: 'Forbidden.' });
  const parsed = z.object({ userId: z.string().uuid(), eventType: z.string().min(1).max(80), title: z.string().min(1).max(160), body: z.string().min(1).max(1000), referenceType: z.string().max(40).optional(), referenceId: z.string().uuid().optional() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid notification payload.' });
  await pushNotification(parsed.data);
  response.status(202).json({ accepted: true });
}));

app.get('/api/notifications', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const result = await pool.query(
    `SELECT id, event_type, title, body, reference_type, reference_id, created_at, read_at
     FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [authRequest.authUser?.id],
  );
  response.json(result.rows);
}));

app.patch('/api/notifications/:id/read', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const notificationId = z.string().uuid().safeParse(request.params.id);
  if (!notificationId.success) return response.status(404).json({ error: 'Notification not found.' });
  const result = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id, read_at', [notificationId.data, authRequest.authUser?.id]);
  if (!result.rows[0]) return response.status(404).json({ error: 'Notification not found.' });
  response.json(result.rows[0]);
}));

app.patch('/api/notifications/read-all', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [authRequest.authUser?.id]);
  response.status(204).end();
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ level: 'error', service: 'notification-service', message: error instanceof Error ? error.message : 'unknown error' }));
  response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function startServer(): Promise<void> {
  if (redisPublisher && redisSubscriber) {
    redisPublisher.on('error', (error) => console.error(JSON.stringify({ level: 'error', service: 'notification-service', event: 'redis_publisher_error', message: error.message })));
    redisSubscriber.on('error', (error) => console.error(JSON.stringify({ level: 'error', service: 'notification-service', event: 'redis_subscriber_error', message: error.message })));
    await Promise.all([redisPublisher.connect(), redisSubscriber.connect()]);
    io.adapter(createAdapter(redisPublisher, redisSubscriber));
  }
  httpServer.listen(port, () => console.log(JSON.stringify({ level: 'info', service: 'notification-service', event: 'listening', port })));
}

void startServer().catch((error) => {
  console.error(JSON.stringify({ level: 'error', service: 'notification-service', event: 'startup_failed', message: error instanceof Error ? error.message : 'unknown error' }));
  process.exitCode = 1;
});