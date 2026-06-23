// MongoDB store , same interface as jsonStore, with the members tier.
import { MongoClient } from 'mongodb';
import crypto from 'crypto';

let db = null;
const id = () => crypto.randomBytes(8).toString('hex');
const defaultHours = () => ({ 0: [], 1: [{ start: '09:00', end: '17:00' }], 2: [{ start: '09:00', end: '17:00' }],
  3: [{ start: '09:00', end: '17:00' }], 4: [{ start: '09:00', end: '17:00' }], 5: [{ start: '09:00', end: '17:00' }], 6: [] });

async function connect() {
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'openslot');
  await db.collection('accounts').createIndex({ slug: 1 }, { unique: true });
  await db.collection('members').createIndex({ email: 1 }, { unique: true });
  await db.collection('members').createIndex({ accountId: 1, slug: 1 });
  await db.collection('members').createIndex({ inviteToken: 1 });
  await db.collection('eventTypes').createIndex({ memberId: 1, slug: 1 });
  await db.collection('bookings').createIndex({ memberId: 1, eventTypeId: 1 });
  await db.collection('bookings').createIndex({ id: 1 });
  return db;
}
const c = async (name) => (await connect()).collection(name);

export const mongoStore = {
  async init() { await connect(); },

  async getLanding() { const d = await (await c('settings')).findOne({ key: 'landing' }); return d ? d.value : null; },
  async setLanding(cfg) { await (await c('settings')).updateOne({ key: 'landing' }, { $set: { key: 'landing', value: cfg } }, { upsert: true }); return cfg; },
  async getDonate() { const d = await (await c('settings')).findOne({ key: 'donate' }); return d ? d.value : null; },
  async setDonate(cfg) { await (await c('settings')).updateOne({ key: 'donate' }, { $set: { key: 'donate', value: cfg } }, { upsert: true }); return cfg; },
  async getPage(key) { const d = await (await c('settings')).findOne({ key: 'page:' + key }); return d ? d.value : null; },
  async getPlatformAdmins() { return (await c('platformAdmins')).find({}).sort({ createdAt: -1 }).toArray(); },
  async getPlatformAdminByEmail(email) { return (await c('platformAdmins')).findOne({ email }); },
  async addPlatformAdmin(rec) { const r = { id: id(), createdAt: new Date().toISOString(), ...rec }; await (await c('platformAdmins')).insertOne(r); return r; },
  async removePlatformAdmin(aid) { await (await c('platformAdmins')).deleteOne({ id: aid }); },
  async getPlatformAdminById(aid) { return (await c('platformAdmins')).findOne({ id: aid }); },
  async updatePlatformAdmin(aid, patch) { await (await c('platformAdmins')).updateOne({ id: aid }, { $set: patch }); return (await c('platformAdmins')).findOne({ id: aid }); },
  async addLog(e) { const r = { id: id(), ts: new Date().toISOString(), ...e }; await (await c('logs')).insertOne(r); return r; },
  async listLogs(limit = 200) { return (await c('logs')).find({}).sort({ ts: -1 }).limit(limit).toArray(); },
  async queryLogs({ q = '', sort = 'ts', dir = 'desc', offset = 0, limit = 50 } = {}) {
    const col = await c('logs');
    let filter = {};
    if (q) { const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter = { $or: ['action', 'actor', 'actorRole', 'accountName', 'detail', 'ip'].map(f => ({ [f]: rx })) }; }
    const total = await col.countDocuments(filter);
    const items = await col.find(filter, { projection: { _id: 0 } }).sort({ [sort]: dir === 'asc' ? 1 : -1 }).skip(offset).limit(limit).toArray();
    return { items, total };
  },
  async countMembers(accountId) { return (await c('members')).countDocuments({ accountId }); },
  async countAllMembers() { return (await c('members')).countDocuments({}); },
  async listAllMembers() { return (await c('members')).find({}, { projection: { _id: 0 } }).toArray(); },
  async setPage(key, cfg) { await (await c('settings')).updateOne({ key: 'page:' + key }, { $set: { key: 'page:' + key, value: cfg } }, { upsert: true }); return cfg; },

  async createAccount(acct) { const a = { id: id(), createdAt: new Date().toISOString(), memberSelfManage: true, ...acct }; await (await c('accounts')).insertOne(a); return a; },
  async listAllAccounts() { return (await c('accounts')).find({}).sort({ createdAt: -1 }).toArray(); },
  async getAccountBySlug(slug) { return (await c('accounts')).findOne({ slug }); },
  async getAccountById(aid) { return (await c('accounts')).findOne({ id: aid }); },
  async deleteAccount(aid) {
    await (await c('members')).deleteMany({ accountId: aid });
    await (await c('eventTypes')).deleteMany({ accountId: aid });
    await (await c('bookings')).deleteMany({ accountId: aid });
    await (await c('services')).deleteMany({ accountId: aid });
    await (await c('waitlist')).deleteMany({ accountId: aid });
    await (await c('accounts')).deleteOne({ id: aid });
  },
  async updateAccount(aid, patch) { await (await c('accounts')).updateOne({ id: aid }, { $set: patch }); return this.getAccountById(aid); },

  async createMember(accountId, m) { const rec = { id: id(), accountId, availability: defaultHours(), createdAt: new Date().toISOString(), ...m }; await (await c('members')).insertOne(rec); return rec; },
  async getMemberByEmail(email) { return (await c('members')).findOne({ email }); },
  async getMemberById(mid) { return (await c('members')).findOne({ id: mid }); },
  async getMemberBySlug(accountId, slug) { return (await c('members')).findOne({ accountId, slug }); },
  async getMemberByInvite(token) { return (await c('members')).findOne({ inviteToken: token }); },
  async getMemberByReset(token) { return (await c('members')).findOne({ resetToken: token }); },
  async listMembers(accountId) { return (await c('members')).find({ accountId }).toArray(); },
  async updateMember(mid, patch) { await (await c('members')).updateOne({ id: mid }, { $set: patch }); return this.getMemberById(mid); },
  async deleteMember(mid) {
    await (await c('members')).deleteOne({ id: mid });
    await (await c('eventTypes')).deleteMany({ memberId: mid });
    await (await c('bookings')).updateMany({ memberId: mid, status: { $ne: 'cancelled' } }, { $set: { status: 'cancelled' } });
    await (await c('services')).updateMany({ memberIds: mid }, { $pull: { memberIds: mid } });
  },

  async listEventTypesByMember(memberId) { return (await c('eventTypes')).find({ memberId }).toArray(); },
  async getEventType(memberId, slug) { return (await c('eventTypes')).findOne({ memberId, slug }); },
  async getEventTypeById(eid) { return (await c('eventTypes')).findOne({ id: eid }); },
  async createEventType(accountId, memberId, ev) { const e = { id: id(), accountId, memberId, ...ev }; await (await c('eventTypes')).insertOne(e); return e; },
  async deleteEventType(memberId, eid) { await (await c('eventTypes')).deleteOne({ memberId, id: eid }); },

  // ---- services (v2) ----
  async createService(accountId, svc) { const s = { id: id(), accountId, memberIds: [], assignMode: 'choose', active: true, createdAt: new Date().toISOString(), rrIndex: 0, ...svc }; await (await c('services')).insertOne(s); return s; },
  async listServices(accountId) { return (await c('services')).find({ accountId }, { projection: { _id: 0 } }).toArray(); },
  async getServiceById(sid) { return (await c('services')).findOne({ id: sid }, { projection: { _id: 0 } }); },
  async getServiceBySlug(accountId, slug) { return (await c('services')).findOne({ accountId, slug }, { projection: { _id: 0 } }); },
  async updateService(sid, patch) { await (await c('services')).updateOne({ id: sid }, { $set: patch }); return this.getServiceById(sid); },
  async deleteService(sid) { await (await c('services')).deleteOne({ id: sid }); await (await c('waitlist')).deleteMany({ serviceId: sid }); },

  async addWaitlist(w) { const r = { id: id(), notified: false, createdAt: new Date().toISOString(), ...w }; await (await c('waitlist')).insertOne(r); return r; },
  async listWaitlist(serviceId) { return (await c('waitlist')).find({ serviceId }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(); },
  async updateWaitlist(wid, patch) { await (await c('waitlist')).updateOne({ id: wid }, { $set: patch }); return (await c('waitlist')).findOne({ id: wid }, { projection: { _id: 0 } }); },

  async createBooking(accountId, memberId, b) { const rec = { id: crypto.randomBytes(6).toString('hex'), accountId, memberId, status: 'confirmed', createdAt: new Date().toISOString(), ...b }; await (await c('bookings')).insertOne(rec); return rec; },
  async listBookingsByMember(memberId) { return (await c('bookings')).find({ memberId }).toArray(); },
  async listBookingsByAccount(accountId) { return (await c('bookings')).find({ accountId }, { projection: { _id: 0 } }).toArray(); },
  async listAllBookings() { return (await c('bookings')).find({}, { projection: { _id: 0 } }).toArray(); },
  async listBookingsBetween(fromIso, toIso) { return (await c('bookings')).find({ status: { $ne: 'cancelled' }, start: { $gte: fromIso, $lte: toIso } }, { projection: { _id: 0 } }).toArray(); },
  async getBookingPublic(bid) { return (await c('bookings')).findOne({ id: bid }); },
  async getBookingById(bid) { return (await c('bookings')).findOne({ id: bid }); },
  async updateBooking(bid, patch) { await (await c('bookings')).updateOne({ id: bid }, { $set: patch }); return (await c('bookings')).findOne({ id: bid }); },
  async cancelBooking(memberId, bid) { await (await c('bookings')).updateOne({ memberId, id: bid }, { $set: { status: 'cancelled' } }); },
  async findClash(memberId, eventTypeId, startMs, endMs) {
    const rows = await (await c('bookings')).find({ memberId, eventTypeId, status: { $ne: 'cancelled' } }).toArray();
    return rows.some(b => startMs < new Date(b.end).getTime() && endMs > new Date(b.start).getTime());
  }
};
