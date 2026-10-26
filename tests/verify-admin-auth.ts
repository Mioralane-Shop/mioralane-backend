/**
 * Admin authentication — behavioural verification.
 *
 * Run with: npm run verify:admin-auth
 *
 * Unlike the other harnesses (which lean on static analysis), this one drives the
 * REAL Express app and the REAL controllers, middlewares, guards and CSRF logic.
 * The only thing replaced is persistence: every Mongoose model used by the admin
 * flow is backed by an in-memory store, so the run needs no MongoDB.
 *
 * That trade-off is deliberate. The properties this feature must guarantee are
 * behavioural — single-use codes, attempt ceilings, revocation, expiry and the
 * customer/admin separation — and a regex over source could not demonstrate any
 * of them. The fakes still execute the genuine `pre('save')` hooks, so the
 * "password is hashed" assertion exercises the shipped hashing code rather than
 * a copy of it.
 *
 * Email delivery runs through the real `sendAdminOtpEmail`; only nodemailer's
 * transport is stubbed. "The code reaches the configured inbox" is therefore
 * asserted on the message the service actually builds.
 *
 * Exits non-zero if any check fails.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import express from 'express';
import cookieParser from 'cookie-parser';
import { AdminModel } from '../src/admin/admin.model';
import { AdminOtpModel } from '../src/admin/admin-otp.model';
import { AdminSessionModel } from '../src/admin/admin-session.model';
import { UserModel } from '../src/auth/user.model';
import { ActivityLog } from '../src/activity-log/activity-log.model';
import {
  DEFAULT_ADMIN_SESSION_TTL_MS,
  resolveAdminSessionTtlMs,
  setAdminAuthCookie,
} from '../src/admin/admin-session.service';
import { MAX_ADMIN_OTP_ATTEMPTS, resolveAdminOtpTtlMs } from '../src/admin/admin-otp.service';
import { CSRF_HEADER } from '../src/middleware/csrf-token.middleware';

/* ────────────────────────── harness scaffolding ────────────────────────── */

const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    console.log(`  OK   ${label}`);
    return;
  }

  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  FAIL ${label}${suffix}`);
  failures.push(`${label}${suffix}`);
};

const section = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

const SRC_DIR = join(__dirname, '..', 'src');

const PROBE = {
  adminEmail: 'admin-probe@mioralane.test',
  otpInbox: 'otp-inbox@mioralane.test',
  adminPassword: 'Probe-Password-9x!',
  bootstrapSecret: 'probe-bootstrap-secret-0123456789abcdef',
  customerEmail: 'customer-probe@mioralane.test',
  customerUsername: 'customer-probe',
  customerPassword: 'Customer-Pass-9x!',
} as const;

/**
 * Placeholders so the module graph can be imported without a developer env:
 * `media.routes.ts` builds an `ImageKitService` at load and throws on empty
 * variables, and `protect` captures `JWT_SECRET` at module load.
 */
const ensureProbeEnv = (): void => {
  process.env.IMAGEKIT_URL_ENDPOINT ??= 'https://ik.imagekit.io/probe-endpoint';
  process.env.IMAGEKIT_PUBLIC_KEY ??= 'probe-public-key';
  process.env.IMAGEKIT_PRIVATE_KEY ??= 'probe-private-key';
  process.env.JWT_SECRET ??= 'probe-jwt-secret-not-a-credential-0123456789';
  process.env.ADMIN_OTP_EMAIL = PROBE.otpInbox;
  process.env.ADMIN_BOOTSTRAP_SECRET = PROBE.bootstrapSecret;
  process.env.ADMIN_SESSION_TTL_HOURS = '3';
  // The real email service refuses to build a transport without SMTP_HOST; the
  // transport itself is stubbed below, so this value is never dialled.
  process.env.SMTP_HOST ??= 'smtp.probe.invalid';
  process.env.SMTP_PORT ??= '587';
  delete process.env.TURNSTILE_SECRET_KEY;
};

/* ────────────────────────────── in-memory data ─────────────────────────── */

type StoredAdmin = {
  _id: Types.ObjectId;
  email: string;
  password?: string;
  name?: string;
  role: 'owner' | 'admin';
  permissions: string[];
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

type StoredChallenge = {
  _id: Types.ObjectId;
  adminId: Types.ObjectId;
  challengeId: string;
  otpHash: string;
  expiresAt: Date;
  lastSentAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
};

type StoredSession = {
  _id: Types.ObjectId;
  adminId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string;
  lastSeenAt?: Date;
  createdAt: Date;
};

type StoredUser = {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password?: string;
  role: 'user' | 'admin';
  authProvider: string;
  createdAt: Date;
};

let admins: StoredAdmin[] = [];
let challenges: StoredChallenge[] = [];
let sessions: StoredSession[] = [];
let users: StoredUser[] = [];
const sentEmails: Array<{ to: string; subject: string; text: string; html: string }> = [];

/**
 * A thenable query exposing the subset of the Mongoose API the code uses.
 *
 * `resolve` is called lazily, so a `.select(...)` applied after the object is
 * created still affects the returned value — exactly like a Mongoose query.
 */
type SelectableQuery<T> = Promise<T> & {
  select(fields: string): SelectableQuery<T>;
  lean(): SelectableQuery<T>;
  exec(): Promise<T>;
};

const selectableQuery = <T>(resolve: (fields: string) => T): SelectableQuery<T> => {
  let fields = '';

  const settle = (): Promise<T> => Promise.resolve(resolve(fields));

  const query = {
    select: (value: string) => {
      fields = value;
      return query;
    },
    lean: () => query,
    exec: () => settle(),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      settle().then(onFulfilled as (value: T) => unknown, onRejected as (reason: unknown) => unknown),
    catch: (onRejected: unknown) => settle().catch(onRejected as (reason: unknown) => unknown),
    finally: (onFinally: unknown) => settle().finally(onFinally as () => void),
    [Symbol.toStringTag]: 'Promise',
  };

  return query as unknown as SelectableQuery<T>;
};

const override = (model: object, method: string, impl: unknown): void => {
  (model as unknown as Record<string, unknown>)[method] = impl;
};

/** Runs the model's real `pre('save')` hooks, so hashing is the shipped code. */
const runSaveHooks = async (model: { schema: unknown }, doc: unknown): Promise<void> => {
  const hooks = (
    model.schema as {
      s: { hooks: { execPre: (name: string, context: unknown, args: unknown[]) => Promise<void> } };
    }
  ).s.hooks;

  await hooks.execPre('save', doc, []);
};

const publicAdmin = (admin: StoredAdmin): Omit<StoredAdmin, 'password'> => {
  const { password, ...rest } = admin;
  void password;

  return { ...rest };
};

/* ─────────────────────────────── model fakes ───────────────────────────── */

const installModelFakes = (): void => {
  override(AdminModel, 'countDocuments', async () => admins.length);

  override(AdminModel, 'create', async (input: Record<string, unknown>) => {
    const email = String(input.email);

    if (admins.some((admin) => admin.email === email)) {
      throw Object.assign(new Error('E11000 duplicate key error collection: admins'), { code: 11000 });
    }

    const doc = new AdminModel(input as never);
    await runSaveHooks(AdminModel, doc);

    const record: StoredAdmin = {
      _id: new Types.ObjectId(),
      email: doc.email,
      password: doc.password as string | undefined,
      name: doc.name as string | undefined,
      role: (doc.role ?? 'admin') as 'owner' | 'admin',
      permissions: (doc.permissions ?? []) as StoredAdmin['permissions'],
      isActive: doc.isActive !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    admins.push(record);

    return publicAdmin(record);
  });

  override(AdminModel, 'findOne', (filter: { email?: string }) =>
    selectableQuery((fields) => {
      const found = admins.find((admin) => admin.email === filter.email);

      if (!found) {
        return null;
      }

      return fields.includes('+password') ? { ...found } : publicAdmin(found);
    })
  );

  override(AdminModel, 'findById', (id: unknown) =>
    selectableQuery(() => {
      const found = admins.find((admin) => String(admin._id) === String(id));

      return found ? publicAdmin(found) : null;
    })
  );

  override(AdminModel, 'updateOne', async (filter: { _id?: unknown }, update: Record<string, unknown>) => {
    const found = admins.find((admin) => String(admin._id) === String(filter._id));

    if (found && typeof update.$set === 'object' && update.$set !== null) {
      Object.assign(found, update.$set);
    }

    return { matchedCount: found ? 1 : 0 };
  });

  override(AdminModel, 'deleteOne', async (filter: { _id?: unknown }) => {
    const before = admins.length;
    admins = admins.filter((admin) => String(admin._id) !== String(filter._id));

    return { deletedCount: before - admins.length };
  });

  /* ── challenges ── */

  override(AdminOtpModel, 'create', async (input: Record<string, unknown>) => {
    const record: StoredChallenge = {
      _id: new Types.ObjectId(),
      adminId: input.adminId as Types.ObjectId,
      challengeId: String(input.challengeId),
      otpHash: String(input.otpHash),
      expiresAt: input.expiresAt as Date,
      lastSentAt: input.lastSentAt as Date,
      attempts: Number(input.attempts ?? 0),
      consumedAt: null,
      createdAt: new Date(),
    };

    challenges.push(record);

    return { ...record };
  });

  override(AdminOtpModel, 'findOne', (filter: { challengeId?: string }) =>
    selectableQuery(() => {
      const found = challenges.find((challenge) => challenge.challengeId === filter.challengeId);

      return found ? { ...found } : null;
    })
  );

  override(
    AdminOtpModel,
    'findOneAndUpdate',
    async (
      filter: { _id?: unknown; consumedAt?: null; attempts?: { $lt: number } },
      update: { $inc?: { attempts?: number }; $set?: Record<string, unknown> }
    ) => {
      const found = challenges.find((challenge) => String(challenge._id) === String(filter._id));

      if (!found) {
        return null;
      }

      if ('consumedAt' in filter && filter.consumedAt === null && found.consumedAt !== null) {
        return null;
      }

      if (filter.attempts?.$lt !== undefined && !(found.attempts < filter.attempts.$lt)) {
        return null;
      }

      if (update.$inc?.attempts !== undefined) {
        found.attempts += update.$inc.attempts;
      }

      if (update.$set) {
        Object.assign(found, update.$set);
      }

      return { ...found };
    }
  );

  override(AdminOtpModel, 'deleteOne', async (filter: { _id?: unknown; consumedAt?: null }) => {
    const before = challenges.length;

    challenges = challenges.filter((challenge) => {
      if (String(challenge._id) !== String(filter._id)) {
        return true;
      }

      // `{ consumedAt: null }` in the filter means "only if still unconsumed".
      return filter.consumedAt === null && challenge.consumedAt !== null;
    });

    return { deletedCount: before - challenges.length };
  });

  override(AdminOtpModel, 'deleteMany', async (filter: { adminId?: unknown }) => {
    const before = challenges.length;
    challenges = challenges.filter((challenge) => String(challenge.adminId) !== String(filter.adminId));

    return { deletedCount: before - challenges.length };
  });

  /* ── sessions ── */

  override(AdminSessionModel, 'create', async (input: Record<string, unknown>) => {
    const record: StoredSession = {
      _id: new Types.ObjectId(),
      adminId: input.adminId as Types.ObjectId,
      tokenHash: String(input.tokenHash),
      expiresAt: input.expiresAt as Date,
      revokedAt: null,
      createdAt: new Date(),
    };

    sessions.push(record);

    return { ...record };
  });

  override(AdminSessionModel, 'findOne', (filter: { tokenHash?: string }) =>
    selectableQuery(() => {
      const found = sessions.find((session) => session.tokenHash === filter.tokenHash);

      return found ? { ...found } : null;
    })
  );

  override(
    AdminSessionModel,
    'updateOne',
    async (filter: { _id?: unknown; revokedAt?: null }, update: Record<string, unknown>) => {
      const found = sessions.find((session) => String(session._id) === String(filter._id));

      if (!found) {
        return { matchedCount: 0 };
      }

      if ('revokedAt' in filter && filter.revokedAt === null && found.revokedAt !== null) {
        return { matchedCount: 0 };
      }

      if (typeof update.$set === 'object' && update.$set !== null) {
        Object.assign(found, update.$set);
      }

      return { matchedCount: 1 };
    }
  );

  /* ── customer users (regression and isolation fixtures) ── */

  override(UserModel, 'findOne', (filter: { $or?: Array<Record<string, unknown>> }) =>
    selectableQuery((fields) => {
      const clauses = filter.$or ?? [];
      const found = users.find((user) =>
        clauses.some(
          (clause) =>
            (clause.username !== undefined && clause.username === user.username) ||
            (clause.email !== undefined && clause.email === user.email)
        )
      );

      if (!found) {
        return null;
      }

      return fields.includes('+password') ? { ...found } : { ...found, password: undefined };
    })
  );

  override(UserModel, 'findById', (id: unknown) =>
    selectableQuery((fields) => {
      const found = users.find((user) => String(user._id) === String(id));

      if (!found) {
        return null;
      }

      // `protect` selects only the role; `/auth/me` loads the document.
      return fields.includes('role') && !fields.includes('username')
        ? { role: found.role }
        : { ...found, password: undefined };
    })
  );

  /* ── audit log (written once, on a successful OTP verification) ── */

  override(ActivityLog, 'create', async () => [{}]);
};

/* ───────────────────────────── HTTP plumbing ───────────────────────────── */

type ProbeResponse = {
  status: number;
  json: Record<string, unknown>;
  setCookie: string[];
};

const listen = (app: express.Application): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const cookiePair = (setCookie: string[], name: string): string | null => {
  const match = setCookie.find((cookie) => cookie.startsWith(`${name}=`));

  return match ? match.split(';')[0] : null;
};

/** Every request gets its own forwarded address, so tests do not share limiter buckets. */
let addressCounter = 0;
const nextAddress = (): string => {
  addressCounter += 1;

  return `203.0.113.${(addressCounter % 250) + 1}`;
};

type SendOptions = {
  method?: string;
  body?: unknown;
  cookie?: string | null;
  csrf?: string;
  origin?: string | null;
  authorization?: string;
  headers?: Record<string, string>;
  forwardedFor?: string;
};

const send = async (base: string, path: string, options: SendOptions = {}): Promise<ProbeResponse> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': options.forwardedFor ?? nextAddress(),
    ...options.headers,
  };

  if (options.cookie) {
    headers.Cookie = options.cookie;
  }

  if (options.csrf) {
    headers[CSRF_HEADER] = options.csrf;
  }

  if (options.origin !== null && options.origin !== undefined) {
    headers.Origin = options.origin;
  }

  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};

  try {
    json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { raw: text };
  }

  return { status: response.status, json, setCookie: response.headers.getSetCookie() };
};

/* ──────────────────────────── flow helpers ─────────────────────────────── */

const lastEmail = (): { to: string; subject: string; text: string; html: string } | undefined =>
  sentEmails[sentEmails.length - 1];

const otpFromLastEmail = (): string => lastEmail()?.text.match(/\b(\d{6})\b/)?.[1] ?? '';

type Challenge = { challengeId: string; otp: string };

const startLogin = async (base: string): Promise<Challenge | null> => {
  const before = sentEmails.length;
  const response = await send(base, '/api/admin/auth/login', {
    method: 'POST',
    body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
  });

  if (response.status !== 200 || sentEmails.length === before) {
    return null;
  }

  return { challengeId: String(response.json.challengeId ?? ''), otp: otpFromLastEmail() };
};

const verifyChallenge = (base: string, challenge: Challenge): Promise<ProbeResponse> =>
  send(base, '/api/admin/auth/verify-otp', {
    method: 'POST',
    body: { challengeId: challenge.challengeId, otp: challenge.otp },
  });

type AdminSession = { cookie: string; csrf: string };

const signIn = async (base: string): Promise<AdminSession | null> => {
  const challenge = await startLogin(base);

  if (!challenge) {
    return null;
  }

  const response = await verifyChallenge(base, challenge);
  const cookie = cookiePair(response.setCookie, 'admin_token');

  if (response.status !== 200 || !cookie) {
    return null;
  }

  return { cookie, csrf: String(response.json.csrfToken ?? '') };
};

/* ──────────────────────────────── checks ───────────────────────────────── */

const main = async (): Promise<void> => {
  ensureProbeEnv();

  // `requireTurnstile` warns on every request when no secret is configured. The
  // harness deliberately leaves it unconfigured (that is how CI runs the other
  // suites too), so those known lines are filtered out to keep the report legible.
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[turnstile]')) {
      return;
    }

    originalWarn(...(args as []));
  };

  /*
   * Everything is imported AFTER `ensureProbeEnv()`. `middleware/auth.middleware`
   * captures `JWT_SECRET` at module load, so a static import would freeze the
   * placeholder away; `app.module` additionally needs the ImageKit placeholders.
   */
  const { default: createApp } = await import('../src/app.module');
  const { adminGuard, protect } = await import('../src/middleware/auth.middleware');
  const { csrfOriginGuard } = await import('../src/middleware/csrf.middleware');
  const { csrfTokenGuard } = await import('../src/middleware/csrf-token.middleware');

  installModelFakes();

  // Real transport replaced; the real message-building code is kept.
  const transport = {
    sendMail: async (message: Record<string, string>) => {
      sentEmails.push({
        to: String(message.to),
        subject: String(message.subject),
        text: String(message.text),
        html: String(message.html),
      });

      return { accepted: [message.to] };
    },
  };
  (nodemailer as unknown as { createTransport: unknown }).createTransport = () => transport;

  const server = await listen(createApp({ skipDatabaseCheck: true }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /*
   * A second app carrying the same guards, ending in business-route probes.
   * `createApp` mounts the same guards, but every admin business handler needs a
   * model this harness does not fake, so the guard/CSRF semantics for a
   * state-changing admin route are asserted here instead.
   */
  const probeApp = express();
  probeApp.set('trust proxy', 1);
  probeApp.use(express.json());
  probeApp.use(cookieParser());
  probeApp.use(csrfOriginGuard);
  probeApp.use(csrfTokenGuard);
  probeApp.get(
    '/probe/admin',
    ...adminGuard,
    ((req, res) => {
      res.json({ success: true, admin: req.admin?.email ?? null, userId: req.user?.id ?? null });
    }) as express.RequestHandler
  );
  probeApp.post(
    '/probe/admin',
    ...adminGuard,
    ((req, res) => {
      res.json({ success: true, admin: req.admin?.email ?? null, userId: req.user?.id ?? null });
    }) as express.RequestHandler
  );
  probeApp.get(
    '/probe/customer',
    protect as express.RequestHandler,
    ((req, res) => {
      res.json({ success: true, userId: req.user?.id ?? null });
    }) as express.RequestHandler
  );

  const probeServer = await listen(probeApp);
  const probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;

  try {
    /* ── A. bootstrap ─────────────────────────────────────────────── */
    section('A. Bootstrap is secret-gated and one-shot');

    const savedSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
    delete process.env.ADMIN_BOOTSTRAP_SECRET;

    const unconfigured = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
      headers: { 'x-admin-bootstrap-secret': PROBE.bootstrapSecret },
    });

    if (savedSecret !== undefined) {
      process.env.ADMIN_BOOTSTRAP_SECRET = savedSecret;
    }

    check(
      'bootstrap fails closed when ADMIN_BOOTSTRAP_SECRET is not configured',
      unconfigured.status === 503,
      `status ${unconfigured.status}`
    );

    const missingSecret = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
    });

    check(
      'bootstrap without the secret header is refused',
      missingSecret.status === 403,
      `status ${missingSecret.status}`
    );

    const wrongSecret = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
      headers: { 'x-admin-bootstrap-secret': 'wrong-secret-value-that-is-long-enough' },
    });

    check(
      'bootstrap with the wrong secret is refused',
      wrongSecret.status === 403,
      `status ${wrongSecret.status}`
    );
    check('no admin was created by the refused calls', admins.length === 0, `${admins.length} admins`);

    const weakPassword = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: 'short' },
      headers: { 'x-admin-bootstrap-secret': PROBE.bootstrapSecret },
    });

    check('bootstrap rejects a weak password', weakPassword.status === 400, `status ${weakPassword.status}`);

    const bootstrap = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword, name: 'Probe Owner' },
      headers: { 'x-admin-bootstrap-secret': PROBE.bootstrapSecret },
    });

    check(
      'bootstrap with the correct secret creates the first admin (201)',
      bootstrap.status === 201,
      `status ${bootstrap.status}: ${JSON.stringify(bootstrap.json)}`
    );
    check(
      'bootstrap creates no session cookie',
      cookiePair(bootstrap.setCookie, 'admin_token') === null,
      bootstrap.setCookie.join(' | ')
    );
    check(
      'the bootstrap response never contains a password or hash',
      Object.keys((bootstrap.json.admin as Record<string, unknown> | undefined) ?? {}).join(',') ===
        'id,email,name,role,permissions,isActive,createdAt' &&
        !JSON.stringify(bootstrap.json).includes('$2b$'),
      JSON.stringify(bootstrap.json)
    );

    const storedAdmin = admins[0] as StoredAdmin;
    const storedHash = storedAdmin?.password;

    check(
      'the stored password is a bcrypt hash that matches the submitted password',
      typeof storedHash === 'string' &&
        storedHash.startsWith('$2b$') &&
        (await bcrypt.compare(PROBE.adminPassword, storedHash)),
      typeof storedHash === 'string' ? storedHash.slice(0, 7) : 'missing'
    );
    check(
      'the initial admin gets the owner role and is active',
      storedAdmin?.role === 'owner' && storedAdmin?.isActive === true,
      `${String(storedAdmin?.role)} / active=${String(storedAdmin?.isActive)}`
    );

    const secondBootstrap = await send(base, '/api/admin/auth/bootstrap', {
      method: 'POST',
      body: { email: 'second@mioralane.test', password: PROBE.adminPassword },
      headers: { 'x-admin-bootstrap-secret': PROBE.bootstrapSecret },
    });

    check(
      'a second bootstrap is refused once an admin exists (409)',
      secondBootstrap.status === 409,
      `status ${secondBootstrap.status}`
    );
    check('the refused bootstrap created no second admin', admins.length === 1, `${admins.length} admins`);

    /* ── B. login (password step) ─────────────────────────────────── */
    section('B. Login validates credentials and emails a code — no session yet');

    const beforeLoginEmails = sentEmails.length;
    const login = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
    });

    check('valid credentials return an OTP challenge (200)', login.status === 200, `status ${login.status}`);
    check(
      'login answers requiresOtp with a challenge id',
      login.json.requiresOtp === true &&
        typeof login.json.challengeId === 'string' &&
        login.json.challengeId.length > 20,
      JSON.stringify(login.json)
    );
    check(
      'login issues NO session cookie (the session is minted only after the code)',
      cookiePair(login.setCookie, 'admin_token') === null,
      login.setCookie.join(' | ')
    );
    check('login returns no raw token in the body', !('token' in login.json), Object.keys(login.json).join(','));

    const loginEmail = lastEmail();
    // Widened through String() so the compiler does not narrow these to literal
    // types and then reject the "different from each other" comparison below.
    const deliveredTo = String(loginEmail?.to ?? "");
    const inboxAddress = String(PROBE.otpInbox);
    const loginAddress = String(PROBE.adminEmail);

    check(
      'the code is delivered to the CONFIGURED inbox, not the login address',
      sentEmails.length === beforeLoginEmails + 1 &&
        deliveredTo === inboxAddress &&
        deliveredTo !== loginAddress,
      `to=${deliveredTo}`
    );
    check(
      'the email identifies the Mioralane Admin code and its 5-minute expiry',
      /Mioralane Admin/i.test(loginEmail?.subject ?? '') &&
        /expires in 5 minutes/i.test(loginEmail?.text ?? ''),
      loginEmail?.subject ?? 'missing'
    );
    check('the emailed code is exactly 6 digits', /^\d{6}$/.test(otpFromLastEmail()), otpFromLastEmail());

    const controllerSource = readFileSync(join(SRC_DIR, 'admin', 'admin-auth.controller.ts'), 'utf8');
    const computedLogLines = controllerSource
      .split('\n')
      .filter((line) => /console\.(log|warn|error|info|debug)\(/.test(line) && line.includes('${'));

    check(
      'no log statement interpolates a value (so no OTP, password or token can reach a log line)',
      computedLogLines.length === 0,
      computedLogLines.join(' | ')
    );

    const beforeInvalid = sentEmails.length;
    const wrongPassword = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: 'definitely-wrong' },
    });

    check(
      'a wrong password is refused with a generic 401',
      wrongPassword.status === 401 && wrongPassword.json.message === 'Invalid email or password',
      `status ${wrongPassword.status}`
    );
    check(
      'a wrong password sends no email',
      sentEmails.length === beforeInvalid,
      `${sentEmails.length - beforeInvalid} email(s) sent`
    );

    const unknownEmail = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'nobody@mioralane.test', password: PROBE.adminPassword },
    });

    check(
      'an unknown address answers exactly like a wrong password',
      unknownEmail.status === 401 && unknownEmail.json.message === wrongPassword.json.message,
      `status ${unknownEmail.status}`
    );

    // A customer account whose role is "admin" must not be able to sign in here.
    const userDoc = new UserModel({
      username: PROBE.customerUsername,
      email: PROBE.customerEmail,
      password: PROBE.customerPassword,
      role: 'admin',
    } as never);
    await runSaveHooks(UserModel, userDoc);
    users.push({
      _id: new Types.ObjectId(),
      username: PROBE.customerUsername,
      email: PROBE.customerEmail,
      password: userDoc.password as string,
      role: 'admin',
      authProvider: 'local',
      createdAt: new Date(),
    });

    const customerAsAdmin = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.customerEmail, password: PROBE.customerPassword },
    });

    check(
      'a customer account with role "admin" cannot sign in to the admin portal',
      customerAsAdmin.status === 401,
      `status ${customerAsAdmin.status}`
    );

    storedAdmin.isActive = false;

    const disabledLogin = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
    });

    check(
      'a disabled admin cannot sign in (generic 401, no OTP)',
      disabledLogin.status === 401 && disabledLogin.json.message === 'Invalid email or password',
      `status ${disabledLogin.status}`
    );

    storedAdmin.isActive = true;

    /* ── C. verify-otp ────────────────────────────────────────────── */
    section('C. OTP verification: single use, attempt ceiling, expiry');

    const firstChallenge = await startLogin(base);

    check('a challenge is issued', firstChallenge !== null && firstChallenge.otp.length === 6, 'no challenge');

    if (!firstChallenge) {
      throw new Error('cannot continue: no challenge issued');
    }

    const sessionResponse = await verifyChallenge(base, firstChallenge);
    const adminCookie = cookiePair(sessionResponse.setCookie, 'admin_token');

    check('a valid OTP creates the session (200)', sessionResponse.status === 200, `status ${sessionResponse.status}`);
    check('the admin cookie is issued', adminCookie !== null, sessionResponse.setCookie.join(' | '));

    const adminSetCookie = sessionResponse.setCookie.find((cookie) => cookie.startsWith('admin_token=')) ?? '';

    check(
      'the cookie is HttpOnly, Path=/ and SameSite=Lax outside production',
      /HttpOnly/i.test(adminSetCookie) && /Path=\//.test(adminSetCookie) && /SameSite=Lax/i.test(adminSetCookie),
      adminSetCookie
    );
    check(
      'the cookie lifetime matches the 3-hour session policy (10800s)',
      /Max-Age=(1079[5-9]|10800)\b/.test(adminSetCookie),
      adminSetCookie
    );

    const liveSession = sessions[sessions.length - 1];
    const sessionMs = liveSession.expiresAt.getTime() - liveSession.createdAt.getTime();

    check(
      'the persisted session expires 3 hours after verification',
      Math.abs(sessionMs - DEFAULT_ADMIN_SESSION_TTL_MS) < 5000,
      `${Math.round(sessionMs / 1000)}s`
    );

    const sessionPayload = sessionResponse.json.session as { expiresAt?: string } | undefined;

    check(
      'the response reports the same expiry it stored',
      new Date(String(sessionPayload?.expiresAt)).getTime() === liveSession.expiresAt.getTime(),
      JSON.stringify(sessionPayload)
    );
    check(
      'the response carries a CSRF token and no raw session token',
      typeof sessionResponse.json.csrfToken === 'string' && !('token' in sessionResponse.json),
      Object.keys(sessionResponse.json).join(',')
    );
    check(
      'the response never exposes the password hash',
      !JSON.stringify(sessionResponse.json).includes('$2b$'),
      JSON.stringify(sessionResponse.json)
    );

    const replay = await verifyChallenge(base, firstChallenge);

    check(
      'the same code cannot be replayed (single use)',
      replay.status === 400 && replay.json.code === 'OTP_ALREADY_USED',
      `status ${replay.status} code ${String(replay.json.code)}`
    );

    const unknownChallenge = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: 'x'.repeat(43), otp: '123456' },
    });

    check(
      'an unknown challenge id is refused',
      unknownChallenge.status === 400 && unknownChallenge.json.code === 'CHALLENGE_NOT_FOUND',
      `status ${unknownChallenge.status} code ${String(unknownChallenge.json.code)}`
    );

    const wrongCodeChallenge = await startLogin(base);
    const wrongCode = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: wrongCodeChallenge?.challengeId, otp: '000001' },
    });

    check(
      'a wrong code is refused and creates no session',
      wrongCode.status === 400 &&
        wrongCode.json.code === 'OTP_INVALID' &&
        wrongCode.setCookie.length === 0,
      `status ${wrongCode.status} code ${String(wrongCode.json.code)}`
    );

    let attemptLimitHit = false;

    for (let attempt = 0; attempt < MAX_ADMIN_OTP_ATTEMPTS; attempt += 1) {
      const response = await send(base, '/api/admin/auth/verify-otp', {
        method: 'POST',
        body: { challengeId: wrongCodeChallenge?.challengeId, otp: '000002' },
      });

      attemptLimitHit = response.json.code === 'OTP_ATTEMPT_LIMIT';
    }

    check(
      `the challenge is voided after ${MAX_ADMIN_OTP_ATTEMPTS} wrong attempts`,
      attemptLimitHit,
      'the attempt ceiling never surfaced'
    );

    const correctAfterLimit = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: wrongCodeChallenge?.challengeId, otp: wrongCodeChallenge?.otp },
    });

    check(
      'the correct code is rejected once the attempt ceiling was reached',
      correctAfterLimit.status === 400 && correctAfterLimit.json.code === 'OTP_ATTEMPT_LIMIT',
      `status ${correctAfterLimit.status} code ${String(correctAfterLimit.json.code)}`
    );

    const expiringChallenge = await startLogin(base);

    if (expiringChallenge) {
      const record = challenges.find((challenge) => challenge.challengeId === expiringChallenge.challengeId);

      if (record) {
        record.expiresAt = new Date(Date.now() - 1000);
      }
    }

    const expired = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: expiringChallenge?.challengeId, otp: expiringChallenge?.otp },
    });

    check(
      'an expired code is refused even though the TTL sweep has not run',
      expired.status === 400 && expired.json.code === 'OTP_EXPIRED',
      `status ${expired.status} code ${String(expired.json.code)}`
    );

    const rotatedOld = await startLogin(base);
    const rotatedNew = await startLogin(base);

    const oldAfterRotation = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: rotatedOld?.challengeId, otp: rotatedOld?.otp },
    });

    check(
      'requesting a new code invalidates the previous challenge',
      oldAfterRotation.status === 400 && oldAfterRotation.json.code === 'CHALLENGE_NOT_FOUND',
      `status ${oldAfterRotation.status} code ${String(oldAfterRotation.json.code)}`
    );
    check('the newest challenge is still usable', rotatedNew !== null, 'no challenge');

    /* ── D. session enforcement ───────────────────────────────────── */
    section('D. Every admin request validates the live session');

    const session: AdminSession = {
      cookie: adminCookie ?? '',
      csrf: String(sessionResponse.json.csrfToken ?? ''),
    };

    const me = await send(base, '/api/admin/auth/me', { cookie: session.cookie });

    check('GET /api/admin/auth/me answers for a live session', me.status === 200, `status ${me.status}`);
    check(
      'the profile is the admin account and carries no password',
      (me.json.admin as { email?: string } | undefined)?.email === PROBE.adminEmail &&
        !JSON.stringify(me.json).includes('$2b$'),
      JSON.stringify(me.json)
    );
    check(
      'me re-issues a CSRF token (so a reloaded tab recovers)',
      typeof me.json.csrfToken === 'string' && me.json.csrfToken.length > 0,
      String(me.json.csrfToken)
    );

    const noCookie = await send(base, '/api/admin/auth/me');

    check(
      'the same endpoint without a cookie is 401',
      noCookie.status === 401 && noCookie.json.code === 'ADMIN_SESSION_REQUIRED',
      `status ${noCookie.status} code ${String(noCookie.json.code)}`
    );

    const businessNoCsrf = await send(probeBase, '/probe/admin', { method: 'POST', cookie: session.cookie });

    check(
      'an admin write without the CSRF token is refused (403)',
      businessNoCsrf.status === 403,
      `status ${businessNoCsrf.status}`
    );

    const businessWithCsrf = await send(probeBase, '/probe/admin', {
      method: 'POST',
      cookie: session.cookie,
      csrf: session.csrf,
    });

    check(
      'an admin write with the session CSRF token reaches the business handler',
      businessWithCsrf.status === 200 && businessWithCsrf.json.admin === PROBE.adminEmail,
      `status ${businessWithCsrf.status} ${JSON.stringify(businessWithCsrf.json)}`
    );
    check(
      'the guard populates req.admin (and the audit shim) for business handlers',
      typeof businessWithCsrf.json.userId === 'string' && businessWithCsrf.json.userId.length > 0,
      JSON.stringify(businessWithCsrf.json)
    );

    const sessionRecord = sessions[sessions.length - 1];
    sessionRecord.expiresAt = new Date(Date.now() - 1000);

    const expiredSession = await send(base, '/api/admin/auth/me', { cookie: session.cookie });

    check(
      'a session past its expiry is refused server-side (its JWT is still valid)',
      expiredSession.status === 401 && expiredSession.json.code === 'ADMIN_SESSION_EXPIRED',
      `status ${expiredSession.status} code ${String(expiredSession.json.code)}`
    );

    const revokedSession = await signIn(base);

    check('a new sign-in produces a new session', revokedSession !== null, 'sign-in failed');

    if (revokedSession) {
      sessions[sessions.length - 1].revokedAt = new Date();

      const revoked = await send(base, '/api/admin/auth/me', { cookie: revokedSession.cookie });

      check(
        'a revoked session is refused',
        revoked.status === 401 && revoked.json.code === 'ADMIN_SESSION_REVOKED',
        `status ${revoked.status} code ${String(revoked.json.code)}`
      );
    }

    const disabledSession = await signIn(base);

    if (disabledSession) {
      storedAdmin.isActive = false;

      const disabled = await send(base, '/api/admin/auth/me', { cookie: disabledSession.cookie });

      check(
        'a session belonging to a since-disabled admin is refused',
        disabled.status === 403 && disabled.json.code === 'ADMIN_ACCOUNT_DISABLED',
        `status ${disabled.status} code ${String(disabled.json.code)}`
      );

      storedAdmin.isActive = true;
    }

    const forged = await send(probeBase, '/probe/admin', { cookie: 'admin_token=not-a-real-token' });

    check('a forged admin cookie is refused', forged.status === 401, `status ${forged.status}`);

    /* ── E. isolation ─────────────────────────────────────────────── */
    section('E. Customer and admin authentication cannot cross');

    const customerLogin = await send(base, '/api/auth/login', {
      method: 'POST',
      body: { email: PROBE.customerEmail, password: PROBE.customerPassword },
    });
    const customerCookie = cookiePair(customerLogin.setCookie, 'token');
    const customerSetCookie = customerLogin.setCookie.find((cookie) => cookie.startsWith('token=')) ?? '';

    check('the customer can still sign in', customerLogin.status === 200, `status ${customerLogin.status}`);
    check(
      'the customer session uses the `token` cookie, not `admin_token`',
      customerCookie !== null && cookiePair(customerLogin.setCookie, 'admin_token') === null,
      customerLogin.setCookie.join(' | ')
    );
    check(
      'the customer session keeps the long-lived JWT_EXPIRES_IN window (not 3 hours)',
      !/Max-Age=10800\b/.test(customerSetCookie),
      customerSetCookie
    );

    const customerOnAdminMe = await send(base, '/api/admin/auth/me', { cookie: customerCookie });
    const customerOnAdminProbe = await send(probeBase, '/probe/admin', { cookie: customerCookie });
    const customerBearerOnAdmin = await send(probeBase, '/probe/admin', {
      authorization: `Bearer ${String(customerLogin.json.token ?? '')}`,
    });

    check(
      'a customer session cannot use admin APIs — even with role "admin"',
      customerOnAdminMe.status === 401 && customerOnAdminProbe.status === 401,
      `me ${customerOnAdminMe.status}, probe ${customerOnAdminProbe.status}`
    );
    check(
      'a customer JWT in an Authorization header cannot use admin APIs',
      customerBearerOnAdmin.status === 401,
      `status ${customerBearerOnAdmin.status}`
    );

    const customerMe = await send(base, '/api/auth/me', { cookie: customerCookie });

    check(
      'GET /api/auth/me still works for the customer, with its live role',
      customerMe.status === 200 &&
        (customerMe.json.user as { role?: string } | undefined)?.role === 'admin' &&
        typeof customerMe.json.csrfToken === 'string',
      `status ${customerMe.status} body ${JSON.stringify(customerMe.json)}`
    );

    const adminOnCustomerRoute = await send(probeBase, '/probe/customer', { cookie: session.cookie });
    const adminTokenAsCustomer = await send(base, '/api/auth/me', {
      cookie: `token=${encodeURIComponent(session.cookie.replace('admin_token=', ''))}`,
    });

    check(
      'an admin session cannot authenticate a customer route',
      adminOnCustomerRoute.status === 401,
      `status ${adminOnCustomerRoute.status}`
    );
    check(
      'an admin JWT planted in the customer cookie is refused (audience mismatch)',
      adminTokenAsCustomer.status === 401,
      `status ${adminTokenAsCustomer.status}`
    );

    /* ── F. logout ────────────────────────────────────────────────── */
    section('F. Logout revokes the session server-side');

    const logoutSession = await signIn(base);

    if (logoutSession) {
      const logoutNoCsrf = await send(base, '/api/admin/auth/logout', {
        method: 'POST',
        cookie: logoutSession.cookie,
      });

      check(
        'logout requires the CSRF token like any other admin write',
        logoutNoCsrf.status === 403,
        `status ${logoutNoCsrf.status}`
      );

      const logout = await send(base, '/api/admin/auth/logout', {
        method: 'POST',
        cookie: logoutSession.cookie,
        csrf: logoutSession.csrf,
      });

      check('logout succeeds', logout.status === 200, `status ${logout.status}`);
      check(
        'logout clears the admin cookie',
        (cookiePair(logout.setCookie, 'admin_token') ?? 'x').endsWith('=') ||
          /Expires=Thu, 01 Jan 1970/i.test(logout.setCookie.join(' ')),
        logout.setCookie.join(' | ')
      );

      const afterLogout = await send(probeBase, '/probe/admin', { cookie: logoutSession.cookie });

      check('the revoked session cannot be reused', afterLogout.status === 401, `status ${afterLogout.status}`);
    }

    /* ── G. resend-otp ────────────────────────────────────────────── */
    section('G. Resend rotates the challenge and is cooldown-limited');

    const resendTarget = await startLogin(base);
    const resendEmailsBefore = sentEmails.length;

    const resent = await send(base, '/api/admin/auth/resend-otp', {
      method: 'POST',
      body: { challengeId: resendTarget?.challengeId },
    });

    check(
      'resending inside the cooldown is refused (429, no email)',
      resent.status === 429 && sentEmails.length === resendEmailsBefore,
      `status ${resent.status} code ${String(resent.json.code)}`
    );

    if (resendTarget) {
      const record = challenges.find((challenge) => challenge.challengeId === resendTarget.challengeId);

      if (record) {
        record.lastSentAt = new Date(Date.now() - 61_000);
      }
    }

    const resentAfterCooldown = await send(base, '/api/admin/auth/resend-otp', {
      method: 'POST',
      body: { challengeId: resendTarget?.challengeId },
    });

    check(
      'after the cooldown a new code and challenge id are issued',
      resentAfterCooldown.status === 200 &&
        typeof resentAfterCooldown.json.challengeId === 'string' &&
        resentAfterCooldown.json.challengeId !== resendTarget?.challengeId,
      `status ${resentAfterCooldown.status}`
    );

    const oldChallengeAfterResend = await send(base, '/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { challengeId: resendTarget?.challengeId, otp: resendTarget?.otp },
    });

    check(
      'the challenge id presented before the resend no longer works',
      oldChallengeAfterResend.status === 400 && oldChallengeAfterResend.json.code === 'CHALLENGE_NOT_FOUND',
      `status ${oldChallengeAfterResend.status} code ${String(oldChallengeAfterResend.json.code)}`
    );

    /* ── H. rate limiting ─────────────────────────────────────────── */
    section('H. Login is rate limited per client');

    const hammeredAddress = '198.51.100.77';
    let sawRateLimit = false;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await send(base, '/api/admin/auth/login', {
        method: 'POST',
        body: { email: PROBE.adminEmail, password: 'wrong-on-purpose' },
        forwardedFor: hammeredAddress,
      });

      if (response.status === 429) {
        sawRateLimit = true;
        break;
      }
    }

    check(
      'repeated login attempts from one address are eventually rate limited',
      sawRateLimit,
      'never returned 429'
    );

    /* ── I. production cookie flags and pinned policy ────────────── */
    section('I. Production cookie flags and the pinned session policy');

    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const cookieApp = express();
    cookieApp.get('/probe', (_req, res) => {
      setAdminAuthCookie(res, 'probe-token', new Date(Date.now() + 60_000));
      res.json({ success: true });
    });

    const cookieServer = await listen(cookieApp);
    const cookieResponse = await fetch(
      `http://127.0.0.1:${(cookieServer.address() as AddressInfo).port}/probe`
    );
    const productionCookie = cookieResponse.headers.getSetCookie().join(' | ');
    cookieServer.close();

    const pinnedTtl = resolveAdminSessionTtlMs({
      NODE_ENV: 'production',
      ADMIN_SESSION_TTL_HOURS: '1',
    });

    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }

    check(
      'in production the admin cookie is Secure and SameSite=None',
      /Secure/i.test(productionCookie) && /SameSite=None/i.test(productionCookie),
      productionCookie
    );
    check(
      'in production ADMIN_SESSION_TTL_HOURS cannot shorten the pinned 3-hour policy',
      pinnedTtl === DEFAULT_ADMIN_SESSION_TTL_MS,
      `${pinnedTtl}ms`
    );
    check(
      'outside production the same variable is honoured (so staging can test expiry)',
      resolveAdminSessionTtlMs({ NODE_ENV: 'development', ADMIN_SESSION_TTL_HOURS: '1' }) === 3_600_000,
      'override ignored'
    );
    check(
      'ADMIN_OTP_TTL_MINUTES defaults to 5 and is clamped to a safe range',
      resolveAdminOtpTtlMs({}) === 5 * 60 * 1000 &&
        resolveAdminOtpTtlMs({ ADMIN_OTP_TTL_MINUTES: '99' }) === 5 * 60 * 1000,
      'unexpected OTP TTL'
    );

    /* ── J. CSRF / CORS remain enforced ──────────────────────────── */
    section('J. CSRF and CORS stay enforced on the new endpoints');

    const badOrigin = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: PROBE.adminPassword },
      origin: 'https://evil.example',
    });

    check(
      'an untrusted Origin is still refused on the pre-session endpoints',
      badOrigin.status === 403,
      `status ${badOrigin.status}`
    );

    const staleCustomerCookie = await send(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: PROBE.adminEmail, password: 'wrong-again' },
      cookie: 'token=stale-customer-cookie',
    });

    check(
      'a stale customer cookie does not block the pre-session endpoints (CSRF exemption)',
      staleCustomerCookie.status === 401,
      `status ${staleCustomerCookie.status}`
    );
  } finally {
    server.close();
    probeServer.close();
  }

  console.log('\n=== Result ===');

  if (failures.length > 0) {
    console.log(`FAILED (${failures.length}):`);

    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log('All admin authentication checks passed.');
};

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
