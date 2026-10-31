import 'dotenv/config';
import nodemailer from 'nodemailer';

const port = Number(process.env.SMTP_PORT || 587);
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  logger: true,
  debug: true,
  connectionTimeout: 15000,
});

try {
  await t.verify();
  console.log('SMTP connection + auth OK');
  const info = await t.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.ADMIN_OTP_EMAIL || process.env.ADMIN_EMAIL,
    subject: 'Mioralane SMTP test',
    text: 'SMTP test',
  });
  console.log('SENT:', info.response);
} catch (err) {
  console.error('SMTP FAILED:', err);
}
