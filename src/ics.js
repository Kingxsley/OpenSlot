// Universal calendar delivery. An .ics file imports into Google Calendar,
// Outlook, Apple Calendar, Teams , everything , with zero OAuth setup.
// We also build "Add to Google / Outlook" web links.

function pad(n) { return String(n).padStart(2, '0'); }

function toICSDate(iso) {
  const d = new Date(iso);
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z'
  );
}

function escapeICS(s = '') {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildICS(booking) {
  const uid = `${booking.id}@openslot`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenSlot//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date().toISOString())}`,
    `DTSTART:${toICSDate(booking.start)}`,
    `DTEND:${toICSDate(booking.end)}`,
    `SUMMARY:${escapeICS(booking.title)}`,
    `DESCRIPTION:${escapeICS(booking.description || '')}`,
    `LOCATION:${escapeICS(booking.locationText || '')}`,
    `ORGANIZER;CN=${escapeICS(booking.ownerName)}:mailto:${booking.ownerEmail || 'noreply@openslot.local'}`,
    `ATTENDEE;CN=${escapeICS(booking.name)};RSVP=TRUE:mailto:${booking.email}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.join('\r\n');
}

export function googleCalLink(booking) {
  const fmt = (iso) => toICSDate(iso);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: booking.title,
    dates: `${fmt(booking.start)}/${fmt(booking.end)}`,
    details: booking.description || '',
    location: booking.locationText || ''
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function outlookLink(booking) {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    startdt: booking.start,
    enddt: booking.end,
    subject: booking.title,
    body: booking.description || '',
    location: booking.locationText || ''
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
