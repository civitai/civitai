# ZKP2P ClickHouse Metrics Specification (Simplified)

## Overview
This document defines a simplified metrics collection strategy for ZKP2P payment integration, focused on answering key business questions:
- How many times are people trying to use it?
- What payment methods are they trying to use?
- How often are they succeeding, failing, or abandoning?

@dev: There's a lot here. This is very, very comprehensive, and while that's good, this seems like it's going to be time-consuming to implement. Is there simplifications that we can make here to kind of get the most value out of this without having to do all of this? What we really care about is, you know, how many times are people trying to use it? What payment methods are they trying to use? And how often are they succeeding? Or failing, or running into an error, or, you know, abandoning.

@ai: I've simplified the approach to focus only on essential metrics. We now have just one main table tracking key events (attempts, successes, failures, abandons) and one simple daily aggregate view. This gives you the core insights without the complexity.

## Database Table (Single Simple Table)

### zkp2p_payment_events
Track only essential payment events.

```sql
CREATE TABLE civitai.zkp2p_payment_events
(
    `userId` UInt32,
    `sessionId` String,
    `eventType` Enum8(
        'attempt' = 1,      -- User clicked payment button
        'success' = 2,      -- Payment completed successfully
        'error' = 3,        -- Payment failed with error
        'abandoned' = 4     -- User left without completing
    ),
    `paymentMethod` Enum8(
        'venmo' = 1,
        'cashapp' = 2,
        'paypal' = 3,
        'zelle' = 4,
        'wise' = 5,
        'revolut' = 6
    ),
    `usdAmount` Decimal(10, 2),
    `buzzAmount` UInt32,
    `errorMessage` Nullable(String),
    `timestamp` DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (timestamp, userId)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 90 DAY;
```

## Single Materialized View

### Daily Summary
```sql
CREATE MATERIALIZED VIEW civitai.zkp2p_daily_summary
ENGINE = SummingMergeTree()
ORDER BY (date, paymentMethod)
AS
SELECT
    toDate(timestamp) as date,
    paymentMethod,
    countIf(eventType = 'attempt') as attempts,
    countIf(eventType = 'success') as successes,
    countIf(eventType = 'error') as errors,
    countIf(eventType = 'abandoned') as abandons,
    sumIf(usdAmount, eventType = 'success') as total_usd,
    uniqIf(userId, eventType = 'success') as unique_buyers
FROM civitai.zkp2p_payment_events
GROUP BY date, paymentMethod;
```

## Simple Implementation

### Track Events in Components
```typescript
// In BuzzZkp2pButton component - track attempt
const handlePaymentClick = (method: string) => {
  // Simple tracking call
  await fetch('/api/track', {
    method: 'POST',
    body: JSON.stringify({
      event: 'zkp2p_payment',
      data: {
        eventType: 'attempt',
        paymentMethod: method,
        usdAmount: amount,
        buzzAmount: buzzAmount,
        sessionId: generateSessionId()
      }
    })
  });
  
  // Navigate to iframe
  router.push(`/purchase/zkp2p?method=${method}&amount=${amount}`);
};

// In iframe page - track outcomes based on postMessage
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://zkp2p.civitai.com') return;
  
  const { type, data } = event.data;
  
  let eventType = null;
  if (type === 'flow:completed') eventType = 'success';
  else if (type === 'flow:error') eventType = 'error';
  
  if (eventType) {
    await fetch('/api/track', {
      method: 'POST',
      body: JSON.stringify({
        event: 'zkp2p_payment',
        data: {
          eventType,
          paymentMethod: currentMethod,
          errorMessage: data?.error,
          ...sessionData
        }
      })
    });
  }
});

// Track abandonment on page unload
window.addEventListener('beforeunload', () => {
  if (!completed && !errored) {
    navigator.sendBeacon('/api/track', JSON.stringify({
      event: 'zkp2p_payment',
      data: { eventType: 'abandoned', ...sessionData }
    }));
  }
});
```

## Simple Queries for Business Questions

### How many times are people trying to use it?
```sql
SELECT 
    date,
    sum(attempts) as total_attempts,
    sum(unique_buyers) as unique_users
FROM civitai.zkp2p_daily_summary
WHERE date >= today() - 7
GROUP BY date
ORDER BY date DESC;
```

### What payment methods are they trying to use?
```sql
SELECT 
    paymentMethod,
    sum(attempts) as total_attempts,
    sum(attempts) * 100.0 / sum(sum(attempts)) OVER () as percentage
FROM civitai.zkp2p_daily_summary
WHERE date >= today() - 30
GROUP BY paymentMethod
ORDER BY total_attempts DESC;
```

### How often are they succeeding/failing/abandoning?
```sql
SELECT 
    paymentMethod,
    sum(attempts) as attempts,
    sum(successes) as successes,
    sum(errors) as errors,
    sum(abandons) as abandons,
    sum(successes) * 100.0 / sum(attempts) as success_rate,
    sum(errors) * 100.0 / sum(attempts) as error_rate,
    sum(abandons) * 100.0 / sum(attempts) as abandon_rate
FROM civitai.zkp2p_daily_summary
WHERE date >= today() - 7
GROUP BY paymentMethod;
```

### Simple Dashboard Query
```sql
-- One query to answer all questions
SELECT 
    date,
    paymentMethod,
    attempts,
    successes,
    errors,
    abandons,
    total_usd,
    unique_buyers,
    successes::Float64 / attempts as success_rate
FROM civitai.zkp2p_daily_summary
WHERE date >= today() - 30
ORDER BY date DESC, attempts DESC;
```

## That's It!

This simplified approach:
- Uses only 1 table and 1 view
- Tracks only 4 event types (attempt, success, error, abandoned)
- Answers your 3 key questions directly
- Can be implemented in a few hours instead of days
- Still provides room to expand later if needed