# Stripe sandbox for local dev

Local dev should run against a Stripe **sandbox** (test mode), never a live key: a live key in a
local `.env` means a local checkout, refund or webhook replay moves real money.

## Keys

| Variable | Sandbox value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` from the sandbox's Developers > API keys |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` from the same page |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` printed by `stripe listen` (below) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | the same `whsec_...`; `stripe listen` signs every event it forwards with one secret |
| `STRIPE_DONATE_ID` | the sandbox copy of the donate price (from the sync's id map) |

Check which mode a key is in without changing anything; `livemode` is `false` for a sandbox key:

```bash
curl -s https://api.stripe.com/v1/balance -u "$STRIPE_SECRET_KEY:" | grep livemode
```

The `stripe` skill (`.claude/skills/stripe`) is a support tool for the live account. It reads its
own `.claude/skills/stripe/.env` first and falls back to the repo `.env`, so once the repo `.env`
holds a sandbox key, the skill needs its own `.env` or its lookups quietly hit the sandbox.

## Webhooks

```bash
stripe listen --api-key "$STRIPE_SECRET_KEY" --print-secret          # the whsec_ for .env
stripe listen --api-key "$STRIPE_SECRET_KEY" \
  --forward-to localhost:3000/api/webhooks/stripe \
  --forward-connect-to localhost:3000/api/webhooks/stripe-connect
```

## Copying the live catalogue into the sandbox

Checkout needs the membership products and prices, with their metadata (`tier`, Buzz amounts,
vault size...) and lookup keys. `scripts/stripe-sandbox/sync.ts` copies them from live:

```bash
pnpm exec tsx scripts/stripe-sandbox/sync.ts                          # dry run: prints the plan
pnpm exec tsx scripts/stripe-sandbox/sync.ts --apply --map-out ids.json
```

- **Live is read only.** The source key reaches only list calls. Every write goes through a client
  that refuses any key not starting `sk_test_`/`rk_test_`. Source key: `STRIPE_LIVE_READ_KEY`, else
  `STRIPE_SECRET_KEY` in `.claude/skills/stripe/.env`. A restricted live key with read access to
  products and prices is enough.
- **Matched by `metadata.live_id`, not by id**, because ids differ between accounts. Re-runs update
  in place and create nothing new. A price whose amount, currency or interval changed in live gets a
  new sandbox price (prices are immutable); the lookup key and product default move to it, and the old
  copy is archived.
- Sandbox objects without `metadata.live_id` (made by hand, or by other tests) are never touched, so
  older hand-made copies with the same names can sit beside the synced ones.
- Inactive live products and prices are skipped unless `--include-inactive`. Tiered prices are skipped.
- `ids.json` maps each live id to its sandbox id.

### Membership checkout stays broken locally (for now)

The app reads `Product` and `Price` rows from the database (written by the Stripe webhook), then
hands those ids to Stripe. A database cloned from production holds live ids, so with a sandbox key
a membership checkout fails at `prices.retrieve`. Writing the sandbox rows into a shared dev
database would show them to every live-key environment reading it too, so that waits for the app
to tell sandbox rows (`metadata.live_id`) from live ones by key mode.
