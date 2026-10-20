/**
 * verify:password-reset - DB-free checks for the forgot/reset password flow.
 *
 * ## Coverage
 *
 *   1. The User model really owns the two reset fields, and the hash is
 *      `select:false` with a sparse index.
 *   2. Token handling: SHA-256 hex storage and the one-hour TTL.
 *   3. The reset link is built from FRONTEND_URL as
 *      `<origin>/reset-password?token=<encoded>`.
 *   4. Request schemas: email normalization/format, token presence, and the
 *      eight-character `newPassword` minimum.
 *   5. The real `forgotPasswordLimiter`: three requests per email per hour,
 *      a fourth is 429, a different email has its own bucket, and an invalid
 *      email is refused by the schema before it is counted.
 *   6. Controller behaviour with `UserModel.findOne` stubbed: unknown account,
 *      Google-only account and success all return the exact same 200 body; the
 *      success path stores the SHA-256 hash of the token that appears in the
 *      email; the reset handler rejects an unknown token with the exact 400
 *      message and clears both fields on success.
 *   7. Static wiring: routes -> validate -> limiter -> handler, and both paths
 *      are CSRF-exempt.
 *
 * No database is opened. Exits non-zero if any check fails.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response } from 'express';
import nodemailer from 'nodemailer';
import { UserModel } from '../src/auth/user.model';
import { forgotPasswordSchema, registerUserSchema, resetPasswordSchema } from '../src/auth/auth.schemas';
import {
    forgotPassword,
    hashResetToken,
    resetPassword,
    RESET_TOKEN_TTL_MS,
} from '../src/auth/password-reset.controller';
import { buildPasswordResetLink, resolveFrontendUrl } from '../src/services/email.service';
import {
    FORGOT_PASSWORD_LIMIT,
    forgotPasswordLimiter,
} from '../src/middleware/rateLimiter.middleware';
import { validate } from '../src/middleware/validate.middleware';

const SRC_DIR = join(__dirname, '..', 'src');

let failures = 0;

const check = (label: string, condition: boolean, detail = ''): void => {
    console.log(`${condition ? '  OK  ' : ' FAIL '} ${label}${detail ? ` - ${detail}` : ''}`);
    if (!condition) failures += 1;
};

const section = (title: string): void => {
    console.log(`\n${title}`);
};

/* -- helpers --------------------------------------------------------------- */

type Captured = { statusCode: number; body?: Record<string, unknown> };

const createResponse = (captured: Captured): Response =>
    ({
        status(code: number) {
            captured.statusCode = code;
            return this;
        },
        json(body: Record<string, unknown>) {
            captured.body = body;
            return this;
        },
    }) as unknown as Response;

const callForgot = async (email: string): Promise<Captured> => {
    const captured: Captured = { statusCode: 0 };
    await forgotPassword({ body: { email } } as unknown as Request, createResponse(captured));

    return captured;
};

const callReset = async (token: string, newPassword: string): Promise<Captured> => {
    const captured: Captured = { statusCode: 0 };
    await resetPassword(
        { body: { token, newPassword } } as unknown as Request,
        createResponse(captured)
    );

    return captured;
};

type MockUser = {
    email: string;
    password?: string;
    resetPasswordToken?: string;
    resetPasswordExpires?: Date;
    save: () => Promise<void>;
};

type MockFindOneQuery = Promise<MockUser | null> & {
    select: (projection: string) => Promise<MockUser | null>;
};

const userModel = UserModel as unknown as {
    findOne: (query: Record<string, unknown>) => MockFindOneQuery;
};

let saveCalls = 0;

const createUser = (overrides: Partial<MockUser> = {}): MockUser => ({
    email: 'user@example.com',
    save: async () => {
        saveCalls += 1;
    },
    ...overrides,
});

type Server = { base: string; close: () => Promise<void> };

const listen = (app: express.Express): Promise<Server> =>
    new Promise((resolve) => {
        const server = app.listen(0, () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;

            resolve({
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>((done) => server.close(() => done())),
            });
        });
    });

/* -- checks ---------------------------------------------------------------- */

const main = async (): Promise<void> => {
    /* 1. User model */
    section('User model');

    const tokenPath = UserModel.schema.path('resetPasswordToken');
    const expiresPath = UserModel.schema.path('resetPasswordExpires');

    check('resetPasswordToken exists and is a String', tokenPath?.instance === 'String');
    check('resetPasswordToken is excluded from generic loads', tokenPath?.options.select === false);
    check(
        'resetPasswordToken has a sparse index',
        tokenPath?.options.index === true && tokenPath?.options.sparse === true
    );
    check('resetPasswordExpires exists and is a Date', expiresPath?.instance === 'Date');

    /* 2. token handling */
    section('Token storage');

    const rawToken = 'a'.repeat(64);
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');

    check('hashResetToken is SHA-256 hex', hashResetToken(rawToken) === expectedHash);
    check('the stored hash is 64 hex characters', /^[0-9a-f]{64}$/.test(hashResetToken(rawToken)));
    check('the stored hash differs from the raw token', hashResetToken(rawToken) !== rawToken);
    check('the TTL is exactly one hour', RESET_TOKEN_TTL_MS === 60 * 60 * 1000);

    /* 3. reset link */
    section('Reset link');

    const originalFrontendUrl = process.env.FRONTEND_URL;

    try {
        process.env.FRONTEND_URL = 'https://mioralane.com/';
        check(
            'the link is <FRONTEND_URL>/reset-password?token=<token>',
            buildPasswordResetLink('abc123') === 'https://mioralane.com/reset-password?token=abc123'
        );
        check(
            'the token is URL-encoded',
            buildPasswordResetLink('a+b c') ===
                'https://mioralane.com/reset-password?token=a%2Bb%20c'
        );

        process.env.FRONTEND_URL = '  https://mioralane.com///  ';
        check(
            'whitespace and trailing slashes are removed',
            resolveFrontendUrl() === 'https://mioralane.com'
        );

        process.env.FRONTEND_URL = '';
        check(
            'a blank FRONTEND_URL falls back to localhost:3000',
            resolveFrontendUrl() === 'http://localhost:3000'
        );

        delete process.env.FRONTEND_URL;
        check(
            'a missing FRONTEND_URL falls back to localhost:3000',
            resolveFrontendUrl() === 'http://localhost:3000'
        );
    } finally {
        if (originalFrontendUrl === undefined) {
            delete process.env.FRONTEND_URL;
        } else {
            process.env.FRONTEND_URL = originalFrontendUrl;
        }
    }

    /* 4. request schemas */
    section('Request schemas');

    const normalizedEmail = forgotPasswordSchema.safeParse({ email: '  USER@Example.COM  ' });

    check('forgot-password accepts a valid email', normalizedEmail.success);
    check(
        'forgot-password trims and lower-cases the email',
        normalizedEmail.success && normalizedEmail.data.email === 'user@example.com'
    );
    check(
        'forgot-password rejects a malformed email',
        !forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success
    );
    check('forgot-password rejects a missing email', !forgotPasswordSchema.safeParse({}).success);

    check(
        'reset-password requires a token',
        !resetPasswordSchema.safeParse({ newPassword: 'abcdefgh' }).success
    );
    check(
        'reset-password rejects a 7-character password',
        !resetPasswordSchema.safeParse({ token: 't', newPassword: 'abcdefg' }).success
    );
    check(
        'reset-password accepts an 8-character password',
        resetPasswordSchema.safeParse({ token: 't', newPassword: 'abcdefgh' }).success
    );

    const strippedReset = resetPasswordSchema.safeParse({
        token: 't',
        newPassword: 'abcdefgh',
        password: 'ignored',
    });
    check(
        'reset-password strips unknown fields (mass-assignment guard)',
        strippedReset.success && !('password' in strippedReset.data)
    );

    check(
        'register-user accepts any 8-character password (no character-class rule)',
        registerUserSchema.safeParse({ username: 'user', email: 'user@example.com', password: 'abcdefgh' }).success
    );
    check(
        'register-user rejects a 7-character password',
        !registerUserSchema.safeParse({ username: 'user', email: 'user@example.com', password: 'abcdefg' }).success
    );

    /* 5. per-email rate limit */
    section('Per-email rate limit');

    check(
        'the limit is 3 requests per hour',
        FORGOT_PASSWORD_LIMIT.limit === 3 && FORGOT_PASSWORD_LIMIT.windowMs === 60 * 60 * 1000
    );

    const limiterApp = express();
    limiterApp.use(express.json());
    limiterApp.post(
        '/forgot-password',
        validate({ body: forgotPasswordSchema }),
        forgotPasswordLimiter,
        (_req, res) => {
            res.status(200).json({ success: true });
        }
    );

    const limiterServer = await listen(limiterApp);

    try {
        const post = async (
            email: string
        ): Promise<{ status: number; body: { success?: boolean; message?: string } }> => {
            const response = await fetch(`${limiterServer.base}/forgot-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const body = (await response.json()) as { success?: boolean; message?: string };

            return { status: response.status, body };
        };

        const stamp = Date.now();
        const limitedEmail = `limit-${stamp}@example.com`;
        const responses = [
            await post(limitedEmail),
            await post(limitedEmail),
            await post(limitedEmail),
            await post(limitedEmail),
        ];

        check(
            'the first three requests are accepted',
            responses.slice(0, 3).every((response) => response.status === 200),
            responses.map((response) => response.status).join(',')
        );
        check('the fourth request for the same email is 429', responses[3].status === 429);
        check(
            'the 429 body explains the limit',
            responses[3].body.success === false &&
                (responses[3].body.message ?? '').includes('Too many reset requests')
        );

        const variant = await post(`  ${limitedEmail.toUpperCase()}  `);
        check(
            'case and whitespace variants share the same bucket',
            variant.status === 429,
            String(variant.status)
        );

        const other = await post(`other-${stamp}@example.com`);
        check('a different email has its own bucket', other.status === 200);

        const invalid = await post('not-an-email');
        check('an invalid email is a 400 before the limiter', invalid.status === 400);
    } finally {
        await limiterServer.close();
    }

    /* 6. controller behaviour (model stubbed) */
    section('Controller behaviour (UserModel.findOne stubbed)');

    const originalFindOne = userModel.findOne;
    const originalConsoleError = console.error;

    let nextUser: MockUser | null = null;
    let lastQuery: Record<string, unknown> | null = null;

    userModel.findOne = (query) => {
        lastQuery = query;
        const promise = Promise.resolve(nextUser) as MockFindOneQuery;
        promise.select = async () => nextUser;

        return promise;
    };

    type CapturedMail = {
        from?: string;
        to?: string;
        subject?: string;
        text?: string;
        html?: string;
    };
    let capturedMail: CapturedMail | null = null;

    // Read through functions so TypeScript does not narrow the closure-assigned
    // variables to their initial `null` value.
    const getCapturedMail = (): CapturedMail | null => capturedMail;
    const getLastQuery = (): Record<string, unknown> | null => lastQuery;

    const nodemailerModule = nodemailer as unknown as {
        createTransport: (options: unknown) => {
            sendMail: (message: CapturedMail) => Promise<unknown>;
        };
    };
    const originalCreateTransport = nodemailerModule.createTransport;
    nodemailerModule.createTransport = () => ({
        sendMail: async (message) => {
            capturedMail = message;

            return { messageId: 'verify-password-reset' };
        },
    });

    const originalSmtpHost = process.env.SMTP_HOST;
    process.env.SMTP_HOST = 'smtp.verify.invalid';
    console.error = () => {};

    try {
        nextUser = null;
        const unknown = await callForgot('missing@example.com');

        check('an unknown email returns 200', unknown.statusCode === 200);
        check(
            'an unknown email gets the generic message',
            unknown.body?.message === 'If an account exists, a reset link has been sent.'
        );

        nextUser = createUser({ email: 'google@example.com', password: undefined });
        saveCalls = 0;
        const googleOnly = await callForgot('google@example.com');

        check('a Google-only account returns 200', googleOnly.statusCode === 200);
        check('a Google-only account does not issue a token', saveCalls === 0);
        check(
            'the Google-only body is identical to the unknown-email body',
            JSON.stringify(googleOnly.body) === JSON.stringify(unknown.body)
        );

        const localUser = createUser({ email: 'local@example.com', password: 'stored-hash' });
        let localSaveCalls = 0;
        localUser.save = async () => {
            localSaveCalls += 1;
        };
        nextUser = localUser;
        const successfulForgot = await callForgot('local@example.com');

        check('an existing account returns 200', successfulForgot.statusCode === 200);
        check(
            'the existing-account body is identical to the unknown-email body',
            JSON.stringify(successfulForgot.body) === JSON.stringify(unknown.body)
        );
        check('an existing account saves once', localSaveCalls === 1);
        check(
            'the stored reset token is 64 hex characters',
            /^[0-9a-f]{64}$/.test(localUser.resetPasswordToken ?? '')
        );
        check(
            'the expiry is one hour in the future',
            (localUser.resetPasswordExpires?.getTime() ?? 0) - Date.now() > 59 * 60 * 1000
        );

        const mail = getCapturedMail();
        const mailedToken = /reset-password\?token=([0-9a-f]{64})/.exec(mail?.text ?? '')?.[1];

        check('the email contains the raw token in the reset link', Boolean(mailedToken));
        check(
            'the stored value is the SHA-256 hash of the emailed token',
            Boolean(mailedToken) &&
                localUser.resetPasswordToken === hashResetToken(mailedToken ?? '')
        );
        check(
            'the raw emailed token is not stored',
            Boolean(mailedToken) && localUser.resetPasswordToken !== mailedToken
        );
        check(
            'the email has the expected recipient and subject',
            mail?.to === 'local@example.com' &&
                mail?.subject === 'Reset your Mioralane password'
        );

        const html = mail?.html ?? '';
        check(
            'the email uses the absolute logo URL',
            html.includes(`${resolveFrontendUrl()}/logo/logo_text.png`)
        );
        check('the email uses the light grey background', html.includes('background:#f4f4f5'));
        check('the email button is black', html.includes('background:#111827'));
        check(
            'the email footer keeps the security warning',
            html.includes('If you did not request a password reset')
        );

        nextUser = null;
        const invalidReset = await callReset('unknown-token', 'abcdefgh');

        check('an unknown or expired token returns 400', invalidReset.statusCode === 400);
        check(
            'the invalid-token message is exact',
            invalidReset.body?.message === 'Invalid or expired password reset token'
        );

        const resetUser = createUser({
            email: 'local@example.com',
            password: 'old-hash',
            resetPasswordToken: hashResetToken('good-token'),
            resetPasswordExpires: new Date(Date.now() + 60_000),
        });
        let resetSaveCalls = 0;
        resetUser.save = async () => {
            resetSaveCalls += 1;
        };
        nextUser = resetUser;
        const successfulReset = await callReset('good-token', 'new-password-8');

        check('a valid token returns 200', successfulReset.statusCode === 200);
        check(
            'the success message is exact',
            successfulReset.body?.message === 'Password reset successfully'
        );
        check(
            'the success body contains only success and message',
            Object.keys(successfulReset.body ?? {}).sort().join(',') === 'message,success'
        );
        check('the submitted new password is assigned', resetUser.password === 'new-password-8');
        check(
            'both reset fields are cleared',
            resetUser.resetPasswordToken === undefined && resetUser.resetPasswordExpires === undefined
        );
        check('the user is saved once', resetSaveCalls === 1);

        const query = getLastQuery();
        const expiryFilter = query?.resetPasswordExpires as { $gt?: Date } | undefined;

        check(
            'the lookup uses the SHA-256 hash of the submitted token',
            query?.resetPasswordToken === hashResetToken('good-token')
        );
        check(
            'the lookup requires an expiry in the future',
            expiryFilter?.$gt instanceof Date &&
                expiryFilter.$gt.getTime() > Date.now() - 5_000
        );
    } finally {
        userModel.findOne = originalFindOne;
        nodemailerModule.createTransport = originalCreateTransport;
        console.error = originalConsoleError;

        if (originalSmtpHost === undefined) {
            delete process.env.SMTP_HOST;
        } else {
            process.env.SMTP_HOST = originalSmtpHost;
        }
    }

    /* 7. static wiring */
    section('Static wiring');

    const routesSource = readFileSync(join(SRC_DIR, 'auth', 'auth.routes.ts'), 'utf8');
    const csrfSource = readFileSync(join(SRC_DIR, 'middleware', 'csrf-token.middleware.ts'), 'utf8');
    const controllerSource = readFileSync(
        join(SRC_DIR, 'auth', 'password-reset.controller.ts'),
        'utf8'
    );
    const userModelSource = readFileSync(join(SRC_DIR, 'auth', 'user.model.ts'), 'utf8');

    check(
        'the User model bcrypt-hashes a modified password before save',
        /isModified\('password'\)[\s\S]*bcrypt\.hash/.test(userModelSource)
    );

    const forgotStart = routesSource.indexOf("'/forgot-password'");
    const resetStart = routesSource.indexOf("'/reset-password'", forgotStart);
    const resetEnd = routesSource.indexOf('/**', resetStart);
    const forgotBlock = routesSource.slice(forgotStart, resetStart);
    const resetBlock = routesSource.slice(resetStart, resetEnd);

    check('forgot-password is mounted as a POST route', forgotStart > -1);
    check(
        'forgot-password runs validate -> limiter -> handler',
        /validate\([\s\S]*forgotPasswordLimiter[\s\S]*forgotPassword/.test(forgotBlock)
    );
    check('reset-password is mounted as a POST route', resetStart > -1);
    check(
        'reset-password runs validate -> handler',
        /validate\([\s\S]*resetPassword/.test(resetBlock)
    );
    check(
        'both reset paths are CSRF-exempt',
        csrfSource.includes("'/api/auth/forgot-password'") &&
            csrfSource.includes("'/api/auth/reset-password'")
    );
    check(
        'the forgot handler stores only hashResetToken(rawToken)',
        /resetPasswordToken\s*=\s*hashResetToken\(rawToken\)/.test(controllerSource)
    );
    check(
        'no response body serializes a reset token',
        !/json\(\s*\{[^}]*\btoken\s*:/i.test(controllerSource)
    );

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} - ${failures} failure(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
