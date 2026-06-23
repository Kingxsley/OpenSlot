# Pre-launch checklist

Two kinds of testing. Run the automated suite for the logic, then walk this
checklist on the deployed instance for the things a script cannot verify.

## Automated (run this first, after `npm install`)

```
npm test
```

This boots the app in an isolated temporary data directory and checks signup and
org-email enforcement, the password policy, two-factor (enrolment, login challenge,
recovery codes and reuse protection), the full role matrix (super admin, onboarding,
content), role allocation, user limits, offboarding of an org and a member, the
booking create / reschedule / cancel lifecycle, manager permissions, and blocked
dates. It should report all checks passed. Run it again after every change.

## Manual, on the deployed instance

These need a human because they involve real email, a real phone, real DNS, and
real eyes on a screen.

1. Persistence. Set `MONGODB_URI`, deploy, create an organisation, then redeploy.
   The account must still exist and log in. If it vanishes, persistence is not set up.

2. Email delivery. With Brevo `SMTP_*` set, use "Forgot your password?" on `/admin`
   and invite a member. Both emails should arrive (check spam too), and every link in
   them must point to your real address, not localhost.

3. Two-factor with a real app. On a member dashboard, set up two factor, scan the QR
   with Google Authenticator or Authy, confirm a code, and save the recovery codes.
   Log out and back in using a code. Then log in once using a recovery code and
   confirm that same code no longer works.

4. The booking round trip. Approve a test organisation, set availability, then from
   the public booking page book a slot as an outsider. Confirm the calendar invite
   arrives and the video link works. Cancel and reschedule it from the dashboard and
   confirm the person who booked is emailed each time.

5. Blocked days. Block a day in the dashboard calendar and confirm that day offers no
   times on the public booking page.

6. Console roles. Sign in at `/console` as the super admin. Create an onboarding admin
   and a content admin. Sign in as each and confirm they only see their own tabs and
   cannot reach the others.

7. Offboarding. Suspend a test organisation and confirm its users cannot sign in.
   Restore it and confirm they can again.

8. Stripe support page. Paste your Stripe payment link into the support page settings,
   then click through as a visitor and confirm Stripe's checkout opens.

9. TLS and domain. Once `enjeeoh.com` and `enjeeoh.com.au` point at the service,
   confirm both load over https and that booking and invite links use the domain.

10. Mobile. Open the landing, booking, dashboard, and console pages on a phone and
    check nothing overflows or overlaps.
