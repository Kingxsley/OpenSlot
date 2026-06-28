import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import store from './src/store/index.js';
import { slotsForDate, labelTime } from './src/availability.js';
import { buildICS, googleCalLink, outlookLink } from './src/ics.js';
import {
  hashPassword, checkPassword, issueMemberToken, issueReviewerToken, issueConsoleToken, issueMfaToken, verifyToken,
  requireMember, requireMemberOrSetup, requireOrgAdmin, requireOrgManager, canManageOwnEvents, requireReviewer, requireConsole, requireSuperAdmin, requirePerm, sendEmail, emailEnabled, emailMethod, emailFrom, sendSms, smsEnabled
} from './src/auth.js';
import { newMfaSecret, verifyTotp, mfaQrDataUrl, newRecoveryCodes } from './src/mfa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
// Absolute base URL for links. Prefers the real request host (correct on Railway
// behind its proxy), falling back to PUBLIC_URL only when there is no request.
function baseUrl(req) {
  const host = req && (req.get('x-forwarded-host') || req.get('host'));
  if (host) {
    const proto = ((req.get('x-forwarded-proto') || req.protocol || 'https') + '').split(',')[0];
    return `${proto}://${host}`;
  }
  return process.env.PUBLIC_URL || `http://localhost:${PORT}`;
}
const BASE_DOMAINS = (process.env.BASE_DOMAIN || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); // e.g. enjeeoh.com,enjeeoh.com.au
const RESERVED = new Set(['admin', 'signup', 'review', 'console', 'editor', 'donate', 'support', 'about', 'demo', 'reset', 'api', 'book', 'embed.js', 'login', 'join', 'www', 'legal', 'privacy', 'terms', 'cookies', 'acceptable-use', 'dpa', 'manage', '']);

// Video calls use Jitsi. Defaults to the public meet.jit.si; set JITSI_DOMAIN to a
// self-hosted instance for full control. E2EE is requested in the room link.
const JITSI_DOMAIN = process.env.JITSI_DOMAIN || 'meet.jit.si';
const JITSI_E2EE = String(process.env.JITSI_E2EE || 'true') === 'true';

// Personal email providers are rejected at signup so organisations use a work address.
const FREE_EMAIL_DOMAINS = new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.com.au','ymail.com','hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com','icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me','gmx.com','mail.com','yandex.com','zoho.com','pm.me']);
function isOrgEmail(email) { const d = String(email || '').toLowerCase().split('@')[1] || ''; return d.includes('.') && !FREE_EMAIL_DOMAINS.has(d); }

const PASSWORD_POLICY_DEFAULT = {
  minLength: 8, requireUpper: false, requireNumber: false, requireSymbol: false, requireMfa: false,
  // Force a password change this many days after it was last set (0 = never).
  expiryDays: 0,
  // Email reminders to change the password at these password ages, in days.
  reminderDays: [30, 60, 90],
  // Lock an account after this many wrong passwords in a row (0 = never), for this many minutes.
  lockoutThreshold: 3, lockoutMinutes: 30
};
async function getPasswordPolicy() {
  const p = { ...PASSWORD_POLICY_DEFAULT, ...((await store.getPage('passwordPolicy')) || {}) };
  if (!Array.isArray(p.reminderDays)) p.reminderDays = PASSWORD_POLICY_DEFAULT.reminderDays;
  return p;
}
const DAY_MS = 24 * 60 * 60 * 1000;
function passwordAgeDays(member) {
  const since = member?.passwordChangedAt ? new Date(member.passwordChangedAt).getTime() : (member?.createdAt ? new Date(member.createdAt).getTime() : Date.now());
  return Math.floor((Date.now() - since) / DAY_MS);
}

// ================= EDITABLE EMAIL TEMPLATES =================
// Every lifecycle email the platform sends is defined here as a default the super
// admin can override from the console. Bodies use {{placeholders}} that are filled
// at send time. The `vars` list documents which placeholders each template supports.
const EMAIL_TEMPLATES = {
  accountSetup: {
    label: 'Account creation (NGO signup)',
    vars: ['orgName', 'setupUrl'],
    subject: 'Set your password for {{orgName}} on Enjeeoh',
    html: '<p>Welcome. Your application to {{orgName}} has been received.</p><p>Set your password to access your dashboard: <a href="{{setupUrl}}">{{setupUrl}}</a></p>'
  },
  memberInvite: {
    label: 'Team member invite',
    vars: ['orgName', 'inviterName', 'inviteUrl'],
    subject: "You've been added to {{orgName}} on Enjeeoh",
    html: '<p>{{inviterName}} added you to {{orgName}}.</p><p>Set your password and hours: <a href="{{inviteUrl}}">{{inviteUrl}}</a></p>'
  },
  orgApproved: {
    label: 'Application approved',
    vars: ['orgName', 'adminUrl'],
    subject: 'Your Enjeeoh application: approved',
    html: '<p>{{orgName}} is verified and your Enjeeoh account is now live. Sign in at <a href="{{adminUrl}}">{{adminUrl}}</a></p>'
  },
  orgRejected: {
    label: 'Application rejected',
    vars: ['orgName', 'note'],
    subject: 'Your Enjeeoh application: rejected',
    html: "<p>We couldn't verify {{orgName}} at this time.</p><p>{{note}}</p>"
  },
  passwordReset: {
    label: 'Password reset (forgot password)',
    vars: ['name', 'resetUrl'],
    subject: 'Reset your Enjeeoh password',
    html: '<p>Hi {{name}},</p><p>Use this link to set a new password (valid for one hour): <a href="{{resetUrl}}">{{resetUrl}}</a></p><p>If you did not request this, you can ignore this email.</p>'
  },
  forcedReset: {
    label: 'Password reset (required by an admin)',
    vars: ['name', 'resetUrl'],
    subject: 'Action required: reset your Enjeeoh password',
    html: '<p>Hi {{name}},</p><p>An administrator has required you to set a new password before signing in again. Use this link (valid for one hour): <a href="{{resetUrl}}">{{resetUrl}}</a></p>'
  },
  passwordReminder: {
    label: 'Password expiry reminder',
    vars: ['name', 'ageDays', 'resetUrl'],
    subject: 'A reminder to update your Enjeeoh password',
    html: "<p>Hi {{name}},</p><p>Your password is {{ageDays}} days old. For security, please set a new one: <a href=\"{{resetUrl}}\">{{resetUrl}}</a></p>"
  },
  accountDeleted: {
    label: 'Organisation deleted',
    vars: ['orgName'],
    subject: 'Your Enjeeoh organisation has been removed',
    html: '<p>The organisation {{orgName}} and its data have been removed from Enjeeoh. If you believe this was a mistake, reply to this email.</p>'
  },
  memberRemoved: {
    label: 'Member removed from organisation',
    vars: ['name', 'orgName'],
    subject: 'You have been removed from {{orgName}}',
    html: '<p>Hi {{name}},</p><p>Your access to {{orgName}} on Enjeeoh has been removed by an administrator.</p>'
  },
  policyUpdate: {
    label: 'Policy / legal document update (broadcast)',
    vars: [],
    subject: "We've updated our policies",
    html: '<p>Hello,</p><p>We have updated our legal documents (for example our <a href="https://enjeeoh.com/privacy">Privacy Policy</a> and <a href="https://enjeeoh.com/terms">Terms</a>).</p><p>Please take a moment to review the changes. By continuing to use Enjeeoh you agree to the updated terms.</p><p>Thank you,<br>The Enjeeoh team</p>'
  },
  demoRequestAck: {
    label: 'Demo request, confirmation to the requester',
    vars: ['name'],
    subject: 'Thanks for your interest in Enjeeoh',
    html: '<p>Hi {{name}},</p><p>Thank you for requesting a demo of Enjeeoh. We have received your request and a member of our team will be in touch shortly to arrange a time that suits you.</p><p>In the meantime, feel free to explore the platform.</p><p>Warm regards,<br>The Enjeeoh team</p>'
  },
  demoRequestNotify: {
    label: 'Demo request, notification to the team',
    vars: ['name', 'email', 'org', 'message'],
    subject: 'New demo request: {{org}}',
    html: '<p>A new demo has been requested.</p><ul><li><b>Name:</b> {{name}}</li><li><b>Email:</b> {{email}}</li><li><b>Organisation:</b> {{org}}</li><li><b>Message:</b> {{message}}</li></ul>'
  }
};
function fillTemplate(str, vars) { return String(str || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k]))); }
async function getEmailTemplates() {
  const overrides = (await store.getPage('emailTemplates')) || {};
  const out = {};
  for (const [key, def] of Object.entries(EMAIL_TEMPLATES)) {
    const o = overrides[key] || {};
    out[key] = { label: def.label, vars: def.vars, subject: o.subject || def.subject, html: o.html || def.html, customised: !!(o.subject || o.html) };
  }
  return out;
}
// Render and send a templated email in one step. Silently no-ops when email is off.
async function sendTemplate(key, to, vars = {}, extra = {}) {
  if (!emailEnabled() || !to) return { sent: false, reason: 'email off' };
  const all = await getEmailTemplates();
  const t = all[key]; if (!t) return { sent: false, reason: 'unknown template' };
  return sendEmail({ to, subject: fillTemplate(t.subject, vars), html: fillTemplate(t.html, vars), ...extra });
}
async function passwordError(pw) {
  const p = await getPasswordPolicy();
  pw = pw || '';
  if (pw.length < (p.minLength || 8)) return `Password must be at least ${p.minLength || 8} characters.`;
  if (p.requireUpper && !/[A-Z]/.test(pw)) return 'Password must include an uppercase letter.';
  if (p.requireNumber && !/[0-9]/.test(pw)) return 'Password must include a number.';
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) return 'Password must include a symbol.';
  return null;
}

// Australian visitors land on a .com.au domain; default their timezone accordingly.
function localeForHost(req) { const h = (req.get('x-forwarded-host') || req.get('host') || '').toLowerCase(); return h.endsWith('.au') ? 'Australia/Melbourne' : 'Etc/UTC'; }

const DONATE_DEFAULTS = {
  heading: 'Support the project',
  blurb: 'Enjeeoh is built and run by an independent sole trader, not a registered charity. Your support covers hosting and funds ongoing development so the platform can stay free for verified non-profits.',
  disclaimer: 'Enjeeoh is operated by a sole trader and is not a registered charity. Contributions are not tax deductible. They go towards the running costs and continued development of this project.',
  currency: 'AUD',
  amounts: [10, 25, 50, 100],
  recurringEnabled: true,
  providers: { stripe: '', openCollective: '', githubSponsors: '', paypal: '', kofi: '' },
  options: []
};

const LANDING_DEFAULTS = {
  badge: 'Free for verified NGOs',
  headLead: 'Scheduling', headRest: 'that NGOs run for free.',
  sub: 'Self hosted booking for non profits. Every member keeps their own hours and page, on your own domain, with no fees.',
  ctaPrimary: 'Apply as an NGO', ctaSecondary: 'Sign in',
  features: [
    { title: 'Team scheduling', body: 'Every member has their own login, hours and booking page.' },
    { title: 'Free video calls', body: 'A private Jitsi room is created for every booking, at no cost.' },
    { title: 'Your own domain', body: "Run it on a subdomain or the organisation's own web address." }
  ],
  accent: '#0F9D7A', accent2: '#11B98F', theme: 'light', anim: 'fadeUp'
};

// Map an incoming Host header to an organisation:
//  - <slug>.<BASE_DOMAIN>      -> subdomain match
//  - a registered customDomain -> white-label match
// Returns the org slug, or null for the main site.
async function resolveHostToOrg(host) {
  if (!host) return null;
  host = host.split(':')[0].toLowerCase();
  for (const base of BASE_DOMAINS) {
    if (host === base || host === 'www.' + base) return null;       // main site on any of our domains
    if (host.endsWith('.' + base)) {                                 // <slug>.<base> subdomain
      const sub = host.slice(0, -(base.length + 1));
      if (RESERVED.has(sub)) return null;
      const bySub = await store.getAccountBySlug(sub);
      return bySub ? bySub.slug : null;
    }
  }
  const all = await store.listAllAccounts();
  const custom = all.find(a => a.customDomain && a.customDomain.toLowerCase() === host);
  return custom ? custom.slug : null;
}

// Trust only as many proxy hops as actually sit in front of us (Railway = 1).
// Trusting *all* proxies (true) lets a client forge X-Forwarded-For and spoof the
// logged/rate-limited IP. Override with TRUST_PROXY if your hosting differs.
app.set('trust proxy', Number.isNaN(Number(process.env.TRUST_PROXY)) ? 1 : Number(process.env.TRUST_PROXY ?? 1));

// Security headers on every response. CSP keeps 'unsafe-inline' because the pages
// are inline-scripted with no build step, but it still blocks external scripts,
// plugins and (for sensitive pages) framing. The public booking surface stays
// framable so the embeddable widget keeps working.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // overridden below for embeddable pages
  const embeddable = req.path === '/' || req.path === '/embed.js' || req.path.startsWith('/book');
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    embeddable ? "frame-ancestors *" : "frame-ancestors 'self'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  if (embeddable) res.removeHeader('X-Frame-Options');
  next();
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => { req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(p => p[0])); next(); });

// Lightweight in-memory, per-IP rate limiter (no extra dependency). It is a first
// line of defence against credential spraying and email-bombing; the per-account
// lockout is the real protection. Counters are per process, which is fine here.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs);
  timer.unref?.();
  return (req, res, next) => {
    const k = clientIp(req) || 'unknown';
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
    }
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.RATE_LOGIN_MAX || 100) });
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.RATE_FORGOT_MAX || 5) });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.RATE_SIGNUP_MAX || 15) });

const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // seconds, matches the 7-day JWT
function setCookie(res, name, value, { httpOnly = true, secure = false, maxAge = SESSION_MAX_AGE } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
// Establish a browser session: the token in an httpOnly cookie (not reachable by
// JS, so XSS can't steal it) plus a readable CSRF token for the double-submit check.
function startSession(req, res, cookieName, token) {
  const secure = baseUrl(req).startsWith('https');
  const csrf = crypto.randomBytes(16).toString('hex');
  setCookie(res, cookieName, token, { httpOnly: true, secure });
  setCookie(res, 'csrf', csrf, { httpOnly: false, secure });
  return csrf;
}
function clearSession(res, cookieName) {
  setCookie(res, cookieName, '', { httpOnly: true, maxAge: 0 });
  setCookie(res, 'csrf', '', { httpOnly: false, maxAge: 0 });
}

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Only allow http(s) and inline image data URLs for coach/service images, so a
// pasted URL can never become a javascript:/other scheme injection vector.
function cleanImageUrl(u) {
  u = String(u || '').trim().slice(0, 4000);
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(u)) return u;
  return '';
}
// Validate an IANA timezone (e.g. "Australia/Melbourne"); empty = use the org's.
function cleanTimezone(tz) {
  tz = String(tz || '').trim().slice(0, 64);
  if (!tz) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return ''; }
}
function locationText(ev, jitsiUrl) {
  switch (ev.location) { case 'jitsi': return jitsiUrl; case 'phone': return 'Phone call';
    case 'inperson': return ev.customLocation || 'In person'; default: return ev.customLocation || ''; }
}
async function uniqueMemberSlug(accountId, base) {
  let slug = slugify(base) || 'member';
  while (await store.getMemberBySlug(accountId, slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  return slug;
}

// ================= ONBOARDING =================

// NGO applies: creates a PENDING org + its first member as admin.
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { orgName, contactName, country, website, registrationId, mission } = req.body || {};
  const email = String((req.body?.email) ?? '');
  if (!orgName || !email) return res.status(400).json({ error: 'Organisation name and email are required.' });
  if (!isOrgEmail(email)) return res.status(400).json({ error: "Please use your organisation's email address, not a personal email such as Gmail or Yahoo." });
  if (await store.getMemberByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const limits = (await store.getPage('limits')) || {};
  if (limits.globalMax > 0 && (await store.countAllMembers()) >= limits.globalMax) return res.status(403).json({ error: 'The platform is at capacity. Please try again later.' });
  let slug = slugify(orgName) || 'org';
  while (RESERVED.has(slug) || await store.getAccountBySlug(slug)) slug += '-' + crypto.randomBytes(2).toString('hex');

  const account = await store.createAccount({
    slug, name: orgName, email, country: country || '', website: website || '', contactName: contactName || '',
    registrationId: registrationId || '', mission: mission || '', status: 'pending', reviewNote: '',
    brandColor: '#0F9D7A', timezone: localeForHost(req), branding: true, memberSelfManage: true,
    maxMembers: limits.orgDefault > 0 ? limits.orgDefault : 0
  });
  // No password is entered at signup. The account is created with a one-time
  // secure setup link; the applicant clicks it to set their own password.
  const setupToken = crypto.randomBytes(24).toString('hex');
  const adminMember = await store.createMember(account.id, {
    name: contactName || orgName, email, passwordHash: '',
    slug: await uniqueMemberSlug(account.id, contactName || 'admin'),
    role: 'admin', status: 'invited', inviteToken: setupToken
  });
  await store.createEventType(account.id, adminMember.id, { title: 'Intro Call', slug: 'intro-call', durationMins: 30, description: 'A quick 30 minute call.', location: 'jitsi', customLocation: '' });

  const setupUrl = `${baseUrl(req)}/join?token=${setupToken}`;
  sendTemplate('accountSetup', email, { orgName, setupUrl });
  if (process.env.REVIEW_NOTIFY_EMAIL) sendEmail({ to: process.env.REVIEW_NOTIFY_EMAIL, subject: `New application: ${orgName}`, html: `<p>${orgName} (${country}) applied. Review at ${baseUrl(req)}/console</p>` });
  await audit(req, 'ngo.signup', { accountId: account.id, accountName: orgName, actor: email, actorRole: 'ngo', text: 'application submitted' });
  res.json({ ok: true, status: 'pending', setupUrl, emailed: emailEnabled(), message: 'Application received. Set your password using the link below, then we will verify your organisation.' });
});

// How a locked member is told to get unlocked: org admins must contact the
// super admin; everyone else can ask an admin in their own organisation.
function lockMessage(member) {
  return member.role === 'admin'
    ? 'Your account is locked after too many failed sign ins. Please email the platform super admin to unlock it.'
    : 'Your account is locked after too many failed sign ins. Ask an admin in your organisation to unlock it.';
}

app.post('/api/login', loginLimiter, async (req, res) => {
  // Coerce to strings: a JSON body like {"email":{"$ne":null}} must never reach
  // the data layer as an operator object (NoSQL injection guard).
  const email = String((req.body?.email) ?? ''), password = String((req.body?.password) ?? '');
  const member = await store.getMemberByEmail(email);
  // Unknown email or never-set password: generic failure, no enumeration.
  if (!member || member.status !== 'active') return res.status(401).json({ error: 'Wrong email or password.' });

  const policy = await getPasswordPolicy();
  // Account currently locked from earlier failures?
  if (member.lockedUntil && new Date(member.lockedUntil).getTime() > Date.now()) {
    return res.status(423).json({ error: lockMessage(member), locked: true });
  }

  if (!checkPassword(password || '', member.passwordHash || '')) {
    // Track consecutive failures and lock once the threshold is hit.
    const fails = (member.failedAttempts || 0) + 1;
    const patch = { failedAttempts: fails, lastFailedAt: new Date().toISOString() };
    const threshold = policy.lockoutThreshold || 0;
    if (threshold && fails >= threshold) {
      patch.lockedUntil = new Date(Date.now() + (policy.lockoutMinutes || 30) * 60 * 1000).toISOString();
      patch.failedAttempts = 0;
    }
    await store.updateMember(member.id, patch);
    if (patch.lockedUntil) {
      await audit(req, 'login.locked', { accountId: member.accountId, actor: member.email, actorRole: member.role, text: `locked after ${threshold} failed attempts` });
      return res.status(423).json({ error: lockMessage(member), locked: true });
    }
    await audit(req, 'login.failed', { accountId: member.accountId, actor: member.email, actorRole: member.role, text: `wrong password (attempt ${fails})` });
    return res.status(401).json({ error: 'Wrong email or password.' });
  }

  // Correct password from here on: clear any failure counters.
  if (member.failedAttempts || member.lockedUntil) await store.updateMember(member.id, { failedAttempts: 0, lockedUntil: null });
  await audit(req, 'login.success', { accountId: member.accountId, actor: member.email, actorRole: member.role, text: 'password verified' });

  const account = await store.getAccountById(member.accountId);
  if (account?.deleted) return res.status(403).json({ error: 'This organisation is no longer active.' });
  if (account?.suspended) return res.status(403).json({ error: 'This organisation has been locked. Please contact support.' });
  if (member.suspended) return res.status(403).json({ error: 'Your access has been suspended.' });

  // Forced reset (set by an admin) or an expired password blocks login until reset.
  const expired = policy.expiryDays > 0 && passwordAgeDays(member) >= policy.expiryDays;
  if (member.forceReset || expired) {
    const resetToken = crypto.randomBytes(24).toString('hex');
    await store.updateMember(member.id, { resetToken, resetExpires: Date.now() + 60 * 60 * 1000 });
    const reason = member.forceReset ? 'An administrator requires you to set a new password.' : 'Your password has expired. Please set a new one.';
    return res.json({ passwordResetRequired: true, resetUrl: `/reset?token=${resetToken}`, reason });
  }

  if (member.mfaEnabled) return res.json({ mfaRequired: true, mfaToken: issueMfaToken(member.id, 'mfa') });
  if (policy.requireMfa) return res.json({ mfaEnrollRequired: true, setupToken: issueMfaToken(member.id, 'mfa-setup') });
  const tok = issueMemberToken(member);
  const csrf = startSession(req, res, 'os_token', tok);
  res.json({ token: tok, csrf });
});

app.post('/api/logout', (req, res) => { clearSession(res, 'os_token'); res.json({ ok: true }); });

// Second step of login: a TOTP code or a recovery code.
app.post('/api/login/mfa', loginLimiter, async (req, res) => {
  const { mfaToken, code } = req.body || {};
  const tok = verifyToken(mfaToken);
  if (!tok || tok.scope !== 'mfa' || !tok.memberId) return res.status(401).json({ error: 'This sign in step has expired. Please start again.' });
  const member = await store.getMemberById(tok.memberId);
  if (!member || !member.mfaEnabled) return res.status(401).json({ error: 'Two factor is not set up.' });
  const clean = String(code || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  let ok = verifyTotp(member.mfaSecret, code);
  if (!ok && Array.isArray(member.mfaRecovery)) {
    const idx = member.mfaRecovery.findIndex(h => checkPassword(clean, h));
    if (idx >= 0) { const left = member.mfaRecovery.slice(); left.splice(idx, 1); await store.updateMember(member.id, { mfaRecovery: left }); ok = true; }
  }
  if (!ok) return res.status(401).json({ error: 'That code is not valid.' });
  const session = issueMemberToken(member);
  const csrf = startSession(req, res, 'os_token', session);
  res.json({ token: session, csrf });
});

// Start enrolment: returns a secret and a QR to scan. Works with a session or a forced-enrol setup token.
app.post('/api/me/mfa/setup', requireMemberOrSetup, async (req, res) => {
  const secret = newMfaSecret();
  await store.updateMember(req.member.id, { mfaPending: secret });
  res.json({ secret, qr: await mfaQrDataUrl(secret, req.member.email) });
});

// Confirm a code to turn 2FA on; returns one-time recovery codes (and a session if this was forced enrolment).
app.post('/api/me/mfa/enable', requireMemberOrSetup, async (req, res) => {
  const m = await store.getMemberById(req.member.id);
  if (!m.mfaPending || !verifyTotp(m.mfaPending, req.body?.code)) return res.status(400).json({ error: 'That code is not valid. Try again.' });
  const recovery = newRecoveryCodes(8);
  await store.updateMember(m.id, { mfaSecret: m.mfaPending, mfaEnabled: true, mfaPending: null, mfaRecovery: recovery.map(c => hashPassword(c.replace(/[^a-z0-9]/gi, '').toLowerCase())) });
  const fresh = await store.getMemberById(m.id);
  const tok = issueMemberToken(fresh);
  const csrf = startSession(req, res, 'os_token', tok);
  res.json({ ok: true, recovery, token: tok, csrf });
});

// Turn 2FA off (requires a valid current code).
app.post('/api/me/mfa/disable', requireMember, async (req, res) => {
  if (!req.member.mfaEnabled) return res.json({ ok: true });
  if (!verifyTotp(req.member.mfaSecret, req.body?.code)) return res.status(400).json({ error: 'Enter a current code to turn off two factor.' });
  await store.updateMember(req.member.id, { mfaEnabled: false, mfaSecret: null, mfaPending: null, mfaRecovery: [] });
  res.json({ ok: true });
});

// Forgot password: always responds the same way so it cannot reveal who has an account.
app.post('/api/forgot', forgotLimiter, async (req, res) => {
  const email = String((req.body?.email) ?? '');
  const member = email && await store.getMemberByEmail(email);
  if (member) {
    const resetToken = crypto.randomBytes(24).toString('hex');
    await store.updateMember(member.id, { resetToken, resetExpires: Date.now() + 60 * 60 * 1000 });
    const resetUrl = `${baseUrl(req)}/reset?token=${resetToken}`;
    sendTemplate('passwordReset', member.email, { name: member.name || 'there', resetUrl });
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link has been sent.' });
});

// Set a password from a reset token (forgot-password flow).
app.post('/api/reset', async (req, res) => {
  const token = String((req.body?.token) ?? ''), password = req.body?.password;
  if (!token || !password) return res.status(400).json({ error: 'A token and a password are required.' });
  const perr = await passwordError(password); if (perr) return res.status(400).json({ error: perr });
  const found = await store.getMemberByReset(token);
  if (!found || !found.resetExpires || found.resetExpires < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  await store.updateMember(found.id, { passwordHash: hashPassword(password), status: 'active', resetToken: null, resetExpires: null, passwordChangedAt: new Date().toISOString(), forceReset: false, lockedUntil: null, failedAttempts: 0, lastReminderThreshold: 0 });
  res.json({ ok: true });
});

// Change password while signed in.
app.post('/api/me/password', requireMember, async (req, res) => {
  const { current, next } = req.body || {};
  const perr = await passwordError(next); if (perr) return res.status(400).json({ error: perr });
  if (!checkPassword(current || '', req.member.passwordHash || '')) return res.status(401).json({ error: 'Your current password is incorrect.' });
  await store.updateMember(req.member.id, { passwordHash: hashPassword(next), passwordChangedAt: new Date().toISOString(), forceReset: false, lastReminderThreshold: 0 });
  res.json({ ok: true });
});

// Accept a team invite: set your name + password.
app.post('/api/join', async (req, res) => {
  const token = String((req.body?.token) ?? ''), name = req.body?.name, password = req.body?.password;
  const member = await store.getMemberByInvite(token);
  if (!member) return res.status(404).json({ error: 'This invite is invalid or has already been used.' });
  const perr = await passwordError(password); if (perr) return res.status(400).json({ error: perr });
  await store.updateMember(member.id, { name: name || member.name, passwordHash: hashPassword(password), status: 'active', inviteToken: null, passwordChangedAt: new Date().toISOString(), forceReset: false, lockedUntil: null, failedAttempts: 0, lastReminderThreshold: 0 });
  const fresh = await store.getMemberById(member.id);
  const tok = issueMemberToken(fresh);
  const csrf = startSession(req, res, 'os_token', tok);
  res.json({ ok: true, token: tok, csrf });
});

app.get('/api/invite/:token', async (req, res) => {
  const m = await store.getMemberByInvite(req.params.token);
  if (!m) return res.status(404).json({ error: 'Invalid invite.' });
  const a = await store.getAccountById(m.accountId);
  res.json({ orgName: a?.name || '', email: m.email });
});

// ================= MEMBER (self) =================

app.get('/api/me', requireMember, async (req, res) => {
  const m = req.member, a = req.account;
  const [eventTypes, bookings] = await Promise.all([store.listEventTypesByMember(m.id), store.listBookingsByMember(m.id)]);
  const out = {
    member: { id: m.id, name: m.name, email: m.email, slug: m.slug, role: m.role, availability: m.availability, blockedDates: m.blockedDates || [], mfaEnabled: !!m.mfaEnabled, bio: m.bio || '', title: m.title || '', imageUrl: m.imageUrl || '', timezone: m.timezone || '' },
    account: { slug: a.slug, name: a.name, status: a.status, reviewNote: a.reviewNote, brandColor: a.brandColor, timezone: a.timezone, memberSelfManage: a.memberSelfManage, website: a.website, bookingPage: a.bookingPage || {} },
    canManageOwnEvents: canManageOwnEvents(m, a),
    eventTypes,
    bookings: bookings.sort((x, y) => new Date(y.start) - new Date(x.start)),
    bookingUrl: `${baseUrl(req)}/book/${a.slug}/${m.slug}`,
    emailEnabled: emailEnabled()
  };
  if (m.role === 'admin') {
    const members = await store.listMembers(a.id);
    out.members = members.map(x => ({ id: x.id, name: x.name, email: x.email, slug: x.slug, role: x.role, status: x.status, inviteToken: x.inviteToken || null, locked: !!(x.lockedUntil && new Date(x.lockedUntil).getTime() > Date.now()), bio: x.bio || '', title: x.title || '', imageUrl: x.imageUrl || '' }));
    out.services = await store.listServices(a.id);
  }
  res.json(out);
});

app.put('/api/me/availability', requireMember, async (req, res) => {
  const patch = { availability: req.body.availability || req.member.availability };
  if (Array.isArray(req.body.blockedDates)) patch.blockedDates = req.body.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 400);
  await store.updateMember(req.member.id, patch);
  res.json({ ok: true });
});

app.put('/api/me/profile', requireMember, async (req, res) => {
  const patch = {};
  if (typeof req.body.name === 'string') patch.name = req.body.name;
  // v2 coach profile fields (shown on service booking pages).
  if (typeof req.body.bio === 'string') patch.bio = req.body.bio.slice(0, 1000);
  if (typeof req.body.title === 'string') patch.title = req.body.title.slice(0, 120);
  if (typeof req.body.imageUrl === 'string') patch.imageUrl = cleanImageUrl(req.body.imageUrl);
  if (typeof req.body.timezone === 'string') patch.timezone = cleanTimezone(req.body.timezone);
  await store.updateMember(req.member.id, patch); res.json({ ok: true });
});

app.post('/api/me/event-types', requireMember, async (req, res) => {
  if (!canManageOwnEvents(req.member, req.account)) return res.status(403).json({ error: 'Your organisation has set meeting types to be admin-managed.' });
  const { title, durationMins, description, location, customLocation } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required.' });
  let slug = slugify(title) || 'event';
  const existing = await store.listEventTypesByMember(req.member.id);
  while (existing.some(e => e.slug === slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  const ev = await store.createEventType(req.account.id, req.member.id, { title, slug, durationMins: Number(durationMins) || 30, description: description || '', location: location || 'jitsi', customLocation: customLocation || '' });
  res.json({ ok: true, eventType: ev });
});

app.delete('/api/me/event-types/:id', requireMember, async (req, res) => {
  if (!canManageOwnEvents(req.member, req.account)) return res.status(403).json({ error: 'Admin-managed meeting types.' });
  await store.deleteEventType(req.member.id, req.params.id); res.json({ ok: true });
});

app.delete('/api/me/bookings/:id', requireMember, async (req, res) => {
  const b = await store.getBookingById(req.params.id);
  await store.cancelBooking(req.member.id, req.params.id);
  if (b && b.memberId === req.member.id) {
    await store.updateBooking(b.id, { cancelledBy: req.member.email, cancelledByRole: req.member.role, cancelledAt: new Date().toISOString() });
    notifyBookingChange(req, b, 'cancelled'); notifyWaitlistOpening(req, b);
  }
  res.json({ ok: true });
});

// Notify the person who booked when a booking is cancelled or moved.
function fmtWhen(tz, date) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz || 'Etc/UTC', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(date));
}
async function notifyBookingChange(req, booking, kind, opts = {}) {
  if (!emailEnabled() || !booking?.email) return;
  const acc = await store.getAccountById(booking.accountId);
  const tz = acc?.timezone;
  if (kind === 'cancelled') {
    sendEmail({ to: booking.email, subject: `Your ${booking.title} booking has been cancelled`,
      html: `<p>Hi ${booking.name || 'there'},</p><p>Your ${booking.title} with ${booking.memberName} on ${fmtWhen(tz, booking.start)} has been cancelled.</p>${opts.note ? `<p>${opts.note}</p>` : ''}<p>You can book another time on the booking page.</p>` });
  } else if (kind === 'rescheduled') {
    const ics = buildICS({ ...booking, ownerName: booking.memberName || 'Enjeeoh', ownerEmail: '' });
    sendEmail({ to: booking.email, subject: `Your ${booking.title} booking has moved`,
      html: `<p>Hi ${booking.name || 'there'},</p><p>Your ${booking.title} with ${booking.memberName} has been moved.</p><p>New time: <b>${fmtWhen(tz, booking.start)}</b>.</p><p>${booking.locationText || ''}</p>`, ics });
  }
}

// Admin or manager cancels any booking in their organisation.
app.post('/api/org/bookings/:id/cancel', requireMember, requireOrgManager, async (req, res) => {
  const b = await store.getBookingById(req.params.id);
  if (!b || b.accountId !== req.account.id) return res.status(404).json({ error: 'Booking not found.' });
  await store.updateBooking(b.id, { status: 'cancelled', cancelledBy: req.member.email, cancelledByRole: req.member.role, cancelledAt: new Date().toISOString(), cancelNote: req.body?.note || '' });
  await notifyBookingChange(req, b, 'cancelled', { note: req.body?.note });
  notifyWaitlistOpening(req, b);
  await audit(req, 'booking.cancelled', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: `${b.title} for ${b.email}` });
  res.json({ ok: true });
});

// Admin or manager reschedules a booking; the booker is emailed the new time.
app.post('/api/org/bookings/:id/reschedule', requireMember, requireOrgManager, async (req, res) => {
  const { start } = req.body || {};
  const b = await store.getBookingById(req.params.id);
  if (!b || b.accountId !== req.account.id) return res.status(404).json({ error: 'Booking not found.' });
  const startDate = new Date(start); if (isNaN(startDate)) return res.status(400).json({ error: 'Invalid time.' });
  if (startDate.getTime() < Date.now()) return res.status(400).json({ error: 'Please choose a time in the future.' });
  const durationMs = new Date(b.end) - new Date(b.start);
  const endDate = new Date(startDate.getTime() + durationMs);
  if (await store.findClash(b.memberId, b.eventTypeId, startDate.getTime(), endDate.getTime())) return res.status(409).json({ error: 'That time is already taken.' });
  const updated = await store.updateBooking(b.id, { start: startDate.toISOString(), end: endDate.toISOString(), status: 'confirmed', rescheduledBy: req.member.email, rescheduledByRole: req.member.role, rescheduledAt: new Date().toISOString(), rescheduleCount: (b.rescheduleCount || 0) + 1 });
  await notifyBookingChange(req, updated, 'rescheduled');
  await audit(req, 'booking.rescheduled', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: `${b.title} for ${b.email}` });
  res.json({ ok: true, start: startDate.toISOString(), end: endDate.toISOString() });
});

// Ask the person who booked to pick a new time themselves (emails them the manage link).
app.post('/api/org/bookings/:id/request-reschedule', requireMember, requireOrgManager, async (req, res) => {
  const b = await store.getBookingById(req.params.id);
  if (!b || b.accountId !== req.account.id) return res.status(404).json({ error: 'Booking not found.' });
  if (!b.manageToken) return res.status(400).json({ error: 'This booking has no self-manage link.' });
  const link = `${baseUrl(req)}/manage/${b.id}/${b.manageToken}`;
  const note = String(req.body?.note || '').slice(0, 500);
  if (emailEnabled() && b.email) sendEmail({ to: b.email, subject: `Please pick a new time for your ${b.title}`, html: `<p>Hi ${b.name || 'there'},</p><p>${req.member.name} at ${req.account.name} has asked if you could choose a new time for your <b>${b.title}</b>.</p>${note ? `<p>${note}</p>` : ''}<p><a href="${link}">Reschedule or cancel your booking</a>.</p>` });
  await audit(req, 'booking.reschedule-requested', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: `${b.title} for ${b.email}` });
  res.json({ ok: true, emailed: emailEnabled() });
});

// ================= BOOKINGS REPORT =================
// A row per booking with status and who acted (cancelled/rescheduled).
function reportRow(b) {
  return {
    id: b.id, service: b.serviceName || b.title || '', member: b.memberName || '', bookerName: b.name || '', bookerEmail: b.email || '',
    start: b.start, end: b.end, status: b.status, createdAt: b.createdAt || '',
    cancelledBy: b.cancelledBy || '', cancelledByRole: b.cancelledByRole || '', cancelledAt: b.cancelledAt || '', cancelNote: b.cancelNote || '',
    rescheduledBy: b.rescheduledBy || '', rescheduledByRole: b.rescheduledByRole || '', rescheduledAt: b.rescheduledAt || '', rescheduleCount: b.rescheduleCount || 0
  };
}
function reportSummary(rows) {
  const now = Date.now();
  const future = b => new Date(b.start).getTime() > now;
  return {
    total: rows.length,
    upcoming: rows.filter(b => b.status !== 'cancelled' && future(b)).length,
    completed: rows.filter(b => b.status !== 'cancelled' && !future(b)).length,
    cancelled: rows.filter(b => b.status === 'cancelled').length,
    rescheduled: rows.filter(b => (b.rescheduleCount || 0) > 0).length
  };
}
app.get('/api/org/report', requireMember, requireOrgManager, async (req, res) => {
  const rows = (await store.listBookingsByAccount(req.account.id)).map(reportRow).sort((a, b) => new Date(b.start) - new Date(a.start));
  res.json({ summary: reportSummary(rows), bookings: rows, timezone: req.account.timezone });
});
app.get('/api/console/report', requireSuperAdmin, async (_req, res) => {
  const [bookings, accounts] = await Promise.all([store.listAllBookings(), store.listAllAccounts()]);
  const byId = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const rows = bookings.map(b => ({ ...reportRow(b), org: byId[b.accountId] || '(unknown)' })).sort((a, b) => new Date(b.start) - new Date(a.start));
  res.json({ summary: reportSummary(rows), bookings: rows });
});

// ================= ORG ADMIN =================

// Editable wording for an org's public booking page. Stored as plain strings and
// rendered as text on the booking page (no HTML), so it is no-code and XSS-safe.
const BOOKING_PAGE_FIELDS = ['headline', 'welcome', 'servicePrompt', 'teamPrompt', 'dayPrompt', 'timesLabel', 'confirmButton', 'thankYouHeading', 'thankYouNote'];
function cleanBookingPage(input) {
  const out = {};
  for (const k of BOOKING_PAGE_FIELDS) if (typeof input?.[k] === 'string') out[k] = input[k].slice(0, k === 'welcome' || k === 'thankYouNote' ? 600 : 120);
  return out;
}

app.put('/api/org/settings', requireMember, requireOrgAdmin, async (req, res) => {
  const allowed = ['name', 'brandColor', 'timezone', 'branding', 'website', 'memberSelfManage', 'customDomain'];
  const patch = {}; for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if (req.body && typeof req.body.bookingPage === 'object') patch.bookingPage = cleanBookingPage(req.body.bookingPage);
  const a = await store.updateAccount(req.account.id, patch);
  res.json({ ok: true, account: { name: a.name, brandColor: a.brandColor, timezone: a.timezone, memberSelfManage: a.memberSelfManage } });
});

app.post('/api/org/members/invite', requireMember, requireOrgManager, async (req, res) => {
  const { name, role } = req.body || {};
  const email = String((req.body?.email) ?? '');
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (await store.getMemberByEmail(email)) return res.status(409).json({ error: 'That email already belongs to a member.' });
  const limits = (await store.getPage('limits')) || {};
  const orgCap = req.account.maxMembers > 0 ? req.account.maxMembers : 0;
  if (orgCap && (await store.countMembers(req.account.id)) >= orgCap) return res.status(403).json({ error: `This organisation has reached its limit of ${orgCap} members.` });
  if (limits.globalMax > 0 && (await store.countAllMembers()) >= limits.globalMax) return res.status(403).json({ error: 'The platform is at capacity.' });
  const inviteToken = crypto.randomBytes(16).toString('hex');
  const member = await store.createMember(req.account.id, {
    name: name || email.split('@')[0], email, passwordHash: '', role: ['admin','manager','member'].includes(role) ? role : 'member',
    status: 'invited', inviteToken, slug: await uniqueMemberSlug(req.account.id, name || email.split('@')[0])
  });
  const inviteUrl = `${baseUrl(req)}/join?token=${inviteToken}`;
  sendTemplate('memberInvite', email, { orgName: req.account.name, inviterName: req.member.name, inviteUrl });
  await audit(req, 'member.invited', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: email });
  res.json({ ok: true, member: { id: member.id, name: member.name, email, status: 'invited' }, inviteUrl });
});

app.delete('/api/org/members/:id', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!target || target.accountId !== req.account.id) return res.status(404).json({ error: 'Member not found.' });
  if (target.id === req.member.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
  await store.deleteMember(target.id);
  sendTemplate('memberRemoved', target.email, { name: target.name || 'there', orgName: req.account.name });
  await audit(req, 'member.removed', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: target.email });
  res.json({ ok: true });
});

// An org admin or manager unlocks a locked member. Admins cannot be unlocked this
// way (they must contact the super admin), matching the lock message.
app.post('/api/org/members/:id/unlock', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!target || target.accountId !== req.account.id) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'admin') return res.status(403).json({ error: 'Admins are unlocked by the platform super admin, not within the organisation.' });
  await store.updateMember(target.id, { lockedUntil: null, failedAttempts: 0 });
  await audit(req, 'member.unlocked', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: target.email });
  res.json({ ok: true });
});

// ===== v2: SERVICES (multi-coach offerings) =====
const ASSIGN_MODES = ['choose', 'auto', 'roundrobin'];
const INTAKE_TYPES = ['text', 'textarea', 'select'];
// Normalise the intake questions a service asks each booker. Each gets a stable id.
function cleanIntake(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(q => q && typeof q.label === 'string' && q.label.trim()).slice(0, 12).map((q, i) => ({
    id: 'q' + i,
    label: String(q.label).slice(0, 200),
    type: INTAKE_TYPES.includes(q.type) ? q.type : 'text',
    required: !!q.required,
    options: Array.isArray(q.options) ? q.options.map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, 20) : []
  }));
}
function serviceFromBody(b, members) {
  const valid = new Set(members.map(m => m.id));
  return {
    name: String(b.name || '').slice(0, 120),
    description: String(b.description || '').slice(0, 2000),
    intro: String(b.intro || '').slice(0, 4000),
    durationMins: Math.max(5, Math.min(480, parseInt(b.durationMins, 10) || 30)),
    location: ['jitsi', 'phone', 'inperson', 'custom'].includes(b.location) ? b.location : 'jitsi',
    customLocation: String(b.customLocation || '').slice(0, 200),
    imageUrl: cleanImageUrl(b.imageUrl),
    memberIds: Array.isArray(b.memberIds) ? b.memberIds.filter(id => valid.has(id)).slice(0, 100) : [],
    assignMode: ASSIGN_MODES.includes(b.assignMode) ? b.assignMode : 'choose',
    active: b.active !== false,
    // capacity 1 = a private 1:1 session; >1 = a group session with that many seats.
    capacity: Math.max(1, Math.min(500, parseInt(b.capacity, 10) || 1)),
    intakeQuestions: cleanIntake(b.intakeQuestions),
    waitlistEnabled: b.waitlistEnabled !== false,
    showCoaches: b.showCoaches !== false,
    // When on, a person cannot book this service again while they have an upcoming one.
    oneActivePerEmail: !!b.oneActivePerEmail
  };
}
// Shape a service for the org dashboard, with its coaches resolved.
async function serviceForAdmin(s, membersById) {
  return { ...s, coaches: (s.memberIds || []).map(id => membersById[id]).filter(Boolean).map(m => ({ id: m.id, name: m.name, slug: m.slug, imageUrl: m.imageUrl || '', title: m.title || '' })) };
}

app.get('/api/org/services', requireMember, async (req, res) => {
  const [services, members] = await Promise.all([store.listServices(req.account.id), store.listMembers(req.account.id)]);
  const byId = Object.fromEntries(members.map(m => [m.id, m]));
  res.json(await Promise.all(services.map(s => serviceForAdmin(s, byId))));
});

app.post('/api/org/services', requireMember, requireOrgManager, async (req, res) => {
  const members = await store.listMembers(req.account.id);
  const fields = serviceFromBody(req.body || {}, members);
  if (!fields.name) return res.status(400).json({ error: 'A service name is required.' });
  let slug = slugify(fields.name) || 'service';
  while (await store.getServiceBySlug(req.account.id, slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  const svc = await store.createService(req.account.id, { ...fields, slug });
  await audit(req, 'service.created', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: fields.name });
  res.json({ ok: true, service: svc });
});

app.put('/api/org/services/:id', requireMember, requireOrgManager, async (req, res) => {
  const svc = await store.getServiceById(req.params.id);
  if (!svc || svc.accountId !== req.account.id) return res.status(404).json({ error: 'Service not found.' });
  const members = await store.listMembers(req.account.id);
  const fields = serviceFromBody({ ...svc, ...req.body }, members);
  const updated = await store.updateService(svc.id, fields);
  await audit(req, 'service.updated', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: fields.name });
  res.json({ ok: true, service: updated });
});

app.delete('/api/org/services/:id', requireMember, requireOrgManager, async (req, res) => {
  const svc = await store.getServiceById(req.params.id);
  if (!svc || svc.accountId !== req.account.id) return res.status(404).json({ error: 'Service not found.' });
  await store.deleteService(svc.id);
  await audit(req, 'service.deleted', { accountId: req.account.id, accountName: req.account.name, actor: req.member.email, actorRole: req.member.role, text: svc.name });
  res.json({ ok: true });
});

// An admin sets a coach's public profile (photo, title, bio).
app.put('/api/org/members/:id/profile', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!target || target.accountId !== req.account.id) return res.status(404).json({ error: 'Member not found.' });
  const patch = {};
  if (typeof req.body.bio === 'string') patch.bio = req.body.bio.slice(0, 1000);
  if (typeof req.body.title === 'string') patch.title = req.body.title.slice(0, 120);
  if (typeof req.body.imageUrl === 'string') patch.imageUrl = cleanImageUrl(req.body.imageUrl);
  if (typeof req.body.timezone === 'string') patch.timezone = cleanTimezone(req.body.timezone);
  await store.updateMember(target.id, patch);
  res.json({ ok: true });
});

// Admin manages a specific member's availability or event types (admin-controlled mode).
function ensureSameOrg(req, target) { return target && target.accountId === req.account.id; }

app.put('/api/org/members/:id/availability', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!ensureSameOrg(req, target)) return res.status(404).json({ error: 'Member not found.' });
  const patch = { availability: req.body.availability || target.availability };
  if (Array.isArray(req.body.blockedDates)) patch.blockedDates = req.body.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 400);
  await store.updateMember(target.id, patch); res.json({ ok: true });
});

app.get('/api/org/members/:id/event-types', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!ensureSameOrg(req, target)) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member: { id: target.id, name: target.name, availability: target.availability }, eventTypes: await store.listEventTypesByMember(target.id) });
});

app.post('/api/org/members/:id/event-types', requireMember, requireOrgManager, async (req, res) => {
  const target = await store.getMemberById(req.params.id);
  if (!ensureSameOrg(req, target)) return res.status(404).json({ error: 'Member not found.' });
  const { title, durationMins, description, location, customLocation } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required.' });
  let slug = slugify(title) || 'event';
  const existing = await store.listEventTypesByMember(target.id);
  while (existing.some(e => e.slug === slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  const ev = await store.createEventType(req.account.id, target.id, { title, slug, durationMins: Number(durationMins) || 30, description: description || '', location: location || 'jitsi', customLocation: customLocation || '' });
  res.json({ ok: true, eventType: ev });
});

app.delete('/api/org/members/:mid/event-types/:eid', requireMember, requireOrgAdmin, async (req, res) => {
  const target = await store.getMemberById(req.params.mid);
  if (!ensureSameOrg(req, target)) return res.status(404).json({ error: 'Member not found.' });
  await store.deleteEventType(target.id, req.params.eid); res.json({ ok: true });
});

// ================= PUBLIC BOOKING (per member) =================

async function approvedAccount(slug, res) {
  const a = await store.getAccountBySlug(slug);
  if (!a || a.deleted) { res.status(404).json({ error: 'Organisation not found.' }); return null; }
  if (a.suspended) { res.status(403).json({ error: 'This organisation is not currently available.' }); return null; }
  if (a.status !== 'approved') { res.status(403).json({ error: 'This organisation is not active yet.' }); return null; }
  return a;
}

app.get('/api/biz/:slug/config', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const hasServices = (await store.listServices(a.id)).some(s => s.active && (s.memberIds || []).length);
  res.json({ orgName: a.name, brandColor: a.brandColor, showBranding: a.branding, timezone: a.timezone, hasServices, bookingPage: a.bookingPage || {} });
});

// list the team for an org
app.get('/api/biz/:slug/members', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const members = (await store.listMembers(a.id)).filter(m => m.status === 'active');
  res.json(members.map(m => ({ name: m.name, slug: m.slug, role: m.role })));
});

app.get('/api/biz/:slug/m/:mslug/event-types', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const m = await store.getMemberBySlug(a.id, req.params.mslug);
  if (!m || m.status !== 'active') return res.status(404).json({ error: 'Member not found.' });
  const evs = await store.listEventTypesByMember(m.id);
  res.json({ member: { name: m.name }, eventTypes: evs.map(e => ({ title: e.title, slug: e.slug, durationMins: e.durationMins, description: e.description })) });
});

app.get('/api/biz/:slug/m/:mslug/slots/:evslug', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const m = await store.getMemberBySlug(a.id, req.params.mslug);
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  const ev = await store.getEventType(m.id, req.params.evslug);
  if (!ev) return res.status(404).json({ error: 'Event type not found.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) return res.status(400).json({ error: 'Pass ?date=YYYY-MM-DD' });
  const bookings = await store.listBookingsByMember(m.id);
  const bookedRanges = bookings.filter(b => b.eventTypeId === ev.id && b.status !== 'cancelled');
  const blocked = Array.isArray(m.blockedDates) && m.blockedDates.includes(req.query.date);
  const tz = m.timezone || a.timezone;
  const slots = blocked ? [] : slotsForDate({ dateStr: req.query.date, durationMins: ev.durationMins, timeZone: tz, availability: m.availability, bookedRanges }).map(s => ({ ...s, label: labelTime(s.start, tz) }));
  res.json({ event: { title: ev.title, durationMins: ev.durationMins }, member: { name: m.name }, timezone: tz, slots });
});

app.post('/api/biz/:slug/m/:mslug/bookings', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const m = await store.getMemberBySlug(a.id, req.params.mslug);
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  const { evslug, start, name, email, notes } = req.body || {};
  const ev = await store.getEventType(m.id, evslug);
  if (!ev) return res.status(404).json({ error: 'Event type not found.' });
  if (!start || !name || !email) return res.status(400).json({ error: 'Name, email and a time are required.' });
  const startDate = new Date(start); if (isNaN(startDate)) return res.status(400).json({ error: 'Invalid time.' });
  const endDate = new Date(startDate.getTime() + ev.durationMins * 60000);
  if (await store.findClash(m.id, ev.id, startDate.getTime(), endDate.getTime())) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.' });

  const tmpId = crypto.randomBytes(6).toString('hex');
  const jitsiUrl = `https://${JITSI_DOMAIN}/enjeeoh-${a.slug}-${tmpId}` + (JITSI_E2EE ? '#config.e2ee.enabled=true&config.disableAudioLevels=true' : '');
  const locText = locationText(ev, jitsiUrl);
  const booking = await store.createBooking(a.id, m.id, { eventTypeId: ev.id, title: ev.title, description: ev.description, memberName: m.name, name, email, phone: String(req.body?.phone || '').slice(0, 40), notes: notes || '', manageToken: crypto.randomBytes(16).toString('hex'), start: startDate.toISOString(), end: endDate.toISOString(), locationText: locText });
  const ics = buildICS({ ...booking, ownerName: m.name, ownerEmail: m.email });
  const when = new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(startDate);
  const manageUrl = `${baseUrl(req)}/manage/${booking.id}/${booking.manageToken}`;
  if (emailEnabled()) {
    sendEmail({ to: email, subject: `Confirmed: ${ev.title} with ${m.name} on ${when}`, html: `<p>Hi ${name},</p><p>Your <b>${ev.title}</b> with ${m.name} at ${a.name} is booked for <b>${when}</b>.</p><p>Location: ${locText}</p><p>Need to change it? <a href="${manageUrl}">Reschedule or cancel</a>.</p>`, ics });
    if (m.email) sendEmail({ to: m.email, subject: `New booking from ${name} on ${when}`, html: `<p>${name} (${email}) booked ${ev.title} for ${when}.</p><p>${locText}</p>`, ics });
  }
  res.json({ ok: true, booking: { id: booking.id, title: ev.title, when, locationText: locText, memberName: m.name }, manageUrl, addToCalendar: { google: googleCalLink({ ...booking, locationText: locText }), outlook: outlookLink({ ...booking, locationText: locText }), ics: `/api/bookings/${booking.id}/ics` } });
});

app.get('/api/bookings/:id/ics', async (req, res) => {
  const b = await store.getBookingPublic(req.params.id); if (!b) return res.status(404).send('Not found');
  const ics = buildICS({ ...b, ownerName: b.memberName || 'OpenSlot', ownerEmail: '' });
  res.setHeader('Content-Type', 'text/calendar'); res.setHeader('Content-Disposition', 'attachment; filename="invite.ics"'); res.send(ics);
});

// ================= v2: PUBLIC SERVICE BOOKING =================
// A service is staffed by several coaches. The public chooses a service, sees the
// combined availability of all its coaches, picks a time, and (optionally) a coach.
function bookingOverlaps(bookings, startMs, endMs) {
  return bookings.some(b => b.status !== 'cancelled' && startMs < new Date(b.end).getTime() && endMs > new Date(b.start).getTime());
}
async function activeCoaches(service) {
  const list = await Promise.all((service.memberIds || []).map(id => store.getMemberById(id)));
  return list.filter(m => m && m.status === 'active' && !m.suspended);
}
function coachCard(m) { return { slug: m.slug, name: m.name, title: m.title || '', bio: m.bio || '', imageUrl: m.imageUrl || '' }; }

// How many seats a coach has left for a group service at an exact start (capacity 1 = private).
function seatsLeft(service, bookings, startIso, endMs) {
  const startMs = new Date(startIso).getTime();
  if ((service.capacity || 1) <= 1) {
    return bookingOverlaps(bookings, startMs, endMs) ? 0 : 1;
  }
  // Group: a non-group booking overlapping the slot blocks the coach entirely.
  const nonGroupConflict = bookings.some(b => b.status !== 'cancelled' && !(b.serviceId === service.id && b.start === startIso) && startMs < new Date(b.end).getTime() && endMs > new Date(b.start).getTime());
  if (nonGroupConflict) return 0;
  const taken = bookings.filter(b => b.status !== 'cancelled' && b.serviceId === service.id && b.start === startIso).length;
  return Math.max(0, (service.capacity || 1) - taken);
}
// Validate & format intake answers against a service's questions.
function collectIntake(service, answers) {
  const out = [];
  for (const q of (service.intakeQuestions || [])) {
    const v = answers && typeof answers === 'object' ? String(answers[q.id] ?? '').slice(0, 2000).trim() : '';
    if (q.required && !v) return { error: `Please answer: ${q.label}` };
    if (v) out.push({ label: q.label, answer: v });
  }
  return { intake: out };
}

app.get('/api/biz/:slug/services', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const services = (await store.listServices(a.id)).filter(s => s.active && (s.memberIds || []).length);
  res.json({
    orgName: a.name, brandColor: a.brandColor, timezone: a.timezone,
    services: await Promise.all(services.map(async s => {
      const coaches = await activeCoaches(s);
      return { name: s.name, slug: s.slug, description: s.description, imageUrl: s.imageUrl || '', durationMins: s.durationMins, coachCount: coaches.length, capacity: s.capacity || 1, isGroup: (s.capacity || 1) > 1 };
    }))
  });
});

app.get('/api/biz/:slug/services/:svcSlug', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const s = await store.getServiceBySlug(a.id, req.params.svcSlug);
  if (!s || !s.active) return res.status(404).json({ error: 'Service not found.' });
  const coaches = await activeCoaches(s);
  res.json({
    service: { name: s.name, slug: s.slug, description: s.description, intro: s.intro || '', imageUrl: s.imageUrl || '', durationMins: s.durationMins, assignMode: s.assignMode, location: s.location, capacity: s.capacity || 1, isGroup: (s.capacity || 1) > 1, waitlistEnabled: s.waitlistEnabled !== false, showCoaches: s.showCoaches !== false, intakeQuestions: s.intakeQuestions || [] },
    coaches: coaches.map(coachCard), timezone: a.timezone, orgName: a.name
  });
});

app.get('/api/biz/:slug/services/:svcSlug/slots', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const s = await store.getServiceBySlug(a.id, req.params.svcSlug);
  if (!s || !s.active) return res.status(404).json({ error: 'Service not found.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) return res.status(400).json({ error: 'Pass ?date=YYYY-MM-DD' });
  const group = (s.capacity || 1) > 1;
  const coaches = await activeCoaches(s);
  const map = new Map(); // start -> { coaches:[], seats }
  for (const m of coaches) {
    if (Array.isArray(m.blockedDates) && m.blockedDates.includes(req.query.date)) continue;
    const all = (await store.listBookingsByMember(m.id)).filter(b => b.status !== 'cancelled');
    // For group services a coach's own group bookings should not hide the slot.
    const bookedRanges = group ? all.filter(b => b.serviceId !== s.id) : all;
    const slots = slotsForDate({ dateStr: req.query.date, durationMins: s.durationMins, timeZone: m.timezone || a.timezone, availability: m.availability, bookedRanges });
    for (const slot of slots) {
      const endMs = new Date(slot.start).getTime() + s.durationMins * 60000;
      const seats = seatsLeft(s, all, slot.start, endMs);
      if (seats <= 0) continue;
      if (!map.has(slot.start)) map.set(slot.start, { coaches: [], seats: 0 });
      const e = map.get(slot.start); e.coaches.push({ slug: m.slug, name: m.name, imageUrl: m.imageUrl || '', title: m.title || '', seats }); e.seats += seats;
    }
  }
  const slots = [...map.keys()].sort().map(start => ({ start, label: labelTime(start, a.timezone), coaches: map.get(start).coaches, seats: map.get(start).seats }));
  res.json({ service: { name: s.name, durationMins: s.durationMins, assignMode: s.assignMode, isGroup: group, capacity: s.capacity || 1 }, timezone: a.timezone, slots });
});

app.post('/api/biz/:slug/services/:svcSlug/bookings', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const s = await store.getServiceBySlug(a.id, req.params.svcSlug);
  if (!s || !s.active) return res.status(404).json({ error: 'Service not found.' });
  const { start, name, email, notes, coachSlug } = req.body || {};
  if (!start || !name || !email) return res.status(400).json({ error: 'Name, email and a time are required.' });
  const startDate = new Date(start); if (isNaN(startDate)) return res.status(400).json({ error: 'Invalid time.' });
  const endDate = new Date(startDate.getTime() + s.durationMins * 60000);
  const ans = collectIntake(s, req.body.intake); if (ans.error) return res.status(400).json({ error: ans.error });

  // One-active-booking rule: block a repeat booking for this service while one is upcoming.
  if (s.oneActivePerEmail) {
    const existing = (await store.listBookingsByAccount(a.id)).some(b => b.serviceId === s.id && (b.email || '').toLowerCase() === email.toLowerCase() && b.status !== 'cancelled' && new Date(b.end).getTime() > Date.now());
    if (existing) return res.status(409).json({ error: `You already have an upcoming ${s.name} booking. Please attend or cancel it before booking another.` });
  }

  // Which coaches still have a seat at this exact time?
  const coaches = await activeCoaches(s);
  const free = [];
  for (const m of coaches) {
    if (Array.isArray(m.blockedDates) && m.blockedDates.includes(start.slice(0, 10))) continue;
    const bookings = await store.listBookingsByMember(m.id);
    if (seatsLeft(s, bookings, startDate.toISOString(), endDate.getTime()) > 0) free.push(m);
  }
  if (!free.length) return res.status(409).json({ error: 'Sorry, that time is full. Please pick another time' + (s.waitlistEnabled !== false ? ', or join the waitlist.' : '.'), full: true });

  // Pick the coach: the visitor's choice if still free, else by the service's assign mode.
  let coach;
  if (coachSlug) { coach = free.find(m => m.slug === coachSlug); if (!coach) return res.status(409).json({ error: 'That coach is no longer available at this time. Please pick another.' }); }
  else if (s.assignMode === 'roundrobin') { const idx = (s.rrIndex || 0) % free.length; coach = free[idx]; await store.updateService(s.id, { rrIndex: (s.rrIndex || 0) + 1 }); }
  else coach = free[0]; // 'auto' or 'choose' without an explicit pick

  const tmpId = crypto.randomBytes(6).toString('hex');
  const jitsiUrl = `https://${JITSI_DOMAIN}/enjeeoh-${a.slug}-${tmpId}` + (JITSI_E2EE ? '#config.e2ee.enabled=true&config.disableAudioLevels=true' : '');
  const locText = (function () { switch (s.location) { case 'jitsi': return jitsiUrl; case 'phone': return 'Phone call'; case 'inperson': return s.customLocation || 'In person'; default: return s.customLocation || ''; } })();
  const booking = await store.createBooking(a.id, coach.id, {
    serviceId: s.id, serviceName: s.name, title: s.name, description: s.description, memberName: coach.name,
    name, email, phone: String(req.body?.phone || '').slice(0, 40), notes: notes || '', intake: ans.intake, manageToken: crypto.randomBytes(16).toString('hex'),
    start: startDate.toISOString(), end: endDate.toISOString(), locationText: locText
  });
  const ics = buildICS({ ...booking, ownerName: coach.name, ownerEmail: coach.email });
  const when = new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(startDate);
  const manageUrl = `${baseUrl(req)}/manage/${booking.id}/${booking.manageToken}`;
  const intakeHtml = (ans.intake || []).map(x => `<li><b>${x.label}:</b> ${x.answer}</li>`).join('');
  if (emailEnabled()) {
    sendEmail({ to: email, subject: `Confirmed: ${s.name} with ${coach.name} on ${when}`, html: `<p>Hi ${name},</p><p>Your <b>${s.name}</b> with ${coach.name} at ${a.name} is booked for <b>${when}</b>.</p><p>Location: ${locText}</p><p>Need to change it? <a href="${manageUrl}">Reschedule or cancel</a>.</p>`, ics });
    if (coach.email) sendEmail({ to: coach.email, subject: `New ${s.name} booking from ${name} on ${when}`, html: `<p>${name} (${email}) booked ${s.name} with you for ${when}.</p><p>${locText}</p>${notes ? `<p>Note: ${notes}</p>` : ''}${intakeHtml ? `<p>Intake answers:</p><ul>${intakeHtml}</ul>` : ''}` });
  }
  res.json({ ok: true, booking: { id: booking.id, title: s.name, when, locationText: locText, memberName: coach.name }, manageUrl, addToCalendar: { google: googleCalLink({ ...booking, locationText: locText }), outlook: outlookLink({ ...booking, locationText: locText }), ics: `/api/bookings/${booking.id}/ics` } });
});

// ----- Waitlist: join when full, get notified when a seat opens -----
app.post('/api/biz/:slug/services/:svcSlug/waitlist', async (req, res) => {
  const a = await approvedAccount(req.params.slug, res); if (!a) return;
  const s = await store.getServiceBySlug(a.id, req.params.svcSlug);
  if (!s || !s.active || s.waitlistEnabled === false) return res.status(404).json({ error: 'Waitlist not available.' });
  const name = String(req.body?.name || '').slice(0, 120), email = String(req.body?.email || '').slice(0, 200);
  const date = String(req.body?.date || '').slice(0, 10);
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  await store.addWaitlist({ accountId: a.id, serviceId: s.id, serviceName: s.name, name, email, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null });
  res.json({ ok: true, message: "You're on the waitlist. We'll email you if a spot opens up." });
});

// ----- Self-service manage: cancel/reschedule from the link in the booking email -----
async function loadManaged(req, res) {
  const b = await store.getBookingById(req.params.id);
  if (!b || !b.manageToken || b.manageToken !== req.params.token) { res.status(404).json({ error: 'This link is invalid or has expired.' }); return null; }
  return b;
}
app.get('/api/manage/:id/:token', async (req, res) => {
  const b = await loadManaged(req, res); if (!b) return;
  const a = await store.getAccountById(b.accountId);
  const when = a ? new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(b.start)) : b.start;
  res.json({ title: b.serviceName || b.title, memberName: b.memberName, when, start: b.start, locationText: b.locationText || '', status: b.status, orgSlug: a?.slug, timezone: a?.timezone, durationMins: Math.round((new Date(b.end) - new Date(b.start)) / 60000) });
});
app.post('/api/manage/:id/:token/cancel', async (req, res) => {
  const b = await loadManaged(req, res); if (!b) return;
  if (b.status === 'cancelled') return res.json({ ok: true });
  await store.updateBooking(b.id, { status: 'cancelled', cancelledBy: 'the person who booked', cancelledByRole: 'booker', cancelledAt: new Date().toISOString() });
  notifyBookingChange(req, b, 'cancelled');
  notifyWaitlistOpening(req, b);
  res.json({ ok: true });
});
app.post('/api/manage/:id/:token/reschedule', async (req, res) => {
  const b = await loadManaged(req, res); if (!b) return;
  const startDate = new Date(req.body?.start); if (isNaN(startDate)) return res.status(400).json({ error: 'Invalid time.' });
  if (startDate.getTime() < Date.now()) return res.status(400).json({ error: 'Please choose a time in the future.' });
  const durationMs = new Date(b.end) - new Date(b.start);
  const endDate = new Date(startDate.getTime() + durationMs);
  const others = (await store.listBookingsByMember(b.memberId)).filter(x => x.id !== b.id);
  if (bookingOverlaps(others, startDate.getTime(), endDate.getTime())) return res.status(409).json({ error: 'That time is no longer free. Please pick another.' });
  const updated = await store.updateBooking(b.id, { start: startDate.toISOString(), end: endDate.toISOString(), status: 'confirmed', rescheduledBy: 'the person who booked', rescheduledByRole: 'booker', rescheduledAt: new Date().toISOString(), rescheduleCount: (b.rescheduleCount || 0) + 1 });
  notifyBookingChange(req, updated, 'rescheduled');
  res.json({ ok: true, start: startDate.toISOString() });
});

// When a service booking is cancelled, tell the next person waiting for that service.
async function notifyWaitlistOpening(req, booking) {
  try {
    if (!booking || !booking.serviceId || !emailEnabled()) return;
    const list = await store.listWaitlist(booking.serviceId);
    const day = (booking.start || '').slice(0, 10);
    const next = list.find(w => !w.notified && (!w.date || w.date === day));
    if (!next) return;
    const a = await store.getAccountById(booking.accountId);
    const link = a ? `${baseUrl(req)}/book/${a.slug}` : '';
    await store.updateWaitlist(next.id, { notified: true, notifiedAt: new Date().toISOString() });
    sendEmail({ to: next.email, subject: `A spot opened for ${booking.serviceName || 'your booking'}`, html: `<p>Hi ${next.name || 'there'},</p><p>A spot has opened up for <b>${booking.serviceName || 'a service'}</b>. Book it before someone else does: <a href="${link}">${link}</a></p>` });
  } catch (e) { /* never break a cancellation because of the waitlist */ }
}

// ================= SUPER ADMIN CONSOLE =================

const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || process.env.REVIEWER_EMAIL || '';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || process.env.REVIEWER_PASSWORD || '';

// Best-effort client IP. With `trust proxy` on, req.ip already reflects the
// X-Forwarded-For chain; we fall back to the raw header and socket address.
function clientIp(req) {
  if (!req) return '';
  const fwd = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (req.ip || fwd || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

async function audit(req, action, detail = {}) {
  try {
    await store.addLog({
      actor: req?.console?.email || detail.actor || 'system',
      actorRole: req?.console?.role || detail.actorRole || 'system',
      action, accountId: detail.accountId || null, accountName: detail.accountName || null,
      detail: detail.text || '', ip: detail.ip || clientIp(req)
    });
  } catch (e) { /* logging must never break the request */ }
}

// Console login: the super admin (from env) or any platform admin (from the database).
async function consoleLogin(req, res) {
  const email = String((req.body?.email) ?? ''), password = String((req.body?.password) ?? '');
  if (SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL && password === SUPERADMIN_PASSWORD) {
    await audit(req, 'console.login', { actor: email, actorRole: 'superadmin', text: 'super admin signed in' });
    const tok = issueConsoleToken(email, 'superadmin');
    const csrf = startSession(req, res, 'os_console', tok);
    return res.json({ token: tok, role: 'superadmin', csrf });
  }
  const admin = email && await store.getPlatformAdminByEmail(email);
  if (admin && checkPassword(password || '', admin.passwordHash || '')) {
    const role = admin.role || 'onboarding';
    await audit(req, 'console.login', { actor: email, actorRole: role, text: role + ' signed in' });
    const tok = issueConsoleToken(email, role);
    const csrf = startSession(req, res, 'os_console', tok);
    return res.json({ token: tok, role, csrf });
  }
  await audit(req, 'console.login.failed', { actor: email || 'unknown', actorRole: 'console', text: 'wrong console credentials' });
  if (!SUPERADMIN_EMAIL) return res.status(400).json({ error: 'Console login is not configured. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD.' });
  res.status(401).json({ error: 'Wrong email or password.' });
}
app.post('/api/console/login', loginLimiter, consoleLogin);
app.post('/api/review/login', loginLimiter, consoleLogin); // legacy alias
// Logout just clears the cookies; forging it is harmless, so no CSRF needed.
app.post('/api/console/logout', (req, res) => { clearSession(res, 'os_console'); res.json({ ok: true }); });

app.get('/api/console/me', requireConsole, (req, res) => res.json({ email: req.console.email, role: req.console.role }));

app.get('/api/console/applications', requireConsole, requirePerm('onboarding'), async (_req, res) => {
  const all = await store.listAllAccounts();
  res.json(await Promise.all(all.map(async a => ({ id: a.id, name: a.name, slug: a.slug, email: a.email, contactName: a.contactName, country: a.country, website: a.website, registrationId: a.registrationId, mission: a.mission, status: a.status, reviewNote: a.reviewNote, createdAt: a.createdAt, maxMembers: a.maxMembers || 0, memberCount: await store.countMembers(a.id), suspended: !!a.suspended, archived: !!a.archived, deleted: !!a.deleted }))));
});
app.get('/api/review/applications', requireConsole, async (req, res) => res.redirect(307, '/api/console/applications'));

app.post('/api/console/:id/decision', requireConsole, requirePerm('onboarding'), async (req, res) => {
  const { decision, note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const a = await store.updateAccount(req.params.id, { status: decision, reviewNote: note || '', approvedAt: decision === 'approved' ? new Date().toISOString() : null });
  await audit(req, 'ngo.' + decision, { accountId: a?.id, accountName: a?.name, text: note || '' });
  if (a) {
    if (decision === 'approved') sendTemplate('orgApproved', a.email, { orgName: a.name, adminUrl: `${baseUrl(req)}/admin` });
    else sendTemplate('orgRejected', a.email, { orgName: a.name, note: note || '' });
  }
  res.json({ ok: true, status: decision });
});
app.post('/api/review/:id/decision', requireConsole, async (req, res) => res.redirect(307, '/api/console/' + req.params.id + '/decision'));

// Platform admins (super admin only).
app.get('/api/console/admins', requireConsole, async (_req, res) => {
  const admins = await store.getPlatformAdmins();
  res.json(admins.map(a => ({ id: a.id, name: a.name, email: a.email, role: a.role || 'onboarding', createdAt: a.createdAt })));
});
app.post('/api/console/admins', requireSuperAdmin, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Name and email are required.' });
  const perr = await passwordError(password); if (perr) return res.status(400).json({ error: perr });
  if (email === SUPERADMIN_EMAIL || await store.getPlatformAdminByEmail(email)) return res.status(409).json({ error: 'That email is already an admin.' });
  const role = ['onboarding', 'content'].includes(req.body?.role) ? req.body.role : 'onboarding';
  const admin = await store.addPlatformAdmin({ name: name || email.split('@')[0], email, passwordHash: hashPassword(password), role });
  await audit(req, 'admin.added', { text: email + ' as ' + role });
  res.json({ ok: true, admin: { id: admin.id, name: admin.name, email: admin.email, role } });
});
app.delete('/api/console/admins/:id', requireSuperAdmin, async (req, res) => {
  await store.removePlatformAdmin(req.params.id);
  await audit(req, 'admin.removed', { text: req.params.id });
  res.json({ ok: true });
});

// Role allocation: super admin changes a platform admin's role.
app.put('/api/console/admins/:id/role', requireSuperAdmin, async (req, res) => {
  const role = ['onboarding', 'content'].includes(req.body?.role) ? req.body.role : null;
  if (!role) return res.status(400).json({ error: 'Role must be onboarding or content.' });
  const a = await store.updatePlatformAdmin(req.params.id, { role });
  await audit(req, 'admin.role', { text: (a?.email || req.params.id) + ' -> ' + role });
  res.json({ ok: true, role });
});

// Offboarding: suspend or restore an organisation or a single member.
app.post('/api/console/org/:id/suspend', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { suspended: true });
  await audit(req, 'org.suspended', { accountId: req.params.id, accountName: a?.name, text: 'access revoked' });
  res.json({ ok: true });
});
app.post('/api/console/org/:id/restore', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { suspended: false });
  await audit(req, 'org.restored', { accountId: req.params.id, accountName: a?.name, text: 'access restored' });
  res.json({ ok: true });
});
app.get('/api/console/org/:id/members', requireSuperAdmin, async (req, res) => {
  const members = await store.listMembers(req.params.id);
  res.json(members.map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, status: m.status, suspended: !!m.suspended, locked: !!(m.lockedUntil && new Date(m.lockedUntil).getTime() > Date.now()), forceReset: !!m.forceReset })));
});

// Bulk-add members to an org. Each new member is created as "invited" and emailed
// a link to set their own password.
app.post('/api/console/org/:id/members/bulk', requireSuperAdmin, async (req, res) => {
  const a = await store.getAccountById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Organisation not found.' });
  const rows = Array.isArray(req.body?.members) ? req.body.members.slice(0, 500) : [];
  if (!rows.length) return res.status(400).json({ error: 'Add at least one member (one per line).' });
  const limits = (await store.getPage('limits')) || {};
  const orgCap = a.maxMembers > 0 ? a.maxMembers : 0;
  let added = 0; const skipped = [], errors = [], invites = [];
  for (const row of rows) {
    const email = String(row.email || '').trim().toLowerCase();
    const name = (String(row.name || '').trim()) || (email.split('@')[0] || '');
    const role = ['admin', 'manager', 'member'].includes(row.role) ? row.role : 'member';
    if (!email || !email.includes('@')) { errors.push((email || '(blank)') + ', invalid email'); continue; }
    if (await store.getMemberByEmail(email)) { skipped.push(email + ', already a member'); continue; }
    if (orgCap && (await store.countMembers(a.id)) >= orgCap) { errors.push(email + ', org is at its member limit'); continue; }
    if (limits.globalMax > 0 && (await store.countAllMembers()) >= limits.globalMax) { errors.push(email + ', platform is at capacity'); break; }
    const inviteToken = crypto.randomBytes(16).toString('hex');
    await store.createMember(a.id, { name, email, passwordHash: '', role, status: 'invited', inviteToken, slug: await uniqueMemberSlug(a.id, name) });
    sendTemplate('memberInvite', email, { orgName: a.name, inviterName: req.console.email, inviteUrl: `${baseUrl(req)}/join?token=${inviteToken}` });
    invites.push({ email, url: `${baseUrl(req)}/join?token=${inviteToken}` });
    added++;
  }
  await audit(req, 'members.bulk-added', { accountId: a.id, accountName: a.name, actor: req.console.email, text: `${added} added, ${skipped.length} skipped` });
  res.json({ ok: true, added, skipped, errors, emailed: emailEnabled(), invites });
});
app.post('/api/console/member/:id/suspend', requireSuperAdmin, async (req, res) => {
  const m = await store.updateMember(req.params.id, { suspended: true });
  await audit(req, 'member.suspended', { accountId: m?.accountId, actor: req.console.email, text: m?.email || req.params.id });
  res.json({ ok: true });
});
app.post('/api/console/member/:id/restore', requireSuperAdmin, async (req, res) => {
  const m = await store.updateMember(req.params.id, { suspended: false });
  await audit(req, 'member.restored', { accountId: m?.accountId, actor: req.console.email, text: m?.email || req.params.id });
  res.json({ ok: true });
});

// Archive (recoverable) or permanently delete an organisation.
app.post('/api/console/org/:id/archive', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { archived: true });
  await audit(req, 'org.archived', { accountId: req.params.id, accountName: a?.name });
  res.json({ ok: true });
});
app.post('/api/console/org/:id/unarchive', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { archived: false });
  await audit(req, 'org.unarchived', { accountId: req.params.id, accountName: a?.name });
  res.json({ ok: true });
});
// Soft delete: mark as deleted (blocks all access, recoverable), shown in the
// Deleted tab. Data is kept until a permanent delete.
app.post('/api/console/org/:id/soft-delete', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { deleted: true });
  await audit(req, 'org.soft-deleted', { accountId: req.params.id, accountName: a?.name, text: 'moved to Deleted (recoverable)' });
  res.json({ ok: true });
});
// Reactivate a locked or soft-deleted org, clears deleted/suspended/archived.
app.post('/api/console/org/:id/reactivate', requireSuperAdmin, async (req, res) => {
  const a = await store.updateAccount(req.params.id, { deleted: false, suspended: false, archived: false });
  await audit(req, 'org.reactivated', { accountId: req.params.id, accountName: a?.name, text: 'reactivated' });
  res.json({ ok: true });
});
app.delete('/api/console/org/:id', requireSuperAdmin, async (req, res) => {
  const a = await store.getAccountById(req.params.id);
  if (a?.email) sendTemplate('accountDeleted', a.email, { orgName: a.name });
  await store.deleteAccount(req.params.id);
  await audit(req, 'org.deleted', { accountName: a?.name, text: 'permanently removed with all data' });
  res.json({ ok: true });
});

// ---- Super admin: account unlock + forced password resets ----
app.post('/api/console/member/:id/unlock', requireSuperAdmin, async (req, res) => {
  const m = await store.updateMember(req.params.id, { lockedUntil: null, failedAttempts: 0 });
  await audit(req, 'member.unlocked', { accountId: m?.accountId, actor: req.console.email, text: m?.email || req.params.id });
  res.json({ ok: true });
});

// Require a member to set a new password before they can sign in again, and email
// them a one-hour reset link. Used for a single member or a whole organisation.
async function forcePasswordReset(req, member) {
  const resetToken = crypto.randomBytes(24).toString('hex');
  await store.updateMember(member.id, { forceReset: true, resetToken, resetExpires: Date.now() + 60 * 60 * 1000 });
  sendTemplate('forcedReset', member.email, { name: member.name || 'there', resetUrl: `${baseUrl(req)}/reset?token=${resetToken}` });
}
app.post('/api/console/member/:id/force-reset', requireSuperAdmin, async (req, res) => {
  const m = await store.getMemberById(req.params.id);
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  await forcePasswordReset(req, m);
  await audit(req, 'member.force-reset', { accountId: m.accountId, actor: req.console.email, text: m.email });
  res.json({ ok: true, emailed: emailEnabled() });
});
app.post('/api/console/org/:id/force-reset', requireSuperAdmin, async (req, res) => {
  const a = await store.getAccountById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Organisation not found.' });
  const members = (await store.listMembers(req.params.id)).filter(m => m.status === 'active');
  for (const m of members) await forcePasswordReset(req, m);
  await audit(req, 'org.force-reset', { accountId: a.id, accountName: a.name, actor: req.console.email, text: `${members.length} members` });
  res.json({ ok: true, count: members.length, emailed: emailEnabled() });
});

// Super admin: every member across all organisations, with org + lock state,
// for the console Members tab (filter, sort, export, reset, unlock all happen here).
app.get('/api/console/members', requireSuperAdmin, async (_req, res) => {
  const [members, accounts] = await Promise.all([store.listAllMembers(), store.listAllAccounts()]);
  const byId = Object.fromEntries(accounts.map(a => [a.id, a]));
  res.json(members.map(m => {
    const a = byId[m.accountId];
    return {
      id: m.id, name: m.name, email: m.email, role: m.role, status: m.status,
      accountId: m.accountId, orgName: a?.name || '(unknown)', orgSlug: a?.slug || '',
      suspended: !!m.suspended, locked: !!(m.lockedUntil && new Date(m.lockedUntil).getTime() > Date.now()),
      lockedUntil: m.lockedUntil || null, forceReset: !!m.forceReset, mfaEnabled: !!m.mfaEnabled,
      createdAt: m.createdAt || null, passwordChangedAt: m.passwordChangedAt || null,
      passwordAgeDays: m.passwordHash ? passwordAgeDays(m) : null
    };
  }));
});

// ---- Editable email templates (super admin) ----
app.get('/api/console/email-templates', requireSuperAdmin, async (_req, res) => res.json(await getEmailTemplates()));
app.put('/api/console/email-templates/:key', requireSuperAdmin, async (req, res) => {
  if (!EMAIL_TEMPLATES[req.params.key]) return res.status(404).json({ error: 'Unknown template.' });
  const all = (await store.getPage('emailTemplates')) || {};
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.slice(0, 300) : '';
  const html = typeof req.body?.html === 'string' ? req.body.html.slice(0, 20000) : '';
  all[req.params.key] = { subject, html };
  await store.setPage('emailTemplates', all);
  await audit(req, 'email-template.updated', { text: req.params.key });
  res.json({ ok: true });
});
app.delete('/api/console/email-templates/:key', requireSuperAdmin, async (req, res) => {
  const all = (await store.getPage('emailTemplates')) || {};
  delete all[req.params.key];
  await store.setPage('emailTemplates', all);
  await audit(req, 'email-template.reset', { text: req.params.key });
  res.json({ ok: true });
});

// Navigation menu: public read, content/super-admin write.
const NAV_DEFAULT = [
  { label: 'Demo', href: '/demo' }, { label: 'About', href: '/about' },
  { label: 'Support', href: '/donate' }, { label: 'Apply', href: '/signup' }, { label: 'Sign in', href: '/admin' }
];
app.get('/api/nav', async (_req, res) => { const n = await store.getPage('nav'); res.json(Array.isArray(n) && n.length ? n : NAV_DEFAULT); });

// Editable pages (marketing + legal). Content stored as a free-form object of
// HTML overrides keyed by the page's data-edit fields. Public read, content write.
// Legal documents are edited as a single rich "body" field, so they get a larger cap.
const EDITABLE_PAGES = new Set(['about', 'demo', 'privacy', 'terms', 'cookies', 'acceptable-use', 'dpa', 'legal']);
// Legal documents are version-controlled: each save keeps a numbered, dated snapshot.
const LEGAL_KEYS = new Set(['privacy', 'terms', 'cookies', 'acceptable-use', 'dpa', 'legal']);
app.get('/api/page/:key', async (req, res) => {
  if (!EDITABLE_PAGES.has(req.params.key)) return res.status(404).json({ error: 'Unknown page.' });
  res.json((await store.getPage('content:' + req.params.key)) || {});
});
app.put('/api/page/:key', requirePerm('content'), async (req, res) => {
  if (!EDITABLE_PAGES.has(req.params.key)) return res.status(404).json({ error: 'Unknown page.' });
  const fields = req.body && typeof req.body.fields === 'object' ? req.body.fields : {};
  const clean = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') clean[k] = v.slice(0, 100000);
  await store.setPage('content:' + req.params.key, clean);
  // Snapshot a version for legal documents.
  if (LEGAL_KEYS.has(req.params.key)) {
    const vkey = 'legalver:' + req.params.key;
    const vers = (await store.getPage(vkey)) || [];
    const num = (vers.length ? vers[vers.length - 1].num : 0) + 1;
    vers.push({ num, version: '1.' + num, html: clean.body || '', date: new Date().toISOString(), by: req.console?.email || '' });
    while (vers.length > 50) vers.shift();
    await store.setPage(vkey, vers);
  }
  await audit(req, 'page.updated', { text: req.params.key });
  res.json({ ok: true });
});

// ---- Legal document version history ----
app.get('/api/console/legal-versions/:key', requirePerm('content'), async (req, res) => {
  if (!LEGAL_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown document.' });
  res.json((await store.getPage('legalver:' + req.params.key)) || []);
});
app.post('/api/console/legal-versions/:key/:num/restore', requirePerm('content'), async (req, res) => {
  if (!LEGAL_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown document.' });
  const vers = (await store.getPage('legalver:' + req.params.key)) || [];
  const v = vers.find(x => String(x.num) === String(req.params.num));
  if (!v) return res.status(404).json({ error: 'Version not found.' });
  // Publishing a restore also creates a new version (so history stays linear).
  await store.setPage('content:' + req.params.key, { body: v.html });
  const num = (vers.length ? vers[vers.length - 1].num : 0) + 1;
  vers.push({ num, version: '1.' + num, html: v.html, date: new Date().toISOString(), by: req.console?.email || '', restoredFrom: v.version });
  await store.setPage('legalver:' + req.params.key, vers);
  await audit(req, 'legal.restored', { text: req.params.key + ' -> ' + v.version });
  res.json({ ok: true });
});
app.delete('/api/console/legal-versions/:key/:num', requirePerm('content'), async (req, res) => {
  if (!LEGAL_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown document.' });
  const vers = ((await store.getPage('legalver:' + req.params.key)) || []).filter(x => String(x.num) !== String(req.params.num));
  await store.setPage('legalver:' + req.params.key, vers);
  await audit(req, 'legal.version-deleted', { text: req.params.key + ' v' + req.params.num });
  res.json({ ok: true });
});
app.put('/api/console/nav', requirePerm('content'), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.filter(x => x && x.label && x.href).slice(0, 10).map(x => ({ label: String(x.label).slice(0, 40), href: String(x.href).slice(0, 200), hidden: !!x.hidden })) : [];
  await store.setPage('nav', items);
  await audit(req, 'nav.updated', { text: items.map(i => i.label).join(', ') });
  res.json({ ok: true, items });
});

// Audit log across all enterprises.
//  - legacy: no ?paginate -> a plain array (kept for older clients and tests)
//  - paginated: ?paginate=1&page=&pageSize=&q=&sort=&dir= -> { items, total, page, pageSize }
app.get('/api/console/logs', requireConsole, async (req, res) => {
  if (!req.query.paginate) {
    return res.json(await store.listLogs(Number(req.query.limit) || 300));
  }
  const pageSize = [50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 50;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sort = ['ts', 'action', 'actor', 'actorRole', 'accountName'].includes(req.query.sort) ? req.query.sort : 'ts';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const { items, total } = await store.queryLogs({ q: (req.query.q || '').trim(), sort, dir, offset: (page - 1) * pageSize, limit: pageSize });
  res.json({ items, total, page, pageSize });
});

// Send a test email so the super admin can see the exact SMTP result.
app.post('/api/console/test-email', requireSuperAdmin, async (req, res) => {
  const to = (req.body?.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an email address to test.' });
  if (!emailEnabled()) return res.status(400).json({ error: 'Email is not configured. Set RESEND_API_KEY + SMTP_FROM, or GMAIL_USER + GMAIL_APP_PASSWORD, or SMTP_HOST/USER/PASS + SMTP_FROM.' });
  const from = emailFrom();
  const r = await sendEmail({ to, subject: 'Enjeeoh test email', html: '<p>This is a test from your Enjeeoh console. If you can read this, email sending works.</p>' });
  if (r.sent) return res.json({ ok: true, from, method: emailMethod() });
  // Surface the provider's real reason, plus a hint matched to the provider AND the error.
  const fromDomain = (from.split('@')[1] || '').toLowerCase();
  const freeDomain = FREE_EMAIL_DOMAINS.has(fromDomain);
  const reason = (r.reason || 'send failed');
  const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNECTION|connect/i.test(reason);
  let hint;
  if (process.env.RESEND_API_KEY) {
    hint = freeDomain
      ? ` You cannot send from ${fromDomain} via Resend, you do not own it. Verify your own domain at resend.com/domains and set SMTP_FROM to an address on it (e.g. noreply@yourdomain.org), or use onboarding@resend.dev to email only your own account.`
      : ' The "from" address (SMTP_FROM) must be on a domain you have verified at resend.com/domains.';
  } else if (process.env.BREVO_API_KEY) {
    hint = ' The "from" address must be a verified sender on a domain authenticated in Brevo.';
  } else if (isTimeout) {
    hint = ' Could not connect, your host (e.g. Railway) is blocking the SMTP port. Switch to Resend: set RESEND_API_KEY and SMTP_FROM (a verified-domain address), and remove GMAIL_USER / GMAIL_APP_PASSWORD / SMTP_* vars.';
  } else {
    hint = ' Check your SMTP username/password (for Gmail this must be an App Password, not your normal password).';
  }
  res.status(502).json({ error: emailMethod() + ' said: ' + reason + '.' + hint });
});

// User limits: a global cap across all enterprises and a per-organisation cap.
app.get('/api/console/limits', requireConsole, async (_req, res) => {
  const limits = (await store.getPage('limits')) || { globalMax: 0, orgDefault: 0 };
  res.json({ globalMax: limits.globalMax || 0, orgDefault: limits.orgDefault || 0, totalMembers: await store.countAllMembers() });
});
app.put('/api/console/limits', requireSuperAdmin, async (req, res) => {
  const globalMax = Math.max(0, parseInt(req.body?.globalMax, 10) || 0);
  const orgDefault = Math.max(0, parseInt(req.body?.orgDefault, 10) || 0);
  await store.setPage('limits', { globalMax, orgDefault });
  await audit(req, 'limits.updated', { text: `global=${globalMax} orgDefault=${orgDefault}` });
  res.json({ ok: true, globalMax, orgDefault });
});
app.get('/api/password-policy', async (_req, res) => { const p = await getPasswordPolicy(); res.json({ minLength: p.minLength, requireUpper: p.requireUpper, requireNumber: p.requireNumber, requireSymbol: p.requireSymbol }); });
app.get('/api/console/policy', requireConsole, async (_req, res) => res.json(await getPasswordPolicy()));
app.put('/api/console/policy', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  // Merge over the current policy so a partial save never silently disables a
  // setting the caller did not include (e.g. saving length rules from one form
  // must not switch off lockout configured elsewhere).
  const cur = await getPasswordPolicy();
  const num = (v, lo, hi, dflt) => v === undefined || v === null || v === '' ? dflt : Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
  const bool = (k, dflt) => (k in b ? !!b[k] : dflt);
  const reminderDays = Array.isArray(b.reminderDays)
    ? [...new Set(b.reminderDays.map(n => parseInt(n, 10)).filter(n => n > 0 && n <= 3650))].sort((x, y) => x - y).slice(0, 6)
    : cur.reminderDays;
  const policy = {
    minLength: num(b.minLength, 8, 64, cur.minLength),
    requireUpper: bool('requireUpper', cur.requireUpper), requireNumber: bool('requireNumber', cur.requireNumber),
    requireSymbol: bool('requireSymbol', cur.requireSymbol), requireMfa: bool('requireMfa', cur.requireMfa),
    expiryDays: num(b.expiryDays, 0, 3650, cur.expiryDays),
    reminderDays,
    lockoutThreshold: num(b.lockoutThreshold, 0, 20, cur.lockoutThreshold),
    lockoutMinutes: num(b.lockoutMinutes, 1, 1440, cur.lockoutMinutes)
  };
  await store.setPage('passwordPolicy', policy);
  await audit(req, 'policy.updated', { text: JSON.stringify(policy) });
  res.json({ ok: true, policy });
});

app.put('/api/console/org/:id/limit', requireSuperAdmin, async (req, res) => {
  const maxMembers = Math.max(0, parseInt(req.body?.maxMembers, 10) || 0);
  const a = await store.updateAccount(req.params.id, { maxMembers });
  await audit(req, 'org.limit.updated', { accountId: req.params.id, accountName: a?.name, text: `maxMembers=${maxMembers}` });
  res.json({ ok: true, maxMembers });
});

// ================= LANDING PAGE CONTENT =================
app.get('/api/landing', async (_req, res) => {
  const l = await store.getLanding();
  res.json(l || LANDING_DEFAULTS);
});
app.put('/api/landing', requirePerm('content'), async (req, res) => {
  const cur = (await store.getLanding()) || LANDING_DEFAULTS;
  const allowed = ['badge','headLead','headRest','sub','ctaPrimary','ctaSecondary','features','accent','accent2','theme','anim'];
  const next = { ...cur };
  for (const k of allowed) if (k in (req.body || {})) next[k] = req.body[k];
  await store.setLanding(next);
  res.json({ ok: true, landing: next });
});

// ================= DONATIONS =================
app.get('/api/donate', async (_req, res) => {
  const d = await store.getDonate();
  res.json(d || DONATE_DEFAULTS);
});
app.put('/api/donate', requirePerm('content'), async (req, res) => {
  const cur = (await store.getDonate()) || DONATE_DEFAULTS;
  const allowed = ['heading', 'blurb', 'disclaimer', 'currency', 'amounts', 'recurringEnabled', 'providers', 'options'];
  const next = { ...cur };
  for (const k of allowed) if (k in (req.body || {})) next[k] = req.body[k];
  if (Array.isArray(next.options)) next.options = next.options.filter(o => o && o.label && o.url).slice(0, 8).map(o => ({ label: String(o.label).slice(0, 60), url: String(o.url).slice(0, 300) }));
  await store.setDonate(next);
  res.json({ ok: true, donate: next });
});

// ================= TEAM ("the people behind it") =================
const TEAM_STYLES = ['cards', 'flashcard', 'list', 'circles', 'minimal', 'spotlight'];
const TEAM_DEFAULT = {
  heading: 'The people behind it', style: 'cards',
  members: [
    { name: 'Amara Mensah', role: 'Founder', description: '', imageUrl: '' },
    { name: 'Tomas Nilsson', role: 'Engineering', description: '', imageUrl: '' },
    { name: 'Priya Raman', role: 'Community', description: '', imageUrl: '' }
  ]
};
app.get('/api/team', async (_req, res) => res.json((await store.getPage('team')) || TEAM_DEFAULT));
app.put('/api/console/team', requirePerm('content'), async (req, res) => {
  const b = req.body || {};
  const next = {
    heading: String(b.heading || TEAM_DEFAULT.heading).slice(0, 120),
    style: TEAM_STYLES.includes(b.style) ? b.style : 'cards',
    members: (Array.isArray(b.members) ? b.members : []).slice(0, 40).map(m => ({
      name: String(m.name || '').slice(0, 80),
      role: String(m.role || '').slice(0, 80),
      description: String(m.description || '').slice(0, 600),
      imageUrl: cleanImageUrl(m.imageUrl)
    })).filter(m => m.name)
  };
  await store.setPage('team', next);
  await audit(req, 'team.updated', { text: next.members.length + ' people, style ' + next.style });
  res.json({ ok: true, team: next });
});

// ================= BROADCAST (announcements / policy updates) =================
// Send a one-off email to all organisations or all members, e.g. to notify users
// that a policy or legal document changed.
app.post('/api/console/broadcast', requireSuperAdmin, async (req, res) => {
  if (!emailEnabled()) return res.status(400).json({ error: 'Email is not configured.' });
  const subject = String(req.body?.subject || '').slice(0, 200).trim();
  const html = String(req.body?.html || '').slice(0, 50000).trim();
  const audience = ['orgs', 'members', 'all'].includes(req.body?.audience) ? req.body.audience : 'orgs';
  const test = !!req.body?.test;
  if (!subject || !html) return res.status(400).json({ error: 'A subject and message are required.' });

  // Build the de-duplicated recipient list.
  const set = new Set();
  if (test) { set.add(req.console.email); }
  else {
    if (audience === 'orgs' || audience === 'all') {
      for (const a of await store.listAllAccounts()) if (a.email && !a.deleted) set.add(a.email.toLowerCase());
    }
    if (audience === 'members' || audience === 'all') {
      for (const m of await store.listAllMembers()) if (m.email && m.status === 'active' && !m.suspended) set.add(m.email.toLowerCase());
    }
  }
  const recipients = [...set];
  if (!recipients.length) return res.status(400).json({ error: 'No recipients for that audience.' });

  // Send sequentially with a tiny gap so we don't hammer the provider.
  let sent = 0, failed = 0;
  for (const to of recipients) {
    const r = await sendEmail({ to, subject, html });
    if (r.sent) sent++; else failed++;
    await new Promise(r => setTimeout(r, 80));
  }
  await audit(req, 'broadcast.sent', { actor: req.console.email, text: `${subject} to ${audience} (${sent} sent, ${failed} failed${test ? ', TEST' : ''})` });
  res.json({ ok: true, sent, failed, total: recipients.length, test });
});

// Public: request a demo. Notifies the team and sends a professional acknowledgement.
app.post('/api/demo-request', signupLimiter, async (req, res) => {
  const name = String(req.body?.name || '').slice(0, 120).trim();
  const email = String(req.body?.email || '').slice(0, 200).trim();
  const org = String(req.body?.org || '').slice(0, 160).trim();
  const message = String(req.body?.message || '').slice(0, 2000).trim();
  if (!name || !email.includes('@')) return res.status(400).json({ error: 'Please give your name and a valid email.' });
  const teamTo = process.env.REVIEW_NOTIFY_EMAIL || SUPERADMIN_EMAIL;
  if (teamTo) sendTemplate('demoRequestNotify', teamTo, { name, email, org: org || '(not given)', message: message || '(none)' });
  sendTemplate('demoRequestAck', email, { name });
  await audit(req, 'demo.requested', { actor: email, text: org || name });
  res.json({ ok: true, emailed: emailEnabled() });
});

// ================= DEMO BOOKING + SUPER-ADMIN CALENDAR =================
// Super admins can publish their availability so visitors book a demo directly.
// Demo bookings live in the bookings collection under a synthetic owner so they
// reuse slots, reminders, and the self-manage page.
const DEMO_OWNER = '__demo__', PLATFORM_ACCT = '__platform__';
const DEMO_AVAIL_DEFAULT = { 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }], 3: [{ start: '09:00', end: '17:00' }], 4: [{ start: '09:00', end: '17:00' }], 5: [{ start: '09:00', end: '17:00' }], 6: [] };
async function getDemoConfig() {
  const c = (await store.getPage('demoConfig')) || {};
  return { enabled: !!c.enabled, durationMins: c.durationMins || 30, timezone: c.timezone || 'Etc/UTC', availability: c.availability || DEMO_AVAIL_DEFAULT };
}
app.get('/api/console/demo-config', requireSuperAdmin, async (_req, res) => res.json(await getDemoConfig()));
app.put('/api/console/demo-config', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const cfg = {
    enabled: !!b.enabled,
    durationMins: Math.max(10, Math.min(240, parseInt(b.durationMins, 10) || 30)),
    timezone: cleanTimezone(b.timezone) || 'Etc/UTC',
    availability: (b.availability && typeof b.availability === 'object') ? b.availability : DEMO_AVAIL_DEFAULT
  };
  await store.setPage('demoConfig', cfg);
  await audit(req, 'demo.config', { actor: req.console.email, text: cfg.enabled ? 'enabled' : 'disabled' });
  res.json({ ok: true, config: cfg });
});
// Public: is demo booking on, and its slots/booking.
app.get('/api/demo/config', async (_req, res) => { const c = await getDemoConfig(); res.json({ enabled: c.enabled, durationMins: c.durationMins, timezone: c.timezone }); });
app.get('/api/demo/slots', async (req, res) => {
  const c = await getDemoConfig(); if (!c.enabled) return res.status(404).json({ error: 'Demo booking is not available.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) return res.status(400).json({ error: 'Pass ?date=YYYY-MM-DD' });
  const booked = (await store.listBookingsByMember(DEMO_OWNER)).filter(b => b.status !== 'cancelled');
  const slots = slotsForDate({ dateStr: req.query.date, durationMins: c.durationMins, timeZone: c.timezone, availability: c.availability, bookedRanges: booked });
  res.json({ durationMins: c.durationMins, timezone: c.timezone, slots });
});
app.post('/api/demo/book', signupLimiter, async (req, res) => {
  const c = await getDemoConfig(); if (!c.enabled) return res.status(404).json({ error: 'Demo booking is not available.' });
  const name = String(req.body?.name || '').slice(0, 120).trim(), email = String(req.body?.email || '').slice(0, 200).trim();
  const org = String(req.body?.org || '').slice(0, 160).trim(), notes = String(req.body?.notes || '').slice(0, 2000).trim();
  const start = req.body?.start;
  if (!name || !email.includes('@') || !start) return res.status(400).json({ error: 'Name, email and a time are required.' });
  const startDate = new Date(start); if (isNaN(startDate)) return res.status(400).json({ error: 'Invalid time.' });
  if (startDate.getTime() < Date.now()) return res.status(400).json({ error: 'Please pick a future time.' });
  const endDate = new Date(startDate.getTime() + c.durationMins * 60000);
  const booked = await store.listBookingsByMember(DEMO_OWNER);
  if (bookingOverlaps(booked, startDate.getTime(), endDate.getTime())) return res.status(409).json({ error: 'That time was just taken. Please pick another.' });
  const tmpId = crypto.randomBytes(6).toString('hex');
  const jitsiUrl = `https://${JITSI_DOMAIN}/enjeeoh-demo-${tmpId}` + (JITSI_E2EE ? '#config.e2ee.enabled=true&config.disableAudioLevels=true' : '');
  const booking = await store.createBooking(PLATFORM_ACCT, DEMO_OWNER, {
    demo: true, title: 'Enjeeoh demo', serviceName: 'Demo', memberName: 'Enjeeoh team', name, email,
    phone: String(req.body?.phone || '').slice(0, 40), notes, org, manageToken: crypto.randomBytes(16).toString('hex'),
    start: startDate.toISOString(), end: endDate.toISOString(), locationText: jitsiUrl
  });
  const when = new Intl.DateTimeFormat('en-AU', { timeZone: c.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(startDate);
  const manageUrl = `${baseUrl(req)}/manage/${booking.id}/${booking.manageToken}`;
  const teamTo = process.env.REVIEW_NOTIFY_EMAIL || SUPERADMIN_EMAIL;
  if (emailEnabled()) {
    sendEmail({ to: email, subject: `Your Enjeeoh demo is booked for ${when}`, html: `<p>Hi ${name},</p><p>Thank you for booking a demo of Enjeeoh. Your session is confirmed for <b>${when}</b>.</p><p>When the time comes, join here: <a href="${jitsiUrl}">${jitsiUrl}</a></p><p>Need to change it? <a href="${manageUrl}">Reschedule or cancel</a>.</p><p>We look forward to speaking with you.</p>` });
    if (teamTo) sendEmail({ to: teamTo, subject: `New demo booked: ${org || name} on ${when}`, html: `<p>${name} (${email})${org ? ` from ${org}` : ''} booked a demo for ${when}.</p>${notes ? `<p>Notes: ${notes}</p>` : ''}<p>${jitsiUrl}</p>` });
  }
  await audit(req, 'demo.booked', { actor: email, text: (org || name) + ' ' + when });
  res.json({ ok: true, when, locationText: jitsiUrl, manageUrl });
});
// Super-admin calendar: upcoming sessions across the platform (demos + all orgs).
app.get('/api/console/calendar', requireSuperAdmin, async (_req, res) => {
  const now = Date.now();
  const accounts = await store.listAllAccounts(); const byId = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const all = (await store.listAllBookings()).filter(b => b.status !== 'cancelled' && new Date(b.start).getTime() > now - 2 * 3600 * 1000);
  const sessions = all.map(b => ({ id: b.id, title: b.serviceName || b.title, start: b.start, who: b.memberName, booker: b.name, bookerEmail: b.email, org: b.demo ? 'Demo request' : (byId[b.accountId] || ''), demo: !!b.demo }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  res.json({ sessions });
});

// ================= EMBED + PAGES =================
app.get('/embed.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  // Two modes:
  //   default        -> a button that opens the booking page in a modal
  //   data-mode=inline -> the booking page rendered directly in the page (drop-in
  //                       replacement for an existing /book page; the visitor's URL
  //                       never leaves the host site)
  res.send(`(function(){
  var s=document.currentScript;
  var org=s.getAttribute('data-org')||'',m=s.getAttribute('data-member')||'',ev=s.getAttribute('data-event')||'';
  var color=s.getAttribute('data-color')||'#0F9D7A',label=s.getAttribute('data-label')||'Book a time';
  var mode=s.getAttribute('data-mode')||'button';
  var height=s.getAttribute('data-height')||'760';
  var maxw=s.getAttribute('data-max-width')||(mode==='inline'?'620':'480');
  var base=new URL(s.src).origin;
  var src=base+'/book/'+org+(m?'/'+m:'')+(ev?'/'+ev:'')+'?embed=1';
  function iframe(css){var fr=document.createElement('iframe');fr.src=src;fr.setAttribute('title','Booking');fr.setAttribute('loading','lazy');fr.style.cssText=css;return fr;}
  if(mode==='inline'){
    var fr=iframe('width:100%;max-width:'+maxw+'px;height:'+height+'px;border:0;border-radius:16px;background:#fff;display:block;margin:0 auto');
    s.parentNode.insertBefore(fr,s);
    return;
  }
  var b=document.createElement('button');b.type='button';b.textContent=label;
  b.style.cssText='background:'+color+';color:#fff;border:0;border-radius:10px;padding:12px 20px;font:600 15px system-ui,sans-serif;cursor:pointer';
  var ov=document.createElement('div');ov.style.cssText='display:none;position:fixed;inset:0;background:rgba(10,12,20,.55);z-index:99999;align-items:center;justify-content:center;padding:16px';
  var fr=iframe('width:100%;max-width:'+maxw+'px;height:'+height+'px;max-height:90vh;border:0;border-radius:16px;background:#fff');
  ov.appendChild(fr);
  ov.addEventListener('click',function(e){if(e.target===ov)ov.style.display='none';});
  b.addEventListener('click',function(){ov.style.display='flex';});
  function mt(){document.body.appendChild(ov);}if(document.body)mt();else document.addEventListener('DOMContentLoaded',mt);
  s.parentNode.insertBefore(b,s);
})();`);
});

// Tells the booking page which org it's serving when reached via a custom host.
app.get('/api/resolve-host', async (req, res) => {
  const slug = await resolveHostToOrg(req.headers.host);
  res.json({ orgSlug: slug });
});

app.get('/book/:slug/:mslug/:evslug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('/book/:slug/:mslug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('/book/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/join', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/reset', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.get('/console', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'console.html')));
app.get('/review', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'console.html')));
app.get('/editor', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/donate', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'donate.html')));
app.get('/about', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/demo', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
// Legal documents (clean URLs).
for (const slug of ['legal', 'privacy', 'terms', 'cookies', 'acceptable-use', 'dpa']) {
  app.get('/' + slug, (_req, res) => res.sendFile(path.join(__dirname, 'public', slug + '.html')));
}
// Self-service manage page (cancel/reschedule from the email link).
app.get('/manage/:id/:token', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'manage.html')));
app.get('/', async (req, res) => {
  // If reached via an org subdomain or custom domain, show that org's booking page.
  const slug = await resolveHostToOrg(req.headers.host);
  res.sendFile(path.join(__dirname, 'public', slug ? 'book.html' : 'index.html'));
});

// ================= PASSWORD EXPIRY REMINDERS =================
// Once a day, email active members whose password has crossed a configured
// reminder age (e.g. 30/60/90 days). Each member gets at most one email per
// threshold, tracked by lastReminderThreshold so we never spam.
async function runPasswordReminders() {
  try {
    if (!emailEnabled()) return;
    const policy = await getPasswordPolicy();
    const thresholds = (policy.reminderDays || []).slice().sort((a, b) => a - b);
    if (!thresholds.length) return;
    const members = await store.listAllMembers();
    for (const m of members) {
      if (m.status !== 'active' || !m.passwordHash || m.suspended) continue;
      const age = passwordAgeDays(m);
      // Highest threshold this member has now reached.
      const due = thresholds.filter(t => age >= t).pop();
      if (!due) continue;
      if ((m.lastReminderThreshold || 0) >= due) continue; // already reminded at this level
      const resetToken = crypto.randomBytes(24).toString('hex');
      await store.updateMember(m.id, { lastReminderThreshold: due, resetToken, resetExpires: Date.now() + 7 * DAY_MS });
      await sendTemplate('passwordReminder', m.email, { name: m.name || 'there', ageDays: age, resetUrl: `${PUBLIC_URL}/reset?token=${resetToken}` });
    }
  } catch (e) { console.error('Password reminder sweep failed:', e.message); }
}
// Run shortly after boot, then every 24 hours.
setTimeout(runPasswordReminders, 30 * 1000);
setInterval(runPasswordReminders, DAY_MS).unref?.();

// ================= APPOINTMENT REMINDERS (~24h before) =================
// Hourly, email (and SMS if configured) bookers whose appointment is ~24h away.
async function runBookingReminders() {
  try {
    if (!emailEnabled() && !smsEnabled()) return;
    const now = Date.now();
    // Two reminder windows: ~24h before and ~4h before, each tracked separately.
    const windows = [
      { from: 23, to: 25, flag: 'reminderSent', label: 'tomorrow' },
      { from: 3.5, to: 4.5, flag: 'reminder4Sent', label: 'in about 4 hours' }
    ];
    for (const w of windows) {
      const due = await store.listBookingsBetween(new Date(now + w.from * 3600 * 1000).toISOString(), new Date(now + w.to * 3600 * 1000).toISOString());
      for (const b of due) {
        if (b[w.flag] || !b.email) continue;
        const a = await store.getAccountById(b.accountId);
        const when = a ? new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(b.start)) : b.start;
        const manageLink = b.manageToken ? `${PUBLIC_URL}/manage/${b.id}/${b.manageToken}` : '';
        if (emailEnabled()) sendEmail({ to: b.email, subject: `Reminder: ${b.title} ${w.label}`, html: `<p>Hi ${b.name || 'there'},</p><p>A reminder for your <b>${b.title}</b> with ${b.memberName} ${w.label}, <b>${when}</b>.</p><p>${b.locationText || ''}</p>${manageLink ? `<p>Need to change it? <a href="${manageLink}">Reschedule or cancel</a>.</p>` : ''}` });
        if (smsEnabled() && b.phone) sendSms({ to: b.phone, body: `Reminder: ${b.title} ${w.label} (${when}). ${b.locationText || ''}`.slice(0, 320) });
        await store.updateBooking(b.id, { [w.flag]: true });
      }
    }
  } catch (e) { console.error('Booking reminder sweep failed:', e.message); }
}
setTimeout(runBookingReminders, 45 * 1000);
setInterval(runBookingReminders, 60 * 60 * 1000).unref?.();

// Warn loudly if the deployment is running on insecure defaults.
function securityPreflight() {
  const warns = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production') warns.push('JWT_SECRET is unset or default, set a long random value.');
  if ((process.env.SUPERADMIN_PASSWORD || process.env.REVIEWER_PASSWORD || '').length < 12) warns.push('Super admin password is short or unset, use 12+ characters.');
  if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) warns.push('Running in production on the JSON file store, set MONGODB_URI.');
  // Catch the most common email mistake: Resend/Brevo cannot send "from" a free
  // mailbox domain you do not own, it will reject every message.
  const fromAddr = emailFrom();
  const fromDomain = (fromAddr.split('@')[1] || '').toLowerCase();
  // Warn when several providers are set, only the highest-priority one is used.
  const providers = [];
  if (process.env.RESEND_API_KEY) providers.push('Resend');
  if (process.env.BREVO_API_KEY) providers.push('Brevo');
  if (process.env.SMTP_HOST || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)) providers.push(process.env.SMTP_HOST ? 'SMTP' : 'Gmail');
  if (providers.length > 1) {
    warns.push(`Multiple email providers configured (${providers.join(', ')}). Only ${emailMethod()} is used, order is Resend > Brevo > SMTP/Gmail. To use Gmail, REMOVE RESEND_API_KEY and BREVO_API_KEY.`);
  }
  if ((process.env.RESEND_API_KEY || process.env.BREVO_API_KEY) && FREE_EMAIL_DOMAINS.has(fromDomain)) {
    warns.push(`Email will FAIL: ${emailMethod()} cannot send from ${fromDomain} (you do not own it). Either (a) verify your own domain and set SMTP_FROM=you@yourdomain, or (b) use Gmail instead, remove RESEND_API_KEY/BREVO_API_KEY and set GMAIL_USER + GMAIL_APP_PASSWORD.`);
  }
  if (warns.length) console.warn('\n  STARTUP WARNINGS:\n' + warns.map(w => '   - ' + w).join('\n'));
}

app.listen(PORT, () => {
  securityPreflight();
  console.log(`\n  Enjeeoh on ${PUBLIC_URL}`);
  console.log(`  Email sending: ${emailEnabled() ? 'on via ' + emailMethod() + ', from ' + (emailFrom() || '(no from set)') : 'OFF'}`);
  console.log(`  Apply ${PUBLIC_URL}/signup · Dashboard ${PUBLIC_URL}/admin · Console ${PUBLIC_URL}/console`);
  console.log(`  Email ${emailEnabled() ? 'on' : 'off'}\n`);
});
