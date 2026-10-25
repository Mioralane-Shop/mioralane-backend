import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Transactional email delivery over Brevo's SMTP relay.
 *
 * The reset token and the admin OTP are only ever interpolated into a message
 * logged here and never returned by an API response. Settings are read lazily so
 * a deployment (and the verification harness) can set them without re-importing
 * this module.
 */

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_MAIL_FROM = 'noreply@mioralane.com';

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
  const from = (process.env.MAIL_FROM ?? '').trim() || DEFAULT_MAIL_FROM;

  const html = `
    <div style="margin:0;padding:24px;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Reset your Mioralane password</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
          We received a request to reset the password for your Mioralane account.
          Click the button below to choose a new password.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${resetLink}"
             style="display:inline-block;background:#1f2933;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:bold;">
            Reset password
          </a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          This link expires in 1 hour and can only be used once.
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          If you did not request a password reset, you can safely ignore this email.
          Your password will not change.
        </p>
        <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">
          If the button does not work, copy and paste this link into your browser:<br>
          <a href="${resetLink}" style="color:#1f2933;word-break:break-all;">${resetLink}</a>
        </p>
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

/**
 * Sends the 6-digit admin login OTP (2FA second factor). Throws when SMTP is
 * not configured or the relay rejects the message, so a caller can only report
 * `success: true` once the relay accepted it. The code is never logged here.
 */
export const sendAdminOtpEmail = async (to: string, otp: string): Promise<void> => {
  const from = (process.env.MAIL_FROM ?? '').trim() || DEFAULT_MAIL_FROM;

  const html = `
    <div style="margin:0;padding:24px;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Your Mioralane admin verification code</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
          Use the code below to finish signing in to the Mioralane admin portal.
        </p>
        <p style="margin:0 0 24px;font-size:28px;font-weight:bold;letter-spacing:8px;color:#1f2933;">${otp}</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
          This code expires in 5 minutes and can only be used once.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.6;">
          If you did not attempt to sign in, you can safely ignore this email.
        </p>
      </div>
    </div>
  `.trim();

  await getTransporter().sendMail({
    from,
    to,
    subject: 'Your Mioralane admin verification code',
    text:
      `Your Mioralane admin verification code is ${otp}. ` +
      'It expires in 5 minutes and can only be used once.',
    html,
  });
};
