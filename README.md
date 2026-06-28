# Enjeeoh for NGOs

A free, multi-tenant booking platform built for non-profits. Every organisation
gets its own account, its own branded booking page, and every feature. No tiers,
no fees, no billing. Organisations are verified before activation, so the platform
stays for genuine non-profits.

Built with Node.js and Express, on MongoDB (or a JSON file for development). No build
step: the front end is plain HTML, CSS and JavaScript served from `public/`.

---

## How it works

1. An organisation applies at `/signup` (name, country, registration/charity number,
   mission). Their account is created as pending.
2. A super admin signs in at `/console`, reviews the application in the Applications
   tab (Pending / Approved / Rejected), and approves or rejects it.
3. Once approved, the organisation's dashboard unlocks and its booking page goes live
   at `/book/<slug>`, with every feature available, free.

Each organisation's data is fully isolated by `accountId`, so organisations never see
each other's information.

## What every verified organisation gets (all free)

- Unlimited members, each with their own login, availability and timezone.
- Per-person booking pages and team pages.
- Multi-coach services: one bookable service (for example Coaching) staffed by several
  people, with combined availability and automatic or visitor-chosen assignment.
- Group sessions with seat capacity, waitlists, and custom intake questions.
- Coach profiles with photo, public role/title and bio.
- Free built-in video calls via Jitsi (no API keys), or phone / in person / custom.
- Calendar invites (.ics, Add to Google, Add to Outlook).
- Email confirmations plus 24-hour and 4-hour reminders (and SMS if Twilio is set).
- A self-manage link in every booking email so people can reschedule or cancel without
  an account.
- A bookings report (held, upcoming, cancelled, rescheduled, and who acted) with
  pagination, filters and CSV export.
- An embeddable booking widget (button popup or inline) for the organisation's own site.
- Custom branding (colour and name) and no-code editable booking-page wording.

There is intentionally no paid tier. The only gate is verification.

---

## Putting bookings on your own website

The default booking URL is `your-app.com/book/<slug>`, but bookings can live entirely
on the organisation's own domain, two ways:

### 1. Inline embed (keep your existing /book page URL)

Drop one line into any page (WordPress, Squarespace, plain HTML) and the booking page
renders in place. The visitor's URL never changes.

```html
<script src="https://your-app.com/embed.js" data-org="your-slug" data-mode="inline" data-height="780"></script>
```

A button-and-popup variant is the default (omit `data-mode`). Options: `data-org`,
`data-member`, `data-event`, `data-mode` (`inline` or button), `data-height`,
`data-max-width`, `data-color`, `data-label`. The exact snippets for an organisation
are shown in its dashboard.

Tip: to gate bookings behind your own rules (eligibility questions, terms), show the
questions on your page first and only inject the embed script once the visitor passes.

### 2. Custom domain or subdomain

Point a domain at the app and the whole booking site serves there:

- Subdomain: set `BASE_DOMAIN=your-app.com` and a wildcard DNS record, then orgs are at
  `<slug>.your-app.com`.
- Custom domain: the org sets a custom domain in its settings (for example
  `bookings.theirorg.org`) and adds a CNAME to the app. Provision TLS for that domain
  (Railway custom domains, Cloudflare, or similar). The app resolves the incoming Host
  header to the right organisation automatically.

---

## Services (multi-coach booking)

In the dashboard, an admin creates a service and assigns the people who provide it. The
public picks the service, sees everyone's combined availability, and books. Per service
you can set: duration, location, image and intro text, who staffs it, how clashes are
handled (visitor chooses / auto-assign / round-robin), seat capacity for group sessions,
a waitlist, intake questions, whether to show the team, and "one active booking per
person". Times are computed in each coach's timezone and shown to visitors in their own.

## Demo bookings and the super-admin calendar

The `/demo` page lets a visitor request a demo. If a super admin publishes demo
availability (Console, Calendar tab), the page instead offers real time slots and the
visitor books directly, with a professional confirmation email and a self-manage link.
The Calendar tab shows an agenda of all upcoming sessions across the platform, flagging
anything starting within four hours.

---

## Run locally (JSON file store, zero database setup)

Requires Node.js 18+.

```
npm install
JWT_SECRET=dev-secret SUPERADMIN_EMAIL=you@org.org SUPERADMIN_PASSWORD=choose-a-long-one npm start
```

Then:
- Apply: http://localhost:3000/signup
- Super admin console: http://localhost:3000/console
- Dashboard: http://localhost:3000/admin
- A booking page (after approval): http://localhost:3000/book/<slug>

Run the test suite with `npm test`.

## Deploy on Railway (production, with MongoDB)

1. Push this folder to a GitHub repo.
2. Railway, New Project, Deploy from GitHub repo.
3. Railway, Variables, set what you need from `.env.example`:
   - `PUBLIC_URL` = your Railway URL (so email links are correct)
   - `JWT_SECRET` = a long random string
   - `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` = your console login
   - `MONGODB_URI` = a MongoDB Atlas connection string (see below, important)
   - Email (pick one): `RESEND_API_KEY` + `SMTP_FROM`, or `GMAIL_USER` + `GMAIL_APP_PASSWORD`
   - Optional `REVIEW_NOTIFY_EMAIL` to be alerted of new applications and demo requests
4. Railway runs `npm start`. The startup log prints warnings if anything important is
   missing.

### Storage: use MongoDB in production

The app auto-selects its database:
- No `MONGODB_URI`: a local JSON file (`data/platform.json`). Fine for testing.
- `MONGODB_URI` set: MongoDB Atlas. Use this in production. Railway's filesystem is
  ephemeral and is wiped on every deploy or restart, so without MongoDB you would lose
  all data. Indexes are created automatically.

Both backends implement the same interface (`src/store/jsonStore.js` and
`src/store/mongoStore.js`), so nothing else changes when you switch.

### Email setup (a common snag)

Pick one provider and set only its variables:
- Resend or Brevo: needs `SMTP_FROM` on a domain you have verified with them. They will
  reject a free mailbox like `@gmail.com`.
- Gmail (free, no domain): set `GMAIL_USER` and a Gmail App Password as
  `GMAIL_APP_PASSWORD`. Make sure `RESEND_API_KEY` and `BREVO_API_KEY` are not set, or
  they take priority.

Test it from Console, Security, "Email delivery test", which shows the exact result.

---

## Security

- Sessions in HttpOnly cookies with double-submit CSRF protection (not in local storage).
- bcrypt passwords; configurable policy with expiry, reminders and forced resets.
- Per-IP rate limiting on auth endpoints and temporary lockout after repeated failures.
- Security response headers (including a Content-Security-Policy) and HTTPS in production.
- Tenant isolation, input coercion, output escaping, and sanitised image URLs.

## Legal documents

`/privacy`, `/terms`, `/cookies`, `/acceptable-use` and `/dpa` ship as editable pages,
linked from a `/legal` index. Edit them in place (Console, Design), and each save keeps
a dated version you can restore or delete (Console, Design, Legal versions). Fill in the
bracketed placeholders and have them reviewed by a lawyer before launch.

## Roles and permissions

- Super admin: full console (applications, members, organisations, reports, calendar,
  emails, design, security).
- Platform admins: onboarding (approve applications) or content (edit the site).
- Organisation admin / manager / member: manage their own team, services and bookings.

## Project layout

```
server.js                 Express app and all API routes
src/store/index.js        Picks JSON or MongoDB automatically
src/store/jsonStore.js    JSON file store (dev), multi-tenant
src/store/mongoStore.js   MongoDB store (production), same interface
src/availability.js       Timezone-aware slot computation
src/ics.js                Calendar invite and Google/Outlook links
src/auth.js               Sessions, CSRF, email and SMS transport
public/                   All front-end pages and shared scripts
test/smoke.mjs            End-to-end smoke tests (npm test)
```

Proprietary. All rights reserved.
