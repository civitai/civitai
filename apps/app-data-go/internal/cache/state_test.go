package cache

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

//nolint:gosec // G101: synthetic test fixtures, not credentials
const (
	hubToken   = "civitai_HUB-TOKEN-1a2b"
	hubToken2  = "civitai_HUB-TOKEN-9z8y"
	blockToken = "blk-header-1.blk-payload-1.blk-sig-1"
)

// fakeHub counts exchanges and issues "x.<n>.<subject>", or refuses those listed.
type fakeHub struct {
	mu     sync.Mutex
	n      int
	refuse map[string]bool
	life   time.Duration
	now    func() time.Time
	block  chan struct{} // when set, every exchange waits on it
}

func (h *fakeHub) exchange(_ context.Context, subject string) (exchange.Token, error) {
	if h.block != nil {
		<-h.block
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.n++
	if h.refuse[subject] {
		return exchange.Token{}, &exchange.RefusedError{Status: 400, Code: "invalid_grant"}
	}
	return exchange.Token{Access: "x." + strconv.Itoa(h.n) + "." + subject, Expires: h.now().Add(h.life)}, nil
}

func (h *fakeHub) count() int { h.mu.Lock(); defer h.mu.Unlock(); return h.n }

func tokensRig(t *testing.T) (*rig, *fakeHub, *Tokens) {
	t.Helper()
	r := newRig(t, secretA)
	hub := &fakeHub{refuse: map[string]bool{}, life: 15 * time.Minute, now: r.clk.now}
	return r, hub, &Tokens{C: r.c, Exchange: hub.exchange, Recheck: 2 * time.Minute, Margin: 30 * time.Second, Now: r.clk.now}
}

func TestAHubTokensExchangeIsAnsweredFromTheCacheWithinTheRecheckWindow(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	ctx := context.Background()
	first, err := tokens.Open(ctx, hubToken)
	if err != nil || hub.count() != 1 || !first.Checked.IsZero() {
		t.Fatalf("first: %+v %v (hub %d)", first, err, hub.count())
	}
	r.clk.add(time.Minute)
	again, err := tokens.Open(ctx, hubToken)
	if err != nil || hub.count() != 1 || again.Access != first.Access {
		t.Fatalf("cached: %+v %v (hub %d)", again, err, hub.count())
	}
	// Checked is when the hub last exchanged the subject: the stream's re-check counts from then.
	if !again.Checked.Equal(r.clk.now().Add(-time.Minute)) {
		t.Fatalf("checked %s", again.Checked)
	}
	// Another token never reads it.
	if other, _ := tokens.Open(ctx, hubToken2); other.Access == first.Access || hub.count() != 2 {
		t.Fatal("🔴 another token was answered the first one's exchange")
	}
	// Its time to live is the token's own life, never more.
	id := sha256.Sum256([]byte(hubToken))
	if _, ttl := r.store.raw(r.c.Name(KindUser, id[:])); ttl != 15*time.Minute {
		t.Fatalf("ttl %s, want the token's 15m", ttl)
	}
}

// 🔴 Past the re-check window the hub is asked again, as a live stream's re-check would: a cached
// exchange never extends how long a revoked token is served.
func TestPastTheRecheckWindowTheHubIsAskedAgain(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	ctx := context.Background()
	if _, err := tokens.Open(ctx, hubToken); err != nil {
		t.Fatal(err)
	}
	r.clk.add(2 * time.Minute)
	if _, err := tokens.Open(ctx, hubToken); err != nil || hub.count() != 2 {
		t.Fatalf("at the window's end the hub was asked %d times, want 2", hub.count())
	}
	// A revoked token: refused, and the cache entry gone.
	hub.refuse[hubToken] = true
	r.clk.add(2 * time.Minute)
	if _, err := tokens.Open(ctx, hubToken); !errors.Is(err, exchange.ErrRefused) {
		t.Fatalf("revoked: %v", err)
	}
	r.clk.add(-3 * time.Minute) // even back inside the old window
	if _, err := tokens.Open(ctx, hubToken); !errors.Is(err, exchange.ErrRefused) || hub.count() != 4 {
		t.Fatalf("🔴 a refused token was answered from the cache (%v, hub %d)", err, hub.count())
	}
}

// 🔴 A re-check the hub refuses (one stream's) drops the cached exchange at once, so another stream of
// the same token opening inside the old window asks the hub and is refused too.
func TestARefusedRecheckDropsTheCachedExchangeInsideItsWindow(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	ctx := context.Background()
	if _, err := tokens.Open(ctx, hubToken); err != nil {
		t.Fatal(err)
	}
	r.clk.add(30 * time.Second)
	hub.refuse[hubToken] = true
	if _, err := tokens.Fresh(ctx, hubToken); !errors.Is(err, exchange.ErrRefused) {
		t.Fatal(err)
	}
	r.clk.add(30 * time.Second) // one minute after the cached check: inside its window
	if tok, err := tokens.Open(ctx, hubToken); !errors.Is(err, exchange.ErrRefused) || hub.count() != 3 {
		t.Fatalf("🔴 a refused token opened from the cache: %+v %v (hub %d)", tok, err, hub.count())
	}
}

func TestATokenNearItsExpiryIsNotAnsweredFromTheCache(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	hub.life = time.Minute
	ctx := context.Background()
	_, _ = tokens.Open(ctx, hubToken)
	r.clk.add(31 * time.Second) // 29s left, inside the 30s margin
	if _, _ = tokens.Open(ctx, hubToken); hub.count() != 2 {
		t.Fatalf("hub asked %d times", hub.count())
	}
}

func TestFreshAlwaysAsksTheHubAndForgetDrops(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	ctx := context.Background()
	_, _ = tokens.Open(ctx, hubToken)
	r.clk.add(10 * time.Second)
	fresh, _ := tokens.Fresh(ctx, hubToken)
	if hub.count() != 2 {
		t.Fatal("fresh did not ask the hub")
	}
	// The re-check's answer is what the cache holds now, checked now.
	got, _ := tokens.Open(ctx, hubToken)
	if got.Access != fresh.Access || !got.Checked.Equal(r.clk.now()) {
		t.Fatalf("after fresh: %+v", got)
	}
	tokens.Forget(sha256.Sum256([]byte(hubToken)))
	if _, _ = tokens.Open(ctx, hubToken); hub.count() != 3 {
		t.Fatal("a forgotten token was answered from the cache")
	}
}

func TestOnlyHubTokensAreCachedHere(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	ctx := context.Background()
	for range 2 {
		_, _ = tokens.Open(ctx, blockToken)
		_, _ = tokens.Fresh(ctx, blockToken)
	}
	if hub.count() != 4 || len(r.store.keys()) != 0 {
		t.Fatalf("hub %d, keys %v", hub.count(), r.store.keys())
	}
}

func TestACachedTokenThatDoesNotReadIsAMiss(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	id := sha256.Sum256([]byte(hubToken))
	for _, raw := range []string{`{`, `{"v":2,"access":"a","expires":"2099-01-01T00:00:00Z"}`,
		`{"v":1,"access":"","expires":"2099-01-01T00:00:00Z"}`} {
		r.c.Put(context.Background(), KindUser, id[:], []byte(raw), time.Minute)
		before := hub.count()
		_, _ = tokens.Open(context.Background(), hubToken)
		if hub.count() != before+1 {
			t.Fatalf("%s was answered", raw)
		}
	}
	// A check dated in the future is not believed.
	future, _ := json.Marshal(userValue{V: valueVersion, Access: "a", Expires: r.clk.now().Add(time.Hour), Checked: r.clk.now().Add(time.Minute)})
	r.c.Put(context.Background(), KindUser, id[:], future, time.Minute)
	before := hub.count()
	_, _ = tokens.Open(context.Background(), hubToken)
	if hub.count() != before+1 {
		t.Fatal("a check from the future was believed")
	}
}

// 🔴 FAIL OPEN: with valkey down a hub token is exchanged as without a cache.
func TestTokensFailOpen(t *testing.T) {
	r, hub, tokens := tokensRig(t)
	r.store.set(func(m *memStore) { m.fail = true })
	for range 3 {
		if _, err := tokens.Open(context.Background(), hubToken); err != nil {
			t.Fatal(err)
		}
	}
	if hub.count() != 3 {
		t.Fatalf("hub %d", hub.count())
	}
}

// ---- block tokens ----

// process is one app-data-go process's block cache over the shared cache c.
func process(c *Cache, hub *fakeHub, clk *clock) *exchange.BlockCache {
	return &exchange.BlockCache{Hub: hub.exchange, Margin: 30 * time.Second, Now: clk.now,
		Shared: &Blocks{C: c, Poll: time.Millisecond, Now: clk.now}}
}

// 🔴 THE RACE: two processes sharing the cache exchange one block token at once. The hub is asked
// exactly once, and both get the token it issued. Without the shared claim the second would be the
// hub's replay refusal (block_token_spent after a restart).
func TestTwoProcessesNeverBothExchangeOneBlockToken(t *testing.T) {
	r := newRig(t, secretA)
	gate := make(chan struct{})
	hub := &fakeHub{refuse: map[string]bool{}, life: 15 * time.Minute, now: r.clk.now, block: gate}
	a, b := process(r.c, hub, r.clk), process(r.sharing(t, secretA), hub, r.clk)
	// Both processes find nothing (their Gets both run before either claims), so both reach the claim
	// at once: only SET NX keeps one of them from the hub.
	var barrier sync.WaitGroup
	barrier.Add(2)
	var gets atomic.Int32
	r.store.set(func(m *memStore) {
		m.afterGet = func() {
			// The first two Gets wait for each other; later ones (the loser's polls) pass.
			if gets.Add(1) <= 2 {
				barrier.Done()
				barrier.Wait()
			}
		}
	})
	var wg sync.WaitGroup
	got := make([]exchange.Token, 2)
	errs := make([]error, 2)
	for i, p := range []*exchange.BlockCache{a, b} {
		wg.Go(func() { got[i], errs[i] = p.Exchange(context.Background(), blockToken) })
	}
	// Let both reach the claim, then the winner's hub call through.
	time.Sleep(20 * time.Millisecond)
	r.store.set(func(m *memStore) { m.afterGet = nil })
	close(gate)
	wg.Wait()
	if hub.count() != 1 {
		t.Fatalf("🔴 the hub was asked %d times for one block token", hub.count())
	}
	if errs[0] != nil || errs[1] != nil || got[0].Access == "" || got[0].Access != got[1].Access {
		t.Fatalf("answers %+v %v", got, errs)
	}
	// A third process after the fact reads it, the hub not asked.
	c := process(r.sharing(t, secretA), hub, r.clk)
	if tok, err := c.Exchange(context.Background(), blockToken); err != nil || tok.Access != got[0].Access || hub.count() != 1 {
		t.Fatalf("third: %+v %v (hub %d)", tok, err, hub.count())
	}
}

func TestABlockRefusalIsSharedAndAFailureIsReleased(t *testing.T) {
	r := newRig(t, secretA)
	hub := &fakeHub{refuse: map[string]bool{blockToken: true}, life: 15 * time.Minute, now: r.clk.now}
	if _, err := process(r.c, hub, r.clk).Exchange(context.Background(), blockToken); !errors.Is(err, exchange.ErrRefused) {
		t.Fatal(err)
	}
	var re *exchange.RefusedError
	if _, err := process(r.sharing(t, secretA), hub, r.clk).Exchange(context.Background(), blockToken); !errors.As(err, &re) ||
		re.Code != "invalid_grant" || hub.count() != 1 {
		t.Fatalf("shared refusal: %v (hub %d)", err, hub.count())
	}
	// Its time to live is the block memory.
	id := sha256.Sum256([]byte(blockToken))
	if _, ttl := r.store.raw(r.c.Name(KindBlock, id[:])); ttl != BlockRefusalTTL {
		t.Fatalf("refusal ttl %s", ttl)
	}
	// A failure (no token issued) releases the claim: the next process asks the hub itself.
	other := "blk-header-2.blk-payload-2.blk-sig-2"
	failing := &exchange.BlockCache{Hub: func(context.Context, string) (exchange.Token, error) {
		return exchange.Token{}, errors.New("hub unreachable")
	}, Now: r.clk.now, Shared: &Blocks{C: r.c, Now: r.clk.now}}
	if _, err := failing.Exchange(context.Background(), other); err == nil {
		t.Fatal("a failure answered")
	}
	if _, err := process(r.sharing(t, secretA), hub, r.clk).Exchange(context.Background(), other); err != nil || hub.count() != 2 {
		t.Fatalf("after a released claim: %v (hub %d)", err, hub.count())
	}
}

func TestAnIssuedBlockTokensTimeToLiveIsItsExpiry(t *testing.T) {
	r := newRig(t, secretA)
	hub := &fakeHub{refuse: map[string]bool{}, life: 10 * time.Minute, now: r.clk.now}
	if _, err := process(r.c, hub, r.clk).Exchange(context.Background(), blockToken); err != nil {
		t.Fatal(err)
	}
	id := sha256.Sum256([]byte(blockToken))
	if _, ttl := r.store.raw(r.c.Name(KindBlock, id[:])); ttl != 10*time.Minute {
		t.Fatalf("ttl %s", ttl)
	}
}

// A claim another process never finishes: waited for, then pending (a failure), never exchanged here.
func TestAClaimNeverFinishedIsPendingNotExchangedAgain(t *testing.T) {
	r := newRig(t, secretA)
	id := sha256.Sum256([]byte(blockToken))
	if _, st := r.c.Claim(context.Background(), KindBlock, id[:], time.Minute); st != ClaimWon {
		t.Fatal("setup claim")
	}
	hub := &fakeHub{refuse: map[string]bool{}, life: 15 * time.Minute, now: r.clk.now}
	p := &exchange.BlockCache{Hub: hub.exchange, Now: r.clk.now,
		Shared: &Blocks{C: r.sharing(t, secretA), Wait: 20 * time.Millisecond, Poll: time.Millisecond, Now: r.clk.now}}
	if _, err := p.Exchange(context.Background(), blockToken); !errors.Is(err, exchange.ErrBlockPending) || hub.count() != 0 {
		t.Fatalf("%v (hub %d)", err, hub.count())
	}
	// The caller giving up ends the wait too.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b := &Blocks{C: r.c, Wait: time.Hour, Poll: time.Hour}
	if got := b.Begin(ctx, id); got.State != exchange.SharedPending {
		t.Fatalf("cancelled wait: %v", got.State)
	}
}

// A claim found at Get (not at SetNX) is waited for; garbage there is waited on until the wait ends.
func TestBeginWaitsOnAClaimFoundAtGet(t *testing.T) {
	r := newRig(t, secretA)
	id := sha256.Sum256([]byte(blockToken))
	cl, _ := r.c.Claim(context.Background(), KindBlock, id[:], time.Minute)
	b := &Blocks{C: r.sharing(t, secretA), Wait: time.Second, Poll: time.Millisecond}
	done := make(chan exchange.SharedBegin)
	go func() { done <- b.Begin(context.Background(), id) }()
	time.Sleep(10 * time.Millisecond)
	raw, _ := json.Marshal(blockValue{V: valueVersion, Access: "issued-elsewhere", Expires: time.Now().Add(time.Hour)})
	r.c.Finish(context.Background(), KindBlock, cl, raw, time.Minute)
	if got := <-done; got.State != exchange.SharedIssued || got.Token.Access != "issued-elsewhere" {
		t.Fatalf("%+v", got)
	}
	// Unreadable results are not answers.
	for _, v := range []string{`{`, `{"v":1}`, `{"v":9,"access":"a"}`} {
		r.c.Put(context.Background(), KindBlock, id[:], []byte(v), time.Minute)
		b.Wait = 5 * time.Millisecond
		if got := b.Begin(context.Background(), id); got.State != exchange.SharedPending {
			t.Fatalf("%s: %v", v, got.State)
		}
	}
	// The default timings.
	if (&Blocks{}).now().IsZero() {
		t.Fatal("no clock")
	}
}

// 🔴 FAIL OPEN: with valkey down the block exchange runs as without a cache.
func TestBlocksFailOpen(t *testing.T) {
	r := newRig(t, secretA)
	r.store.set(func(m *memStore) { m.fail = true })
	hub := &fakeHub{refuse: map[string]bool{}, life: 15 * time.Minute, now: r.clk.now}
	if tok, err := process(r.c, hub, r.clk).Exchange(context.Background(), blockToken); err != nil || tok.Access == "" || hub.count() != 1 {
		t.Fatalf("%+v %v", tok, err)
	}
}

func TestBlocksIgnoresAClaimOfAnotherType(t *testing.T) {
	b := &Blocks{C: newRig(t, secretA).c}
	b.Issued(context.Background(), "not a claim", exchange.Token{})
	b.Refused(context.Background(), "not a claim", &exchange.RefusedError{})
	b.Refused(context.Background(), Claim{name: "x"}, nil)
	b.Release(context.Background(), 42)
}

// ---- snapshots and overlays ----

func snapKey(token string) session.SnapshotKey {
	return session.SnapshotKey{Token: sha256.Sum256([]byte(token)), Schema: "urn:schema:apps.civitai.com:a/notes@v1",
		Region: session.Region{"DE", "", ""}}
}

func TestASnapshotReadsBackOnlyForItsTokenSchemaAndRegion(t *testing.T) {
	r := newRig(t, secretA)
	s := Snapshots{C: r.c}
	ctx := context.Background()
	saved := session.Saved{Cursor: "b1.0a1b2c3d4e5f60718293a4b5.p1.0123", Records: []registry.Entity{
		{URN: "urn:apps.civitai.com:a/notes/r1", Rev: "r", Body: json.RawMessage(`{"t":"A-CANARY"}`), Key: "k1", Seq: 4, Version: 2}}}
	s.Save(ctx, snapKey(hubToken), saved, time.Minute)
	got, ok := s.Load(ctx, snapKey(hubToken))
	if !ok || got.Cursor != saved.Cursor || len(got.Records) != 1 || string(got.Records[0].Body) != `{"t":"A-CANARY"}` ||
		got.Records[0].Seq != 4 || got.Records[0].Version != 2 {
		t.Fatalf("%+v %v", got, ok)
	}
	other := snapKey(hubToken2)
	region := snapKey(hubToken)
	region.Region = session.Region{"FR", "", ""}
	schema := snapKey(hubToken)
	schema.Schema = "urn:schema:apps.civitai.com:a/notes@v2"
	for _, k := range []session.SnapshotKey{other, region, schema} {
		if _, ok := s.Load(ctx, k); ok {
			t.Fatalf("🔴 %+v read another key's snapshot", k)
		}
	}
	s.Drop(ctx, snapKey(hubToken))
	if _, ok := s.Load(ctx, snapKey(hubToken)); ok {
		t.Fatal("a dropped snapshot read back")
	}
	// A value that does not read, or names another schema, is a miss.
	id := snapshotID(snapKey(hubToken))
	for _, raw := range []string{`{`, `{"v":2,"schema":"` + snapKey(hubToken).Schema + `","cursor":"c"}`,
		`{"v":1,"schema":"other","cursor":"c"}`, `{"v":1,"schema":"` + snapKey(hubToken).Schema + `","cursor":""}`} {
		r.c.Put(ctx, KindSnapshot, id, []byte(raw), time.Minute)
		if _, ok := s.Load(ctx, snapKey(hubToken)); ok {
			t.Fatalf("%s read", raw)
		}
	}
}

func TestOverlaysReadBackPerTokenAndSchema(t *testing.T) {
	r := newRig(t, secretA)
	o := Overlays{C: r.c, Max: 2, Now: r.clk.now}
	tok := sha256.Sum256([]byte(hubToken))
	schema := "urn:schema:apps.civitai.com:a/notes@v1"
	until := r.clk.now().Add(time.Minute)
	o.Save(tok, schema, session.SavedOverlay{Ack: session.Ack{Key: "k1", Seq: 9, URN: "urn:1", Body: json.RawMessage(`{"a":1}`), Version: 3}, Until: until})
	o.Save(tok, schema, session.SavedOverlay{Ack: session.Ack{Key: "k2", Seq: 10, Deleted: true}, Until: until})
	o.Save(tok, schema, session.SavedOverlay{Ack: session.Ack{Key: "k3", Seq: 11}, Until: r.clk.now()}) // expired: not stored
	var got []session.SavedOverlay
	deadline := time.Now().Add(2 * time.Second)
	for len(got) < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
		got = o.Load(context.Background(), tok, schema)
	}
	if len(got) != 2 {
		t.Fatalf("%d overlays", len(got))
	}
	byKey := map[string]session.SavedOverlay{}
	for _, g := range got {
		byKey[g.Key] = g
	}
	if k1 := byKey["k1"]; k1.Seq != 9 || k1.URN != "urn:1" || string(k1.Body) != `{"a":1}` || k1.Version != 3 || !k1.Until.Equal(until) {
		t.Fatalf("k1 %+v", k1)
	}
	if !byKey["k2"].Deleted {
		t.Fatal("k2 lost its delete")
	}
	if o.Load(context.Background(), sha256.Sum256([]byte(hubToken2)), schema) != nil ||
		o.Load(context.Background(), tok, schema+"x") != nil {
		t.Fatal("🔴 another token's or schema's overlays read back")
	}
	o.Drop(context.Background(), tok, schema)
	if o.Load(context.Background(), tok, schema) != nil {
		t.Fatal("dropped overlays read back")
	}
	// A field that does not read is skipped; the default clock works.
	r.c.HPut(context.Background(), KindOverlay, overlayID(tok, schema), []byte("k9"), []byte(`{"v":7}`), time.Minute, 4)
	if o.Load(context.Background(), tok, schema) != nil {
		t.Fatal("an unreadable overlay read back")
	}
	Overlays{C: r.c}.Save(tok, schema, session.SavedOverlay{Ack: session.Ack{Key: "kx", Seq: 1}, Until: time.Now().Add(time.Minute)})
	// A body that is not JSON is not stored (never: the store's bodies are JSON).
	Overlays{C: r.c}.Save(tok, schema, session.SavedOverlay{Ack: session.Ack{Key: "ky", Seq: 1, Body: json.RawMessage(`{`)}, Until: time.Now().Add(time.Minute)})
}
