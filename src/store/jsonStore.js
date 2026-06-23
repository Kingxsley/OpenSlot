// Multi-tenant JSON store, now with members inside each organisation.
// Hierarchy: account (NGO) -> members (people) -> their event types, availability, bookings.
// Every record carries accountId for tenant isolation; member data also carries memberId.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'platform.json');

function blank() { return { accounts: [], members: [], eventTypes: [], bookings: [], services: [], waitlist: [] }; }
function ensure() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function read() {
  ensure();
  if (!fs.existsSync(FILE)) { fs.writeFileSync(FILE, JSON.stringify(blank(), null, 2)); return blank(); }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return blank(); }
}
let cache = null;
function data() { if (!cache) cache = read(); return cache; }
function flush() { ensure(); fs.writeFileSync(FILE, JSON.stringify(data(), null, 2)); }
const id = () => crypto.randomBytes(8).toString('hex');
const defaultHours = () => ({ 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }],
  3: [{ start: '09:00', end: '17:00' }], 4: [{ start: '09:00', end: '17:00' }], 5: [{ start: '09:00', end: '17:00' }], 6: [] });

export const jsonStore = {
  async init() { data(); },

  // ---- landing page content (single platform-level document) ----
  async getLanding() { return data().landing || null; },
  async setLanding(cfg) { data().landing = cfg; flush(); return cfg; },
  async getDonate() { return data().donate || null; },
  async setDonate(cfg) { data().donate = cfg; flush(); return cfg; },
  async getPage(key) { return (data().pages && data().pages[key]) || null; },
  async getPlatformAdmins() { return data().platformAdmins || []; },
  async getPlatformAdminByEmail(email) { return (data().platformAdmins || []).find(x => x.email === email) || null; },
  async addPlatformAdmin(rec) { if (!data().platformAdmins) data().platformAdmins = []; const r = { id: id(), createdAt: new Date().toISOString(), ...rec }; data().platformAdmins.push(r); flush(); return r; },
  async removePlatformAdmin(aid) { data().platformAdmins = (data().platformAdmins || []).filter(x => x.id !== aid); flush(); },
  async getPlatformAdminById(aid) { return (data().platformAdmins || []).find(x => x.id === aid) || null; },
  async updatePlatformAdmin(aid, patch) { const x = (data().platformAdmins || []).find(y => y.id === aid); if (x) { Object.assign(x, patch); flush(); } return x; },
  async addLog(e) { if (!data().logs) data().logs = []; const r = { id: id(), ts: new Date().toISOString(), ...e }; data().logs.push(r); if (data().logs.length > 5000) data().logs = data().logs.slice(-5000); flush(); return r; },
  async listLogs(limit = 200) { return [...(data().logs || [])].reverse().slice(0, limit); },
  // Filter, sort and paginate logs. Returns { items, total } for the matching set.
  async queryLogs({ q = '', sort = 'ts', dir = 'desc', offset = 0, limit = 50 } = {}) {
    let rows = [...(data().logs || [])];
    if (q) { const needle = q.toLowerCase(); rows = rows.filter(l => [l.action, l.actor, l.actorRole, l.accountName, l.detail, l.ip].some(v => String(v || '').toLowerCase().includes(needle))); }
    rows.sort((a, b) => { const x = String(a[sort] ?? ''), y = String(b[sort] ?? ''); return dir === 'asc' ? x.localeCompare(y) : y.localeCompare(x); });
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  },
  async countMembers(accountId) { return data().members.filter(m => m.accountId === accountId).length; },
  async countAllMembers() { return data().members.length; },
  async listAllMembers() { return [...data().members]; },
  async setPage(key, cfg) { if (!data().pages) data().pages = {}; data().pages[key] = cfg; flush(); return cfg; },

  // ---- accounts (organisations) ----
  async createAccount(acct) {
    const a = { id: id(), createdAt: new Date().toISOString(), memberSelfManage: true, ...acct };
    data().accounts.push(a); flush(); return a;
  },
  async listAllAccounts() { return [...data().accounts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); },
  async getAccountBySlug(slug) { return data().accounts.find(a => a.slug === slug) || null; },
  async getAccountById(aid) { return data().accounts.find(a => a.id === aid) || null; },
  async deleteAccount(aid) {
    const d = data();
    d.members = (d.members || []).filter(m => m.accountId !== aid);
    if (d.eventTypes) d.eventTypes = d.eventTypes.filter(e => e.accountId !== aid);
    if (d.bookings) d.bookings = d.bookings.filter(b => b.accountId !== aid);
    if (d.services) d.services = d.services.filter(s => s.accountId !== aid);
    if (d.waitlist) d.waitlist = d.waitlist.filter(w => w.accountId !== aid);
    d.accounts = (d.accounts || []).filter(a => a.id !== aid);
    flush();
  },
  async updateAccount(aid, patch) { const a = data().accounts.find(x => x.id === aid); if (a) { Object.assign(a, patch); flush(); } return a; },

  // ---- members (people inside an org) ----
  async createMember(accountId, m) {
    const rec = { id: id(), accountId, availability: defaultHours(), createdAt: new Date().toISOString(), ...m };
    data().members.push(rec); flush(); return rec;
  },
  async getMemberByEmail(email) { return data().members.find(m => m.email === email) || null; },
  async getMemberById(mid) { return data().members.find(m => m.id === mid) || null; },
  async getMemberBySlug(accountId, slug) { return data().members.find(m => m.accountId === accountId && m.slug === slug) || null; },
  async getMemberByInvite(token) { return data().members.find(m => m.inviteToken === token) || null; },
  async getMemberByReset(token) { return data().members.find(m => m.resetToken === token) || null; },
  async listMembers(accountId) { return data().members.filter(m => m.accountId === accountId); },
  async updateMember(mid, patch) { const m = data().members.find(x => x.id === mid); if (m) { Object.assign(m, patch); flush(); } return m; },
  async deleteMember(mid) {
    data().members = data().members.filter(m => m.id !== mid);
    data().eventTypes = data().eventTypes.filter(e => e.memberId !== mid);
    data().bookings.forEach(b => { if (b.memberId === mid && b.status !== 'cancelled') b.status = 'cancelled'; });
    (data().services || []).forEach(s => { if (Array.isArray(s.memberIds)) s.memberIds = s.memberIds.filter(x => x !== mid); });
    flush();
  },

  // ---- event types (belong to a member) ----
  async listEventTypesByMember(memberId) { return data().eventTypes.filter(e => e.memberId === memberId); },
  async getEventType(memberId, slug) { return data().eventTypes.find(e => e.memberId === memberId && e.slug === slug) || null; },
  async getEventTypeById(eid) { return data().eventTypes.find(e => e.id === eid) || null; },
  async createEventType(accountId, memberId, ev) { const e = { id: id(), accountId, memberId, ...ev }; data().eventTypes.push(e); flush(); return e; },
  async deleteEventType(memberId, eid) { data().eventTypes = data().eventTypes.filter(e => !(e.memberId === memberId && e.id === eid)); flush(); },

  // ---- services (v2): a named service staffed by several members (coaches) ----
  async createService(accountId, svc) {
    if (!data().services) data().services = [];
    const s = { id: id(), accountId, memberIds: [], assignMode: 'choose', active: true, createdAt: new Date().toISOString(), rrIndex: 0, ...svc };
    data().services.push(s); flush(); return s;
  },
  async listServices(accountId) { return (data().services || []).filter(s => s.accountId === accountId); },
  async getServiceById(sid) { return (data().services || []).find(s => s.id === sid) || null; },
  async getServiceBySlug(accountId, slug) { return (data().services || []).find(s => s.accountId === accountId && s.slug === slug) || null; },
  async updateService(sid, patch) { const s = (data().services || []).find(x => x.id === sid); if (s) { Object.assign(s, patch); flush(); } return s; },
  async deleteService(sid) { data().services = (data().services || []).filter(s => s.id !== sid); data().waitlist = (data().waitlist || []).filter(w => w.serviceId !== sid); flush(); },

  // ---- waitlist (v2) ----
  async addWaitlist(w) { if (!data().waitlist) data().waitlist = []; const r = { id: id(), notified: false, createdAt: new Date().toISOString(), ...w }; data().waitlist.push(r); flush(); return r; },
  async listWaitlist(serviceId) { return (data().waitlist || []).filter(w => w.serviceId === serviceId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); },
  async updateWaitlist(wid, patch) { const w = (data().waitlist || []).find(x => x.id === wid); if (w) { Object.assign(w, patch); flush(); } return w; },

  // ---- bookings ----
  async createBooking(accountId, memberId, b) {
    const rec = { id: crypto.randomBytes(6).toString('hex'), accountId, memberId, status: 'confirmed', createdAt: new Date().toISOString(), ...b };
    data().bookings.push(rec); flush(); return rec;
  },
  async listBookingsByMember(memberId) { return data().bookings.filter(b => b.memberId === memberId); },
  async listBookingsByAccount(accountId) { return data().bookings.filter(b => b.accountId === accountId); },
  async listAllBookings() { return [...(data().bookings || [])]; },
  async listBookingsBetween(fromIso, toIso) { return (data().bookings || []).filter(b => b.status !== 'cancelled' && b.start >= fromIso && b.start <= toIso); },
  async getBookingPublic(bid) { return data().bookings.find(b => b.id === bid) || null; },
  async getBookingById(bid) { return data().bookings.find(b => b.id === bid) || null; },
  async updateBooking(bid, patch) { const b = data().bookings.find(x => x.id === bid); if (b) { Object.assign(b, patch); flush(); } return b; },
  async cancelBooking(memberId, bid) { const b = data().bookings.find(x => x.memberId === memberId && x.id === bid); if (b) { b.status = 'cancelled'; flush(); } },
  async findClash(memberId, eventTypeId, startMs, endMs) {
    return data().bookings.some(b => b.memberId === memberId && b.eventTypeId === eventTypeId && b.status !== 'cancelled' &&
      startMs < new Date(b.end).getTime() && endMs > new Date(b.start).getTime());
  }
};
