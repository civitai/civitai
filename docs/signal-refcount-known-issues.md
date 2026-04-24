# Signal Topic Refcount — Known Issues

Post-implementation notes on the refcount + retry change in [SignalsProvider.tsx](../src/components/Signals/SignalsProvider.tsx). Each item is a conscious trade-off or edge case; all are safe to leave as-is today, but worth tracking for later review.

## Summary of the change

- `SignalProvider` owns a `Map<topic, refCount>` + a `Map<topic, notify>` + a `Map<topic, retryState>` + a `Map<topic, lastConfirmedAt>`.
- `registerTopic` / `releaseTopic` replace direct `worker.topicRegister` / `worker.topicUnsubscribe` calls from `useSignalTopic`.
- **Reconnect-driven re-registration**: the provider watches connection state and re-registers every active topic on each `'connected'` transition (initial connect, reconnect, or worker identity change).
- **50s keep-alive interval**: the hub drops each registration 60s after the last `subscribe` call, so a single provider-level `setInterval` refreshes every active topic at 50s. One timer for all topics; skips while disconnected.
- **Retry on hub-side failures**: the worker now emits a `topic:status` message after every `topicInvoke`. The provider listens; on `ok: false` (except `no-connection`), it schedules an exponential-backoff retry (up to 4 attempts, capped at 30s). Successful registers clear the retry; `no-connection` failures are left to the reconnect effect.
- Fixes the silent stale-data window when one of several duplicate subscribers unmounts.

---

## Concerns

### [x] 1. Keep-alive captures the first subscriber's `notify` value — RESOLVED

The provider now maintains `topicNotify: Map<topic, boolean | undefined>` and uses last-write-wins: every `registerTopic` call overwrites the stored value, and the reconnect + retry paths read from the map. A subscriber passing `notify=false` after one passing `notify=true` will flip the re-registered value correctly.

---

### [ ] 2. `worker.topicRegister` fires on every subscribe, not just 0 → 1

**Severity**: low — wire-traffic waste, not a correctness issue.

**Description**: For N subscribers to the same topic, `worker.topicRegister(topic, notify)` is called N times on mount. The hub is expected to handle duplicates idempotently.

**Concrete impact**: On a card-heavy page or during a burst of mounts, the wire sees duplicate register messages. Not broken, just wasteful. The hub also emits a `topic:status` event per register call, so the duplicate register messages produce duplicate status messages back.

**Fix (when needed)**: move the `worker.topicRegister` call inside the `if (count === 0)` branch of `registerTopic`. The reconnect effect handles resilience against the hub losing state. Skipped today because the behavior mirrors the previous (non-refcounted) code and avoids surprise.

---

### [x] 3. No cleanup on `SignalProvider` unmount — RESOLVED

There are no longer any periodic timers to leak. The only per-topic timer state is `topicRetries` (retry-after-backoff handles), and the provider has an explicit unmount-cleanup effect that clears every outstanding retry. If a future pattern reintroduces periodic state, this item will need reopening.

---

### [ ] 4. Worker-change churn on `useCallback` dependencies

**Severity**: low — correct but causes brief subscribe/unsubscribe churn during worker transitions.

**Description**: `registerTopic` and `releaseTopic` depend on `worker` in their `useCallback` deps. When the worker identity changes (initial null → connected, or a reconnect that returns a new object), both callbacks are recreated. Every `useSignalTopic` effect re-runs because those callbacks are in its deps.

**Concrete impact**: For a feed with 50 mounted cards at the moment the worker connects, all 50 cleanups and 50 setups fire in the same commit. Net state is correct (refcounts settle back to their pre-transition values) but there's a brief moment during cleanup where refcount hits 0 before setup takes it back up. Nothing currently observes the refcount transitions, so this is benign — just surprising during debugging.

Note: the reconnect effect ALSO fires on worker change, re-registering every topic. With this churn, a fresh-worker topic can receive 2+ register messages in the same tick (one from the cleanup/setup, one from the reconnect effect). Idempotent at the hub but stacks with item 2.

**Fix (when needed)**: access `worker` via a ref instead of closure, so the callbacks stay identity-stable across worker transitions. Bigger change than it sounds because the worker-change handler then needs to reconcile existing subscriptions with the new worker explicitly.

---

### [ ] 5. Context value re-created on every 0↔1 transition

**Severity**: low — pre-existing; the refcount change doesn't make it worse but doesn't fix it.

**Description**: `setRegisteredTopics` fires when the first subscriber to a topic registers and when the last one unmounts. That triggers a `SignalProvider` re-render, which constructs a new context `value` object inline, which re-renders every `useSignalContext()` consumer.

**Concrete impact**: On a feed that's actively mounting/unmounting cards as the user scrolls, every topic transition cascades through the app. This is the same issue flagged in [signal-topic-subscription-overhead.md](./signal-topic-subscription-overhead.md).

**Fix (when needed)**: split the context into stable parts (`worker`, `connected`, `registerTopic`, `releaseTopic`) and reactive parts (`registeredTopics`). Most consumers only need the stable half.

---

### [ ] 6. Retry gives up silently after `RETRY_MAX_ATTEMPTS`

**Severity**: low — only matters if the hub is persistently refusing a subscription (permissions, auth, deleted entity, etc.).

**Description**: After 4 failed attempts (1s, 2s, 4s, 8s spacing, capped at 30s), the retry scheduler stops. The topic remains in `topicRefs` (subscribers still think they're subscribed) but there's no active subscription at the hub and no signal to the caller that something's wrong.

**Concrete impact**: A component calling `useSignalTopic` on a topic the hub refuses will silently get no updates. `useLiveMetrics` still returns the initial value; the UI looks static but nothing surfaces the failure.

**Fix (when needed)**: surface subscription state to the context (`topicStatus: 'pending' | 'subscribed' | 'failed'` keyed by topic). Consumers that care can read it and show UI. For metrics specifically this probably isn't worth the complexity — if the hub refuses a metric subscription, the base values render fine and the user just doesn't see live updates. But for Auction / real-time scenarios where "we're not getting updates" is user-visible, this matters.

---

### [x] 7a. Hub evicts idle registrations after 60s — RESOLVED

**Confirmed**: the SignalR hub drops each topic registration 60 seconds after the last `subscribe` call. Reconnect-driven re-registration alone is insufficient on long-lived sessions where the connection stays up but registrations age out.

**Mitigation**: a single provider-level `setInterval` runs at `KEEP_ALIVE_INTERVAL_MS = 50_000` (10s margin under the 60s TTL) and iterates `topicRefs.current`, calling `worker.topicRegister(topic, notify)` for each active topic. The interval skips when `status !== 'connected'` — the reconnect effect picks up the slack on the next `'connected'` transition.

**Trade-off vs. the old design**: the old code had one `useInterval(60_000)` per subscribed card (`MetricSubscriptionProviderInner` + each direct `useSignalTopic`). On a 200-card feed that was 200 timers and 200 register calls per minute. Now: 1 timer total and one register call per *active topic* per minute (post-refcount, identical topics share a single registration). Wire traffic is bounded by topic count, not subscriber count.

**Observability**: `window.__signals.getLastConfirmed()` returns the age of the last `topic:status` acknowledgment per topic. In steady state, ages should stay <60s. An age >60s on an active topic means the keep-alive isn't reaching the hub (worker stuck, connection issue, or eviction policy changed).

---

### [ ] 7. Retry retries every failure kind the same way

**Severity**: low — retries permission / auth failures that won't resolve, wasting 4 attempts before giving up.

**Description**: `topicInvoke` failures land with a `reason` string from `(e as Error).message`. The provider retries unless `reason === 'no-connection'`. It doesn't distinguish permission-denied / invalid-entity / auth-expired errors (which won't resolve by retrying) from transient server errors.

**Concrete impact**: An unsubscribable topic burns through the retry budget before going quiet. Wasteful but bounded.

**Fix (when needed)**: extend `SignalTopicStatus` with an error classification (a `code` field: `'transient' | 'permission' | 'auth' | 'unknown'`). The provider can skip retries for non-transient codes. Requires hub-side changes to categorize errors before surfacing them.

---

## Non-concerns (considered and dismissed)

### React StrictMode double-mount

StrictMode double-invokes effects in dev. With refcount: `register → release → register` settles at +1. Pre-existing behavior, not introduced.

### Hub-side duplicate registration logs

The hub is expected to tolerate duplicate registers. Each `topic:status` event now confirms the hub accepted (or rejected) the register call, so we have observability into this from the provider.

### Memory growth in the Maps

`topicRefs`, `topicNotify`, `topicRetries` all delete their entries on the 1 → 0 transition. Bounded by the number of currently-active topics.

---

## Alternatives considered

- **Refcounting in the worker**: moves the logic into the web-worker side. Rejected — harder to test, and the current `SignalProvider` already owns the related `registeredTopics` state.
- **Callback-based `useSignalTopic(topic, cb)`**: unify with `useSignalConnection`'s pattern. Cleaner architecturally but a big refactor (provider needs to route topic-scoped messages, every existing caller migrates). Not done today. Tracked in conversation, not as a concrete concern.
- **Per-card keep-alive timers**: the pre-existing approach (one `useInterval(60_000)` per `useSignalTopic` consumer). Replaced by a single provider-level 50s interval that iterates all active topics. Reconnect-driven re-registration handles connection-state transitions on top of that.

---

## When to revisit

- Subscribing to a topic the hub refuses becomes user-visible → fix item **6** and/or item **7**.
- Profiling shows context-re-render cost dominates → fix item **5**.
- A second worker identity change per session becomes common → fix item **4**.
