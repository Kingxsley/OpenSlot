// End-to-end smoke test for Enjeeoh. Boots the server on a test port with a
// temporary data directory and exercises the critical paths. Run: npm test
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as OTPAuth from 'otpauth';

const PORT = process.env.TEST_PORT || 4399;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'enjeeoh-test-'));
const SUPER = { email: 'super@enjeeoh.test', password: 'superpass123' };

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  FAIL  ' + name); } }

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function totp(secret) { return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate(); }
function nextMonday() { const t = new Date(); const d = new Date(t); d.setUTCDate(t.getUTCDate() + (((1 - t.getUTCDay()) % 7) + 7) % 7 || 7); return d.toISOString().slice(0, 10); }

async function waitReady() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/nav'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('server did not start');
}

async function run() {
  // ---- signup, org email enforcement, passwordless setup ----
  ok((await api('/api/signup', { method: 'POST', body: { orgName: 'Free Org', email: 'x@gmail.com' } })).status === 400, 'gmail signup rejected');
  const su = await api('/api/signup', { method: 'POST', body: { orgName: 'Care Co', email: 'ada@careco.org', contactName: 'Ada' } });
  ok(su.status === 200 && su.data.setupUrl, 'org-email signup accepted with setup link');
  const setupToken = su.data.setupUrl.split('token=')[1];

  // ---- console: super admin + roles ----
  const sa = await api('/api/console/login', { method: 'POST', body: SUPER });
  ok(sa.data.role === 'superadmin', 'super admin login');
  const SAT = sa.data.token;

  // password policy: min 12 + number
  ok((await api('/api/console/policy', { method: 'PUT', token: SAT, body: { minLength: 12, requireNumber: true } })).status === 200, 'super admin sets password policy');
  ok((await api('/api/join', { method: 'POST', body: { token: setupToken, name: 'Ada', password: 'short1' } })).status === 400, 'weak password rejected by policy');
  ok((await api('/api/join', { method: 'POST', body: { token: setupToken, name: 'Ada', password: 'strongpass123' } })).status === 200, 'compliant password accepted');

  const adminLogin = await api('/api/login', { method: 'POST', body: { email: 'ada@careco.org', password: 'strongpass123' } });
  ok(adminLogin.data.token, 'org admin login (no MFA yet)');
  let ADMIN = adminLogin.data.token;

  // add onboarding + content platform admins
  await api('/api/console/admins', { method: 'POST', token: SAT, body: { name: 'Ona', email: 'ona@enjeeoh.test', password: 'onapass12345', role: 'onboarding' } });
  await api('/api/console/admins', { method: 'POST', token: SAT, body: { name: 'Cody', email: 'cody@enjeeoh.test', password: 'codypass1234', role: 'content' } });
  const ON = (await api('/api/console/login', { method: 'POST', body: { email: 'ona@enjeeoh.test', password: 'onapass12345' } })).data.token;
  const CO = (await api('/api/console/login', { method: 'POST', body: { email: 'cody@enjeeoh.test', password: 'codypass1234' } })).data.token;

  // RBAC boundaries
  ok((await api('/api/console/applications', { token: ON })).status === 200, 'onboarding can list applications');
  ok((await api('/api/landing', { method: 'PUT', token: ON, body: { headLead: 'X' } })).status === 403, 'onboarding cannot edit content');
  ok((await api('/api/console/admins', { method: 'POST', token: ON, body: { email: 'z@z.com', password: 'abcdefgh1' } })).status === 403, 'onboarding cannot add admins');
  ok((await api('/api/landing', { method: 'PUT', token: CO, body: { headLead: 'Hi' } })).status === 200, 'content can edit landing');
  ok((await api('/api/console/applications', { token: CO })).status === 403, 'content cannot list applications');
  ok((await api('/api/console/nav', { method: 'PUT', token: CO, body: { items: [{ label: 'Home', href: '/' }] } })).status === 200, 'content can edit nav');
  ok((await api('/api/nav')).data[0].label === 'Home', 'public nav reflects saved menu');

  // role allocation
  const admins = (await api('/api/console/admins', { token: SAT })).data;
  const onaId = admins.find(a => a.email === 'ona@enjeeoh.test').id;
  ok((await api('/api/console/admins/' + onaId + '/role', { method: 'PUT', token: SAT, body: { role: 'content' } })).status === 200, 'super admin reallocates role');
  const ON2 = (await api('/api/console/login', { method: 'POST', body: { email: 'ona@enjeeoh.test', password: 'onapass12345' } })).data.token;
  ok((await api('/api/landing', { method: 'PUT', token: ON2, body: { headLead: 'Y' } })).status === 200, 'reallocated admin gains new permission');

  // approve the org
  const orgId = (await api('/api/console/applications', { token: SAT })).data.find(a => a.name === 'Care Co').id;
  ok((await api('/api/console/' + orgId + '/decision', { method: 'POST', token: SAT, body: { decision: 'approved' } })).status === 200, 'org approved');

  // ---- 2FA ----
  const setup = await api('/api/me/mfa/setup', { method: 'POST', token: ADMIN });
  ok(!!setup.data.secret && !!setup.data.qr, '2FA setup returns secret and QR');
  const secret = setup.data.secret;
  const en = await api('/api/me/mfa/enable', { method: 'POST', token: ADMIN, body: { code: totp(secret) } });
  ok(en.status === 200 && en.data.recovery.length === 8, '2FA enabled with 8 recovery codes');
  const recovery0 = en.data.recovery[0];
  const l1 = await api('/api/login', { method: 'POST', body: { email: 'ada@careco.org', password: 'strongpass123' } });
  ok(l1.data.mfaRequired === true, 'login now demands second factor');
  ok((await api('/api/login/mfa', { method: 'POST', body: { mfaToken: l1.data.mfaToken, code: '000000' } })).status === 401, 'wrong 2FA code rejected');
  const l1b = await api('/api/login', { method: 'POST', body: { email: 'ada@careco.org', password: 'strongpass123' } });
  const good = await api('/api/login/mfa', { method: 'POST', body: { mfaToken: l1b.data.mfaToken, code: totp(secret) } });
  ok(!!good.data.token, 'valid TOTP completes login');
  ADMIN = good.data.token;
  const l2 = await api('/api/login', { method: 'POST', body: { email: 'ada@careco.org', password: 'strongpass123' } });
  ok(!!(await api('/api/login/mfa', { method: 'POST', body: { mfaToken: l2.data.mfaToken, code: recovery0 } })).data.token, 'recovery code completes login');
  const l3 = await api('/api/login', { method: 'POST', body: { email: 'ada@careco.org', password: 'strongpass123' } });
  ok((await api('/api/login/mfa', { method: 'POST', body: { mfaToken: l3.data.mfaToken, code: recovery0 } })).status === 401, 'used recovery code cannot be reused');

  // ---- availability, blocked dates, booking lifecycle ----
  const mon = nextMonday();
  await api('/api/me/availability', { method: 'PUT', token: ADMIN, body: { availability: { 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }] } } });
  const me = (await api('/api/me', { token: ADMIN })).data;
  const oslug = me.account.slug, mslug = me.member.slug;
  const before = (await api(`/api/biz/${oslug}/m/${mslug}/slots/intro-call?date=${mon}`)).data;
  ok((before.slots || []).length > 0, 'slots available on a working day');
  await api('/api/me/availability', { method: 'PUT', token: ADMIN, body: { blockedDates: [mon] } });
  const after = (await api(`/api/biz/${oslug}/m/${mslug}/slots/intro-call?date=${mon}`)).data;
  ok((after.slots || []).length === 0, 'blocked day shows no slots');
  await api('/api/me/availability', { method: 'PUT', token: ADMIN, body: { blockedDates: [] } });

  const slot = (await api(`/api/biz/${oslug}/m/${mslug}/slots/intro-call?date=${mon}`)).data.slots[0].start;
  const bk = await api(`/api/biz/${oslug}/m/${mslug}/bookings`, { method: 'POST', body: { evslug: 'intro-call', start: slot, name: 'Jo', email: 'jo@example.org' } });
  ok(!!bk.data.booking?.id, 'public booking created');
  const bid = bk.data.booking.id;
  const newStart = new Date(new Date(slot).getTime() + 86400000).toISOString();
  ok((await api('/api/org/bookings/' + bid + '/reschedule', { method: 'POST', token: ADMIN, body: { start: new Date(Date.now() - 86400000).toISOString() } })).status === 400, 'cannot reschedule to a past time');
  ok((await api('/api/org/bookings/' + bid + '/reschedule', { method: 'POST', token: ADMIN, body: { start: newStart } })).status === 200, 'admin reschedules booking');
  ok((await api('/api/org/bookings/' + bid + '/cancel', { method: 'POST', token: ADMIN, body: {} })).status === 200, 'admin cancels booking');

  // manager role + member cannot cancel via org route
  const inv = await api('/api/org/members/invite', { method: 'POST', token: ADMIN, body: { name: 'Mem', email: 'mem@careco.org', role: 'member' } });
  const mtok = inv.data.inviteUrl.split('token=')[1];
  await api('/api/join', { method: 'POST', body: { token: mtok, name: 'Mem', password: 'memberpass12' } });
  const MEM = (await api('/api/login', { method: 'POST', body: { email: 'mem@careco.org', password: 'memberpass12' } })).data.token;
  ok((await api('/api/org/bookings/' + bid + '/cancel', { method: 'POST', token: MEM, body: {} })).status === 403, 'plain member cannot cancel org bookings');

  // ---- limits + offboarding ----
  const memId = (await api('/api/console/org/' + orgId + '/members', { token: SAT })).data[0].id;
  ok((await api('/api/console/org/' + orgId + '/suspend', { method: 'POST', token: SAT })).status === 200, 'super admin suspends org');
  ok((await api('/api/login', { method: 'POST', body: { email: 'mem@careco.org', password: 'memberpass12' } })).status === 403, 'login blocked while org suspended');
  await api('/api/console/org/' + orgId + '/restore', { method: 'POST', token: SAT });
  ok((await api('/api/login', { method: 'POST', body: { email: 'mem@careco.org', password: 'memberpass12' } })).data?.token || (await api('/api/login', { method: 'POST', body: { email: 'mem@careco.org', password: 'memberpass12' } })).data?.mfaRequired !== undefined, 'login works again after restore');
  ok((await api('/api/console/member/' + memId + '/suspend', { method: 'POST', token: SAT })).status === 200, 'super admin suspends a single member');

  // audit log populated
  ok((await api('/api/console/logs', { token: SAT })).data.length > 5, 'audit log records activity');

  // ---- account lockout after repeated wrong passwords ----
  await api('/api/console/member/' + memId + '/restore', { method: 'POST', token: SAT }); // memId is the org admin; un-suspend so she can invite
  const inv2 = await api('/api/org/members/invite', { method: 'POST', token: ADMIN, body: { name: 'Lock', email: 'lock@careco.org', role: 'member' } });
  const ltok = inv2.data.inviteUrl.split('token=')[1];
  await api('/api/join', { method: 'POST', body: { token: ltok, name: 'Lock', password: 'lockpass12345' } });
  await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'wrong1' } });
  await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'wrong2' } });
  const third = await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'wrong3' } });
  ok(third.status === 423, 'account locks after 3 wrong passwords');
  ok((await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'lockpass12345' } })).status === 423, 'correct password still blocked while locked');
  const lockId = (await api('/api/console/members', { token: SAT })).data.find(m => m.email === 'lock@careco.org').id;
  ok((await api('/api/console/members', { token: SAT })).data.find(m => m.email === 'lock@careco.org').locked === true, 'console members shows locked state + org');
  ok((await api('/api/org/members/' + lockId + '/unlock', { method: 'POST', token: ADMIN })).status === 200, 'org admin unlocks a member');
  ok(!!(await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'lockpass12345' } })).data.token, 'login works after unlock');

  // ---- forced password reset blocks login until reset ----
  ok((await api('/api/console/member/' + lockId + '/force-reset', { method: 'POST', token: SAT })).status === 200, 'super admin forces a member reset');
  const forced = await api('/api/login', { method: 'POST', body: { email: 'lock@careco.org', password: 'lockpass12345' } });
  ok(forced.data.passwordResetRequired === true && forced.data.resetUrl, 'forced member must reset before login');

  // ---- logs pagination + sorting ----
  const pg = await api('/api/console/logs?paginate=1&page=1&pageSize=50&sort=ts&dir=desc', { token: SAT });
  ok(Array.isArray(pg.data.items) && typeof pg.data.total === 'number' && pg.data.pageSize === 50, 'logs endpoint paginates');

  // ---- editable email templates ----
  ok((await api('/api/console/email-templates', { token: SAT })).data.accountSetup.subject.includes('{{orgName}}'), 'email templates expose defaults');
  ok((await api('/api/console/email-templates/accountSetup', { method: 'PUT', token: SAT, body: { subject: 'Custom {{orgName}}', html: '<p>Hi</p>' } })).status === 200, 'super admin edits an email template');
  ok((await api('/api/console/email-templates', { token: SAT })).data.accountSetup.customised === true, 'template override is recorded');
  ok((await api('/api/console/email-templates/accountSetup', { method: 'DELETE', token: SAT })).status === 200, 'super admin resets a template');

  // members tab is super-admin only
  ok((await api('/api/console/members', { token: ON2 })).status === 403, 'non-super-admin cannot list all members');

  // ---- bulk add members to an org ----
  const bulk = await api('/api/console/org/' + orgId + '/members/bulk', { method: 'POST', token: SAT, body: { members: [
    { name: 'Bulk One', email: 'bulk1@careco.org', role: 'member' },
    { name: 'Bulk Two', email: 'bulk2@careco.org', role: 'manager' },
    { email: 'ada@careco.org' } // duplicate -> skipped
  ] } });
  ok(bulk.status === 200 && bulk.data.added === 2 && bulk.data.skipped.length === 1, 'super admin bulk-adds members (skips duplicates)');
  ok((await api('/api/console/org/' + orgId + '/members', { token: SAT })).data.some(m => m.email === 'bulk1@careco.org' && m.status === 'invited'), 'bulk members created as invited');
  ok((await api('/api/console/org/' + orgId + '/members/bulk', { method: 'POST', token: ON2, body: { members: [{ email: 'x@careco.org' }] } })).status === 403, 'non-super-admin cannot bulk add');

  // ---- org soft-delete (Deleted tab) + reactivate ----
  ok((await api('/api/console/org/' + orgId + '/soft-delete', { method: 'POST', token: SAT })).status === 200, 'super admin soft-deletes an org');
  ok((await api('/api/console/applications', { token: SAT })).data.find(a => a.id === orgId).deleted === true, 'soft-deleted org is flagged deleted');
  ok((await api('/api/login', { method: 'POST', body: { email: 'mem@careco.org', password: 'memberpass12' } })).status === 403, 'login blocked while org is deleted');
  ok((await api('/api/console/org/' + orgId + '/reactivate', { method: 'POST', token: SAT })).status === 200, 'super admin reactivates the org');
  ok((await api('/api/console/applications', { token: SAT })).data.find(a => a.id === orgId).deleted === false, 'reactivated org is no longer deleted');

  // ---- team editor + broadcast ----
  ok((await api('/api/console/team', { method: 'PUT', token: CO, body: { heading: 'Our crew', style: 'flashcard', members: [{ name: 'Ada', role: 'Lead', description: 'Builds things', imageUrl: 'https://example.org/a.jpg' }] } })).status === 200, 'content admin saves the team');
  const team = (await api('/api/team')).data;
  ok(team.style === 'flashcard' && team.members[0].name === 'Ada', 'public team reflects the editor');
  ok((await api('/api/console/broadcast', { method: 'POST', token: CO, body: { subject: 'x', html: '<p>x</p>' } })).status === 403, 'broadcast is super-admin only');

  // ---- reports + timezone + demo + ask-to-reschedule ----
  const rep = await api('/api/org/report', { token: ADMIN });
  ok(rep.status === 200 && rep.data.summary && Array.isArray(rep.data.bookings), 'org bookings report returns summary + rows');
  ok(rep.data.summary.cancelled >= 1, 'report counts cancelled bookings');
  ok(rep.data.bookings.some(b => b.cancelledBy), 'report shows who cancelled');
  ok((await api('/api/org/report', { token: MEM })).status === 403, 'plain member cannot see the report');
  ok((await api('/api/console/report', { token: SAT })).status === 200, 'super admin report across all orgs');
  // member timezone (valid saved, invalid cleared)
  await api('/api/me/profile', { method: 'PUT', token: ADMIN, body: { timezone: 'Europe/London' } });
  ok((await api('/api/me', { token: ADMIN })).data.member.timezone === 'Europe/London', 'member timezone saved');
  await api('/api/me/profile', { method: 'PUT', token: ADMIN, body: { timezone: 'Not/AZone' } });
  ok((await api('/api/me', { token: ADMIN })).data.member.timezone === '', 'invalid timezone rejected');
  // demo request + ask-to-reschedule
  ok((await api('/api/demo-request', { method: 'POST', body: { name: 'Test', email: 't@example.org', org: 'Test Org' } })).status === 200, 'demo request accepted');
  ok((await api('/api/demo-request', { method: 'POST', body: { name: 'No Email' } })).status === 400, 'demo request needs an email');
  ok((await api('/api/org/bookings/' + bid + '/request-reschedule', { method: 'POST', token: ADMIN, body: {} })).status === 200, 'member can ask the booker to reschedule');

  // ---- v2: multi-coach services ----
  const adaId = (await api('/api/me', { token: ADMIN })).data.member.id;
  await api('/api/me/profile', { method: 'PUT', token: ADMIN, body: { title: 'Lead Coach', bio: 'Ten years experience.', imageUrl: 'https://example.org/ada.jpg' } });
  const svc = await api('/api/org/services', { method: 'POST', token: ADMIN, body: { name: 'Coaching', durationMins: 30, location: 'jitsi', assignMode: 'auto', memberIds: [adaId] } });
  ok(svc.status === 200 && svc.data.service.slug === 'coaching', 'org admin creates a multi-coach service');
  ok((await api('/api/org/services', { token: ADMIN })).data[0].coaches.length === 1, 'service lists its coaches');
  ok((await api('/api/org/services', { token: MEM })).status === 200, 'manager/member listing allowed; plain member?'); // member can view
  // public service discovery
  const pubSvcs = await api(`/api/biz/${oslug}/services`);
  ok(pubSvcs.status === 200 && pubSvcs.data.services.some(s => s.slug === 'coaching'), 'public sees the service');
  ok((await api(`/api/biz/${oslug}/services/coaching`)).data.coaches[0].title === 'Lead Coach', 'public sees coach profile');
  ok((await api(`/api/biz/${oslug}/services/coaching`)).data.service.showCoaches === true, 'service exposes showCoaches (default on)');
  await api('/api/org/services/' + svc.data.service.id, { method: 'PUT', token: ADMIN, body: { showCoaches: false } });
  ok((await api(`/api/biz/${oslug}/services/coaching`)).data.service.showCoaches === false, 'admin can hide the team on the booking page');
  // availability + aggregated slots + booking
  await api('/api/me/availability', { method: 'PUT', token: ADMIN, body: { availability: { 1: [{ start: '09:00', end: '17:00' }] }, blockedDates: [] } });
  const svcSlots = (await api(`/api/biz/${oslug}/services/coaching/slots?date=${mon}`)).data;
  ok((svcSlots.slots || []).length > 0, 'service shows aggregated coach availability');
  const sb = await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: svcSlots.slots[0].start, name: 'Pat', email: 'pat@example.org' } });
  ok(sb.data.booking?.id && sb.data.booking.memberName === 'Ada', 'service booking assigns an available coach');
  // intake questions: required answer enforced; answers reach the booking
  await api('/api/org/services/' + svc.data.service.id, { method: 'PUT', token: ADMIN, body: { intakeQuestions: [{ label: 'What is your goal?', type: 'text', required: true }] } });
  const sl2 = (await api(`/api/biz/${oslug}/services/coaching/slots?date=${mon}`)).data;
  ok((await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: sl2.slots[0].start, name: 'Q', email: 'q@example.org' } })).status === 400, 'required intake question is enforced');
  const ib = await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: sl2.slots[0].start, name: 'Q', email: 'q@example.org', intake: { q0: 'Improve confidence' } } });
  ok(ib.data.booking?.id && ib.data.manageUrl, 'intake answered booking succeeds with a manage link');

  // self-service cancel via the manage link
  const mtoken = ib.data.manageUrl.split('/').slice(-1)[0], mid = ib.data.manageUrl.split('/').slice(-2)[0];
  ok((await api('/api/manage/' + mid + '/' + mtoken)).data.title === 'Coaching', 'manage link returns booking details');
  ok((await api('/api/manage/' + mid + '/wrongtoken')).status === 404, 'bad manage token rejected');
  ok((await api('/api/manage/' + mid + '/' + mtoken + '/cancel', { method: 'POST' })).status === 200, 'visitor cancels via manage link');

  // group capacity: capacity 2 → two bookings fit, third is full
  await api('/api/org/services/' + svc.data.service.id, { method: 'PUT', token: ADMIN, body: { capacity: 2, intakeQuestions: [] } });
  const gd = nextMonday();
  const gslots = (await api(`/api/biz/${oslug}/services/coaching/slots?date=${gd}`)).data;
  const gstart = gslots.slots.find(s => s.seats >= 2)?.start || gslots.slots[0].start;
  ok((await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: gstart, name: 'G1', email: 'g1@example.org' } })).status === 200, 'group seat 1 booked');
  ok((await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: gstart, name: 'G2', email: 'g2@example.org' } })).status === 200, 'group seat 2 booked');
  const full = await api(`/api/biz/${oslug}/services/coaching/bookings`, { method: 'POST', body: { start: gstart, name: 'G3', email: 'g3@example.org' } });
  ok(full.status === 409 && full.data.full, 'group full once capacity reached');
  ok((await api(`/api/biz/${oslug}/services/coaching/waitlist`, { method: 'POST', body: { name: 'G3', email: 'g3@example.org', date: gd } })).status === 200, 'can join the waitlist when full');

  ok((await api('/api/org/services/' + svc.data.service.id, { method: 'DELETE', token: ADMIN })).status === 200, 'org admin deletes a service');

  // ---- no-code booking page wording ----
  ok((await api('/api/org/settings', { method: 'PUT', token: ADMIN, body: { bookingPage: { welcome: 'Welcome to Care Co', confirmButton: 'Book now' } } })).status === 200, 'org admin saves booking-page wording');
  const pubCfg = (await api(`/api/biz/${oslug}/config`)).data;
  ok(pubCfg.bookingPage && pubCfg.bookingPage.welcome === 'Welcome to Care Co' && pubCfg.bookingPage.confirmButton === 'Book now', 'public booking config exposes custom wording');
}

// ---- boot, run, report ----
const child = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET: 'test-secret', SUPERADMIN_EMAIL: SUPER.email, SUPERADMIN_PASSWORD: SUPER.password },
  stdio: ['ignore', 'ignore', 'inherit']
});

try {
  await waitReady();
  console.log('\nRunning Enjeeoh smoke tests...\n');
  await run();
} catch (e) {
  console.error('Test run error:', e.message); fail++;
} finally {
  child.kill();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) { console.log('Failed: ' + fails.join('; ')); process.exit(1); }
console.log('All critical paths passed.');
process.exit(0);
