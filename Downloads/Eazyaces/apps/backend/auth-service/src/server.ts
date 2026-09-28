import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import helmet from 'helmet';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import multer from 'multer';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Counter, Histogram, prometheusContentType, register } from '@prometheus-io/client';
import { z } from 'zod';
import { pool } from './db/pool.js';

const app = express();
const port = Number(process.env.PORT ?? 4000);
const accessSecret = process.env.JWT_ACCESS_SECRET;
const refreshCookie = 'kaamsetu_refresh';
const refreshLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const requestCount = new Counter({ name: 'kaamsetu_auth_http_requests_total', help: 'HTTP requests handled by auth-service.', labelNames: ['method', 'route', 'status_code'] });
const requestDuration = new Histogram({ name: 'kaamsetu_auth_http_request_duration_seconds', help: 'HTTP request duration in seconds for auth-service.', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] });

if (!accessSecret || accessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be configured with at least 32 characters.');

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();
  response.once('finish', () => {
    const route = request.route?.path ? `${request.baseUrl}${request.route.path}` : 'unmatched';
    const labels = { method: request.method, route, status_code: String(response.statusCode) };
    requestCount.inc(labels);
    requestDuration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: response.statusCode >= 500 ? 'error' : 'info', service: 'auth-service', ...labels, duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }));
  });
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadDirectory = path.resolve(process.env.UPLOAD_DIR ?? './uploads/kyc');
const profileDirectory = path.resolve(process.env.PROFILE_UPLOAD_DIR ?? './uploads/profiles');
const objectBucket = process.env.OBJECT_STORAGE_BUCKET;
const objectStorage = objectBucket ? new S3Client({
  region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
  forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true' || Boolean(process.env.OBJECT_STORAGE_ENDPOINT),
  credentials: process.env.OBJECT_STORAGE_ACCESS_KEY_ID && process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY }
    : undefined,
}) : null;
fs.mkdirSync(uploadDirectory, { recursive: true });
fs.mkdirSync(profileDirectory, { recursive: true });
app.use('/media/profiles', express.static(profileDirectory, { maxAge: '1d', immutable: true }));
const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, file, callback) => callback(null, file.fieldname === 'profilePhoto' ? profileDirectory : uploadDirectory),
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowed.includes(file.mimetype)) callback(new Error('Upload a PDF, JPG, or PNG document.'));
    else callback(null, true);
  },
});

type Role = 'customer' | 'technician' | 'company' | 'admin';
type AuthUser = { id: string; name: string; email: string | null; phone: string | null; role: Role };
type AuthRequest = Request & { authUser?: AuthUser };

const userSelect = 'id, name, email, phone, role';
const emailSchema = z.string().email().transform((value) => value.toLowerCase());
const customerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema.optional().or(z.literal('')),
  phone: z.string().trim().regex(/^\+?[0-9\s-]{8,16}$/).optional().or(z.literal('')),
  password: z.string().min(8).max(100),
}).refine((value) => Boolean(value.email || value.phone), { message: 'Add an email address or phone number.' });
const providerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  phone: z.string().trim().regex(/^\+?[0-9\s-]{8,16}$/),
  password: z.string().min(8).max(100),
  role: z.enum(['technician', 'company']),
  businessName: z.string().trim().max(120).optional().or(z.literal('')),
  category: z.enum(['electrician', 'plumber', 'painter', 'caterer', 'supplier', 'technician']),
  serviceArea: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  basePrice: z.coerce.number().finite().min(1).max(1000000),
  description: z.string().trim().max(500).optional().or(z.literal('')),
});
const loginSchema = z.object({ identifier: z.string().trim().min(3), password: z.string().min(1) });

function safeUser(row: Record<string, unknown>): AuthUser {
  return { id: String(row.id), name: String(row.name), email: row.email ? String(row.email) : null, phone: row.phone ? String(row.phone) : null, role: row.role as Role };
}

function accessToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, role: user.role }, accessSecret as string, { expiresIn: '15m' });
}

function setRefreshCookie(response: Response, token: string): void {
  response.cookie(refreshCookie, token, { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax', path: '/api/auth', maxAge: refreshLifetimeMs });
}

async function issueSession(response: Response, user: AuthUser): Promise<void> {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await pool.query('INSERT INTO refresh_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')', [user.id, tokenHash]);
  setRefreshCookie(response, refreshToken);
  response.json({ accessToken: accessToken(user), user });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
}

function parseObjectLocation(value: string): { bucket: string; key: string } | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(value);
  return match ? { bucket: match[1], key: match[2] } : null;
}

async function storeUpload(file: Express.Multer.File, prefix: 'kyc' | 'profiles'): Promise<string> {
  if (!objectStorage || !objectBucket) return file.path;
  const key = `${prefix}/${path.basename(file.path)}`;
  await objectStorage.send(new PutObjectCommand({ Bucket: objectBucket, Key: key, Body: fs.createReadStream(file.path), ContentType: file.mimetype }));
  await fs.promises.unlink(file.path);
  return `s3://${objectBucket}/${key}`;
}

async function deleteStoredUpload(value: string | undefined): Promise<void> {
  if (!value) return;
  const location = parseObjectLocation(value);
  if (location && objectStorage) {
    await objectStorage.send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key })).catch((error) => console.error('Object cleanup failed.', error));
    return;
  }
  await fs.promises.unlink(value).catch(() => undefined);
}

async function pipeStoredObject(value: string, response: Response): Promise<boolean> {
  const location = parseObjectLocation(value);
  if (!location || !objectStorage) return false;
  const object = await objectStorage.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }));
  if (!object.Body || !('pipe' in object.Body)) return false;
  response.setHeader('Cache-Control', 'private, no-store');
  if (object.ContentType) response.setHeader('Content-Type', object.ContentType);
  (object.Body as NodeJS.ReadableStream).pipe(response);
  return true;
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
    request.authUser = { id: String(payload.sub), name: '', email: null, phone: null, role: payload.role as Role };
    next();
  } catch {
    response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function requireAdmin(request: AuthRequest, response: Response, next: NextFunction): void {
  requireAuth(request, response, () => {
    if (request.authUser?.role !== 'admin') {
      response.status(403).json({ error: 'Only admins can access this area.' });
      return;
    }
    next();
  });
}

async function notifyBookingService(input: { userId: string; eventType: string; title: string; body: string; referenceType: string; referenceId: string }): Promise<void> {
  const serviceUrl = process.env.NOTIFICATION_SERVICE_URL;
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!serviceUrl || !secret) return;
  try {
    await fetch(`${serviceUrl.replace(/\/$/, '')}/internal/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-secret': secret },
      body: JSON.stringify(input),
    });
  } catch (error) {
    console.error('Notification service unavailable for admin action.', error);
  }
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

app.get('/media/profiles/:filename', asyncRoute(async (request, response) => {
  if (!objectStorage || !objectBucket) return response.status(404).end();
  const parameter = request.params.filename;
  const filename = path.basename(Array.isArray(parameter) ? parameter[0] ?? '' : parameter);
  const key = `profiles/${filename}`;
  const object = await objectStorage.send(new GetObjectCommand({ Bucket: objectBucket, Key: key }));
  if (!object.Body || !('pipe' in object.Body)) return response.status(404).end();
  response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  if (object.ContentType) response.setHeader('Content-Type', object.ContentType);
  (object.Body as NodeJS.ReadableStream).pipe(response);
}));

app.post('/api/auth/register/customer', authLimiter, asyncRoute(async (request, response) => {
  const parsed = customerSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check your details.' });
  const { name, email, phone, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, 'customer') RETURNING ${userSelect}`, [name, email ?? '', phone ?? '', passwordHash]);
  await issueSession(response, safeUser(result.rows[0]));
}));

app.post('/api/auth/register/provider', authLimiter, upload.fields([{ name: 'kycDocument', maxCount: 1 }, { name: 'profilePhoto', maxCount: 1 }]), asyncRoute(async (request, response) => {
  const files = request.files as { kycDocument?: Express.Multer.File[]; profilePhoto?: Express.Multer.File[] } | undefined;
  const kycDocument = files?.kycDocument?.[0];
  const profilePhoto = files?.profilePhoto?.[0];
  const parsed = providerSchema.safeParse(request.body);
  if (!parsed.success) {
    if (kycDocument) fs.unlink(kycDocument.path, () => undefined);
    if (profilePhoto) fs.unlink(profilePhoto.path, () => undefined);
    return response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check your details.' });
  }
  if (!kycDocument) {
    if (profilePhoto) fs.unlink(profilePhoto.path, () => undefined);
    return response.status(400).json({ error: 'Upload one ID or business proof document.' });
  }
  const input = parsed.data;
  const client = await pool.connect();
  let storedKycPath = kycDocument.path;
  let storedPhotoPath = profilePhoto?.path;
  let registeredUser: AuthUser | undefined;
  try {
    storedKycPath = await storeUpload(kycDocument, 'kyc');
    if (profilePhoto) storedPhotoPath = await storeUpload(profilePhoto, 'profiles');
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(input.password, 12);
    const userResult = await client.query(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING ${userSelect}`, [input.name, input.email, input.phone, passwordHash, input.role]);
    registeredUser = safeUser(userResult.rows[0]);
    const photoObject = storedPhotoPath ? parseObjectLocation(storedPhotoPath) : null;
    const photoName = photoObject ? path.basename(photoObject.key) : storedPhotoPath ? path.basename(storedPhotoPath) : '';
    const publicStorageUrl = process.env.OBJECT_STORAGE_PUBLIC_URL?.replace(/\/+$/, '');
    const photoUrl = storedPhotoPath
      ? photoObject && publicStorageUrl
        ? `${publicStorageUrl}/${photoObject.key.split('/').map(encodeURIComponent).join('/')}`
        : `${process.env.PUBLIC_API_URL ?? `http://localhost:${port}`}/media/profiles/${photoName}`
      : null;
    await client.query(`INSERT INTO provider_profiles (user_id, display_name, business_name, category, service_area, city, description, photo_url, base_price_paise, kyc_document_path) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $10)`, [registeredUser.id, input.name, input.businessName ?? '', input.category, input.serviceArea, input.city, input.description ?? '', photoUrl, Math.round(input.basePrice * 100), storedKycPath]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await Promise.all([deleteStoredUpload(storedKycPath), deleteStoredUpload(storedPhotoPath)]);
    throw error;
  } finally {
    client.release();
  }
  if (!registeredUser) throw new Error('Provider registration did not complete.');
  await issueSession(response, registeredUser);
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Enter your email or phone and password.' });
  const result = await pool.query(`SELECT ${userSelect}, password_hash FROM users WHERE LOWER(email) = LOWER($1) OR phone = $1 LIMIT 1`, [parsed.data.identifier]);
  const row = result.rows[0];
  if (row?.role === 'admin') return response.status(403).json({ error: 'Use the separate administrator sign-in.' });
  if (!row?.password_hash || !(await bcrypt.compare(parsed.data.password, String(row.password_hash)))) return response.status(401).json({ error: 'The email/phone or password is incorrect.' });
  await issueSession(response, safeUser(row));
}));

app.post('/api/auth/admin/login', authLimiter, asyncRoute(async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Enter your admin email and password.' });
  const result = await pool.query(`SELECT ${userSelect}, password_hash FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [parsed.data.identifier]);
  const row = result.rows[0];
  if (row?.role !== 'admin' || !row.password_hash || !(await bcrypt.compare(parsed.data.password, String(row.password_hash)))) {
    return response.status(401).json({ error: 'The admin email or password is incorrect.' });
  }
  await issueSession(response, safeUser(row));
}));

app.post('/api/auth/google', authLimiter, asyncRoute(async (request, response) => {
  if (!process.env.GOOGLE_CLIENT_ID) return response.status(503).json({ error: 'Google sign-in is not configured yet.' });
  const credential = z.string().min(20).safeParse(request.body?.credential);
  if (!credential.success) return response.status(400).json({ error: 'Google credential is missing.' });
  const ticket = await googleClient.verifyIdToken({ idToken: credential.data, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || !payload.email_verified) return response.status(401).json({ error: 'Use a verified Google account.' });
  const result = await pool.query(`INSERT INTO users (name, email, role, google_subject) VALUES ($1, $2, 'customer', $3) ON CONFLICT (email) DO UPDATE SET google_subject = COALESCE(users.google_subject, EXCLUDED.google_subject) RETURNING ${userSelect}, google_subject`, [payload.name ?? payload.email, payload.email.toLowerCase(), payload.sub]);
  if (result.rows[0].google_subject !== payload.sub) return response.status(409).json({ error: 'This email is linked to a different Google account.' });
  await issueSession(response, safeUser(result.rows[0]));
}));

app.post('/api/auth/refresh', asyncRoute(async (request, response) => {
  const oldToken = request.cookies.kaamsetu_refresh as string | undefined;
  if (!oldToken) return response.status(401).json({ error: 'Sign in to continue.' });
  const oldHash = crypto.createHash('sha256').update(oldToken).digest('hex');
  const newToken = crypto.randomBytes(48).toString('base64url');
  const newHash = crypto.createHash('sha256').update(newToken).digest('hex');
  const result = await pool.query(`WITH removed AS (DELETE FROM refresh_sessions WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id), inserted AS (INSERT INTO refresh_sessions (user_id, token_hash, expires_at) SELECT user_id, $2, NOW() + INTERVAL '30 days' FROM removed RETURNING user_id) SELECT users.id, users.name, users.email, users.phone, users.role FROM inserted JOIN users ON users.id = inserted.user_id`, [oldHash, newHash]);
  if (!result.rows[0]) {
    response.clearCookie(refreshCookie, { path: '/api/auth' });
    return response.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
  setRefreshCookie(response, newToken);
  response.json({ accessToken: accessToken(safeUser(result.rows[0])), user: safeUser(result.rows[0]) });
}));

app.post('/api/auth/logout', asyncRoute(async (request, response) => {
  const token = request.cookies[refreshCookie] as string | undefined;
  if (token) await pool.query('DELETE FROM refresh_sessions WHERE token_hash = $1', [crypto.createHash('sha256').update(token).digest('hex')]);
  response.clearCookie(refreshCookie, { path: '/api/auth' });
  response.status(204).end();
}));

app.post('/api/auth/admin/bootstrap', authLimiter, asyncRoute(async (request, response) => {
  const bootstrapKey = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!bootstrapKey || request.header('x-admin-bootstrap-key') !== bootstrapKey) return response.status(403).json({ error: 'Admin bootstrap is not enabled.' });
  const parsed = customerSchema.safeParse(request.body);
  if (!parsed.success || !parsed.data.email) return response.status(400).json({ error: 'Provide a name, email, and password.' });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const result = await pool.query(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, NULLIF($3, ''), $4, 'admin') RETURNING ${userSelect}`, [parsed.data.name, parsed.data.email, parsed.data.phone ?? '', passwordHash]);
  await issueSession(response, safeUser(result.rows[0]));
}));

app.get('/api/admin/providers', requireAdmin, asyncRoute(async (request, response) => {
  const status = z.enum(['pending_verification', 'verified', 'rejected']).optional().safeParse(request.query.status ?? 'pending_verification');
  if (!status.success) return response.status(400).json({ error: 'Choose a valid verification status.' });
  const result = await pool.query(
    `SELECT pp.id, pp.user_id, pp.display_name, pp.business_name, pp.category, pp.service_area, pp.city,
            pp.description, pp.verification_status, pp.subscription_status, pp.is_live, pp.created_at,
            u.name AS owner_name, u.email, u.phone, (pp.kyc_document_path IS NOT NULL) AS has_kyc_document
     FROM provider_profiles pp JOIN users u ON u.id = pp.user_id
     WHERE pp.verification_status = $1 ORDER BY pp.created_at ASC`,
    [status.data],
  );
  response.json(result.rows);
}));

app.get('/api/admin/providers/:providerId/kyc', requireAdmin, asyncRoute(async (request, response) => {
  const providerId = z.string().uuid().safeParse(request.params.providerId);
  if (!providerId.success) return response.status(404).json({ error: 'Document not found.' });
  const result = await pool.query('SELECT kyc_document_path FROM provider_profiles WHERE id = $1', [providerId.data]);
  const documentPath = result.rows[0]?.kyc_document_path;
  if (!documentPath) return response.status(404).json({ error: 'Document not found.' });
  const extension = path.extname(String(documentPath)).toLowerCase();
  const contentType = extension === '.pdf' ? 'application/pdf' : extension === '.png' ? 'image/png' : 'image/jpeg';
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentType);
  if (parseObjectLocation(String(documentPath))) {
    if (await pipeStoredObject(String(documentPath), response)) return;
    return response.status(404).json({ error: 'Document not found.' });
  }
  if (!fs.existsSync(String(documentPath))) return response.status(404).json({ error: 'Document not found.' });
  response.sendFile(path.resolve(String(documentPath)));
}));

app.patch('/api/admin/providers/:providerId/verification', requireAdmin, asyncRoute(async (request, response) => {
  const authRequest = request as AuthRequest;
  const providerId = z.string().uuid().safeParse(request.params.providerId);
  const parsed = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).optional() }).safeParse(request.body);
  if (!providerId.success || !parsed.success) return response.status(400).json({ error: 'Invalid verification decision.' });
  if (parsed.data.decision === 'reject' && !parsed.data.reason) return response.status(400).json({ error: 'Add a reason before rejecting this application.' });
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await client.query(
      `UPDATE provider_profiles SET verification_status = $2,
         is_live = ($2 = 'verified' AND subscription_status = 'active'), updated_at = NOW()
       WHERE id = $1 AND verification_status = 'pending_verification'
       RETURNING id, user_id, display_name, business_name, category, verification_status, subscription_status, is_live`,
      [providerId.data, parsed.data.decision === 'approve' ? 'verified' : 'rejected'],
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Pending application not found.' });
    }
    await client.query(
      'INSERT INTO admin_actions_log (admin_id, action, reference_type, reference_id, details) VALUES ($1, $2, \'provider\', $3, $4)',
      [authRequest.authUser?.id, parsed.data.decision === 'approve' ? 'provider_approved' : 'provider_rejected', providerId.data, JSON.stringify({ reason: parsed.data.reason ?? null })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const provider = result.rows[0];
  const approved = parsed.data.decision === 'approve';
  await notifyBookingService({
    userId: String(provider.user_id),
    eventType: approved ? 'verification.approved' : 'verification.rejected',
    title: approved ? 'Verification approved' : 'Verification update',
    body: approved ? 'Your service profile passed verification.' : `Your application needs changes: ${parsed.data.reason}`,
    referenceType: 'provider',
    referenceId: String(provider.id),
  });
  response.json({ provider });
}));

app.get('/api/profiles', asyncRoute(async (request, response) => {
  const querySchema = z.object({ category: z.string().trim().max(60).optional(), location: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(24).default(8) });
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid search filters.' });
  const { category, location, page, limit } = parsed.data;
  const filters = ["verification_status = 'verified'", 'is_live = TRUE', "subscription_status = 'active'"];
  const values: unknown[] = [];
  if (category) { values.push(category.toLowerCase()); filters.push(`category = $${values.length}`); }
  if (location) { values.push(`%${location}%`); filters.push(`(city ILIKE $${values.length} OR service_area ILIKE $${values.length})`); }
  const where = filters.join(' AND ');
  const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM provider_profiles WHERE ${where}`, values);
  const total = Number(totalResult.rows[0].total);
  values.push(limit, (page - 1) * limit);
  const result = await pool.query(
    `SELECT id, display_name AS name, COALESCE(business_name, display_name) AS business_name, category, city, service_area,
            description, photo_url, base_price_paise, verification_status, subscription_status, is_live, is_featured,
            rating, review_count, completed_jobs
     FROM provider_profiles WHERE ${where}
     ORDER BY is_featured DESC, created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  response.json({ items: result.rows, page, limit, total, totalPages: Math.ceil(total / limit) });
}));

app.get('/api/profiles/:id', asyncRoute(async (request, response) => {
  const result = await pool.query(
    `SELECT id, display_name AS name, COALESCE(business_name, display_name) AS business_name, category, city, service_area,
            description, photo_url, base_price_paise, verification_status, subscription_status, is_live, is_featured,
            rating, review_count, completed_jobs
     FROM provider_profiles WHERE id = $1 AND verification_status = 'verified' AND is_live = TRUE AND subscription_status = 'active'`,
    [request.params.id],
  );
  if (!result.rows[0]) return response.status(404).json({ error: 'This profile is not available.' });
  response.json(result.rows[0]);
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'KYC documents must be 5 MB or smaller.' : 'The document could not be uploaded.' });
  if (error instanceof Error && error.message === 'Upload a PDF, JPG, or PNG document.') return response.status(400).json({ error: error.message });
  if (error instanceof z.ZodError) return response.status(400).json({ error: error.issues[0]?.message ?? 'Invalid input.' });
  const databaseError = error as { code?: string };
  if (databaseError.code === '23505') return response.status(409).json({ error: 'An account already uses this email or phone.' });
  console.error(error);
  return response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(port, () => console.log(`KaamSetu auth service listening on http://localhost:${port}`));