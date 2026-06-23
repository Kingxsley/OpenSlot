// Slot engine , pure functions, no storage dependency.
// Timezone-aware via Intl (no external deps).

function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMin = tzOffsetMinutes(new Date(guess), timeZone);
  return new Date(guess - offsetMin * 60000);
}

function hmToMinutes(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }

export function slotsForDate({ dateStr, durationMins, timeZone, availability, bookedRanges = [], now = new Date() }) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const windows = availability[weekday] || [];
  const step = 15;
  const booked = bookedRanges.map(b => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }));
  const slots = [];
  for (const w of windows) {
    const ws = hmToMinutes(w.start), we = hmToMinutes(w.end);
    for (let m = ws; m + durationMins <= we; m += step) {
      const start = zonedTimeToUtc(year, month, day, Math.floor(m / 60), m % 60, timeZone);
      const end = new Date(start.getTime() + durationMins * 60000);
      if (start.getTime() < now.getTime() + 60 * 60000) continue;
      if (booked.some(b => start.getTime() < b.e && end.getTime() > b.s)) continue;
      slots.push({ start: start.toISOString(), end: end.toISOString() });
    }
  }
  return slots;
}

export function labelTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}
