---
name: stripe
description: Look up Stripe customers, subscriptions, charges, and payment methods. Cancel subscriptions and issue refunds. Use when investigating billing issues, subscription cancellations, or payment disputes.
allowed-tools: Bash, Read
---

# Stripe

Look up and manage Stripe customers, subscriptions, charges, and refunds for support investigations.

## Setup

### Required
- `STRIPE_SECRET_KEY` — from Stripe Dashboard > Developers > API Keys (Secret key)

## Quick Reference

```bash
SKILL_DIR=".claude/skills/stripe"

# Look up a customer by email (shows subscriptions, charges, invoices)
node "$SKILL_DIR/query.mjs" customer user@example.com

# Search customers using Stripe Search syntax
node "$SKILL_DIR/query.mjs" search "email:'user@example.com'"

# Get subscription details
node "$SKILL_DIR/query.mjs" subscription sub_1ABC123

# List charges for a customer
node "$SKILL_DIR/query.mjs" charges user@example.com

# List payment methods
node "$SKILL_DIR/query.mjs" payment-methods user@example.com

# Cancel a subscription IMMEDIATELY
node "$SKILL_DIR/query.mjs" cancel sub_1ABC123

# Cancel at end of billing period
node "$SKILL_DIR/query.mjs" cancel sub_1ABC123 --at-period-end

# Refund a specific charge (full)
node "$SKILL_DIR/query.mjs" refund ch_1ABC123

# Partial refund (amount in cents)
node "$SKILL_DIR/query.mjs" refund ch_1ABC123 --amount 500

# Refund with reason
node "$SKILL_DIR/query.mjs" refund ch_1ABC123 --reason requested_by_customer

# Preview all refundable charges (dry run)
node "$SKILL_DIR/query.mjs" refund-all user@example.com --dry-run

# Refund ALL charges for a customer
node "$SKILL_DIR/query.mjs" refund-all user@example.com --reason requested_by_customer
```

## Commands

| Command | Description |
|---------|-------------|
| `customer <email>` | Full customer lookup — details, subscriptions, charges, invoices |
| `search <query>` | Search customers using Stripe Search syntax |
| `subscription <sub_xxx>` | Get detailed subscription info |
| `charges <cus_xxx\|email>` | List charges for a customer |
| `payment-methods <cus_xxx\|email>` | List saved payment methods |
| `cancel <sub_xxx>` | Cancel subscription immediately |
| `cancel <sub_xxx> --at-period-end` | Cancel at end of current billing period |
| `refund <ch_xxx>` | Full refund of a charge |
| `refund <ch_xxx> --amount <cents>` | Partial refund |
| `refund-all <cus_xxx\|email>` | Refund all charges for a customer |
| `refund-all <cus_xxx\|email> --dry-run` | Preview refundable charges without refunding |

## Refund Reasons

Valid `--reason` values:
- `duplicate` — Charge was a duplicate
- `fraudulent` — Charge was fraudulent
- `requested_by_customer` — Customer requested the refund

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON (useful for piping/processing) |

## Safety Notes

- **Cancel** terminates the subscription immediately by default. Use `--at-period-end` for graceful cancellation.
- **Refund-all** with `--dry-run` first to preview. Without `--dry-run`, it refunds every non-refunded charge.
- Refunds and cancellations are **destructive and irreversible**. Always confirm with the human operator before executing.
- The `customer` command is read-only and safe to run at any time.

## When to Use This Skill

- Investigating billing/subscription issues reported in support tickets
- Verifying payment history for disputed charges
- Canceling subscriptions for users who request immediate termination
- Processing refunds for confirmed billing errors
- Cross-referencing Stripe data with Civitai's `CustomerSubscription` table
