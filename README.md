# Enjeeoh for NGOs

A free, **multi-tenant** booking platform built for non-profits. Every
NGO gets its own account, its own branded booking page, and **every feature**. No tiers, no fees, no billing. Organisations are **verified before activation**, so the
platform stays for genuine non-profits.

Built with Node.js, Express, and MongoDB (or a JSON file for development).

---

## How it works

1. An NGO applies at `/signup` with their organisation details (name, country,
   registration/charity number, mission). Their account is created as **pending**.
2. You (the reviewer) log in at `/review`, check their details, and **approve or
   reject**. Pending and rejected accounts cannot take public bookings.
3. Once approved, the NGO's dashboard unlocks and their booking page goes live at
   `/book/<their-slug>`, with every feature available, free.

Each NGO's data (event types, availability, bookings) is fully isolated by
`accountId`, so organisations never see each other's information.

## What's included for every verified NGO (all free)

- Unlimited meeting/event types
- Custom branding (their colour, their name)
- Timezone-aware availability and double-booking prevention
- Universal calendar invites: `.ics` + Add-to-Google / Add-to-Outlook links
- Free built-in video calls via Jitsi (no API keys)
- An embeddable "Book a time" button for any website they own
- Optional email confirmations

There is intentionally **no paid tier**. The only gate is NGO verification.

---

## Run locally (uses the JSON file store, zero database setup)

Requires Node.js 18+.

```
npm install
REVIEWER_EMAIL=you@org.org REVIEWER_PASSWORD=choose-one npm start
```

Then:
- Apply as an NGO: http://localhost:3000/signup
- Review applications: http://localhost:3000/review (log in with the reviewer creds above)
- NGO dashboard: http://localhost:3000/admin
- A booking page (after approval): http://localhost:3000/book/<org-slug>

## Deploy on Railway (production, with MongoDB)

1. Push this folder to a GitHub repo.
2. Railway -> New Project -> Deploy from GitHub repo.
3. Railway -> Variables, set everything from `.env.example`:
   - `PUBLIC_URL` = your Railway URL
   - `JWT_SECRET` = a long random string
   - `REVIEWER_EMAIL` / `REVIEWER_PASSWORD` = your verification login
   - `MONGODB_URI` = your MongoDB Atlas connection string (this switches storage to Mongo)
   - (optional) `SMTP_*` for email + `REVIEW_NOTIFY_EMAIL` to be alerted of new applications
4. Railway runs `npm start`. Done.

### Storage: JSON vs MongoDB

The app auto-selects its database:
- **No `MONGODB_URI`** -> a local JSON file (`data/platform.json`). Great for testing.
  On Railway, attach a Volume at `/data` and set `DATA_DIR=/data` so it persists.
- **`MONGODB_URI` set** -> MongoDB (your Atlas cluster). This is what you want for many
  NGOs. It handles concurrent writes and scales. Indexes are created automatically.

Both implement the same interface (`src/store/jsonStore.js` and `src/store/mongoStore.js`),
so nothing else in the code changes when you switch.

---

## What's stubbed for later

- **Google Meet / Zoom / Teams auto-links** still need each provider's OAuth setup.
  The location field accepts a custom link today (paste a Meet/Zoom URL per event);
  auto-generation is the next build. Jitsi covers video for free with zero setup.
- **Reviewer accounts** are a single env-based login for now. A multi-reviewer system
  with its own user table is a natural next step if your team grows.

## Project layout

```
server.js                 Express app: signup, login, dashboard, public booking, review
src/store/index.js        Picks JSON or MongoDB automatically
src/store/jsonStore.js    JSON file store (dev), multi-tenant
src/store/mongoStore.js   MongoDB store (production), same interface
src/availability.js       Timezone-aware slot computation
src/ics.js                Calendar invite + Google/Outlook links
src/auth.js               Account + reviewer auth, optional email
public/signup.html        NGO application form
public/review.html        Your verification console
public/admin.html         NGO dashboard
public/book.html          Public per-NGO booking page
public/index.html         Landing page
```

Proprietary. All rights reserved.

---

## Teams: multiple users per organisation

Each NGO can have unlimited members, and **every member has their own login and their
own availability**. The applicant becomes the org **admin**; the admin invites others
by email (`/admin` -> Organisation -> Team members), and each invitee sets their own
password and hours via a join link.

### Two permission modes (set per organisation, toggle any time)

- **Members manage their own** (default): each member creates their own meeting types
  and sets their own hours.
- **Admin-controlled**: only admins create meeting types (for any member); members
  still set their own hours. The admin sets a member up via "Set up" on the team list.

Admins can always do everything. The toggle only governs what regular members may do.

### Public URLs with members

- Team page: `/book/<org>` lists everyone; visitors pick a person.
- Direct: `/book/<org>/<member>` goes straight to one person's calendar.
- A booking attaches to that specific member; their availability and clashes are theirs alone.

## Branded URLs

Three levels, increasingly "their brand":

1. **Path** (default): `your-app.com/book/riverside-community-trust/james`
2. **Subdomain**: `riverside.openslot.org`. Set `BASE_DOMAIN=openslot.org` and add a
   wildcard DNS record `*.openslot.org`. One wildcard TLS cert covers all orgs.
3. **Custom domain**: `bookings.riverside.org`. The NGO sets the value in their org
   settings and points a CNAME at your app. You provision TLS for that domain
   (Railway custom domains / Cloudflare for SaaS / Caddy on-demand TLS).

The app resolves the incoming Host header to the right organisation automatically.

---

## Editing the landing page (visual editor)

The public marketing page is editable without touching code. Sign in at `/editor`
with your reviewer login. You can click any text on the page to edit it in place
(headline, badge, subheadline, buttons, feature cards), and use the Design panel to
choose an accent colour, a light or dark theme, and an entrance animation. Press
"Save and publish" and the public landing at `/` updates immediately, rendering your
content and playing the animation you chose. Content is stored in the database, so it
survives restarts and deploys.

---

## Donations (keeping the platform funded)

A donation page lives at `/donate`. It is built to route supporters to a secure,
hosted checkout, so Enjeeoh never handles card details. Sign in there with your
reviewer login and press "Edit donation page" to set your heading, suggested amounts,
currency, and one or more payment links: Stripe Payment Link, Open Collective, GitHub
Sponsors, PayPal, or Ko-fi. The settings are stored in the database and shown publicly.

For a project that funds a free service for NGOs, Open Collective and
GitHub Sponsors are good first choices because they are transparent and built for this.
Open Collective can also act as a fiscal host, which can save you setting up your own
legal entity. Accepting donations has tax and reporting implications that vary by
country, so check the rules that apply to you before going live. This is general
information, not legal or financial advice.

---

## About and demo pages

Two public pages are included:

- `/about` tells the Enjeeoh story, values, how it works, and a team section. The
  team names on it are placeholders to replace with your own in `public/about.html`.
- `/demo` is a full working demo of the booking experience using a fictional charity,
  Riverside Community Trust, with sample team members. A visitor can pick a person,
  choose a time, and book, all without signing up. It is self-contained sample data.

Both are linked from the landing navigation alongside Support.
