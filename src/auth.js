import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import store from './store/index.js';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

export function issueMemberToken(member) {
  return jwt.sign({ memberId: member.id, accountId: member.accountId, role: member.role, email: member.email }, SECRET, { expiresIn: '7d' });
}

// Short-lived token for the two-step login (scope 'mfa') or forced enrolment (scope 'mfa-setup').
export function issueMfaToken(memberId, scope) {
  return jwt.sign({ memberId, scope }, SECRET, { expiresIn: '10m' });
}
export function issueReviewerToken(email) { return jwt.sign({ email, role: 'reviewer' }, SECRET, { expiresIn: '2d' }); }
export function issueConsoleToken(email, role) { return jwt.sign({ email, role }, SECRET, { expiresIn: '2d' }); }
export function verifyToken(token) { try { return jwt.verify(token, SECRET); } catch { return null; } }

// Resolve the auth token and where it came from. A request authenticates either
// with an `Authorization: Bearer` header (API clients, tests) or, for browsers,
// an httpOnly session cookie. The source determines whether CSRF applies.
function readAuth(req, cookieName) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7), source: 'header' };
  const c = req.cookies && req.cookies[cookieName];
  if (c) return { token: c, source: 'cookie' };
  return { token: null, source: 'none' };
}

// Double-submit CSRF check: the non-httpOnly `csrf` cookie must match the
// X-CSRF-Token header. Only meaningful for unsafe methods.
function csrfOk(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const sent = req.headers['x-csrf-token'] || '';
  const cookie = (req.cookies && req.cookies.csrf) || '';
  return !!sent && !!cookie && sent === cookie;
}

// Enforce CSRF ONLY when the session came from a cookie (a browser). Header-bearer
// callers cannot be driven cross-site, so they are inherently CSRF-safe.
function csrfGuard(req, res, source) {
  if (source === 'cookie' && !csrfOk(req)) { res.status(403).json({ error: 'Your session security token is missing or stale. Please refresh and try again.' }); return false; }
  return true;
}

// A logged-in member. Loads live member + their org so role/status are current.
export async function requireMember(req, res, next) {
  const { token, source } = readAuth(req, 'os_token');
  const p = verifyToken(token);
  if (!p || !p.memberId) return res.status(401).json({ error: 'Please sign in.' });
  if (!csrfGuard(req, res, source)) return;
  const member = await store.getMemberById(p.memberId);
  if (!member || member.status !== 'active') return res.status(401).json({ error: 'Account not active.' });
  if (member.suspended) return res.status(403).json({ error: 'Your access has been suspended.' });
  const account = await store.getAccountById(member.accountId);
  if (!account) return res.status(401).json({ error: 'Organisation not found.' });
  if (account.suspended) return res.status(403).json({ error: 'This organisation has been suspended.' });
  req.member = member; req.account = account;
  next();
}

// Accepts a full member session OR a short-lived mfa-setup token (for forced enrolment).
export async function requireMemberOrSetup(req, res, next) {
  const { token, source } = readAuth(req, 'os_token');
  const p = verifyToken(token);
  if (!p || !p.memberId) return res.status(401).json({ error: 'Please sign in.' });
  if (!csrfGuard(req, res, source)) return;
  const member = await store.getMemberById(p.memberId);
  if (!member) return res.status(401).json({ error: 'Account not found.' });
  if (member.suspended) return res.status(403).json({ error: 'Your access has been suspended.' });
  const account = await store.getAccountById(member.accountId);
  if (account?.suspended) return res.status(403).json({ error: 'This organisation has been suspended.' });
  req.member = member; req.account = account; req.tokenScope = p.scope || 'session';
  next();
}

// Org admin only (settings, policy, billing, managing admins).
export function requireOrgAdmin(req, res, next) {
  if (req.member?.role !== 'admin') return res.status(403).json({ error: 'Only an organisation admin can do this.' });
  next();
}

// Org admin OR manager (manage members and bookings, but not org settings).
export function requireOrgManager(req, res, next) {
  if (!['admin', 'manager'].includes(req.member?.role)) return res.status(403).json({ error: 'Only an admin or manager can do this.' });
  next();
}

// Can this member manage their OWN event types? Admins always can.
// Regular members can only when the org policy allows self-management.
export function canManageOwnEvents(member, account) {
  return member.role === 'admin' || account.memberSelfManage === true;
}

// Anyone with console access: the super admin or a platform admin.
// (Legacy 'reviewer' tokens are still accepted so existing editor/donate logins keep working.)
const CONSOLE_ROLES = ['superadmin', 'platformadmin', 'onboarding', 'content', 'reviewer'];
export function requireReviewer(req, res, next) {
  const { token, source } = readAuth(req, 'os_console');
  const p = verifyToken(token);
  if (!p || !CONSOLE_ROLES.includes(p.role)) return res.status(401).json({ error: 'Console access only.' });
  if (!csrfGuard(req, res, source)) return;
  req.console = p; req.reviewer = p;
  next();
}
export const requireConsole = requireReviewer;

// Only the super admin (can manage platform admins).
export function requireSuperAdmin(req, res, next) {
  const { token, source } = readAuth(req, 'os_console');
  const p = verifyToken(token);
  if (!p || p.role !== 'superadmin') return res.status(403).json({ error: 'Super admin only.' });
  if (!csrfGuard(req, res, source)) return;
  req.console = p;
  next();
}

// Requires a specific console permission. The super admin always passes.
export function requirePerm(perm) {
  return function (req, res, next) {
    const { token, source } = readAuth(req, 'os_console');
    const p = verifyToken(token);
    if (!p || !CONSOLE_ROLES.includes(p.role)) return res.status(401).json({ error: 'Console access only.' });
    if (!csrfGuard(req, res, source)) return;
    if (p.role === 'superadmin' || p.role === perm) { req.console = p; return next(); }
    return res.status(403).json({ error: 'You do not have permission for this.' });
  };
}

// ---- optional email ----
// Transports, in order of preference:
//   1. Resend  (RESEND_API_KEY)  - HTTPS API, but the from-address must be a domain you own
//   2. Brevo   (BREVO_API_KEY)   - HTTPS API, also needs an authenticated from-domain
//   3. SMTP    (SMTP_HOST/USER/PASS) - any provider
//   3b. Gmail shortcut: just set GMAIL_USER + GMAIL_APP_PASSWORD and it sends via Gmail
//       (free, no domain needed; from = your Gmail address).
let transporter = null;
// Gmail shortcut resolves into normal SMTP settings when SMTP_* are not set.
function smtpHost() { return process.env.SMTP_HOST || ((process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? 'smtp.gmail.com' : ''); }
function smtpUser() { return process.env.SMTP_USER || process.env.GMAIL_USER || ''; }
function smtpPass() { return process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || ''; }
function smtpPort() { return Number(process.env.SMTP_PORT || 465); }
function smtpReady() { return Boolean(smtpHost() && smtpUser() && smtpPass()); }
const usingGmailShortcut = () => !process.env.SMTP_HOST && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD;
export function emailEnabled() { return Boolean(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY || smtpReady()); }
export function emailMethod() { return process.env.RESEND_API_KEY ? 'Resend API' : (process.env.BREVO_API_KEY ? 'Brevo API' : (smtpReady() ? (usingGmailShortcut() ? 'Gmail SMTP' : 'SMTP') : 'none')); }
export function emailFrom() { return process.env.SMTP_FROM || process.env.EMAIL_FROM || smtpUser() || ''; }
function emailFromName() { return process.env.EMAIL_FROM_NAME || 'Enjeeoh'; }
function getTransporter() {
  if (!transporter && smtpHost()) {
    transporter = nodemailer.createTransport({ host: smtpHost(), port: smtpPort(),
      secure: smtpPort() === 465, auth: { user: smtpUser(), pass: smtpPass() } });
  }
  return transporter;
}

// Send via Brevo's HTTP API (uses the API key, runs over HTTPS so SMTP port blocks don't matter).
async function sendViaBrevoApi({ to, subject, html, ics }) {
  const from = emailFrom();
  if (!from) return { sent: false, reason: 'No from address. Set SMTP_FROM to a verified sender on your authenticated domain.' };
  const body = { sender: { email: from, name: process.env.EMAIL_FROM_NAME || 'Enjeeoh' }, to: [{ email: to }], subject, htmlContent: html };
  if (ics) body.attachment = [{ content: Buffer.from(ics).toString('base64'), name: 'invite.ics' }];
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.ok) return { sent: true };
    let reason = 'HTTP ' + r.status;
    try { const d = await r.json(); reason = (d.message || d.code || reason); } catch {}
    console.error('Brevo API send failed:', reason);
    return { sent: false, reason };
  } catch (e) { console.error('Brevo API send error:', e.message); return { sent: false, reason: e.message }; }
}

// Send via Resend's HTTP API (https://resend.com). Just needs RESEND_API_KEY
// and a verified from address. Runs over HTTPS, so blocked SMTP ports do not matter.
async function sendViaResendApi({ to, subject, html, ics }) {
  const from = emailFrom();
  if (!from) return { sent: false, reason: 'No from address. Set SMTP_FROM to a verified sender on your Resend domain.' };
  const body = { from: `${emailFromName()} <${from}>`, to: [to], subject, html };
  if (ics) body.attachments = [{ filename: 'invite.ics', content: Buffer.from(ics).toString('base64') }];
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.ok) return { sent: true };
    let reason = 'HTTP ' + r.status;
    try { const d = await r.json(); reason = (d.message || d.name || reason); } catch {}
    console.error('Resend API send failed:', reason);
    return { sent: false, reason };
  } catch (e) { console.error('Resend API send error:', e.message); return { sent: false, reason: e.message }; }
}

// ---- optional SMS (Twilio) ----
// Off until TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are set. Used for
// appointment reminders to bookers who provided a phone number.
export function smsEnabled() { return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM); }
export async function sendSms({ to, body }) {
  if (!smsEnabled()) return { sent: false, reason: 'SMS not configured.' };
  if (!to) return { sent: false, reason: 'No phone number.' };
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ From: process.env.TWILIO_FROM, To: to, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: params
    });
    if (r.ok) return { sent: true };
    let reason = 'HTTP ' + r.status; try { const d = await r.json(); reason = d.message || reason; } catch {}
    return { sent: false, reason };
  } catch (e) { return { sent: false, reason: e.message }; }
}

export async function sendEmail({ to, subject, html, ics }) {
  if (!emailEnabled()) return { sent: false, reason: 'Email is not configured.' };
  if (process.env.RESEND_API_KEY) return sendViaResendApi({ to, subject, html, ics });
  if (process.env.BREVO_API_KEY) return sendViaBrevoApi({ to, subject, html, ics });
  try {
    await getTransporter().sendMail({ from: emailFrom(), to, subject, html,
      attachments: ics ? [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar' }] : [] });
    return { sent: true };
  } catch (e) { console.error('Email failed:', e.message); return { sent: false, reason: e.message }; }
}
