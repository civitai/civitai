# Signals Shared Worker — Debugging Improvements

**ClickUp Task**: https://app.clickup.com/t/868hfxzq0
**Status**: Implemented (original proposals kept below as design history; the shipped API is under "Current Debugging Tools")
**Priority**: High

## Problem Statement

The signals shared worker randomly stops working. When it stops, users stop receiving real-time updates (buzz balance, generation status, notifications, etc.). The only recovery is killing the shared worker via browser DevTools or fully restarting the browser.

### Key Diagnostic Finding

When the issue is occurring, the worker's own ping (the old `window.ping()`, now `__signals.status()`) reports a **'connected' state**. This means:

- The SharedWorker process itself is alive and responsive
- The SignalR `HubConnection` object reports `Connected` state
- **But the underlying WebSocket is in a zombie state** — the server has dropped the connection, but the client-side WebSocket layer hasn't detected it

This rules out worker crashes, port failures, and client-side connection tracking bugs. The root cause is a **zombie WebSocket connection** that SignalR's built-in reconnection logic cannot detect because it relies on the transport layer reporting a disconnect.

## Architecture Overview

```
Browser Tab(s)                    SharedWorker                     Signals Server
┌──────────────┐                 ┌──────────────┐                ┌──────────────┐
│ useSignals   │◄──MessagePort──►│  worker.ts   │◄──WebSocket──►│  SignalR Hub  │
│ Worker.ts    │                 │              │                │              │
│              │  ping/pong      │  HubConnection│  (zombie?)    │              │
│              │  event:received │  state:       │               │              │
│              │  connection:    │   "connected" │               │              │
│              │   state         │              │                │              │
└──────────────┘                 └──────────────┘                └──────────────┘
```

**Key files:**
- `src/utils/signals/worker.ts` — SharedWorker, manages SignalR HubConnection
- `src/utils/signals/useSignalsWorker.ts` — React hook, main thread communication
- `src/utils/signals/types.ts` — Message type definitions
- `src/utils/signals/utils.ts` — EventEmitter and Deferred utilities

## Proposed Solutions

### Solution 1: Structured Logging with Ring Buffer

**Impact**: High | **Risk**: Low | **Priority**: 1

Add a ring buffer log inside the worker that captures all significant events with timestamps. Expose it via `__signals.log()`.

**What it captures:**
- Every incoming/outgoing message type + timestamp
- Connection state transitions with reasons
- Topic subscribe/unsubscribe attempts + success/failure
- Port connect/disconnect events (with port count)
- SignalR internal errors
- **Last signal event received timestamp** (critical for detecting zombie state)
- Event delivery counts per signal type

**Why this is priority 1:** When a user reports "signals stopped working," a developer can call `__signals.diagnose()` (or `log()`) and get a full timeline. The **last event received timestamp** is the most important datapoint — if it's 10 minutes stale but connection state says 'connected', we've confirmed the zombie WebSocket theory.

**Implementation sketch:**
```typescript
// In worker.ts
const LOG_MAX = 500;
const log: Array<{ ts: number; type: string; detail?: string }> = [];

function workerLog(type: string, detail?: string) {
  log.push({ ts: Date.now(), type, detail });
  if (log.length > LOG_MAX) log.shift();
}

// New message type: 'debug:dump' → returns the log array
// New message type: 'debug:enable' → turns on verbose per-event logging
```

**New `window` API:**
**Shipped as:** `__signals.log()` (timeline) and `__signals.status()` (snapshot). See "Current Debugging Tools".

---

### Solution 2: Server-Level Heartbeat (SignalR Ping)

**Impact**: High | **Risk**: Medium | **Priority**: 2

The current ping mechanism only checks if the **worker process** is alive. Since the worker is always alive when this issue occurs, we need to ping **through SignalR** to the server.

**Why worker-level ping is insufficient:**
- The worker ping → worker replies with pong + current state (now `status()`; `pingServer()` goes through the WebSocket)
- The worker reports `state: 'connected'` because `HubConnection.state === Connected`
- But the WebSocket is actually dead — no data is flowing

**Implementation:**
```typescript
// In worker.ts — add a server-level health check
async function serverPing(): Promise<boolean> {
  if (!connection || connection.state !== HubConnectionState.Connected) return false;
  try {
    // invoke() will fail if the connection is actually dead
    await Promise.race([
      connection.invoke('Ping'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    return true;
  } catch {
    return false;
  }
}
```

**Trigger options (pick one or combine):**
1. **Periodic interval** — Every 60s, send a SignalR Ping. If it fails/times out, force reconnect.
2. **Staleness detection** — Track `lastEventReceivedAt`. If no events received in N minutes while connected, trigger a server ping to verify.
3. **On visibility change** — When tab becomes visible, do a server ping instead of (or in addition to) the worker ping.

**Option 2 (staleness detection) is recommended** because it avoids unnecessary pings when things are working, and directly targets the symptom (no events flowing).

**Recovery on failure:**
```typescript
if (!await serverPing()) {
  workerLog('heartbeat:failed', 'Server ping failed, forcing reconnect');
  connection?.stop();
  connection = null;
  setConnectionState({ state: 'closed', message: 'Server ping failed' });
  // This triggers the main thread's reconnection flow
}
```

---

### Solution 3: Dev-Mode Connection Status Indicator

**Impact**: Medium | **Risk**: Low | **Priority**: 3

Add a small floating indicator (only visible in dev or with a feature flag / localStorage key) showing real-time connection health.

**Displays:**
- Connection state badge (green/yellow/red)
- Last signal received (relative time, e.g., "12s ago" / "5m ago")
- Reconnect count
- Active port count

**Activation:** `localStorage.setItem('signals-debug', 'true')` or a feature flag.

**Why this helps:** Makes it immediately obvious when signals die, instead of noticing minutes later that buzz balance isn't updating. During development and QA, this gives instant feedback.

---

### Solution 4: Error Boundaries on Topic Operations

**Impact**: Medium | **Risk**: Low | **Priority**: 4

Currently, topic subscribe/unsubscribe calls silently fail:

```typescript
// Current — silent failure
await connection?.invoke('subscribe', data.topic);
```

Wrap in try/catch with logging:
```typescript
try {
  if (!connection) throw new Error('No connection');
  await connection.invoke('subscribe', data.topic);
  workerLog('topic:subscribed', data.topic);
} catch (e) {
  workerLog('topic:subscribe:failed', `${data.topic}: ${e}`);
}
```

This also applies to `subscribeNotify`, `unsubscribe`, and `send` operations.

---

### Solution 5: Port Lifecycle Tracking

**Impact**: Low-Medium | **Risk**: Low | **Priority**: 5

Track connected ports with metadata to understand multi-tab behavior and detect stale ports.

```typescript
const ports = new Map<MessagePort, { connectedAt: number; lastMessageAt: number }>();
```

**Exposed via `__signals.status()`:**
- Number of active ports
- Per-port last activity timestamp
- Helps answer: "Is the worker serving all tabs or have some gone stale?"

---

## Current Debugging Tools

Everything lives on `window.__signals` (production included). `__signals.help()` lists it all.

| Method | What it does |
|--------|-------------|
| `diagnose()` | Runs every check: signed in, token, worker responds, worker/hub/tab state agree, worker user matches, server ping (zombie detection), each topic confirmed within the hub's 60s TTL. Prints a pass/fail table with a fix per failure |
| `status()` | Snapshot of the tab, the worker and the topics |
| `watch(filter?)` | Logs incoming signals live, plus failed topic operations. Filter by target name, RegExp or predicate. Returns a stop function; `unwatch()` stops all |
| `recent()` / `log(limit?)` | The worker's last 50 signals / its event log (connection, topics, heartbeats, SignalR internals) |
| `pingServer()` | Round-trip through the WebSocket; fails on a zombie connection |
| `reconnect()` / `resubscribe()` | Drop and rebuild the hub connection with a fresh token / re-send subscribe for every active topic |
| `verbose()` / `subscribers()` | Echo the worker log to the worker console / handler count per target in this tab |

`window.ping`, `logSignal`, `signalsDump`, `signalsStatus`, `signalsVerbose` and `signalsSubscribers` are
replaced by these. If the worker itself does not answer, kill it in `chrome://inspect/#workers`.

## Implementation Order (all shipped)

1. ~~Structured logging~~ — `__signals.log()`
2. ~~Server-level heartbeat~~ — `lastServerActivityAt` staleness check, `pingServer()`
3. ~~Dev UI indicator~~ — `SignalsDebugIndicator` (`localStorage['signals-debug']`)
4. ~~Error boundaries~~ — `topic:status` events, `watch()` shows failures
5. ~~Port tracking~~ — worker `portTopics`

## Open Questions

- Does the signals server implement a `Ping` hub method? Unverified — nothing in this repo shows it. `serverPing()` treats an error answer as a live socket either way; `__signals.diagnose()` shows the hub's error text if `Ping` is missing.
- What is the token TTL? If tokens expire faster than expected, that could contribute to zombie connections.
- Should we add client-side metrics/telemetry for zombie detection rates in production?
