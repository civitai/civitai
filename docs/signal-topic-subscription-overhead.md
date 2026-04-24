# Signal Topic Subscription Overhead (Feed Metrics)

> **Status (post-refactor)**: most of this analysis has been addressed. `MetricSubscriptionProvider` has been removed; subscription now goes through `useMetricSubscription` inside the refcounted `SignalsProvider`. See [signal-refcount-known-issues.md](./signal-refcount-known-issues.md) for the current state and remaining edges. Per-mitigation status is called out inline in the "Mitigations" section below. The analysis body is kept intact as historical context.

Analysis of overhead from per-card live-metric subscriptions on feed pages. Scope: the interaction between `MetricSubscriptionProvider` (per card) and `useSignalTopic` / `SignalsProvider` (app-level).

Complementary to [frontend-perf-audit-2026-04.md](./frontend-perf-audit-2026-04.md) and [feed-card-dom-audit.md](./feed-card-dom-audit.md) — neither covers this layer in depth.

## Flow summary

Each feed card (ModelCard, ImagesCard, ArticleCard, CreatorCardSimple, ImagesAsPostsCard when wired, etc.) wraps its content in `<MetricSubscriptionProvider entityType entityId>`, which uses the shared `IntersectionObserverProvider` to detect visibility and calls `useSignalTopic(topic)` with a topic like `Metric:Model:123` while the card is visible.

`useSignalTopic` then:

1. Calls `worker.topicRegister(topic, notify)` — a message to the signal worker → SignalR hub message → server registers client interest
2. Mutates `registeredTopics` React state via `setRegisteredTopics(prev => [...prev, topic])`
3. Installs a 60s `useInterval` keep-alive that re-registers the topic
4. On unmount / topic flip to `undefined`: `worker.topicUnsubscribe(topic)` + remove from `registeredTopics`

At feed scale (50–200 visible+nearby cards) this produces two separate classes of overhead that are easy to conflate.

## Cost 1 — React re-render cascade (in-browser)

### Mechanism

[SignalsProvider.tsx:128-135](../src/components/Signals/SignalsProvider.tsx#L128-L135) constructs the context value inline:

```tsx
<SignalContext.Provider
  value={{ connected, status, worker, registeredTopics, setRegisteredTopics }}
>
```

Two compounding issues:

- **(a)** A new `value` object is created on every `SignalProvider` render, even if no field changed. Every `useSignalContext()` consumer in the app re-renders.
- **(b)** `registeredTopics` is React state — every card's visibility flip calls `setRegisteredTopics`, producing a new array reference → `SignalProvider` re-renders → context value changes → every `useSignalContext()` consumer re-renders.

### Blast radius

Every call site of `useSignalContext` (direct or indirect via `useSignalTopic`) re-renders on every register/unregister event across the whole app. For a feed, that includes every `MetricSubscriptionProviderInner`, and their inner content (`ModelCardContent`, `ArticleCardContent`, etc.) re-renders in turn because only the outer card component is wrapped in `React.memo` — the inner `...Content` functions are not.

Net: scrolling a single card into view triggers ~200 cards worth of inner re-render work.

### `registeredTopics` external consumers

Only [Auction/AuctionUtils.tsx:25](../src/components/Auction/AuctionUtils.tsx#L25) and [Auction/AuctionInfo.tsx:126](../src/components/Auction/AuctionInfo.tsx#L126) read `registeredTopics` as reactive state (to branch on "is my topic registered yet?"). Inside `useSignalTopic` itself, `registeredTopics.includes(topic)` is only used as a dedup guard — it doesn't need reactive state.

## Cost 2 — Protocol churn (on the wire + on the hub)

### Per-card register / unregister traffic

With `IntersectionObserverProvider`'s default `rootMargin: '100% 0px'` (one viewport-height buffer), a fast scroll through a 200-card feed crosses intersection thresholds hundreds of times. Each crossing in `MetricSubscriptionProviderInner` produces:

- **In**: `worker.topicRegister(topic, notify)` → worker → hub
- **Out**: `worker.topicUnsubscribe(topic)` → worker → hub

Fast scroll-through-and-back on a large feed can produce 400+ subscribe/unsubscribe messages per scroll session. Each message is small, but the rate is high and the hub does real work per message (per-client registration bookkeeping, plus filtering all subsequent metric broadcasts against the registration list).

### Keep-alive timer per card

[SignalsProvider.tsx:69-73](../src/components/Signals/SignalsProvider.tsx#L69-L73):

```tsx
const interval = useInterval(() => {
  if (!topic) return;
  worker?.topicRegister(topic, notify);
  if (!registeredTopics.includes(topic)) setRegisteredTopics((prev) => [...prev, topic]);
}, 60000);
```

Each subscribed card owns a 60s timer that re-registers its own topic. 100 active topics → 100 keep-alive messages per minute (~1.7/sec steady state), on an otherwise idle page.

## Mitigations — ordered by expected impact

### 1. Dwell-time debouncing (biggest scroll-traffic win)

**Status: superseded.** Not implemented as dwell-time per se. Instead, `<Metrics useLive={inView === true}>` unmounts the Live inner component when the card leaves the ElementInView boundary — its `useMetricSubscription` hook call is then gone, and the refcounted provider cleanly releases the topic. Fast scroll produces mount/unmount pairs rather than register/unregister churn at the hub, achieving the same "don't subscribe briefly-visible cards" goal without a dwell timer. If scroll-churn still shows up in profiling, dwell-time can be layered on top.

Don't subscribe the instant a card becomes visible. Require ~250-500ms of continuous visibility before calling `worker.topicRegister`. Don't unsubscribe immediately on scroll-out — hold the subscription warm for 1-3s in case the user scrolls back.

A fast scroll through the entire feed then produces **zero** register/unregister messages, because no card stays visible long enough to qualify.

Implementation shape: a local debounce inside `useSignalTopic` (or within `MetricSubscriptionProviderInner`) that arms on `isVisible=true`, fires the actual subscription on timer elapse, and disarms (or reverses) if visibility flips back quickly.

Trade-off: live metrics take an extra ~250ms to start showing updates after a card settles in view. Imperceptible for the live-metrics UX.

### 2. Split the React context (biggest render-cost win)

**Status: open.** Still a real concern. Tracked as item #5 in [signal-refcount-known-issues.md](./signal-refcount-known-issues.md) — the refcount change reduced the frequency of `setRegisteredTopics` calls (only 0↔1 transitions mutate it now) but didn't split the context.

Separate the stable parts from the reactive array:

```tsx
const SignalContext = createContext<{
  connected: boolean;
  status: SignalStatus | null;
  worker: SignalWorker | null;
} | null>(null);

const RegisteredTopicsContext = createContext<{
  registeredTopics: string[];
  setRegisteredTopics: Dispatch<SetStateAction<string[]>>;
}>(/* ... */);
```

Memoize each value independently. `useSignalTopic` consumes both (needs `worker` + `setRegisteredTopics`), but most consumers (`MetricSubscriptionProviderInner`, the card bodies via render, most `useSignalConnection` callers) only need `worker`.

Result: topic register/unregister no longer cascades to 200 card subtrees. Only the two Auction-UI components that actually read `registeredTopics` re-render on that axis.

Can be paired with `useSignalContext()` returning a merged view for backward compatibility so existing call sites don't need to migrate immediately.

### 3. Batched worker messages

**Status: open.** Not implemented. With refcounting, duplicate subscribers for the same topic no longer send duplicate wire messages to the hub (the 0→1 transition is the only one that talks to the worker for registration), but a burst of distinct-topic mounts still produces one worker message per topic.

Today `worker.topicRegister(topic)` is one worker message per call. If the worker buffered register/unregister calls in a microtask and flushed once per tick, a burst of 20 registrations becomes one message carrying 20 topics. Smaller wire footprint; fewer hub round-trips.

Lives in the worker (`useSignalsWorker` / whatever implements `topicRegister`/`topicUnsubscribe`), not in `useSignalTopic` itself.

### 4. Global keep-alive sweep

**Status: superseded.** The per-card `useInterval(60s)` is gone, but we didn't replace it with a global timer — we replaced it with an *event-driven* effect that re-registers all active topics on every `SignalStatus` transition to `'connected'` (initial connect, reconnect, worker-identity change). Zero steady-state wire traffic; immediate recovery on reconnect instead of waiting up to 60s. See "Reconnect-driven re-registration" in [signal-refcount-known-issues.md](./signal-refcount-known-issues.md).

One caveat: if the hub silently evicts idle subscriptions without closing the connection, the event-driven approach won't re-register until the next reconnect. Tracked as item #7a in the known-issues doc; no evidence of hub eviction in the code so far.

Replace the per-card `useInterval(60s)` with a single interval at the `SignalProvider` level that iterates all currently-registered topics and sends one batched heartbeat every 60s.

200 timers → 1. Minor JS savings; more-meaningful savings if combined with batched worker messages (one keep-alive message for N topics instead of N).

### 5. Page-level subscriptions (biggest architectural change)

**Status: not done.** Refcounting covers a large fraction of the same benefit by deduplicating identical topic subscriptions across the page, and the visibility-gated pattern prevents overscan subscriptions. Page-level subscriptions remain a valid larger-scale option if profiling shows the per-entity approach is still too chatty.

Instead of subscribing per visible entity, subscribe once at the feed level (e.g., "all Metric:Model updates for the entities in this feed window") and do client-side filtering / routing. Fewer, larger, longer-lived registrations.

Requires hub-side support for that subscription pattern and a client-side fanout mechanism that replaces the current per-card topic subscription. Much larger change; listed for completeness, not recommended as a next step.

## Interaction with current card audit

Signal-layer changes landed since this doc was written:

- `MetricSubscriptionProvider` has been removed entirely. Subscription is now a `useMetricSubscription` hook called by individual cards or inside `<Metrics>` wrappers.
- `SignalProvider` refcounts topics: duplicate subscribers for the same entity share one registration; only the 0→1 / 1→0 transitions talk to the hub.
- Keep-alive timer is gone; re-registration fires on every `SignalStatus` transition to `'connected'`.
- Worker emits `topic:status` events; failed `subscribe` calls retry with exponential backoff.
- `AnimatedCount` no longer uses `@number-flow/react`.
- Feed cards are migrated to `ElementInView`; visibility-gated cards (`<Metrics useLive={inView === true}>`) drop subscription when off-screen.

See [signal-refcount-known-issues.md](./signal-refcount-known-issues.md) for the remaining edges.

Earlier card-layer fixes ([feed-card-dom-audit.md](./feed-card-dom-audit.md)) are adjacent and independent.

## Recommended order of operations

(Historical — most items below have been addressed or superseded. See the inline "Status:" lines in each mitigation above.)

1. **Dwell-time debouncing** first — biggest practical win during real scroll
2. **Context split** second — kills the React cascade for whatever register/unregister traffic remains
3. **Global keep-alive** third — cleanup-tier win, small diff
4. **Batched worker messages** only if profiling after the above still shows topic-register traffic as a hot path
5. **Page-level subscriptions** only if everything else is insufficient

## Out of scope for this document

- Changes to the SignalR hub / server-side registration machinery
- Changes to what data the hub pushes (e.g., batching metric deltas server-side)
- Any changes to `CurrencyBadge.tsx` / `AuctionUtils.tsx` NumberFlow usage (separate decision — those aren't feed-scale)
