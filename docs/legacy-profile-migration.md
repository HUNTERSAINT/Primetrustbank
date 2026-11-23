# Legacy customer profile migration (staging only)

This utility imports **profile records only** into the Railway PostgreSQL database. It does not migrate balances, transaction history, card data, identity documents, or legacy authentication secrets.

## Input CSV

Use a private local CSV with exactly these columns:

```csv
full_name,email
```

The reviewed legacy dump has been converted into a private profile-only CSV for this chat. Do not add it to this repository, GitHub, or a public issue.

## Safety and onboarding

- The importer is dry-run by default.
- It requires `--target=staging` and only writes when `--commit` is present.
- Duplicate email addresses already in the target database are skipped.
- Imported accounts have email verification pending and a zero opening balance.
- New random password and transaction-PIN hashes are generated. The old password and PIN hashes are never reused.
- Customers must verify their email and use password recovery before signing in.
- The current app does not yet provide a customer-facing transaction-PIN recovery flow. Do not use this importer for live customers until that flow is implemented and tested.

## Run against Railway staging

Run this from a trusted computer or private terminal. Do not paste the database URL into chat, GitHub, or screenshots.

1. Download the private CSV from the migration conversation and keep it local.
2. Set `DATABASE_URL` to the **Railway staging** PostgreSQL connection string.
3. Install the repository dependencies.
4. Run a dry run:

```sh
node scripts/legacy-profile-import.js ./legacy-profiles.csv --target=staging
```

5. Confirm the target is staging and the dry-run count is expected, then run:

```sh
node scripts/legacy-profile-import.js ./legacy-profiles.csv --target=staging --commit
```

The importer wraps all inserts in a single transaction and rolls back on error.

## Balances and ledger

Do not import the legacy `account_bal` value into `accounts.balance`. It came from a trading/investment schema and is not itself proof of cleared bank funds. If balances are later approved for migration, import them as documented, reconciled opening ledger entries with source references and audit records—not as silent balance edits.
