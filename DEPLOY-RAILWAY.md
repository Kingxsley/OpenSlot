# Deploying OpenSlot on Railway

This gets your booking platform live on a real URL. It takes about ten minutes.
You do not run any setup scripts: the reviewer login comes from environment
variables, and the first organisation admin is created when someone signs up.

## Step 1. Put the code on GitHub

1. Create a new empty repository on GitHub (for example `openslot`).
2. From this project folder, push it up:

```
git init
git add .
git commit -m "OpenSlot for NGOs"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/openslot.git
git push -u origin main
```

`node_modules`, `.env` and the local `data` folder are already gitignored.

## Step 2. Create the Railway project

1. Go to railway.com and sign in.
2. Click **New Project**, then **Deploy from GitHub repo**, and pick your repo.
3. Railway auto-detects Node from `package.json` and runs `npm start`. It will do
   a first build straight away. Let it finish.

## Step 3. Choose your database

You have two options. Pick one.

### Option A (recommended for production): MongoDB Atlas

Use the same kind of cluster you already run for your forex app.

1. In MongoDB Atlas, create a cluster and a database user, and copy the
   connection string (looks like `mongodb+srv://user:pass@cluster.mongodb.net`).
2. In Railway, open your service, go to **Variables**, and add `MONGODB_URI` with
   that value. The app switches to MongoDB automatically when this is present.

No volume is needed with Atlas. This is the right choice once real NGOs use it.

### Option B (quick start, no external database): JSON file + volume

The app can run on a simple JSON file, but Railway wipes the filesystem on each
deploy, so you must attach a volume to keep your data.

1. In your Railway service, go to **Settings**, find **Volumes**, and create one
   mounted at `/data`.
2. In **Variables**, add `DATA_DIR` with the value `/data`.
3. Leave `MONGODB_URI` unset.

Good for testing. Switch to Option A before going live with real organisations.

## Step 4. Set the rest of the environment variables

In Railway, under **Variables**, add:

| Variable | What to put |
| --- | --- |
| `JWT_SECRET` | A long random string (used to sign logins) |
| `REVIEWER_EMAIL` | The email you will use to verify NGOs at `/review` |
| `REVIEWER_PASSWORD` | A strong password for that reviewer login |
| `PUBLIC_URL` | Your Railway URL (fill in after Step 5) |

Optional extras:

| Variable | What to put |
| --- | --- |
| `BASE_DOMAIN` | Your domain, to enable subdomains like `org.yourdomain.org` |
| `REVIEW_NOTIFY_EMAIL` | Where to be emailed when a new NGO applies |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | Email confirmations (optional, free) |

## Step 5. Get your public URL

1. In Railway, open the service, go to **Settings**, and under **Networking**
   click **Generate Domain**. Railway gives you something like
   `openslot-production-xxxx.up.railway.app` and handles HTTPS for you.
2. Copy that URL into the `PUBLIC_URL` variable from Step 4 and let it redeploy.

## Step 6. Use it

- Marketing page: `https://your-url/`
- An NGO applies: `https://your-url/signup`
- You verify NGOs: `https://your-url/review` (log in with `REVIEWER_EMAIL` and
  `REVIEWER_PASSWORD`)
- An approved NGO's dashboard: `https://your-url/admin`

## Custom domains (optional)

- For your own domain on the whole platform: in Railway **Settings, Networking,
  Custom Domain**, add it and follow the DNS instructions. Railway issues the
  certificate.
- For an NGO's own domain (`bookings.theirngo.org`): they set it in their org
  settings, point a CNAME at your Railway app, and you add that domain in Railway
  so it gets a certificate. The app then maps the domain to their organisation.

## Updating later

Push to the `main` branch and Railway redeploys automatically. With MongoDB Atlas
or a mounted volume, your data carries across deploys.
