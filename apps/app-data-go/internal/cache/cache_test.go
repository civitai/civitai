package cache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	secretA = []byte("cache-secret-A-0123456789abcdef-0123456789")
	secretB = []byte("cache-secret-B-fedcba9876543210-9876543210")
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// outcomes records what Observe was told, as "kind/op/outcome".
type outcomes struct {
	mu  sync.Mutex
	got []string
}

func (o *outcomes) observe(kind Kind, op, outcome string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.got = append(o.got, string(kind)+"/"+op+"/"+outcome)
}

func (o *outcomes) list() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.got, ",")
}

func (o *outcomes) reset() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.got = nil
}

type rig struct {
	store *memStore
	c     *Cache
	clk   *clock
	obs   *outcomes
}

func newRig(t *testing.T, secret []byte) *rig {
	t.Helper()
	clk := &clock{t: time.Unix(1_800_000_000, 0)}
	st := newMemStore()
	st.now = clk.now
	obs := &outcomes{}
	c, err := New(st, secret, Options{Timeout: 50 * time.Millisecond, Observe: obs.observe, Now: clk.now})
	if err != nil {
		t.Fatal(err)
	}
	return &rig{store: st, c: c, clk: clk, obs: obs}
}

// sharing is a second cache, with its own key, over r's store: another process.
func (r *rig) sharing(t *testing.T, secret []byte) *Cache {
	t.Helper()
	c, err := New(r.store, secret, Options{Timeout: 50 * time.Millisecond, Observe: r.obs.observe, Now: r.clk.now})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestNewRefusesAShortKey(t *testing.T) {
	if _, err := New(newMemStore(), []byte("short"), Options{}); err == nil {
		t.Fatal("a 5-byte key was accepted")
	}
	c, err := New(newMemStore(), bytes.Repeat([]byte("k"), MinSecretBytes), Options{})
	if err != nil || c.opts.Now == nil {
		t.Fatalf("defaults: %v %v", c, err)
	}
}

func TestANilCacheDoesNothingAndAlwaysMisses(t *testing.T) {
	var c *Cache
	ctx := context.Background()
	c.Put(ctx, KindUser, []byte("id"), []byte("v"), time.Minute)
	c.Delete(ctx, KindUser, []byte("id"))
	if _, ok := c.Get(ctx, KindUser, []byte("id")); ok || c.BreakerOpen() {
		t.Fatal("a nil cache answered something")
	}
}

func TestAValueReadsBackOnlyUnderItsKindAndId(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.c.Put(ctx, KindUser, []byte("id-1"), []byte("value-1"), time.Minute)
	if v, ok := r.c.Get(ctx, KindUser, []byte("id-1")); !ok || string(v) != "value-1" {
		t.Fatalf("read back %q %v", v, ok)
	}
	for _, k := range []struct {
		kind Kind
		id   string
	}{{KindUser, "id-2"}, {KindBlock, "id-1"}} {
		if _, ok := r.c.Get(ctx, k.kind, []byte(k.id)); ok {
			t.Fatalf("%s/%s read another's value", k.kind, k.id)
		}
	}
	if got := r.obs.list(); got != "user/set/ok,user/get/hit,user/get/miss,block/get/miss" {
		t.Fatalf("observed %s", got)
	}
	// A zero ttl stores nothing.
	r.c.Put(ctx, KindUser, []byte("id-3"), []byte("v"), 0)
	if _, ok := r.c.Get(ctx, KindUser, []byte("id-3")); ok {
		t.Fatal("a zero ttl was stored")
	}
}

// 🔴 No token, its digest, or a value in clear reaches valkey: names are HMACs, values are sealed.
func TestNothingInValkeyNamesTheIdOrHoldsTheValueInClear(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	token := "civitai_TOKEN-CANARY-7f3a" //nolint:gosec // G101: a synthetic test fixture
	id := sha256.Sum256([]byte(token))
	r.c.Put(ctx, KindUser, id[:], []byte("ACCESS-CANARY-91c2"), time.Minute)
	r.c.Put(ctx, KindSnapshot, append(id[:], "\x00STORAGE-KEY-CANARY"...), []byte("BODY-CANARY"), time.Minute)
	keys := r.store.keys()
	if len(keys) != 2 {
		t.Fatalf("keys %v", keys)
	}
	for _, k := range keys {
		for _, leak := range []string{token, hex.EncodeToString(id[:]), "STORAGE-KEY-CANARY"} {
			if strings.Contains(k, leak) {
				t.Fatalf("🔴 key name %q carries %q", k, leak)
			}
		}
		if !strings.HasPrefix(k, "adg:1:") {
			t.Fatalf("key %q has no format prefix", k)
		}
	}
	r.store.mu.Lock()
	defer r.store.mu.Unlock()
	for _, v := range r.store.vals {
		if bytes.Contains(v, []byte("ACCESS-CANARY")) || bytes.Contains(v, []byte("BODY-CANARY")) {
			t.Fatal("🔴 a value is stored in clear")
		}
	}
}

// 🔴 A value sealed under another key (a rotation, another deployment) is a miss, never an error.
func TestAValueOfAnotherKeyIsAMiss(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.c.Put(ctx, KindUser, []byte("id"), []byte("value"), time.Minute)
	other := r.sharing(t, secretB)
	if _, ok := other.Get(ctx, KindUser, []byte("id")); ok {
		t.Fatal("another key's cache read the value")
	}
	// Even copied under the other key's own name: it does not open.
	raw, _ := r.store.raw(r.c.Name(KindUser, []byte("id")))
	r.store.set(func(m *memStore) { m.setLocked(other.Name(KindUser, []byte("id")), raw, time.Minute) })
	r.obs.reset()
	if _, ok := other.Get(ctx, KindUser, []byte("id")); ok {
		t.Fatal("🔴 a value sealed under another key opened")
	}
	if got := r.obs.list(); got != "user/get/invalid" {
		t.Fatalf("observed %s", got)
	}
}

// 🔴 A value moved under another name does not open: the name is the seal's additional data.
func TestAValueMovedUnderAnotherNameDoesNotOpen(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.c.Put(ctx, KindUser, []byte("token-A"), []byte("A's exchanged token"), time.Minute)
	raw, _ := r.store.raw(r.c.Name(KindUser, []byte("token-A")))
	r.store.set(func(m *memStore) { m.setLocked(r.c.Name(KindUser, []byte("token-B")), raw, time.Minute) })
	if v, ok := r.c.Get(ctx, KindUser, []byte("token-B")); ok {
		t.Fatalf("🔴 token B read token A's value %q", v)
	}
}

func TestGarbageAndOtherFormatsAreMisses(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	name := r.c.Name(KindSnapshot, []byte("id"))
	good := r.c.seal(name, []byte("v"))
	other := append([]byte{Format + 1}, good[1:]...)
	flipped := bytes.Clone(good)
	flipped[len(flipped)-1] ^= 1
	for i, raw := range [][]byte{nil, []byte("garbage"), other, flipped, good[:10]} {
		r.store.set(func(m *memStore) { m.setLocked(name, raw, time.Minute) })
		if _, ok := r.c.Get(ctx, KindSnapshot, []byte("id")); ok {
			t.Fatalf("value %d opened", i)
		}
	}
	// POSITIVE CONTROL: the good value opens.
	r.store.set(func(m *memStore) { m.setLocked(name, good, time.Minute) })
	if v, ok := r.c.Get(ctx, KindSnapshot, []byte("id")); !ok || string(v) != "v" {
		t.Fatal("the control did not open")
	}
}

// 🔴 FAIL OPEN: valkey refusing connections is a miss and a no-op, each counted as an error.
func TestARefusedConnectionIsAMissAndANoOp(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.store.set(func(m *memStore) { m.fail = true })
	r.c.Put(ctx, KindUser, []byte("id"), []byte("v"), time.Minute)
	if _, ok := r.c.Get(ctx, KindUser, []byte("id")); ok {
		t.Fatal("a failed get answered")
	}
	r.c.Delete(ctx, KindUser, []byte("id"))
	if got := r.obs.list(); got != "user/set/error,user/get/error,user/del/error" {
		t.Fatalf("observed %s", got)
	}
}

// 🔴 FAIL OPEN: a valkey that stopped answering costs one timeout per call, then the breaker stops
// asking it at all.
func TestAHungValkeyIsBoundedByTheTimeoutThenTheBreaker(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.store.set(func(m *memStore) { m.hang = true })
	for i := range BreakerFailures {
		start := time.Now()
		if _, ok := r.c.Get(ctx, KindSnapshot, []byte("id")); ok {
			t.Fatal("a hung get answered")
		}
		if d := time.Since(start); d > time.Second {
			t.Fatalf("call %d took %s, over its 50ms timeout", i, d)
		}
	}
	if !r.c.BreakerOpen() {
		t.Fatal("the breaker did not open")
	}
	calls := r.store.callCount()
	start := time.Now()
	for range 100 {
		r.c.Get(ctx, KindSnapshot, []byte("id"))
		r.c.Put(ctx, KindSnapshot, []byte("id"), []byte("v"), time.Minute)
	}
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Fatalf("200 calls with the breaker open took %s", d)
	}
	if n := r.store.callCount() - calls; n != 0 {
		t.Fatalf("🔴 valkey was asked %d times with the breaker open", n)
	}
	if !strings.Contains(r.obs.list(), "snapshot/get/skipped_breaker") || !strings.Contains(r.obs.list(), "snapshot/set/skipped_breaker") {
		t.Fatalf("skips not observed: %s", r.obs.list())
	}
}

func TestTheBreakerLetsOneProbeThroughAfterItsCooldown(t *testing.T) {
	r := newRig(t, secretA)
	ctx := context.Background()
	r.store.set(func(m *memStore) { m.fail = true })
	for range BreakerFailures {
		r.c.Get(ctx, KindUser, []byte("id"))
	}
	calls := r.store.callCount()
	r.clk.add(BreakerCooldown - time.Second)
	r.c.Get(ctx, KindUser, []byte("id"))
	if r.store.callCount() != calls {
		t.Fatal("asked inside the cooldown")
	}
	// Past it, one probe; still failing, the breaker re-opens for another cooldown.
	r.clk.add(2 * time.Second)
	r.c.Get(ctx, KindUser, []byte("id"))
	r.c.Get(ctx, KindUser, []byte("id"))
	if n := r.store.callCount() - calls; n != 1 {
		t.Fatalf("%d probes, want 1", n)
	}
	// It recovers: the next probe succeeds and closes it.
	r.store.set(func(m *memStore) { m.fail = false })
	r.clk.add(BreakerCooldown + time.Second)
	r.c.Put(ctx, KindUser, []byte("id"), []byte("v"), time.Minute)
	if r.c.BreakerOpen() {
		t.Fatal("a successful probe left the breaker open")
	}
	if v, ok := r.c.Get(ctx, KindUser, []byte("id")); !ok || string(v) != "v" {
		t.Fatal("the cache did not recover")
	}
}

// A probe in flight holds the half-open breaker: concurrent calls are skipped.
func TestOnlyOneProbeAtATime(t *testing.T) {
	r := newRig(t, secretA)
	r.c.mu.Lock()
	r.c.failures, r.c.openTill = BreakerFailures, r.clk.now()
	r.c.mu.Unlock()
	if !r.c.allow() {
		t.Fatal("the first probe was refused")
	}
	if r.c.allow() {
		t.Fatal("a second concurrent probe was let through")
	}
	r.c.done(false)
	if !r.c.allow() || r.c.BreakerOpen() {
		t.Fatal("a successful probe did not close the breaker")
	}
}

// A misses is not a failure: a cache that holds nothing never trips the breaker.
func TestMissesNeverOpenTheBreaker(t *testing.T) {
	r := newRig(t, secretA)
	for range 3 * BreakerFailures {
		r.c.Get(context.Background(), KindUser, []byte("nothing"))
	}
	if r.c.BreakerOpen() {
		t.Fatal("misses opened the breaker")
	}
}

// A caller that gave up does not count as valkey failing: only the cache's own timeout bounds a call.
func TestACancelledCallerDoesNotTripTheBreaker(t *testing.T) {
	r := newRig(t, secretA)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 2 * BreakerFailures {
		r.c.Put(ctx, KindUser, []byte("id"), []byte("v"), time.Minute)
	}
	if r.c.BreakerOpen() {
		t.Fatal("a cancelled caller opened the breaker")
	}
	if _, ok := r.c.Get(context.Background(), KindUser, []byte("id")); !ok {
		t.Fatal("the write under a cancelled caller was not made")
	}
}
