import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Transactional email delivery over Brevo's SMTP relay.
 *
 * The reset token is only ever interpolated into the message body; it is never
 * logged here and never returned by an API response. Settings are read lazily so
 * a deployment (and the verification harness) can set them without re-importing
 * this module.
 */

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_MAIL_FROM = 'noreply@mioralane.com';
/** Served by the storefront; rasterized from `public/logo/logo_text.svg`. */
const LOGO_PATH = '/logo/logo_text.png';

/** The trusted storefront origin, without a trailing slash. */
export const resolveFrontendUrl = (): string => {
  const configured = (process.env.FRONTEND_URL ?? '').trim();

  return (configured || DEFAULT_FRONTEND_URL).replace(/\/+$/, '');
};

/**
 * The link a user clicks. The token is a query parameter so the storefront can
 * read it without a catch-all path route.
 */
export const buildPasswordResetLink = (token: string): string =>
  `${resolveFrontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;

let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  const host = (process.env.SMTP_HOST ?? '').trim();

  if (!host) {
    throw new Error('SMTP_HOST is not configured');
  }

  if (!transporter) {
    const parsedPort = Number.parseInt(process.env.SMTP_PORT ?? '', 10);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_SMTP_PORT;
    const user = (process.env.SMTP_USER ?? '').trim();
    const pass = process.env.SMTP_PASS ?? '';

    transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 (Brevo's relay default) upgrades with STARTTLS.
      secure: port === 465,
      ...(user ? { auth: { user, pass } } : {}),
    });
  }

  return transporter;
};

/**
 * Sends the password-reset email. Throws when SMTP is not configured or the
 * relay rejects the message; callers must not turn that into a response that
 * discloses whether the account exists.
 */
export const sendPasswordResetEmail = async (to: string, token: string): Promise<void> => {
  const resetLink = buildPasswordResetLink(token);
  const logoUrl = `${resolveFrontendUrl()}${LOGO_PATH}`;
  const from = (process.env.MAIL_FROM ?? '').trim() || DEFAULT_MAIL_FROM;

  const html = `
    <div style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:40px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <div style="margin:0 0 28px;text-align:center;">
          <img src="${logoUrl}" alt="Mioralane" width="160" style="display:block;margin:0 auto;width:160px;height:auto;border:0;outline:none;text-decoration:none;" />
        </div>
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:700;color:#111827;text-align:center;">
          Reset your password
        </h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4b5563;">
          We received a request to reset the password for your Mioralane account.
          Click the button below to choose a new password.
        </p>
        <div style="margin:28px 0;text-align:center;">
          <a href="${resetLink}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:700;">
            Reset Password
          </a>
        </div>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4b5563;">
          This link expires in 1 hour and can only be used once.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563;">
          If the button does not work, copy and paste this link into your browser:<br>
          <a href="${resetLink}" style="color:#e11d48;word-break:break-all;">${resetLink}</a>
        </p>
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
            If you did not request a password reset, you can safely ignore this email.
            Your password will not change.
          </p>
          <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">Mioralane</p>
        </div>
      </div>
    </div>
  `.trim();

  await getTransporter().sendMail({
    from,
    to,
    subject: 'Reset your Mioralane password',
    text:
      'We received a request to reset your Mioralane password.\n\n' +
      `Choose a new password here (valid for 1 hour):\n${resetLink}\n\n` +
      'If you did not request this, you can ignore this email. Your password will not change.',
    html,
  });
};
