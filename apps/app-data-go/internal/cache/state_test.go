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

// replayHub issues once per block token, as the hub does (it claims the token's jti), and refuses
// every later exchange of it as a replay.
type replayHub struct {
	mu     sync.Mutex
	issued map[string]bool
	calls  int
	now    func() time.Time
}

func (h *replayHub) exchange(_ context.Context, subject string) (exchange.Token, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls++
	if h.issued[subject] {
		return exchange.Token{}, &exchange.RefusedError{Status: 400, Code: "invalid_grant"}
	}
	h.issued[subject] = true
	return exchange.Token{Access: "x." + strconv.Itoa(h.calls) + "." + subject, Expires: h.now().Add(10 * time.Minute)}, nil
}

func (h *replayHub) count() int { h.mu.Lock(); defer h.mu.Unlock(); return h.calls }

// process is one app-data-go process's block cache over the shared cache c.
func process(c *Cache, hub func(context.Context, string) (exchange.Token, error), clk *clock) *exchange.BlockCache {
	return &exchange.BlockCache{Hub: hub, Margin: 30 * time.Second, Now: clk.now, Shared: &Blocks{C: c, Now: clk.now}}
}

// 🔴 THE RESTART: a block token exchanged before a restart is not exchanged again after it (without
// the cache, the hub's replay refusal), and the saved token lives until it expires, no longer.
func TestARestartedProcessReusesTheBlockTokensExchange(t *testing.T) {
	r := newRig(t, secretA)
	hub := &replayHub{issued: map[string]bool{}, now: r.clk.now}
	first, err := process(r.c, hub.exchange, r.clk).Exchange(context.Background(), blockToken)
	if err != nil {
		t.Fatal(err)
	}
	r.clk.add(time.Minute)
	again, err := process(r.sharing(t, secretA), hub.exchange, r.clk).Exchange(context.Background(), blockToken)
	if err != nil || again.Access != first.Access || hub.count() != 1 {
		t.Fatalf("🔴 after a restart: %+v %v (hub %d)", again, err, hub.count())
	}
	id := sha256.Sum256([]byte(blockToken))
	if _, ttl := r.store.raw(r.c.Name(KindBlock, id[:])); ttl != 10*time.Minute {
		t.Fatalf("ttl %s, want the token's 10m", ttl)
	}
}

// 🔴 THE RACE, without a claim: two processes that both miss both ask the hub. The loser degrades to
// what happens without the cache: the hub's replay refusal, remembered. Never a hang, never another
// token's exchange, and the winner's token is what the cache keeps.
func TestTheLoserOfARaceGetsTheHubsReplayRefusal(t *testing.T) {
	r := newRig(t, secretA)
	hub := &replayHub{issued: map[string]bool{}, now: r.clk.now}
	a, b := process(r.c, hub.exchange, r.clk), process(r.sharing(t, secretA), hub.exchange, r.clk)
	// Both Gets miss before either saves.
	var barrier sync.WaitGroup
	barrier.Add(2)
	var gets atomic.Int32
	r.store.set(func(m *memStore) {
		m.afterGet = func() {
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
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("🔴 the race hung")
	}
	r.store.set(func(m *memStore) { m.afterGet = nil })
	if hub.count() != 2 {
		t.Fatalf("the hub was asked %d times; the race was not run", hub.count())
	}
	winner, loser := 0, 1
	if errs[0] != nil {
		winner, loser = 1, 0
	}
	var re *exchange.RefusedError
	if errs[winner] != nil || got[winner].Access == "" || !errors.As(errs[loser], &re) || re.Code != "invalid_grant" || got[loser].Access != "" {
		t.Fatalf("🔴 answers %+v %v", got, errs)
	}
	// The loser remembers its refusal (the hub not asked again); a third process reads the winner's.
	loserCache := []*exchange.BlockCache{a, b}[loser]
	if _, err := loserCache.Exchange(context.Background(), blockToken); !errors.Is(err, exchange.ErrRefused) || hub.count() != 2 {
		t.Fatalf("loser again: %v (hub %d)", err, hub.count())
	}
	third, err := process(r.sharing(t, secretA), hub.exchange, r.clk).Exchange(context.Background(), blockToken)
	if err != nil || third.Access != got[winner].Access || hub.count() != 2 {
		t.Fatalf("third: %+v %v (hub %d)", third, err, hub.count())
	}
}

// A refusal is never shared: another process asks the hub itself.
func TestABlockRefusalIsNotShared(t *testing.T) {
	r := newRig(t, secretA)
	calls := 0
	refuse := func(context.Context, string) (exchange.Token, error) {
		calls++
		return exchange.Token{}, &exchange.RefusedError{Status: 400, Code: "invalid_grant"}
	}
	_, _ = process(r.c, refuse, r.clk).Exchange(context.Background(), blockToken)
	_, _ = process(r.sharing(t, secretA), refuse, r.clk).Exchange(context.Background(), blockToken)
	if calls != 2 || len(r.store.keys()) != 0 {
		t.Fatalf("calls %d, keys %v", calls, r.store.keys())
	}
}

func TestASavedBlockTokenThatDoesNotReadIsAMiss(t *testing.T) {
	r := newRig(t, secretA)
	id := sha256.Sum256([]byte(blockToken))
	b := &Blocks{C: r.c}
	for _, raw := range []string{`{`, `{"v":2,"access":"a"}`, `{"v":1,"access":""}`} {
		r.c.Put(context.Background(), KindBlock, id[:], []byte(raw), time.Minute)
		if _, ok := b.Load(context.Background(), id); ok {
			t.Fatalf("%s read", raw)
		}
	}
	// The default clock: a token saved without one lives until its expiry.
	b.Save(context.Background(), id, exchange.Token{Access: "a", Expires: time.Now().Add(time.Minute)})
	if tok, ok := b.Load(context.Background(), id); !ok || tok.Access != "a" {
		t.Fatal("saved with the default clock")
	}
}

// 🔴 FAIL OPEN: with valkey down the block exchange runs as without a cache.
func TestBlocksFailOpen(t *testing.T) {
	r := newRig(t, secretA)
	r.store.set(func(m *memStore) { m.fail = true })
	hub := &replayHub{issued: map[string]bool{}, now: r.clk.now}
	if tok, err := process(r.c, hub.exchange, r.clk).Exchange(context.Background(), blockToken); err != nil || tok.Access == "" || hub.count() != 1 {
		t.Fatalf("%+v %v", tok, err)
	}
}

// ---- snapshots ----

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
