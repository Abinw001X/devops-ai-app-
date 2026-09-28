import 'dotenv/config';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import Razorpay from 'razorpay';
import { Counter, Histogram, prometheusContentType, register } from '@prometheus-io/client';
import { z } from 'zod';
import pg from 'pg';
import { bookingEvents } from './events.js';

const app = express();
const port = Number(process.env.PORT ?? 4001);
const accessSecret = process.env.JWT_ACCESS_SECRET;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const requestCount = new Counter({ name: 'kaamsetu_booking_http_requests_total', help: 'HTTP requests handled by booking-service.', labelNames: ['method', 'route', 'status_code'] });
const requestDuration = new Histogram({ name: 'kaamsetu_booking_http_request_duration_seconds', help: 'HTTP request duration in seconds for booking-service.', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });
const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

if (!accessSecret || accessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be configured with at least 32 characters.');

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000', credentials: true }));
app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();
  response.once('finish', () => {
    const route = request.route?.path ? `${request.baseUrl}${request.route.path}` : 'unmatched';
    const labels = { method: request.method, route, status_code: String(response.statusCode) };
    requestCount.inc(labels);
    requestDuration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: response.statusCode >= 500 ? 'error' : 'info', service: 'booking-service', ...labels, duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }));
  });
  next();
});

type Role = 'customer' | 'technician' | 'company' | 'admin';
type AuthUser = { id: string; role: Role };
type AuthRequest = Request & { authUser?: AuthUser };
type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'rejected';
type SubscriptionStatus = 'pending' | 'active' | 'payment_failed' | 'expired' | 'cancelled';
type PaymentRecord = { booking_id: string; razorpay_order_id: string; razorpay_payment_id: string | null; amount_paise: string; status: string };
type NotificationInput = { userId: string; eventType: string; title: string; body: string; referenceType?: string; referenceId?: string };

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const bookingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const slots = Array.from({ length: 9 }, (_, index) => `${String(index + 9).padStart(2, '0')}:00`);

app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (request, response, next) => {
  void handleWebhook(request, response).catch(next);
});
app.use(express.json({ limit: '1mb' }));

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
}

async function pushNotification(input: NotificationInput): Promise<void> {
  const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL;
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
  if (!notificationServiceUrl || !internalSecret) {
    console.error(JSON.stringify({ level: 'error', service: 'booking-service', event: 'notification_service_unconfigured' }));
    return;
  }
  try {
    const response = await fetch(`${notificationServiceUrl.replace(/\/$/, '')}/internal/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-secret': internalSecret },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) console.error(JSON.stringify({ level: 'error', service: 'booking-service', event: 'notification_delivery_failed', status: response.status }));
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', service: 'booking-service', event: 'notification_delivery_failed', message: error instanceof Error ? error.message : 'unknown error' }));
  }
}

async function notifyBookingPeople(bookingId: string, eventType: string, title: string, body: string): Promise<void> {
  const result = await pool.query(
    `SELECT b.id, b.customer_id, p.user_id AS provider_user_id FROM bookings b
     JOIN provider_profiles p ON p.id = b.provider_id WHERE b.id = $1`,
    [bookingId],
  );
  const booking = result.rows[0];
  if (!booking) return;
  await Promise.all([
    pushNotification({ userId: String(booking.customer_id), eventType, title, body, referenceType: 'booking', referenceId: bookingId }),
    pushNotification({ userId: String(booking.provider_user_id), eventType, title, body, referenceType: 'booking', referenceId: bookingId }),
  ]);
}

function requireAuth(request: AuthRequest, response: Response, next: NextFunction): void {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    response.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  try {
    const payload = jwt.verify(token, accessSecret as string) as JwtPayload;
    if (!payload.sub || !['customer', 'technician', 'company', 'admin'].includes(String(payload.role))) throw new Error('Invalid token claims.');
    request.authUser = { id: String(payload.sub), role: payload.role as Role };
    next();
  } catch {
    response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function roleIs(request: AuthRequest, roles: Role[]): boolean {
  return Boolean(request.authUser && roles.includes(request.authUser.role));
}

function adminOnly(request: AuthRequest, response: Response, next: NextFunction): void {
  if (request.authUser?.role !== 'admin') {
    response.status(403).json({ error: 'Only admins can access this area.' });
    return;
  }
  next();
}

async function recordAdminAction(adminId: string, action: string, referenceType: string, referenceId: string, details: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, $2, $3, $4, $5)',
    [adminId, action, referenceType, referenceId, JSON.stringify(details)],
  );
}

async function razorpayXRequest<T>(resource: string, input: Record<string, unknown>): Promise<T> {
  const keyId = process.env.RAZORPAYX_KEY_ID ?? process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAYX_KEY_SECRET ?? process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !process.env.RAZORPAYX_ACCOUNT_NUMBER) {
    throw Object.assign(new Error('RazorpayX payout credentials are not configured.'), { statusCode: 503 });
  }
  const response = await fetch(`https://api.razorpay.com/v1/${resource}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json() as { id?: string; status?: string; error?: { description?: string } };
  if (!response.ok) throw Object.assign(new Error(body.error?.description ?? 'RazorpayX could not process this payout.'), { statusCode: 502 });
  return body as T;
}

async function createRazorpayXPayout(payout: Record<string, unknown>, profile: Record<string, unknown>, owner: Record<string, unknown>) {
  if (!profile.payout_kyc_verified || !profile.bank_account_holder_name || !(profile.bank_account_number || profile.upi_id)) {
    throw Object.assign(new Error('The provider payout account is not verified.'), { statusCode: 409 });
  }
  const contact = await razorpayXRequest<{ id: string }>('contacts', {
    name: profile.bank_account_holder_name,
    email: owner.email ?? undefined,
    contact: owner.phone ? String(owner.phone).replace(/[^0-9]/g, '').slice(-10) : undefined,
    type: 'vendor',
  });
  const fundAccount = await razorpayXRequest<{ id: string }>('fund_accounts', {
    contact_id: contact.id,
    account_type: profile.upi_id ? 'vpa' : 'bank_account',
    ...(profile.upi_id ? { vpa: { address: profile.upi_id } } : { bank_account: { name: profile.bank_account_holder_name, ifsc: profile.bank_ifsc_code, account_number: profile.bank_account_number } }),
  });
  return razorpayXRequest<{ id: string; status: string }>('payouts', {
    account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
    fund_account_id: fundAccount.id,
    amount: Number(payout.amount_paise),
    currency: 'INR',
    mode: profile.upi_id ? 'UPI' : 'IMPS',
    purpose: 'payout',
    queue_if_low_balance: true,
    reference_id: String(payout.id).replaceAll('-', '').slice(0, 40),
    narration: 'KaamSetu provider payout',
  });
}

function signatureMatches(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'hex');
  const suppliedBuffer = Buffer.from(supplied, 'hex');
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function indiaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().startsWith(date);
}

function isFutureSlot(date: string, time: string): boolean {
  return new Date(`${date}T${time}:00+05:30`).getTime() > Date.now();
}

async function fetchCommissionPercent(client: pg.Pool | pg.PoolClient = pool): Promise<number> {
  const result = await client.query("SELECT value FROM platform_settings WHERE key = 'platform_commission_percent' LIMIT 1");
  const raw = Number(result.rows[0]?.value ?? '10');
  return Number.isFinite(raw) ? raw : 10;
}

async function refreshProviderLiveState(providerId: string, client: pg.Pool | pg.PoolClient = pool): Promise<void> {
  await client.query(
    `UPDATE provider_profiles
     SET is_live = (verification_status = 'verified' AND subscription_status = 'active'),
         is_featured = COALESCE(is_featured, FALSE)
     WHERE id = $1`,
    [providerId],
  );
}

async function getProviderProfileForUser(userId: string, client: pg.Pool | pg.PoolClient = pool) {
  return client.query(`SELECT * FROM provider_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
}

async function openSlots(providerId: string, date: string, client: pg.Pool | pg.PoolClient = pool): Promise<string[]> {
  const reserved = await client.query(
    `SELECT TO_CHAR(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS slot
     FROM bookings
     WHERE provider_id = $1
       AND (scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       AND status IN ('pending', 'confirmed', 'in_progress')
       AND (payment_status = 'paid' OR created_at > NOW() - INTERVAL '15 minutes')`,
    [providerId, date],
  );
  const reservedTimes = new Set(reserved.rows.map((row) => String(row.slot)));
  return slots.filter((time) => !reservedTimes.has(time) && isFutureSlot(date, time));
}

function statusEvent(row: { id: string; customer_id: string; provider_id: string }, previousStatus: string, status: string): void {
  bookingEvents.emit('booking.status_changed', {
    bookingId: row.id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    previousStatus,
    status,
    occurredAt: new Date().toISOString(),
  });
}

bookingEvents.on('booking.status_changed', (event: { bookingId: string; status: string }) => {
  const eventType = event.status === 'confirmed' ? 'booking.confirmed' : 'booking.status_changed';
  void notifyBookingPeople(event.bookingId, eventType, event.status === 'confirmed' ? 'Booking confirmed' : 'Booking updated', `Your booking status is now ${event.status.replaceAll('_', ' ')}.`)
    .catch((error) => console.error('Booking notification could not be delivered.', error));
});

async function refundPayment(paymentId: string, amountPaise: number, bookingId: string): Promise<'refunded' | 'refund_pending'> {
  if (!razorpay) throw new Error('Razorpay is not configured.');
  const refund = await razorpay.payments.refund(paymentId, { amount: amountPaise, notes: { booking_id: bookingId } });
  return refund.status === 'processed' ? 'refunded' : 'refund_pending';
}

async function setPaymentPaid(orderId: string, paymentId: string, eventId?: string): Promise<{ status: string; bookingId: string }> {
  const client = await pool.connect();
  let needsRefund: { amount: number; bookingId: string } | null = null;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT t.booking_id, t.razorpay_order_id, t.razorpay_payment_id, t.amount_paise, t.status,
              b.status AS booking_status, b.customer_id, b.provider_id
       FROM payment_transactions t JOIN bookings b ON b.id = t.booking_id
       WHERE t.razorpay_order_id = $1 FOR UPDATE OF t, b`,
      [orderId],
    );
    const transaction = result.rows[0] as (PaymentRecord & { booking_status: BookingStatus; customer_id: string; provider_id: string }) | undefined;
    if (!transaction) throw Object.assign(new Error('Payment order not found.'), { statusCode: 404 });
    if (transaction.razorpay_payment_id && transaction.razorpay_payment_id !== paymentId) {
      if (transaction.status === 'paid') {
        needsRefund = { amount: Number(transaction.amount_paise), bookingId: transaction.booking_id };
        await client.query("UPDATE payment_transactions SET status = 'refund_pending', updated_at = NOW() WHERE razorpay_order_id = $1", [orderId]);
        await client.query("UPDATE bookings SET payment_status = 'refund_pending', updated_at = NOW() WHERE id = $1", [transaction.booking_id]);
      } else throw Object.assign(new Error('This order is already linked to another payment.'), { statusCode: 409 });
    } else if (transaction.status === 'paid' || transaction.status === 'refunded' || transaction.status === 'partially_refunded') {
      await client.query('COMMIT');
      return { status: transaction.status, bookingId: transaction.booking_id };
    } else {
      const paymentStatus = ['cancelled', 'rejected'].includes(transaction.booking_status) ? 'refund_pending' : 'paid';
      await client.query(
        `UPDATE payment_transactions SET razorpay_payment_id = $2, razorpay_event_id = COALESCE($3, razorpay_event_id), status = $4, updated_at = NOW()
         WHERE razorpay_order_id = $1`,
        [orderId, paymentId, eventId ?? null, paymentStatus],
      );
      await client.query('UPDATE bookings SET payment_status = $2, updated_at = NOW() WHERE id = $1', [transaction.booking_id, paymentStatus]);
      if (paymentStatus === 'refund_pending') needsRefund = { amount: Number(transaction.amount_paise), bookingId: transaction.booking_id };
      await client.query('COMMIT');
      if (!needsRefund) {
        await notifyBookingPeople(transaction.booking_id, 'payment.received', 'Payment received', 'Payment for this booking has been confirmed.');
        return { status: 'paid', bookingId: transaction.booking_id };
      }
    }
    await client.query('COMMIT');
    if (needsRefund) {
      const refundStatus = await refundPayment(paymentId, needsRefund.amount, needsRefund.bookingId);
      await pool.query("UPDATE payment_transactions SET status = $2, updated_at = NOW() WHERE razorpay_payment_id = $1", [paymentId, refundStatus]);
      await pool.query('UPDATE bookings SET payment_status = $2, updated_at = NOW() WHERE id = $1', [needsRefund.bookingId, refundStatus]);
      return { status: refundStatus, bookingId: needsRefund.bookingId };
    }
    return { status: 'paid', bookingId: transaction.booking_id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setPaymentFailed(orderId: string, reason: string, eventId?: string): Promise<void> {
  await pool.query(
    `WITH updated AS (
       UPDATE payment_transactions SET status = 'failed', failure_reason = $2,
         razorpay_event_id = COALESCE($3, razorpay_event_id), updated_at = NOW()
      WHERE razorpay_order_id = $1 AND status NOT IN ('paid', 'refunded', 'refund_pending', 'partially_refunded')
       RETURNING booking_id
     )
     UPDATE bookings SET payment_status = 'failed', updated_at = NOW()
    WHERE id IN (SELECT booking_id FROM updated) AND payment_status NOT IN ('paid', 'refunded', 'refund_pending', 'partially_refunded')`,
    [orderId, reason.slice(0, 250), eventId ?? null],
  );
}

async function handleWebhook(request: Request, response: Response): Promise<void> {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = request.header('x-razorpay-signature');
  if (!secret) {
    response.status(503).json({ error: 'Razorpay webhook verification is not configured.' });
    return;
  }
  if (!Buffer.isBuffer(request.body) || !signature) {
    response.status(400).json({ error: 'Invalid webhook payload.' });
    return;
  }
  const expected = crypto.createHmac('sha256', secret).update(request.body).digest('hex');
  if (!signatureMatches(expected, signature)) {
    response.status(400).json({ error: 'Invalid webhook signature.' });
    return;
  }
  const event = JSON.parse(request.body.toString()) as { event?: string; id?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
  const eventId = event.id;
  const eventType = String(event.event);
  if (eventType === 'payment.captured') {
    const payment = event.payload?.payment?.entity;
    if (typeof payment?.order_id === 'string' && typeof payment.id === 'string') await setPaymentPaid(payment.order_id, payment.id, eventId);
  } else if (eventType === 'payment.failed') {
    const payment = event.payload?.payment?.entity;
    if (typeof payment?.order_id === 'string') await setPaymentFailed(payment.order_id, String(payment.error_description ?? 'Payment failed.'), eventId);
  } else if (eventType === 'refund.processed') {
    const refund = event.payload?.refund?.entity;
    if (typeof refund?.payment_id === 'string') {
      const transaction = await pool.query('SELECT booking_id, amount_paise FROM payment_transactions WHERE razorpay_payment_id = $1', [refund.payment_id]);
      if (transaction.rows[0]) {
        const refundAmount = Number(refund.amount ?? 0);
        const paymentStatus = refundAmount >= Number(transaction.rows[0].amount_paise) ? 'refunded' : 'partially_refunded';
        await pool.query('UPDATE payment_transactions SET status = $2, updated_at = NOW() WHERE razorpay_payment_id = $1', [refund.payment_id, paymentStatus]);
        await pool.query('UPDATE bookings SET payment_status = $2, updated_at = NOW() WHERE id = $1', [transaction.rows[0].booking_id, paymentStatus]);
      }
  }
  const payoutEventType = String(event.event);
  if (['payout.processed', 'payout.failed', 'payout.reversed'].includes(payoutEventType)) {
    const payout = event.payload?.payout?.entity;
    if (typeof payout?.id === 'string') {
      const status = payoutEventType === 'payout.processed' ? 'completed' : payoutEventType === 'payout.failed' || payoutEventType === 'payout.reversed' ? 'failed' : 'processing';
      const result = await pool.query(
        'UPDATE payout_records SET status = $2, processed_at = CASE WHEN $2 = \'completed\' THEN NOW() ELSE processed_at END WHERE razorpayx_payout_id = $1 RETURNING id, provider_id',
        [payout.id, status],
      );
      if (result.rows[0]) {
        const provider = await pool.query('SELECT user_id FROM provider_profiles WHERE id = $1', [result.rows[0].provider_id]);
        if (provider.rows[0]) await pushNotification({ userId: String(provider.rows[0].user_id), eventType: `payout.${status}`, title: status === 'completed' ? 'Payout completed' : 'Payout update', body: `Your payout status is ${status}.`, referenceType: 'payout', referenceId: String(result.rows[0].id) });
      }
    }
    }
  }
  response.status(200).json({ received: true });
}

app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

app.get('/health', asyncRoute(async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', database: 'ready' });
  } catch {
    response.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
}));

app.get('/metrics', asyncRoute(async (_request, response) => {
  response.setHeader('Content-Type', prometheusContentType);
  response.end(await register.metrics());
}));

app.get('/api/subscriptions/plans', asyncRoute(async (_request, response) => {
  const result = await pool.query(`SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price_paise ASC`);
  response.json(result.rows);
}));

app.get('/api/providers/me/dashboard', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || !['technician', 'company'].includes(authRequest.authUser.role)) {
    return response.status(403).json({ error: 'Only service professionals can view the dashboard.' });
  }
  const profileResult = await getProviderProfileForUser(authRequest.authUser.id);
  const profile = profileResult.rows[0];
  if (!profile) return response.status(404).json({ error: 'Complete your provider profile first.' });
  const commissionPercent = await fetchCommissionPercent();
  const summary = await pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' AND payment_status = 'paid' THEN amount_paise ELSE 0 END), 0) AS total_earned_paise,
        COALESCE(SUM(CASE WHEN status = 'completed' AND payment_status = 'paid' THEN (amount_paise * $2 / 100) ELSE 0 END), 0) AS commission_paise,
        COALESCE(SUM(CASE WHEN status = 'completed' AND payment_status = 'paid' THEN amount_paise - (amount_paise * $2 / 100) ELSE 0 END), 0) AS net_earned_paise,
        COALESCE(SUM(CASE WHEN status IN ('requested', 'processing') THEN amount_paise ELSE 0 END), 0) AS pending_payout_paise,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_paise ELSE 0 END), 0) AS completed_payout_paise
      FROM payout_records WHERE provider_id = $1`,
    [profile.id, commissionPercent],
  );
  const subscription = await pool.query(
    `SELECT ps.*, sp.name AS plan_name, sp.is_featured AS plan_is_featured
     FROM provider_subscriptions ps
     LEFT JOIN subscription_plans sp ON sp.id = ps.plan_id
     WHERE ps.provider_id = $1 ORDER BY ps.updated_at DESC LIMIT 1`,
    [profile.id],
  );
  const plans = await pool.query(`SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price_paise ASC`);
  const payouts = await pool.query(
    `SELECT * FROM payout_records WHERE provider_id = $1 ORDER BY requested_at DESC LIMIT 20`,
    [profile.id],
  );
  response.json({
    profile: { id: profile.id, display_name: profile.display_name, business_name: profile.business_name, verification_status: profile.verification_status, subscription_status: profile.subscription_status, is_live: profile.is_live, is_featured: profile.is_featured, bank_account_holder_name: profile.bank_account_holder_name, bank_account_number: profile.bank_account_number, bank_ifsc_code: profile.bank_ifsc_code, upi_id: profile.upi_id, payout_kyc_verified: profile.payout_kyc_verified },
    summary: summary.rows[0],
    subscription: subscription.rows[0] ?? null,
    plans: plans.rows,
    payouts: payouts.rows,
  });
}));

app.get('/api/providers/me/subscription', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || !['technician', 'company'].includes(authRequest.authUser.role)) {
    return response.status(403).json({ error: 'Only service professionals can manage subscriptions.' });
  }
  const profileResult = await getProviderProfileForUser(authRequest.authUser.id);
  const profile = profileResult.rows[0];
  if (!profile) return response.status(404).json({ error: 'Complete your provider profile first.' });
  const result = await pool.query(
    `SELECT ps.*, sp.name AS plan_name, sp.price_paise, sp.is_featured, sp.benefits
     FROM provider_subscriptions ps
     LEFT JOIN subscription_plans sp ON sp.id = ps.plan_id
     WHERE ps.provider_id = $1 ORDER BY ps.updated_at DESC LIMIT 1`,
    [profile.id],
  );
  response.json(result.rows[0] ?? null);
}));

app.post('/api/providers/me/subscribe', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || !['technician', 'company'].includes(authRequest.authUser.role)) {
    return response.status(403).json({ error: 'Only service professionals can subscribe.' });
  }
  const parsed = z.object({ planId: z.string().uuid() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Choose a valid plan.' });
  const profileResult = await getProviderProfileForUser(authRequest.authUser.id);
  const profile = profileResult.rows[0];
  if (!profile) return response.status(404).json({ error: 'Complete your provider profile first.' });
  const planResult = await pool.query(`SELECT * FROM subscription_plans WHERE id = $1 AND is_active = TRUE`, [parsed.data.planId]);
  const plan = planResult.rows[0];
  if (!plan) return response.status(404).json({ error: 'This plan is not available.' });
  if (profile.verification_status !== 'verified') {
    return response.status(409).json({ error: 'Your profile must be verified before a subscription can be activated.' });
  }
  const subscriptionResult = await pool.query(
    `INSERT INTO provider_subscriptions (provider_id, plan_id, status, auto_renew, current_period_end, next_billing_at)
     VALUES ($1, $2, 'active', TRUE, NOW() + INTERVAL '30 days', NOW() + INTERVAL '30 days')
     ON CONFLICT (provider_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', auto_renew = TRUE, updated_at = NOW(), current_period_end = NOW() + INTERVAL '30 days', next_billing_at = NOW() + INTERVAL '30 days'
     RETURNING *`,
    [profile.id, plan.id],
  );
  await pool.query(
    `UPDATE provider_profiles SET subscription_status = 'active', is_live = TRUE, is_featured = $2 WHERE id = $1`,
    [profile.id, Boolean(plan.is_featured)],
  );
  await pushNotification({ userId: String(profile.user_id), eventType: 'subscription.activated', title: 'Subscription active', body: `Your ${String(plan.name)} subscription is active.`, referenceType: 'provider', referenceId: String(profile.id) });
  response.status(201).json({ subscription: subscriptionResult.rows[0], profile: { ...profile, subscription_status: 'active', is_live: true, is_featured: Boolean(plan.is_featured) }, message: 'Subscription activated. Your profile is now live.' });
}));

app.get('/api/payouts/requested', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || !['technician', 'company'].includes(authRequest.authUser.role)) {
    return response.status(403).json({ error: 'Only service professionals can request payouts.' });
  }
  const profileResult = await getProviderProfileForUser(authRequest.authUser.id);
  const profile = profileResult.rows[0];
  if (!profile) return response.status(404).json({ error: 'Complete your provider profile first.' });
  const result = await pool.query(`SELECT * FROM payout_records WHERE provider_id = $1 ORDER BY requested_at DESC`, [profile.id]);
  response.json(result.rows);
}));

app.post('/api/payouts/request', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || !['technician', 'company'].includes(authRequest.authUser.role)) {
    return response.status(403).json({ error: 'Only service professionals can request payouts.' });
  }
  const profileResult = await getProviderProfileForUser(authRequest.authUser.id);
  const profile = profileResult.rows[0];
  if (!profile) return response.status(404).json({ error: 'Complete your provider profile first.' });
  if (!profile.payout_kyc_verified || !(profile.bank_account_holder_name && (profile.bank_account_number || profile.upi_id))) {
    return response.status(409).json({ error: 'Add and verify your payout account before requesting a payout.' });
  }
  const commissionPercent = await fetchCommissionPercent();
  const totals = await pool.query(
    `SELECT
      COALESCE(SUM(amount_paise), 0)::int AS gross_paise,
      COALESCE(SUM((amount_paise * $2) / 100), 0)::int AS commission_paise
     FROM bookings
     WHERE provider_id = $1 AND status = 'completed' AND payment_status = 'paid'`,
    [profile.id, commissionPercent],
  );
  const reserved = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::int AS amount_paise,
            COALESCE(SUM(commission_paise), 0)::int AS commission_paise
     FROM payout_records WHERE provider_id = $1 AND status IN ('requested', 'processing', 'completed')`,
    [profile.id],
  );
  const grossPaise = Number(totals.rows[0].gross_paise);
  const commissionPaise = Math.max(Number(totals.rows[0].commission_paise) - Number(reserved.rows[0].commission_paise), 0);
  const netPaise = Math.max(grossPaise - Number(totals.rows[0].commission_paise) - Number(reserved.rows[0].amount_paise), 0);
  if (netPaise <= 0) return response.status(409).json({ error: 'No payout is due yet. Complete paid bookings to unlock this payout.' });
  const payout = await pool.query(
    `INSERT INTO payout_records (provider_id, amount_paise, commission_paise, status, payout_method, notes)
     VALUES ($1, $2, $3, 'requested', $4, 'Manual payout request')
     RETURNING *`,
    [profile.id, netPaise, commissionPaise, profile.upi_id ? 'upi' : 'bank'],
  );
  response.status(201).json({ payout: payout.rows[0], amountPaise: netPaise, commissionPaise, message: 'Payout requested. We will process it once it is approved.' });
}));

app.get('/api/admin/overview', requireAuth, adminOnly, asyncRoute(async (_request, response) => {
  const result = await pool.query(
    `WITH commission AS (
       SELECT COALESCE(SUM(b.amount_paise * settings.value::numeric / 100), 0)::bigint AS amount_paise
       FROM bookings b CROSS JOIN platform_settings settings
       WHERE settings.key = 'platform_commission_percent' AND b.status = 'completed' AND b.payment_status = 'paid'
     ), subscriptions AS (
       SELECT COALESCE(SUM(sp.price_paise), 0)::bigint AS amount_paise
       FROM provider_subscriptions ps JOIN subscription_plans sp ON sp.id = ps.plan_id
       WHERE ps.status = 'active' AND ps.current_period_end > NOW()
     )
     SELECT commission.amount_paise AS commission_revenue_paise,
            subscriptions.amount_paise AS subscription_run_rate_paise,
            commission.amount_paise + subscriptions.amount_paise AS total_revenue_paise,
            (SELECT COUNT(*)::int FROM provider_profiles WHERE is_live = TRUE) AS active_listings,
            (SELECT COUNT(*)::int FROM bookings WHERE created_at >= date_trunc('month', NOW())) AS bookings_this_month,
            (SELECT COUNT(*)::int FROM provider_profiles WHERE verification_status = 'pending_verification') AS pending_verifications
     FROM commission, subscriptions`,
  );
  response.json(result.rows[0]);
}));

app.get('/api/admin/users', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const parsed = z.object({ search: z.string().trim().max(120).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid search.' });
  const search = parsed.data.search ? `%${parsed.data.search}%` : null;
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id
     WHERE u.role <> 'admin' AND ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1 OR COALESCE(pp.business_name, pp.display_name, '') ILIKE $1)`,
    [search],
  );
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at,
            pp.id AS provider_id, pp.verification_status, pp.subscription_status, pp.is_live,
            COALESCE(activity.bookings_count, 0)::int AS bookings_count,
            COALESCE(activity.earnings_paise, 0)::bigint AS earnings_paise
     FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE b.customer_id = u.id OR b.provider_id = pp.id) AS bookings_count,
              COALESCE(SUM(CASE WHEN b.provider_id = pp.id AND b.status = 'completed' AND b.payment_status = 'paid'
                THEN b.amount_paise * (100 - COALESCE((SELECT value::numeric FROM platform_settings WHERE key = 'platform_commission_percent'), 10)) / 100 ELSE 0 END), 0) AS earnings_paise
       FROM bookings b WHERE b.customer_id = u.id OR b.provider_id = pp.id
     ) activity ON TRUE
     WHERE u.role <> 'admin' AND ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1 OR COALESCE(pp.business_name, pp.display_name, '') ILIKE $1)
     ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
    [search, parsed.data.limit, (parsed.data.page - 1) * parsed.data.limit],
  );
  const total = Number(count.rows[0].total);
  response.json({ items: result.rows, page: parsed.data.page, limit: parsed.data.limit, total, totalPages: Math.max(1, Math.ceil(total / parsed.data.limit)) });
}));

app.get('/api/admin/bookings', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const parsed = z.object({ status: z.enum(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rejected']).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), category: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid booking filters.' });
  const values: unknown[] = [];
  const filters: string[] = [];
  if (parsed.data.status) { values.push(parsed.data.status); filters.push(`b.status = $${values.length}`); }
  if (parsed.data.from) { values.push(parsed.data.from); filters.push(`b.scheduled_at >= $${values.length}::date`); }
  if (parsed.data.to) { values.push(parsed.data.to); filters.push(`b.scheduled_at < ($${values.length}::date + INTERVAL '1 day')`); }
  if (parsed.data.category) { values.push(parsed.data.category); filters.push(`b.service_category = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM bookings b ${where}`, values);
  values.push(parsed.data.limit, (parsed.data.page - 1) * parsed.data.limit);
  const result = await pool.query(
    `SELECT b.id, b.service_category, b.scheduled_at, b.status, b.payment_status, b.amount_paise, b.created_at,
            c.name AS customer_name, c.email AS customer_email, p.display_name AS provider_name,
            COALESCE(p.business_name, p.display_name) AS business_name, d.status AS dispute_status
     FROM bookings b JOIN users c ON c.id = b.customer_id JOIN provider_profiles p ON p.id = b.provider_id
     LEFT JOIN disputes d ON d.booking_id = b.id ${where}
     ORDER BY b.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const total = Number(count.rows[0].total);
  response.json({ items: result.rows, page: parsed.data.page, limit: parsed.data.limit, total, totalPages: Math.max(1, Math.ceil(total / parsed.data.limit)) });
}));

app.get('/api/admin/disputes', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const status = z.enum(['open', 'resolved']).optional().safeParse(request.query.status ?? 'open');
  if (!status.success) return response.status(400).json({ error: 'Invalid dispute filter.' });
  const result = await pool.query(
    `SELECT d.*, b.service_category, b.scheduled_at, b.status AS booking_status, b.payment_status,
            b.amount_paise, b.service_address, b.notes AS booking_notes,
            c.name AS customer_name, c.email AS customer_email, p.display_name AS provider_name,
            COALESCE(p.business_name, p.display_name) AS business_name,
            t.razorpay_payment_id, t.razorpay_order_id, t.amount_paise AS payment_amount_paise, t.status AS transaction_status
     FROM disputes d JOIN bookings b ON b.id = d.booking_id
     JOIN users c ON c.id = b.customer_id JOIN provider_profiles p ON p.id = b.provider_id
     LEFT JOIN LATERAL (SELECT * FROM payment_transactions WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) t ON TRUE
     WHERE d.status = $1 ORDER BY d.created_at ASC LIMIT 200`,
    [status.data],
  );
  response.json(result.rows);
}));

app.get('/api/admin/payouts', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const status = z.enum(['review', 'requested', 'processing', 'completed', 'failed', 'rejected']).safeParse((request.query.status ?? 'review'));
  if (!status.success) return response.status(400).json({ error: 'Choose a valid payout status.' });
  const query = status.data === 'review' ? "WHERE pr.status IN ('requested', 'processing')" : 'WHERE pr.status = $1';
  const values = status.data === 'review' ? [] : [status.data];
  const result = await pool.query(
    `SELECT pr.*, pp.display_name, COALESCE(pp.business_name, pp.display_name) AS business_name,
            pp.payout_kyc_verified, pp.bank_account_holder_name, pp.bank_account_number, pp.bank_ifsc_code,
            pp.upi_id, u.name AS owner_name, u.email, u.phone
     FROM payout_records pr JOIN provider_profiles pp ON pp.id = pr.provider_id
     JOIN users u ON u.id = pp.user_id ${query}
     ORDER BY pr.requested_at DESC`,
    values,
  );
  response.json(result.rows);
}));

app.patch('/api/admin/payouts/:payoutId', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const payoutId = z.string().uuid().safeParse(request.params.payoutId);
  const parsed = z.object({ action: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).optional() }).safeParse(request.body);
  if (!payoutId.success || !parsed.success) return response.status(400).json({ error: 'Invalid payout decision.' });
  if (parsed.data.action === 'reject' && !parsed.data.reason) return response.status(400).json({ error: 'Add a reason before rejecting this payout.' });
  const client = await pool.connect();
  let payout;
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payout_records WHERE id = $1 FOR UPDATE', [payoutId.data]);
    payout = result.rows[0];
    if (!payout || payout.status !== 'requested') {
      await client.query('ROLLBACK');
      return response.status(payout ? 409 : 404).json({ error: payout ? 'This payout is no longer awaiting review.' : 'Payout not found.' });
    }
    if (parsed.data.action === 'reject') {
      await client.query("UPDATE payout_records SET status = 'rejected', notes = $2 WHERE id = $1", [payout.id, parsed.data.reason]);
      await client.query(
        'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, \'payout_rejected\', \'payout\', $2, $3)',
        [authRequest.authUser?.id, payout.id, JSON.stringify({ reason: parsed.data.reason })],
      );
      await client.query('COMMIT');
    } else {
      await client.query("UPDATE payout_records SET status = 'processing' WHERE id = $1", [payout.id]);
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (parsed.data.action === 'reject') {
    const owner = await pool.query('SELECT user_id FROM provider_profiles WHERE id = $1', [payout.provider_id]);
    if (owner.rows[0]) await pushNotification({ userId: String(owner.rows[0].user_id), eventType: 'payout.rejected', title: 'Payout request rejected', body: `Your payout request was rejected: ${parsed.data.reason}`, referenceType: 'payout', referenceId: String(payout.id) });
    return response.json({ payout: { ...payout, status: 'rejected' } });
  }
  const details = await pool.query(
    `SELECT pp.*, u.email, u.phone FROM provider_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.id = $1`,
    [payout.provider_id],
  );
  if (!details.rows[0]) {
    await pool.query("UPDATE payout_records SET status = 'requested' WHERE id = $1 AND status = 'processing'", [payout.id]);
    return response.status(404).json({ error: 'Provider payout account not found.' });
  }
  let gatewayPayout;
  try {
    gatewayPayout = await createRazorpayXPayout(payout, details.rows[0], details.rows[0]);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) await pool.query("UPDATE payout_records SET status = 'requested' WHERE id = $1 AND status = 'processing'", [payout.id]);
    throw error;
  }
  const finalStatus = gatewayPayout.status === 'processed' ? 'completed' : 'processing';
  const auditClient = await pool.connect();
  let updated;
  try {
    await auditClient.query('BEGIN');
    updated = await auditClient.query('UPDATE payout_records SET status = $2, razorpayx_payout_id = $3, processed_at = CASE WHEN $2 = \'completed\' THEN NOW() ELSE NULL END WHERE id = $1 RETURNING *', [payout.id, finalStatus, gatewayPayout.id]);
    await auditClient.query(
      'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, \'payout_approved\', \'payout\', $2, $3)',
      [authRequest.authUser?.id, payout.id, JSON.stringify({ gatewayPayoutId: gatewayPayout.id, status: finalStatus })],
    );
    await auditClient.query('COMMIT');
  } catch (error) {
    await auditClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    auditClient.release();
  }
  const owner = await pool.query('SELECT user_id FROM provider_profiles WHERE id = $1', [payout.provider_id]);
  if (owner.rows[0]) await pushNotification({ userId: String(owner.rows[0].user_id), eventType: 'payout.approved', title: 'Payout approved', body: `Your payout of ${Number(payout.amount_paise) / 100} INR has been sent to RazorpayX.`, referenceType: 'payout', referenceId: String(payout.id) });
  return response.json({ payout: updated.rows[0] });
}));

app.patch('/api/admin/disputes/:disputeId/resolve', requireAuth, adminOnly, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const disputeId = z.string().uuid().safeParse(request.params.disputeId);
  const parsed = z.object({
    outcome: z.enum(['refund_customer', 'release_provider', 'partial', 'dismissed']),
    resolutionNote: z.string().trim().max(1000).optional(),
    refundAmountPaise: z.coerce.number().int().positive().optional(),
  }).safeParse(request.body);
  if (!disputeId.success || !parsed.success) return response.status(400).json({ error: 'Choose a valid dispute resolution.' });
  const client = await pool.connect();
  let dispute: Record<string, unknown> | undefined;
  let payment: Record<string, unknown> | undefined;
  let refundAmountPaise = 0;
  let payoutId: string | null = null;
  let gatewayRefundStatus: string | null = null;
  let gatewayPayoutId: string | null = null;
  try {
    await client.query('BEGIN');
    const disputeResult = await client.query(
      `SELECT d.*, b.customer_id, b.provider_id, b.amount_paise, b.service_category, p.user_id AS provider_user_id
       FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN provider_profiles p ON p.id = b.provider_id
       WHERE d.id = $1 FOR UPDATE OF d`,
      [disputeId.data],
    );
    dispute = disputeResult.rows[0];
    if (!dispute || dispute.status !== 'open') {
      await client.query('ROLLBACK');
      return response.status(dispute ? 409 : 404).json({ error: dispute ? 'This dispute is no longer open.' : 'Dispute not found.' });
    }
    const outcome = parsed.data.outcome;
    if (outcome !== 'dismissed') {
      const paymentResult = await client.query(
        `SELECT * FROM payment_transactions WHERE booking_id = $1 AND status = 'paid'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [dispute.booking_id],
      );
      payment = paymentResult.rows[0];
      if (!payment?.razorpay_payment_id) {
        await client.query('ROLLBACK');
        return response.status(409).json({ error: 'A captured payment is required to resolve this dispute financially.' });
      }
    }
    const chargedAmount = Number(payment?.amount_paise ?? 0);
    if (outcome === 'refund_customer') refundAmountPaise = chargedAmount;
    if (outcome === 'partial') {
      refundAmountPaise = parsed.data.refundAmountPaise ?? 0;
      if (refundAmountPaise <= 0 || refundAmountPaise >= chargedAmount) {
        await client.query('ROLLBACK');
        return response.status(400).json({ error: 'Partial resolution requires a refund amount below the captured payment.' });
      }
    }
    if (refundAmountPaise > 0) {
      gatewayRefundStatus = await refundPayment(String(payment?.razorpay_payment_id), refundAmountPaise, String(dispute.booking_id));
      const paymentStatus = gatewayRefundStatus === 'refund_pending' ? 'refund_pending' : refundAmountPaise === chargedAmount ? 'refunded' : 'partially_refunded';
      await client.query('UPDATE payment_transactions SET status = $2, updated_at = NOW() WHERE id = $1', [payment?.id, paymentStatus]);
      await client.query('UPDATE bookings SET payment_status = $2, updated_at = NOW() WHERE id = $1', [dispute.booking_id, paymentStatus]);
      await client.query(
        'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, \'dispute_refund\', \'booking\', $2, $3)',
        [authRequest.authUser?.id, dispute.booking_id, JSON.stringify({ disputeId: dispute.id, paymentId: payment?.razorpay_payment_id, refundAmountPaise, status: gatewayRefundStatus })],
      );
    }
    if (outcome === 'release_provider' || outcome === 'partial') {
      const provider = await client.query(
        `SELECT pp.*, u.email, u.phone FROM provider_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.id = $1`,
        [dispute.provider_id],
      );
      const profile = provider.rows[0] as Record<string, unknown> | undefined;
      if (!profile) throw Object.assign(new Error('Provider payout account not found.'), { statusCode: 404 });
      const commissionPercent = await fetchCommissionPercent(client);
      const remainingServiceAmount = Math.max(Number(dispute.amount_paise) - refundAmountPaise, 0);
      const payoutCommission = Math.round(remainingServiceAmount * commissionPercent / 100);
      const payoutAmount = Math.max(remainingServiceAmount - payoutCommission, 0);
      if (payoutAmount > 0) {
        const payoutResult = await client.query(
          `INSERT INTO payout_records (provider_id, booking_id, amount_paise, commission_paise, status, payout_method, notes)
           VALUES ($1, $2, $3, $4, 'processing', $5, $6) RETURNING *`,
          [dispute.provider_id, dispute.booking_id, payoutAmount, payoutCommission, profile.upi_id ? 'upi' : 'bank', `Dispute ${String(dispute.id)} resolution`],
        );
        const payout = payoutResult.rows[0] as Record<string, unknown>;
        payoutId = String(payout.id);
        const gatewayPayout = await createRazorpayXPayout(payout, profile, profile);
        gatewayPayoutId = gatewayPayout.id;
        await client.query(
          'UPDATE payout_records SET status = $2, razorpayx_payout_id = $3, processed_at = CASE WHEN $2 = \'completed\' THEN NOW() ELSE NULL END WHERE id = $1',
          [payoutId, gatewayPayout.status === 'processed' ? 'completed' : 'processing', gatewayPayout.id],
        );
        await client.query(
          'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, \'dispute_payout\', \'payout\', $2, $3)',
          [authRequest.authUser?.id, payoutId, JSON.stringify({ disputeId: dispute.id, bookingId: dispute.booking_id, gatewayPayoutId: gatewayPayout.id, amountPaise: payoutAmount })],
        );
      }
    }
    const updated = await client.query(
      `UPDATE disputes SET status = 'resolved', outcome = $2, resolution_note = $3,
         refund_amount_paise = NULLIF($4, 0), resolved_by = $5, resolved_at = NOW()
       WHERE id = $1 RETURNING *`,
      [dispute.id, outcome, parsed.data.resolutionNote ?? null, refundAmountPaise, authRequest.authUser?.id],
    );
    await client.query(
      'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, \'dispute_resolved\', \'dispute\', $2, $3)',
      [authRequest.authUser?.id, dispute.id, JSON.stringify({ bookingId: dispute.booking_id, outcome, resolutionNote: parsed.data.resolutionNote ?? null, refundAmountPaise, payoutId, gatewayRefundStatus, gatewayPayoutId })],
    );
    await client.query('COMMIT');
    const detail = `${outcome.replaceAll('_', ' ')}${refundAmountPaise ? `; refund ${refundAmountPaise} paise` : ''}`;
    await Promise.all([
      pushNotification({ userId: String(dispute.customer_id), eventType: 'dispute.updated', title: 'Dispute resolved', body: `Your dispute was resolved: ${detail}.`, referenceType: 'booking', referenceId: String(dispute.booking_id) }),
      pushNotification({ userId: String(dispute.provider_user_id), eventType: 'dispute.updated', title: 'Dispute resolved', body: `A dispute on your booking was resolved: ${detail}.`, referenceType: 'booking', referenceId: String(dispute.booking_id) }),
    ]);
    return response.json({ dispute: updated.rows[0], payoutId, refundAmountPaise, gatewayRefundStatus, gatewayPayoutId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch('/api/admin/providers/:providerId/subscription-status', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser || authRequest.authUser.role !== 'admin') {
    return response.status(403).json({ error: 'Only admins can override provider subscription status.' });
  }
  const parsed = z.object({ status: z.enum(['active', 'payment_failed', 'expired', 'cancelled', 'inactive']) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Choose a valid subscription status.' });
  const providerId = z.string().uuid().safeParse(request.params.providerId);
  if (!providerId.success) return response.status(400).json({ error: 'Provider not found.' });
  const result = await pool.query(
    `UPDATE provider_profiles
     SET subscription_status = $2,
         is_live = (verification_status = 'verified' AND $2 = 'active'),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [providerId.data, parsed.data.status],
  );
  if (!result.rows[0]) return response.status(404).json({ error: 'Provider not found.' });
  await recordAdminAction(String(authRequest.authUser.id), 'provider_subscription_updated', 'provider', providerId.data, { status: parsed.data.status });
  await pushNotification({ userId: String(result.rows[0].user_id), eventType: 'subscription.updated', title: 'Subscription updated', body: `Your listing subscription is now ${parsed.data.status.replaceAll('_', ' ')}.`, referenceType: 'provider', referenceId: providerId.data });
  response.json({ provider: result.rows[0], status: parsed.data.status });
}));

app.get('/api/providers/:id/availability', asyncRoute(async (request, response) => {
  const providerId = z.string().uuid().safeParse(request.params.id);
  const date = z.string().safeParse(request.query.date);
  if (!providerId.success || !date.success || !isValidDate(date.data)) return response.status(400).json({ error: 'Choose a valid service date.' });
  const providerResult = await pool.query(
    `SELECT id, display_name AS name, COALESCE(business_name, display_name) AS business_name,
            category, city, service_area, base_price_paise
     FROM provider_profiles WHERE id = $1 AND verification_status = 'verified' AND is_live = TRUE AND subscription_status = 'active'`,
    [providerId.data],
  );
  const provider = providerResult.rows[0];
  if (!provider) return response.status(404).json({ error: 'This professional is not available for booking.' });
  if (!provider.base_price_paise || Number(provider.base_price_paise) < 1) return response.status(409).json({ error: 'This professional has not set a service price yet.' });
  const availableSlots = date.data < indiaToday() ? [] : await openSlots(providerId.data, date.data);
  response.json({ provider, date: date.data, slots: availableSlots, currency: 'INR', platformFeePaise: 0 });
}));

const createBookingSchema = z.object({
  providerId: z.string().uuid(),
  date: z.string().refine(isValidDate, 'Choose a valid service date.'),
  time: z.string().regex(/^(?:09|1[0-7]):00$/),
  address: z.string().trim().min(8).max(500),
  notes: z.string().trim().max(1000).optional().default(''),
});

app.post('/api/bookings', requireAuth, bookingLimiter, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!roleIs(authRequest, ['customer'])) return response.status(403).json({ error: 'Only customer accounts can create bookings.' });
  const parsed = createBookingSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the booking details.' });
  const { providerId, date, time, address, notes } = parsed.data;
  if (date < indiaToday() || !isFutureSlot(date, time)) return response.status(409).json({ code: 'SLOT_EXPIRED', error: 'This slot is no longer available. Choose another time.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [providerId, `${date}T${time}`]);
    const profileResult = await client.query(
      `SELECT id, user_id, category, base_price_paise FROM provider_profiles
       WHERE id = $1 AND verification_status = 'verified' AND is_live = TRUE AND subscription_status = 'active' FOR SHARE`,
      [providerId],
    );
    const provider = profileResult.rows[0];
    if (!provider) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'This professional is not available for booking.' });
    }
    if (!provider.base_price_paise || Number(provider.base_price_paise) < 1) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'This professional has not set a service price yet.' });
    }
    const available = await openSlots(providerId, date, client);
    if (!available.includes(time)) {
      await client.query('ROLLBACK');
      return response.status(409).json({ code: 'SLOT_TAKEN', error: 'This slot is no longer available. Choose another time.' });
    }
    const scheduledAt = new Date(`${date}T${time}:00+05:30`);
    const result = await client.query(
      `INSERT INTO bookings (customer_id, provider_id, service_category, scheduled_at, service_address, notes, amount_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, customer_id, provider_id, service_category, scheduled_at, service_address, notes, status, amount_paise, platform_fee_paise, payment_status, created_at`,
      [authRequest.authUser?.id, providerId, provider.category, scheduledAt, address, notes, provider.base_price_paise],
    );
    await client.query('COMMIT');
    await pushNotification({ userId: String(provider.user_id), eventType: 'booking.requested', title: 'New booking request', body: 'A customer has requested your service.', referenceType: 'booking', referenceId: String(result.rows[0].id) });
    response.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

async function listBookings(request: AuthRequest, response: Response, providerView: boolean) {
  const user = request.authUser;
  if (!user || (providerView ? !['technician', 'company'].includes(user.role) : user.role !== 'customer')) {
    return response.status(403).json({ error: providerView ? 'Only service professionals can view incoming requests.' : 'Only customer accounts can view their bookings.' });
  }
  const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(20).default(10) }).safeParse(request.query);
  if (!pagination.success) return response.status(400).json({ error: 'Invalid page.' });
  const { page, limit } = pagination.data;
  const conditions = providerView ? 'p.user_id = $1' : 'b.customer_id = $1';
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id WHERE ${conditions}`, [user.id]);
  const result = await pool.query(
    `SELECT b.id, b.customer_id, b.provider_id, b.service_category, b.scheduled_at, b.service_address, b.notes,
                 b.status, b.amount_paise, b.platform_fee_paise, b.payment_status, b.created_at, b.updated_at,
                 d.status AS dispute_status, d.outcome AS dispute_outcome,
            p.display_name AS provider_name, COALESCE(p.business_name, p.display_name) AS business_name,
            p.city AS provider_city, u.name AS customer_name
               FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN users u ON u.id = b.customer_id
               LEFT JOIN disputes d ON d.booking_id = b.id
     WHERE ${conditions} ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
    [user.id, limit, (page - 1) * limit],
  );
  return response.json({ items: result.rows, page, limit, total: Number(count.rows[0].total), totalPages: Math.max(1, Math.ceil(Number(count.rows[0].total) / limit)) });
}

app.get('/api/bookings/customer', requireAuth, asyncRoute(async (request, response) => listBookings(request as AuthRequest, response, false)));
app.get('/api/bookings/provider', requireAuth, asyncRoute(async (request, response) => listBookings(request as AuthRequest, response, true)));

async function accessibleBooking(id: string, user: AuthUser) {
  return pool.query(
    `SELECT b.*, p.display_name AS provider_name, COALESCE(p.business_name, p.display_name) AS business_name,
            p.city AS provider_city, u.name AS customer_name, p.user_id AS provider_user_id
     FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN users u ON u.id = b.customer_id
     WHERE b.id = $1 AND (b.customer_id = $2 OR p.user_id = $2)`,
    [id, user.id],
  );
}

app.get('/api/bookings/:id', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const bookingId = z.string().uuid().safeParse(request.params.id);
  if (!bookingId.success || !authRequest.authUser) return response.status(404).json({ error: 'Booking not found.' });
  const result = await accessibleBooking(bookingId.data, authRequest.authUser);
  if (!result.rows[0]) return response.status(404).json({ error: 'Booking not found.' });
  const transactions = await pool.query('SELECT id, razorpay_order_id, razorpay_payment_id, amount_paise, status, failure_reason, created_at, updated_at FROM payment_transactions WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId.data]);
  const disputes = await pool.query('SELECT id, raised_by, reason, status, outcome, resolution_note, refund_amount_paise, created_at, resolved_at FROM disputes WHERE booking_id = $1', [bookingId.data]);
  response.json({ booking: result.rows[0], transactions: transactions.rows, dispute: disputes.rows[0] ?? null });
}));

const statusSchema = z.object({ status: z.enum(['confirmed', 'in_progress', 'completed', 'cancelled', 'rejected']) });
app.patch('/api/bookings/:id/status', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!authRequest.authUser) return response.status(401).json({ error: 'Sign in to continue.' });
  const bookingId = z.string().uuid().safeParse(request.params.id);
  const parsed = statusSchema.safeParse(request.body);
  if (!bookingId.success || !parsed.success) return response.status(400).json({ error: 'Invalid booking update.' });
  const result = await accessibleBooking(bookingId.data, authRequest.authUser);
  const booking = result.rows[0];
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  const nextStatus = parsed.data.status as BookingStatus;
  const currentStatus = String(booking.status) as BookingStatus;
  const isProvider = booking.provider_user_id === authRequest.authUser.id && ['technician', 'company'].includes(authRequest.authUser.role);
  const isCustomer = booking.customer_id === authRequest.authUser.id && authRequest.authUser.role === 'customer';
  const transitions: Record<BookingStatus, BookingStatus[]> = {
    pending: ['confirmed', 'rejected', 'cancelled'],
    confirmed: ['in_progress', 'cancelled'],
    in_progress: ['completed'],
    completed: [],
    cancelled: [],
    rejected: [],
  };
  if ((isProvider && !transitions[currentStatus].includes(nextStatus)) || (isCustomer && nextStatus !== 'cancelled') || (!isProvider && !isCustomer)) {
    return response.status(403).json({ error: 'This account cannot make that booking change.' });
  }
  if (nextStatus === 'confirmed' && booking.payment_status !== 'paid') return response.status(409).json({ error: 'The customer payment must clear before you can accept this request.' });

  let paymentStatus = String(booking.payment_status);
  if (['cancelled', 'rejected'].includes(nextStatus) && booking.payment_status === 'paid') {
    if (!razorpay) return response.status(503).json({ error: 'Refund processing is not configured. This booking was not changed.' });
    const paid = await pool.query("SELECT razorpay_payment_id FROM payment_transactions WHERE booking_id = $1 AND status = 'paid' ORDER BY created_at DESC LIMIT 1", [booking.id]);
    if (!paid.rows[0]?.razorpay_payment_id) return response.status(409).json({ error: 'The payment is still being reconciled. Try again shortly.' });
    paymentStatus = await refundPayment(String(paid.rows[0].razorpay_payment_id), Number(booking.amount_paise), String(booking.id));
    await pool.query("UPDATE payment_transactions SET status = $2, updated_at = NOW() WHERE razorpay_payment_id = $1", [paid.rows[0].razorpay_payment_id, paymentStatus]);
  }
  const updated = await pool.query(
    `UPDATE bookings SET status = $2, payment_status = $3, updated_at = NOW()
     WHERE id = $1 AND status = $4 RETURNING *`,
    [booking.id, nextStatus, paymentStatus, currentStatus],
  );
  if (!updated.rows[0]) return response.status(409).json({ error: 'This booking has already changed. Refresh and try again.' });
  statusEvent(booking, currentStatus, nextStatus);
  response.json(updated.rows[0]);
}));

app.post('/api/bookings/:id/disputes', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const bookingId = z.string().uuid().safeParse(request.params.id);
  const parsed = z.object({ reason: z.string().trim().min(20).max(2000) }).safeParse(request.body);
  if (!bookingId.success || !parsed.success) return response.status(400).json({ error: parsed.success ? 'Booking not found.' : 'Describe the issue in at least 20 characters.' });
  const access = await accessibleBooking(bookingId.data, authRequest.authUser as AuthUser);
  const booking = access.rows[0];
  if (!booking) return response.status(404).json({ error: 'Booking not found.' });
  if (['cancelled', 'rejected'].includes(String(booking.status))) return response.status(409).json({ error: 'A dispute cannot be opened for a cancelled booking.' });
  const result = await pool.query(
    `INSERT INTO disputes (booking_id, raised_by, reason) VALUES ($1, $2, $3)
     ON CONFLICT (booking_id) DO NOTHING RETURNING id, booking_id, raised_by, reason, status, created_at`,
    [bookingId.data, authRequest.authUser?.id, parsed.data.reason],
  );
  if (!result.rows[0]) return response.status(409).json({ error: 'A dispute already exists for this booking.' });
  const providerUser = String(booking.provider_user_id);
  await pushNotification({
    userId: booking.customer_id === authRequest.authUser?.id ? providerUser : String(booking.customer_id),
    eventType: 'dispute.opened', title: 'A dispute was opened', body: 'A dispute was raised about a booking. Admin review is pending.', referenceType: 'booking', referenceId: bookingId.data,
  });
  const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(admins.rows.map((admin) => pushNotification({ userId: String(admin.id), eventType: 'dispute.opened', title: 'New booking dispute', body: 'A booking dispute is ready for review.', referenceType: 'dispute', referenceId: String(result.rows[0].id) })));
  response.status(201).json({ dispute: result.rows[0] });
}));

app.post('/api/payments/orders', requireAuth, bookingLimiter, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!roleIs(authRequest, ['customer'])) return response.status(403).json({ error: 'Only customers can start a payment.' });
  if (!razorpay) return response.status(503).json({ error: 'Razorpay test keys are not configured yet.' });
  const parsed = z.object({ bookingId: z.string().uuid() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Booking not found.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE', [parsed.data.bookingId, authRequest.authUser?.id]);
    const booking = result.rows[0];
    if (!booking) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Booking not found.' });
    }
    if (['cancelled', 'rejected'].includes(String(booking.status))) {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'This booking can no longer be paid.' });
    }
    if (booking.payment_status === 'paid') {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'This booking is already paid.' });
    }
    const pending = await client.query("SELECT razorpay_order_id, amount_paise FROM payment_transactions WHERE booking_id = $1 AND status IN ('created', 'pending') ORDER BY created_at DESC LIMIT 1", [booking.id]);
    if (pending.rows[0]) {
      await client.query('COMMIT');
      return response.json({ keyId: process.env.RAZORPAY_KEY_ID, orderId: pending.rows[0].razorpay_order_id, amountPaise: Number(pending.rows[0].amount_paise), currency: 'INR' });
    }
    const amountPaise = Number(booking.amount_paise) + Number(booking.platform_fee_paise);
    const order = await razorpay.orders.create({ amount: amountPaise, currency: 'INR', receipt: String(booking.id), notes: { booking_id: String(booking.id) } });
    await client.query("INSERT INTO payment_transactions (booking_id, razorpay_order_id, amount_paise, status) VALUES ($1, $2, $3, 'created')", [booking.id, order.id, amountPaise]);
    await client.query("UPDATE bookings SET payment_status = 'created', updated_at = NOW() WHERE id = $1", [booking.id]);
    await client.query('COMMIT');
    response.status(201).json({ keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amountPaise, currency: 'INR' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/payments/verify', requireAuth, authLimiter, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  if (!roleIs(authRequest, ['customer'])) return response.status(403).json({ error: 'Only customers can verify a payment.' });
  if (!razorpay || !process.env.RAZORPAY_KEY_SECRET) return response.status(503).json({ error: 'Razorpay test keys are not configured yet.' });
  const parsed = z.object({ bookingId: z.string().uuid(), razorpay_order_id: z.string().min(8), razorpay_payment_id: z.string().min(8), razorpay_signature: z.string().length(64) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Payment response is incomplete.' });
  const access = await accessibleBooking(parsed.data.bookingId, authRequest.authUser as AuthUser);
  if (!access.rows[0] || access.rows[0].customer_id !== authRequest.authUser?.id) return response.status(404).json({ error: 'Booking not found.' });
  const transaction = await pool.query('SELECT * FROM payment_transactions WHERE booking_id = $1 AND razorpay_order_id = $2', [parsed.data.bookingId, parsed.data.razorpay_order_id]);
  if (!transaction.rows[0]) return response.status(400).json({ error: 'Payment order does not match this booking.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${parsed.data.razorpay_order_id}|${parsed.data.razorpay_payment_id}`).digest('hex');
  if (!signatureMatches(expected, parsed.data.razorpay_signature)) return response.status(400).json({ error: 'Payment signature could not be verified.' });
  const payment = await razorpay.payments.fetch(parsed.data.razorpay_payment_id);
  if (payment.order_id !== parsed.data.razorpay_order_id || Number(payment.amount) !== Number(transaction.rows[0].amount_paise) || payment.currency !== 'INR') {
    return response.status(400).json({ error: 'Payment details do not match the booking total.' });
  }
  if (payment.status === 'authorized' && process.env.RAZORPAY_AUTO_CAPTURE !== 'false') await razorpay.payments.capture(payment.id, Number(payment.amount), 'INR');
  const refreshed = await razorpay.payments.fetch(parsed.data.razorpay_payment_id);
  if (refreshed.status === 'captured') {
    const result = await setPaymentPaid(parsed.data.razorpay_order_id, parsed.data.razorpay_payment_id);
    return response.json({ status: result.status, bookingId: result.bookingId });
  }
  if (refreshed.status === 'failed') {
    await setPaymentFailed(parsed.data.razorpay_order_id, String(refreshed.error_description ?? 'Payment failed.'));
    return response.status(402).json({ status: 'failed', error: 'Payment was not completed. You can try again.' });
  }
  await pool.query("UPDATE payment_transactions SET status = 'pending', razorpay_payment_id = $2, updated_at = NOW() WHERE razorpay_order_id = $1 AND status NOT IN ('paid', 'refunded')", [parsed.data.razorpay_order_id, parsed.data.razorpay_payment_id]);
  await pool.query("UPDATE bookings SET payment_status = 'created', updated_at = NOW() WHERE id = $1 AND payment_status <> 'paid'", [parsed.data.bookingId]);
  response.status(202).json({ status: 'pending', bookingId: parsed.data.bookingId, message: 'Payment is processing. We are checking for confirmation.' });
}));

app.get('/api/payments/:bookingId/status', requireAuth, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const bookingId = z.string().uuid().safeParse(request.params.bookingId);
  if (!bookingId.success || !authRequest.authUser) return response.status(404).json({ error: 'Booking not found.' });
  const result = await accessibleBooking(bookingId.data, authRequest.authUser);
  if (!result.rows[0]) return response.status(404).json({ error: 'Booking not found.' });
  const transactions = await pool.query('SELECT razorpay_order_id, razorpay_payment_id, amount_paise, status, created_at, updated_at FROM payment_transactions WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId.data]);
  response.json({ paymentStatus: result.rows[0].payment_status, transactions: transactions.rows });
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const failure = error as { statusCode?: number; code?: string };
  if (failure.statusCode) return response.status(failure.statusCode).json({ error: error instanceof Error ? error.message : 'Request failed.' });
  if (failure.code === '23505') return response.status(409).json({ error: 'A booking or payment record already exists.' });
  console.error(error);
  return response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function startServer(): Promise<void> {
  app.listen(port, () => console.log(`KaamSetu booking service listening on http://localhost:${port}`));
}

void startServer().catch((error) => {
  console.error('Booking service could not start.', error);
  process.exitCode = 1;
});