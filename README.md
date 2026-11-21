# Prime Trust Bank

A full-stack demo banking app: Express API, SQLite database, and a mobile-style web app in plain HTML/CSS/JS.
Before it holds real customer funds it needs the compliance and payment-rail work listed at the bottom of this file.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # API smoke test on a throwaway database
```

## What it does

- Register and log in (bcrypt passwords, 8-hour httpOnly session cookie)
- A 10-digit account number and a debit card per user
- Send money to another user by account number (name is shown before you confirm)
- Airtime and bill payments, approved with a 4-digit transaction PIN
- Freeze and unfreeze the card
- Transaction history and recent beneficiaries
- "Add funds" shows the account details to pay into. A test-funding endpoint exists for development and is off in production (`ALLOW_SANDBOX_FUNDING=false`).

## How the money side is built

- Amounts are integer cents, never floats.
- Every movement writes two ledger rows (debit and credit) inside one SQLite transaction, so a transfer either fully happens or not at all. Balances cannot go below zero (database CHECK constraint plus an application check).
- Send, airtime, bills and deposits accept an `Idempotency-Key` header, so a retried request cannot charge twice. The frontend sends one per form.
- The test suite checks that all balances (users plus system accounts) sum to zero after a run of transfers.

## Security measures included

- Passwords and PINs hashed with bcrypt; login lockout after 5 bad passwords, PIN lockout after 5 bad PINs
- Rate limits on auth and money endpoints
- Cookies: httpOnly, SameSite=Strict, Secure in production; JSON-only writes block cross-site form posts
- Helmet security headers with a strict Content-Security-Policy (no inline scripts)
- Input validation on every endpoint; all user text is escaped before it is shown

## Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Required when `NODE_ENV=production`. Use a long random string. |
| `ALLOW_SANDBOX_FUNDING` | `true` enables a test-only endpoint that credits free money. Keep `false` in production. Default `true` for local development. |
| `DB_PATH` | Where the SQLite file lives. Default `./data/bank.db`. |
| `PORT` | Default `3000`. |

## Deploying (for example on Railway)

1. Push the folder to GitHub and create a service from the repo.
2. Add a volume and set `DB_PATH` to a file on it (for example `/data/bank.db`), or SQLite data is lost on redeploy.
3. Set `NODE_ENV=production` and a strong `JWT_SECRET`.

## Before this could ever handle real money

This is a learning and portfolio project. Real banking needs, at minimum: a banking licence or a licensed partner (for example a BaaS provider), KYC/AML checks, a real payments rail for deposits and withdrawals, 2FA and device checks, audit logging, backups, and a security review. Swapping SQLite for Postgres is also advisable for production.
