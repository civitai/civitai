# Webhook Events ClickHouse Tracking

Generic webhook event storage in ClickHouse for tracking and reporting.

## ClickHouse Table Setup

Run these queries in ClickHouse to create the tables:

```sql
-- Main table for webhook events (generic JSON dump)
CREATE TABLE IF NOT EXISTS webhook_events (
  type LowCardinality(String),
  received_at DateTime64(3) DEFAULT now64(3),
  payload String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(received_at)
ORDER BY (type, received_at)
TTL received_at + INTERVAL 2 YEAR;

-- Buffer table for handling individual webhook inserts
CREATE TABLE IF NOT EXISTS webhook_events_buffer AS webhook_events
ENGINE = Buffer(
  default,                    -- database
  webhook_events,             -- destination table
  16,                         -- num_layers
  10, 60,                     -- min/max seconds before flush
  100, 10000,                 -- min/max rows before flush
  10000, 10000000             -- min/max bytes before flush
);
```

## Implemented Webhooks

Tracking has been added to the following webhook handlers:

| Webhook | Type | File |
|---------|------|------|
| Coinbase | `coinbase` | `src/pages/api/webhooks/coinbase.ts` |
| Stripe | `stripe` | `src/pages/api/webhooks/stripe.ts` |
| Stripe Connect | `stripe-connect` | `src/pages/api/webhooks/stripe-connect.ts` |
| Paddle | `paddle` | `src/pages/api/webhooks/paddle.ts` |
| NOWPayments | `nowpayments` | `src/pages/api/webhooks/nowpayments.ts` |
| Tipalti | `tipalti` | `src/pages/api/webhooks/tipalti.ts` |

## Helper Function

A reusable helper function was added to `src/server/clickhouse/client.ts`:

```typescript
/** Track a webhook event to ClickHouse (fire and forget) */
export async function trackWebhookEvent(type: string, payload: string) {
  if (!clickhouse) return;

  try {
    await clickhouse.insert({
      table: 'webhook_events_buffer',
      values: [{ type, payload }],
      format: 'JSONEachRow',
    });
  } catch (error: any) {
    console.error(`Failed to track ${type} webhook to ClickHouse:`, error.message);
  }
}
```

## Useful Queries

ClickHouse can extract JSON fields on the fly. Here are some example queries:

```sql
-- Summary by webhook type
SELECT
  type,
  count() as count,
  min(received_at) as first_seen,
  max(received_at) as last_seen
FROM webhook_events
GROUP BY type
ORDER BY count DESC;

-- View recent events by type
SELECT received_at, payload
FROM webhook_events
WHERE type = 'coinbase'  -- or 'stripe', 'paddle', etc.
ORDER BY received_at DESC
LIMIT 100;

-- Coinbase: View confirmed charges
SELECT
  received_at,
  JSONExtractString(payload, 'event', 'type') as event_type,
  JSONExtractString(payload, 'event', 'data', 'code') as charge_code,
  JSONExtractString(payload, 'event', 'data', 'pricing', 'settlement', 'amount') as amount_usd
FROM webhook_events
WHERE type = 'coinbase'
  AND JSONExtractString(payload, 'event', 'type') = 'charge:confirmed'
ORDER BY received_at DESC;

-- Stripe: View payment intents
SELECT
  received_at,
  JSONExtractString(payload, 'type') as event_type,
  JSONExtractString(payload, 'data', 'object', 'id') as payment_id,
  JSONExtractInt(payload, 'data', 'object', 'amount') / 100 as amount_usd
FROM webhook_events
WHERE type = 'stripe'
  AND JSONExtractString(payload, 'type') = 'payment_intent.succeeded'
ORDER BY received_at DESC;

-- Paddle: View transactions
SELECT
  received_at,
  JSONExtractString(payload, 'event_type') as event_type,
  JSONExtractString(payload, 'data', 'id') as transaction_id,
  JSONExtractString(payload, 'data', 'customer_id') as customer_id
FROM webhook_events
WHERE type = 'paddle'
ORDER BY received_at DESC;

-- Daily revenue across all payment providers (example)
SELECT
  toDate(received_at) as date,
  type,
  count() as events
FROM webhook_events
WHERE type IN ('coinbase', 'stripe', 'paddle', 'nowpayments')
GROUP BY date, type
ORDER BY date DESC, type;
```

## Notes

- The buffer table will auto-flush to the main table based on time (10-60 seconds), row count (100-10,000), or size (10KB-10MB)
- TTL is set to 2 years - adjust as needed
- The tracking is fire-and-forget to not slow down webhook processing
- ClickHouse's JSON functions let you query any field without needing to define the schema upfront
- Use `type` column to filter by webhook source for efficient queries
