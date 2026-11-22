import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to access job submissions.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
const jobSubmissions = pgTable('job_submissions', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  company: text('company').notNull(),
  category: text('category').notNull(),
  location: text('location').notNull(),
  workMode: text('work_mode').notNull(),
  experienceLevel: text('experience_level').notNull().default('all'),
  compensation: text('compensation'),
  duration: text('duration'),
  description: text('description').notNull(),
  applicationUrl: text('application_url').notNull(),
  submitterName: text('submitter_name').notNull(),
  submitterEmail: text('submitter_email').notNull(),
  closingDate: date('closing_date', { mode: 'string' }).notNull(),
  status: text('status').notNull().default('pending'),
  submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  reviewNote: text('review_note'),
});
const db = drizzle(pool, { schema: { jobSubmissions } });

const MAX_BODY_BYTES = 24_000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const southAfricaToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const CATEGORIES = new Set(['fulltime', 'internship', 'learnership']);
const WORK_MODES = new Set(['onsite', 'hybrid', 'remote']);
const EXPERIENCE_LEVELS = new Set(['entry', 'junior', 'intermediate', 'all']);
let redis;
let submissionLimiter;
let loginLimiter;

function getRedis() {
  if (redis) return redis;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('Submission protection is unavailable.');
  }
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  return redis;
}

function getLimiter(kind) {
  if (kind === 'submission') {
    submissionLimiter ||= new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(3, '1 h'),
      prefix: 'jobs:submission',
    });
    return submissionLimiter;
  }
  loginLimiter ||= new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(5, '15 m'),
    prefix: 'jobs:admin-login',
  });
  return loginLimiter;
}

function getClientAddress(req) {
  const forwardedAddress = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  const address = req.headers['x-real-ip'] || forwardedAddress || req.socket?.remoteAddress;
  return typeof address === 'string' ? address.trim() : '';
}

function getClientKey(req) {
  const address = getClientAddress(req);
  return address ? createHash('sha256').update(address).digest('hex') : '';
}

function send(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw new RangeError('too_large');
    return Array.isArray(req.body) ? {} : req.body;
  }
  const source = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
  if (typeof source !== 'string' || !source.trim()) return {};
  if (Buffer.byteLength(source) > MAX_BODY_BYTES) throw new RangeError('too_large');
  const parsed = JSON.parse(source);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function getCookie(req, cookieName) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : '';
}

function createSessionSignature(expiresAt, secret) {
  return createHmac('sha256', secret).update(expiresAt).digest('base64url');
}

function isAdminSessionValid(req) {
  const secret = process.env.JOBS_ADMIN_TOKEN;
  if (!secret) return false;
  const [expiresAt, signature, extra] = getCookie(req, 'jobs_admin').split('.');
  if (!expiresAt || !signature || extra || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;
  const expected = createSessionSignature(expiresAt, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function setAdminCookie(req, res, value, maxAge) {
  const forwardedProtocol = req.headers['x-forwarded-proto'];
  const secure = forwardedProtocol === 'https' || (!forwardedProtocol && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''));
  res.setHeader('Set-Cookie', `jobs_admin=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/api/jobs; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function validateSubmission(input) {
  const fields = [
    ['title', 120],
    ['company', 120],
    ['location', 120],
    ['description', 3000],
    ['submitterName', 100],
    ['submitterEmail', 254],
    ['applicationUrl', 2048],
  ];
  for (const [name, maxLength] of fields) {
    if (typeof input[name] !== 'string' || !input[name].trim() || input[name].trim().length > maxLength) {
      return `${name} is required and must be no longer than ${maxLength} characters.`;
    }
  }
  if (!CATEGORIES.has(input.category)) return 'Choose a valid opportunity type.';
  if (!WORK_MODES.has(input.workMode)) return 'Choose a valid work arrangement.';
  if (!EXPERIENCE_LEVELS.has(input.experienceLevel)) return 'Choose a valid experience level.';
  if (!['paid', 'stipend', 'unpaid'].includes(input.payType)) return 'Choose a valid compensation type.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.submitterEmail.trim())) return 'Enter a valid contact email.';
  if (typeof input.closingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.closingDate)) {
    return 'Choose a valid closing date.';
  }
  const closingDate = new Date(`${input.closingDate}T00:00:00Z`);
  if (!Number.isFinite(closingDate.getTime()) || closingDate.toISOString().slice(0, 10) !== input.closingDate) {
    return 'Choose a valid closing date.';
  }
  if (input.closingDate < southAfricaToday()) return 'The closing date cannot be in the past.';
  try {
    const applicationUrl = new URL(input.applicationUrl.trim());
    if (!['https:', 'mailto:'].includes(applicationUrl.protocol)) return 'Use a secure HTTPS application link or a mailto address.';
    if (applicationUrl.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicationUrl.pathname)) {
      return 'Enter a valid application email address.';
    }
  } catch {
    return 'Enter a valid application URL.';
  }
  if (typeof input.website === 'string' && input.website.trim()) return 'Submission could not be accepted.';
  for (const [name] of fields) input[name] = input[name].trim();
  return null;
}

function getSubmissionValues(input) {
  const payType = ['paid', 'stipend', 'unpaid'].includes(input.payType) ? input.payType : 'paid';
  const payDetails = typeof input.payDetails === 'string' ? input.payDetails.trim().slice(0, 160) : '';
  const duration = typeof input.duration === 'string' ? input.duration.trim().slice(0, 100) : '';
  return {
    title: input.title,
    company: input.company,
    category: input.category,
    location: input.location,
    workMode: input.workMode,
    experienceLevel: input.experienceLevel,
    compensation: `${payType}${payDetails ? ` — ${payDetails}` : ''}`,
    duration: duration || null,
    description: input.description,
    applicationUrl: input.applicationUrl,
    submitterName: input.submitterName,
    submitterEmail: input.submitterEmail.toLowerCase(),
    closingDate: input.closingDate,
  };
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    const url = new URL(req.url, 'http://localhost');
    const isSessionRoute = url.pathname.endsWith('/session');

    if (isSessionRoute && req.method === 'POST') {
      if (!isSameOrigin(req)) return send(res, 403, { error: 'Request origin is not allowed.' });
      const ip = getClientKey(req);
      if (!ip) return send(res, 503, { error: 'Sign-in is temporarily unavailable. Please try again shortly.' });
      const rate = await getLimiter('login').limit(ip);
      if (!rate.success) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))));
        return send(res, 429, { error: 'Too many sign-in attempts. Please wait before trying again.' });
      }
      const body = parseBody(req);
      const expected = Buffer.from(process.env.JOBS_ADMIN_TOKEN || '');
      if (!expected.length) return send(res, 503, { error: 'Moderator sign-in is not configured in this environment.' });
      const supplied = Buffer.from(typeof body.token === 'string' ? body.token : '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return send(res, 401, { error: 'The moderation token is not correct.' });
      }
      const expiresAt = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
      const signature = createSessionSignature(expiresAt, process.env.JOBS_ADMIN_TOKEN);
      setAdminCookie(req, res, `${expiresAt}.${signature}`, SESSION_TTL_SECONDS);
      return send(res, 200, { authenticated: true });
    }

    if (isSessionRoute && req.method === 'DELETE') {
      setAdminCookie(req, res, '', 0);
      return send(res, 200, { authenticated: false });
    }

    if (req.method === 'GET') {
      if (url.searchParams.get('admin') === '1') {
        if (!isAdminSessionValid(req)) return send(res, 401, { error: 'Sign in to review submissions.' });
        const submissions = await db.select({
          id: jobSubmissions.id,
          title: jobSubmissions.title,
          company: jobSubmissions.company,
          category: jobSubmissions.category,
          location: jobSubmissions.location,
          workMode: jobSubmissions.workMode,
          experienceLevel: jobSubmissions.experienceLevel,
          compensation: jobSubmissions.compensation,
          duration: jobSubmissions.duration,
          description: jobSubmissions.description,
          applicationUrl: jobSubmissions.applicationUrl,
          submitterName: jobSubmissions.submitterName,
          submitterEmail: jobSubmissions.submitterEmail,
          closingDate: jobSubmissions.closingDate,
          status: jobSubmissions.status,
          submittedAt: jobSubmissions.submittedAt,
        })
          .from(jobSubmissions)
          .where(eq(jobSubmissions.status, 'pending'))
          .orderBy(desc(jobSubmissions.submittedAt));
        return send(res, 200, { submissions });
      }

      const today = southAfricaToday();
      const jobs = await db.select({
        id: jobSubmissions.id,
        title: jobSubmissions.title,
        company: jobSubmissions.company,
        category: jobSubmissions.category,
        location: jobSubmissions.location,
        workMode: jobSubmissions.workMode,
        experienceLevel: jobSubmissions.experienceLevel,
        compensation: jobSubmissions.compensation,
        duration: jobSubmissions.duration,
        description: jobSubmissions.description,
        applicationUrl: jobSubmissions.applicationUrl,
        closingDate: jobSubmissions.closingDate,
        submittedAt: jobSubmissions.submittedAt,
      })
        .from(jobSubmissions)
        .where(and(
          eq(jobSubmissions.status, 'approved'),
          gte(jobSubmissions.closingDate, today),
        ))
        .orderBy(asc(jobSubmissions.closingDate));
      return send(res, 200, { jobs });
    }

    if (req.method === 'POST' && !isSessionRoute) {
      if (!isSameOrigin(req)) return send(res, 403, { error: 'Request origin is not allowed.' });
      const ip = getClientKey(req);
      if (!ip) return send(res, 503, { error: 'Submissions are temporarily unavailable. Please try again shortly.' });
      const rate = await getLimiter('submission').limit(ip);
      if (!rate.success) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))));
        return send(res, 429, { error: 'Too many submissions. Please try again later.' });
      }
      const input = parseBody(req);
      const validationError = validateSubmission(input);
      if (validationError) return send(res, 400, { error: validationError });
      const [submission] = await db.insert(jobSubmissions)
        .values(getSubmissionValues(input))
        .returning({ id: jobSubmissions.id });
      return send(res, 201, { submitted: true, id: submission.id });
    }

    if (req.method === 'PATCH') {
      if (!isAdminSessionValid(req)) return send(res, 401, { error: 'Sign in to review submissions.' });
      if (!isSameOrigin(req)) return send(res, 403, { error: 'Request origin is not allowed.' });
      const body = parseBody(req);
      const status = body.status;
      if (!['approved', 'rejected'].includes(status) || typeof body.id !== 'string') {
        return send(res, 400, { error: 'Choose an approval decision.' });
      }
      const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 500) : null;
      const today = southAfricaToday();
      const conditions = [eq(jobSubmissions.id, body.id), eq(jobSubmissions.status, 'pending')];
      if (status === 'approved') conditions.push(gte(jobSubmissions.closingDate, today));
      const [updated] = await db.update(jobSubmissions)
        .set({ status, reviewedAt: new Date(), reviewNote })
        .where(and(...conditions))
        .returning({ id: jobSubmissions.id });
      if (!updated) return send(res, 404, { error: 'This submission is no longer pending or its closing date has passed.' });
      return send(res, 200, { reviewed: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return send(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof RangeError && error.message === 'too_large') {
      return send(res, 413, { error: 'Submission is too large. Please shorten the description.' });
    }
    if (error instanceof SyntaxError) return send(res, 400, { error: 'Send a valid request.' });
    console.error('Jobs API request failed:', error);
    return send(res, 503, { error: 'The jobs service is temporarily unavailable. Please try again shortly.' });
  }
}
