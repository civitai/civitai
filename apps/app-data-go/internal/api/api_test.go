package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/rest"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
)

// End to end: the real handler; the real session manager, exchanger and registry client over HTTP to
// a fake hub and a fake adapter; and the real REST client to a fake document store. The fakes judge
// by bearer token, as the hub, the adapter and the site do, and every token's fixtures are distinct.
// The fake adapter accepts only tokens the fake hub issued, and counts any other it is shown.

const notesSchema = "urn:schema:apps.civitai.com:todo-app/notes@v1"

// fakeRegistry serves the HTTP binding. Each token's stream is sent its records, then Live (unless
// the token is in stall), and stays open; deletes pushed with revoke are sent on every open stream
// of that token.
type fakeRegistry struct {
	srv        *httptest.Server
	mu         sync.Mutex
	records    map[string][]registry.Entity
	stall      map[string]bool
	revokes    map[string][]chan string
	subs       atomic.Int32
	raw        atomic.Int32 // subscriptions that presented a token the hub did not issue
	wide       atomic.Int32 // subscriptions whose token holds more than AppDataRead
	notPrivate map[string]bool
	schemas    sync.Map // token → schema last asked
	// heads is the head a token's Live names in its meta, as the adapter's private feed does.
	heads map[string]int64
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{records: map[string][]registry.Entity{}, stall: map[string]bool{},
		revokes: map[string][]chan string{}, notPrivate: map[string]bool{}, heads: map[string]int64{}}
	t.Cleanup(func() {
		if n := f.raw.Load(); n != 0 {
			t.Errorf("🔴 the adapter was shown %d tokens the hub did not issue", n)
		}
		if n := f.wide.Load(); n != 0 {
			t.Errorf("🔴 the adapter was shown %d tokens holding more than AppDataRead", n)
		}
	})
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.subs.Add(1)
		tok, ok := strings.CutPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "x.")
		var scope string
		if ok {
			scope, tok, ok = strings.Cut(tok, ".")
		}
		if ok && scope != "AppDataRead" {
			f.wide.Add(1)
		}
		if !ok {
			f.raw.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"invalid_token"}`)
			return
		}
		f.schemas.Store(tok, r.URL.Query().Get("schema"))
		ch := make(chan string, 16)
		f.mu.Lock()
		// The adapter's wire form: every cursor wrapped as b1.<24 hex binding>.<inner>.
		recs, stall, cursor := f.records[tok], f.stall[tok], "b1.0a1b2c3d4e5f60718293a4b5.p1.empty"
		head, hasHead := f.heads[tok]
		if f.notPrivate[tok] {
			cursor = "b1.0a1b2c3d4e5f60718293a4b5.f1.0123456789abcdef0123456789abcdef"
		}
		f.revokes[tok] = append(f.revokes[tok], ch)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, e := range recs {
			raw, _ := json.Marshal(map[string]any{"entity": e, "cursor": ""})
			_, _ = fmt.Fprintf(w, "event: upsert\ndata: %s\n\n", raw)
		}
		switch {
		case stall:
		case hasHead:
			_, _ = fmt.Fprintf(w, "event: live\ndata: {\"cursor\":%q,\"meta\":{\"head\":{\"seq\":%d}}}\n\n", cursor, head)
		default:
			_, _ = fmt.Fprintf(w, "event: live\ndata: {\"cursor\":%q}\n\n", cursor)
		}
		fl.Flush()
		for {
			select {
			case urn := <-ch:
				raw, _ := json.Marshal(map[string]any{"urn": urn, "cursor": "c2"})
				_, _ = fmt.Fprintf(w, "event: delete\ndata: %s\n\n", raw)
				fl.Flush()
			case <-r.Context().Done():
				return
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRegistry) revoke(tok, urn string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range f.revokes[tok] {
		ch <- urn
	}
}

// fakeHub is the hub's token endpoint: it exchanges a user's hub token for "x.<scope>.<token>", for
// the relay client and the adapter's resource only. As the hub does, it issues exactly the scope
// requested when that is within the ceiling, refuses one outside it (invalid_scope), and issues the
// whole ceiling when none is requested.
//
// A block token (subject_token_type block-token) is exchanged as the hub's block exchange does it:
// only AppDataRead, and ONCE: a second exchange of the same block token is refused as a replay.
type fakeHub struct {
	srv      *httptest.Server
	mu       sync.Mutex
	refuse   map[string]bool
	subjects []string
	blocks   map[string]int // block-token exchanges asked, by subject
	// limited answers a subject 429 naming this `rateLimit.id`; forwarded is each request's
	// X-Forwarded-For ("" when none), in order.
	limited   map[string]string
	forwarded []string
}

// blockExchanges is how many times the hub was asked to exchange block token tok.
func (h *fakeHub) blockExchanges(tok string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.blocks[tok]
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{refuse: map[string]bool{}, blocks: map[string]int{}, limited: map[string]string{}}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, secret, _ := r.BasicAuth()
		_ = r.ParseForm()
		subject := r.PostForm.Get("subject_token")
		block := r.PostForm.Get("subject_token_type") == exchange.BlockTokenType
		h.mu.Lock()
		h.subjects = append(h.subjects, subject)
		h.forwarded = append(h.forwarded, r.Header.Get("X-Forwarded-For"))
		refused := h.refuse[subject]
		limit := h.limited[subject]
		replay := false
		if block {
			h.blocks[subject]++
			replay = h.blocks[subject] > 1
		}
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case limit != "":
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":"rate_limited","retry_after":60,"rateLimit":{"retryAfterSeconds":60,"id":"`+limit+`","kind":"abuse"}}`)
		case id != "relay-client" || secret != "relay-secret":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"invalid_client"}`)
		case block && (refused || replay || r.PostForm.Get("scope") != "AppDataRead"):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
		case block:
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "x.AppDataRead." + subject,
				"token_type": "Bearer", "expires_in": 900, "scope": "AppDataRead"})
		case r.PostForm.Get("grant_type") != exchange.GrantType || r.PostForm.Get("subject_token_type") != exchange.AccessTokenType ||
			r.PostForm.Get("resource") != "https://apps.invalid" || !strings.HasPrefix(subject, exchange.HubTokenPrefix):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_request"}`)
		case refused:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
		default:
			scope := r.PostForm.Get("scope")
			switch scope {
			case "":
				scope = hubCeiling
			case "AppDataRead", "AppsRead", hubCeiling:
			default:
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":"invalid_scope"}`)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "x." + strings.ReplaceAll(scope, " ", "+") + "." + subject,
				"token_type": "Bearer", "expires_in": 900, "scope": scope})
		}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

// hubCeiling is what the fake hub would issue for a request naming no scope: wider than a stream needs.
const hubCeiling = "AppDataRead AppsRead"

type restAnswer struct {
	status int
	body   string
}

// fakeStore is the site's document store list.
type fakeStore struct {
	srv *httptest.Server
	mu  sync.Mutex
	by  map[string]restAnswer // token → answer
	// retryAfter is the Retry-After header sent with a token's answer, when set.
	retryAfter map[string]string
	calls      atomic.Int32
	froms      []string
	// prefixes are the keyPrefix values sent, one per request ("" when none).
	prefixes []string
	block    chan struct{}
}

func newFakeStore(t *testing.T) *fakeStore {
	t.Helper()
	f := &fakeStore{by: map[string]restAnswer{}, retryAfter: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.mu.Lock()
		f.froms = append(f.froms, r.URL.Query().Get("from"))
		f.prefixes = append(f.prefixes, r.URL.Query().Get("keyPrefix"))
		a, ok := f.by[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		retryAfter := f.retryAfter[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		block := f.block
		f.mu.Unlock()
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return
			}
		}
		if r.URL.Path != "/api/v1/blocks/storage/notes" || r.URL.Query().Get("limit") != "100" {
			a = restAnswer{400, `{"error":"bad_request"}`}
		} else if !ok {
			a = restAnswer{401, `{"error":"unauthenticated"}`}
		}
		w.Header().Set("Content-Type", "application/json")
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(a.status)
		_, _ = io.WriteString(w, a.body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type stack struct {
	guard *exchange.Guard
	hub   *fakeHub
	reg   *fakeRegistry
	store *fakeStore
	mgr   *session.Manager
	m     *metrics.Metrics
	h     http.Handler
	srv   *Server
}

func newStack(t *testing.T, registryOn bool, opts session.Options) *stack {
	t.Helper()
	return newStackWith(t, registryOn, false, opts)
}

// newStackWith is newStack with APP_DATA_BLOCK_EXCHANGE set to blockOn, wired as main wires it.
func newStackWith(t *testing.T, registryOn, blockOn bool, opts session.Options) *stack {
	t.Helper()
	s := &stack{hub: newFakeHub(t), reg: newFakeRegistry(t), store: newFakeStore(t)}
	if opts.MaxStreams == 0 {
		opts.MaxStreams = 10
	}
	if opts.MaxPerToken == 0 {
		opts.MaxPerToken = 4
	}
	opts.IdleTTL, opts.MaxAge, opts.Cooldown = time.Minute, time.Hour, time.Second
	if opts.MaxRecords == 0 {
		opts.MaxRecords = 100
	}
	opts.MaxBytes = 1 << 20
	opts.NotPrivateCooldown, opts.ExpiryMargin = time.Hour, 30*time.Second
	ex := &exchange.Exchanger{Config: exchange.Config{URL: s.hub.srv.URL, ClientID: "relay-client",
		ClientSecret: "relay-secret", Resource: "https://apps.invalid"}}
	var router *exchange.Router
	router, s.guard = exchange.NewRouter(ex.Exchange, func(o string) { s.m.UserExchangeGuard.WithLabelValues(o).Inc() })
	if blockOn {
		router.Blocks = &exchange.BlockCache{Hub: ex.ExchangeBlock, Margin: opts.ExpiryMargin,
			Observe: func(outcome, code string) {
				s.m.ObserveBlockExchange(slog.New(slog.DiscardHandler))(outcome, code)
			}}
	}
	opts.Exchange = router.Exchange
	s.mgr = session.New(session.ClientSubscriber{Client: &registry.Client{BaseURL: s.reg.srv.URL}}, opts)
	t.Cleanup(s.mgr.Close)
	reg := prometheus.NewRegistry()
	s.m = metrics.New(reg, func() (int, int, int, int) {
		st := s.mgr.Stats()
		return st.Streams, st.Live, st.Records, st.Bytes
	})
	s.srv = &Server{
		REST:     &rest.Client{BaseURL: s.store.srv.URL, MaxRecords: opts.MaxRecords},
		Metrics:  s.m,
		Gatherer: reg,
		Deadline: 2 * time.Second, LiveWait: 300 * time.Millisecond,
		RESTSlots: make(chan struct{}, 4),
	}
	if registryOn {
		s.srv.Streams = s.mgr
	}
	s.srv.Exchangeable = router.Accepts
	s.h = s.srv.Handler()
	return s
}

type got struct {
	status int
	header http.Header
	body   string
	ans    answer
}

func (s *stack) get(t *testing.T, path, token string) got {
	t.Helper()
	return s.getFrom(t, path, token, "")
}

// getFrom is get with the edge naming the viewer's address ip (exchange.ClientIPHeader; "" none).
func (s *stack) getFrom(t *testing.T, path, token, ip string) got {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
	if ip != "" {
		req.Header.Set(exchange.ClientIPHeader, ip)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	g := got{status: rec.Code, header: rec.Header(), body: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &g.ans)
	return g
}

const notesPath = "/v1/apps/todo-app/collections/notes/records"

func ent(urn, canary string) registry.Entity {
	return registry.Entity{URN: urn, Rev: "r-" + canary, Schemas: []string{notesSchema},
		Body: json.RawMessage(fmt.Sprintf(`{"text":%q}`, canary))}
}

func fallbacks(s *stack, reason string) float64 {
	return testutil.ToFloat64(s.m.Fallbacks.WithLabelValues(reason))
}

func TestARecordReadIsServedFromTheUsersOwnStream(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "ALICE-7f3a")}
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != 200 || g.ans.Source != "registry" || len(g.ans.Items) != 1 ||
		g.ans.Items[0].URN != "urn:apps.civitai.com:todo-app/notes/r-a" || g.ans.Items[0].Rev != "r-ALICE-7f3a" ||
		string(g.ans.Items[0].Data) != `{"text":"ALICE-7f3a"}` {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if v, _ := s.reg.schemas.Load("civitai_alice"); v != notesSchema {
		t.Fatalf("subscribed to %v", v)
	}
	if cc := g.header.Get("Cache-Control"); cc != "private, no-store" || g.header.Get("Vary") != "Authorization" {
		t.Fatalf("Cache-Control %q, Vary %q", cc, g.header.Get("Vary"))
	}
	if g.header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("no CORS header")
	}
	if s.store.calls.Load() != 0 {
		t.Fatal("a registry answer also read REST")
	}
	// The second read is the cache's: no new subscription.
	_ = s.get(t, notesPath, "civitai_alice")
	if n := s.reg.subs.Load(); n != 1 {
		t.Fatalf("%d subscriptions, want 1", n)
	}
	if v := testutil.ToFloat64(s.m.Reads.WithLabelValues("registry", "ok")); v != 2 {
		t.Fatalf("registry reads counted %v", v)
	}
}

// 🔴 Over HTTP, through the real client: no token ever receives another's records.
func TestTwoUsersNeverSeeEachOthersRecords(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-alice", "ALICE-CANARY-7f3a")}
	s.reg.records["civitai_bob"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-bob", "BOB-CANARY-c40d")}
	var wg sync.WaitGroup
	var bad atomic.Int32
	for range 20 {
		for tok, own := range map[string]string{"civitai_alice": "ALICE-CANARY-7f3a", "civitai_bob": "BOB-CANARY-c40d"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				g := s.get(t, notesPath, tok)
				other := "BOB-CANARY"
				if tok == "civitai_bob" {
					other = "ALICE-CANARY"
				}
				if g.ans.Source != "registry" || !strings.Contains(g.body, own) || strings.Contains(g.body, other) {
					bad.Add(1)
					t.Errorf("%s got %s", tok, g.body)
				}
			}()
		}
	}
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("%d crossed reads", bad.Load())
	}
}

func TestATokenTheHubCannotExchangeReadsRESTOnly(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.store.by["eyJblock.jwt.token"] = restAnswer{200, `{"items":[{"key":"k1","data":{"text":"REST-1"},"version":3}],"nextCursor":null}`}
	g := s.get(t, notesPath, "eyJblock.jwt.token")
	if g.status != 200 || g.ans.Source != "rest" || len(g.ans.Items) != 1 || g.ans.Items[0].Key != "k1" ||
		g.ans.Items[0].Rev != "3" || string(g.ans.Items[0].Data) != `{"text":"REST-1"}` {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if s.reg.subs.Load() != 0 {
		t.Fatal("a block token opened a stream")
	}
	if fallbacks(s, "token_not_exchangeable") != 1 {
		t.Fatal("fallback not counted")
	}
	// 🔴 The block exchange is off: the block token never reaches the hub.
	if len(s.hub.subjects) != 0 {
		t.Fatalf("the hub was sent %d tokens with the block exchange off", len(s.hub.subjects))
	}
}

// A token that is neither the hub's nor a block token's shape reads REST only, block exchange on or
// off, and never reaches the hub.
func TestAnOpaqueTokenReadsRESTOnlyEvenWithTheBlockExchangeOn(t *testing.T) {
	s := newStackWith(t, true, true, session.Options{})
	s.store.by["opaque-token"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	g := s.get(t, notesPath, "opaque-token")
	if g.status != 200 || g.ans.Source != "rest" || fallbacks(s, "token_not_exchangeable") != 1 || len(s.hub.subjects) != 0 {
		t.Fatalf("%d %s, hub saw %d", g.status, g.body, len(s.hub.subjects))
	}
}

// blockTok is a block token's shape (header.payload.signature); pairwise distinct from every other
// fixture.
const blockTok = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJibGstYWxpY2UifQ.c2lnLWFsaWNl"

func blockExchanges(s *stack, outcome, code string) float64 {
	return testutil.ToFloat64(s.m.BlockExchanges.WithLabelValues(outcome, code))
}

// With the block exchange on, a block token is exchanged at the hub's block exchange and read through
// its own stream; the adapter sees the exchanged token only (the fakes' cleanup checks it).
func TestABlockTokenIsReadThroughItsStreamWithTheBlockExchangeOn(t *testing.T) {
	s := newStackWith(t, true, true, session.Options{})
	s.reg.records[blockTok] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-blk", "BLOCK-ALICE-5e1b")}
	g := s.get(t, notesPath, blockTok)
	if g.status != 200 || g.ans.Source != "registry" || len(g.ans.Items) != 1 || !strings.Contains(g.body, "BLOCK-ALICE-5e1b") {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if n := s.hub.blockExchanges(blockTok); n != 1 || s.store.calls.Load() != 0 {
		t.Fatalf("%d block exchanges, %d REST reads; want 1 and 0", n, s.store.calls.Load())
	}
	if blockExchanges(s, "issued", "none") != 1 {
		t.Fatal("the exchange was not counted")
	}
}

// 🔴 One block token is never exchanged twice (the hub refuses a replay): reading a second
// collection reuses the first exchange, and both are served from the registry.
func TestABlockTokenIsExchangedOnceAcrossCollections(t *testing.T) {
	s := newStackWith(t, true, true, session.Options{})
	s.reg.records[blockTok] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-blk", "BLOCK-ALICE-5e1b")}
	for _, path := range []string{notesPath, "/v1/apps/todo-app/collections/lists/records", notesPath} {
		if g := s.get(t, path, blockTok); g.status != 200 || g.ans.Source != "registry" {
			t.Fatalf("%s: %d %s", path, g.status, g.body)
		}
	}
	if n := s.hub.blockExchanges(blockTok); n != 1 {
		t.Fatalf("the hub was asked %d times for one block token, want 1", n)
	}
	if n := s.reg.subs.Load(); n != 2 {
		t.Fatalf("%d subscriptions, want 2 (one per collection)", n)
	}
	if blockExchanges(s, "issued", "none") != 1 || blockExchanges(s, "reused", "none") != 1 {
		t.Fatalf("issued %v reused %v", blockExchanges(s, "issued", "none"), blockExchanges(s, "reused", "none"))
	}
}

// A refused block exchange falls back to REST exactly as a refused user exchange does, counted with
// the hub's refusal code; the hub is not asked again for that block token.
func TestARefusedBlockExchangeFallsBackToREST(t *testing.T) {
	s := newStackWith(t, true, true, session.Options{})
	s.hub.refuse[blockTok] = true
	s.store.by[blockTok] = restAnswer{200, `{"items":[{"key":"k-blk","data":{"text":"BLOCK-REST-77c0"},"version":2}],"nextCursor":null}`}
	g := s.get(t, notesPath, blockTok)
	if g.status != 200 || g.ans.Source != "rest" || !strings.Contains(g.body, "BLOCK-REST-77c0") || s.reg.subs.Load() != 0 {
		t.Fatalf("%d %s, subs %d", g.status, g.body, s.reg.subs.Load())
	}
	if fallbacks(s, "exchange_refused") != 1 || blockExchanges(s, "refused", "invalid_grant") != 1 {
		t.Fatalf("exchange_refused %v, refused/invalid_grant %v", fallbacks(s, "exchange_refused"), blockExchanges(s, "refused", "invalid_grant"))
	}
	// Another collection of the same block token: REST again (the fake store answers any collection but
	// notes with its 400, passed on), the refusal remembered, the hub not asked.
	if g := s.get(t, "/v1/apps/todo-app/collections/lists/records", blockTok); g.status != 400 || g.body != `{"error":"bad_request"}` ||
		fallbacks(s, "exchange_refused") != 2 {
		t.Fatalf("%d %s, exchange_refused %v", g.status, g.body, fallbacks(s, "exchange_refused"))
	}
	if n := s.hub.blockExchanges(blockTok); n != 1 || blockExchanges(s, "remembered", "invalid_grant") != 1 {
		t.Fatalf("%d block exchanges, remembered %v; want 1 and 1", n, blockExchanges(s, "remembered", "invalid_grant"))
	}
}

// The hub unreachable: the read is answered by REST, and nothing is remembered, so a later read may
// try again.
func TestAFailedBlockExchangeFallsBackToREST(t *testing.T) {
	s := newStackWith(t, true, true, session.Options{})
	s.hub.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"temporarily_unavailable"}`)
	})
	s.store.by[blockTok] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	g := s.get(t, notesPath, blockTok)
	if g.status != 200 || g.ans.Source != "rest" || fallbacks(s, "failed") != 1 || blockExchanges(s, "failed", "none") != 1 {
		t.Fatalf("%d %s, failed %v", g.status, g.body, fallbacks(s, "failed"))
	}
}

func TestWithTheRegistryOffEveryReadIsREST(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != 200 || g.ans.Source != "rest" || s.reg.subs.Load() != 0 || fallbacks(s, "registry_off") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if len(s.hub.subjects) != 0 {
		t.Fatal("the registry path is off, yet a token was exchanged")
	}
}

// Every REST read names the app the request names, so the site can never answer one app's data under
// another's slug: the token's own app is not the client's to choose.
func TestTheRESTFallbackAlwaysReadsTheAppTheSlugNames(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	_ = s.get(t, notesPath, "civitai_alice")
	_ = s.get(t, "/v1/apps/other-app/collections/notes/records", "civitai_alice")
	if strings.Join(s.store.froms, ",") != "todo-app,other-app" {
		t.Fatalf("from values sent: %q", s.store.froms)
	}
}

// 🔴 Cap exhaustion falls back to REST, which still answers the read.
func TestReadsOverTheStreamCapFallBackToREST(t *testing.T) {
	s := newStack(t, true, session.Options{MaxStreams: 1, MaxPerToken: 1})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "A")}
	s.store.by["civitai_bob"] = restAnswer{200, `{"items":[{"key":"bob-key","data":{"text":"BOB-REST"},"version":1}],"nextCursor":null}`}
	if g := s.get(t, notesPath, "civitai_alice"); g.ans.Source != "registry" {
		t.Fatal(g.body)
	}
	g := s.get(t, notesPath, "civitai_bob")
	if g.status != 200 || g.ans.Source != "rest" || !strings.Contains(g.body, "BOB-REST") || fallbacks(s, "capacity") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if n := s.reg.subs.Load(); n != 1 {
		t.Fatalf("%d subscriptions, want 1", n)
	}
	_ = s.get(t, "/v1/apps/todo-app/collections/lists/records", "civitai_alice")
	if fallbacks(s, "capacity") != 2 {
		t.Fatalf("capacity fallbacks %v (a second collection for alice is over the process cap too)", fallbacks(s, "capacity"))
	}
}

// The deadline: a stream that never reaches Live (a slow snapshot) is given up
// at LiveWait, the read is answered by REST within the request's deadline, and the next read does
// not wait again.
func TestAStreamShortOfLiveIsGivenUpAndRESTAnswersInTime(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.stall["civitai_alice"] = true
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[{"key":"k","data":{"text":"FROM-REST"},"version":1}],"nextCursor":null}`}
	start := time.Now()
	g := s.get(t, notesPath, "civitai_alice")
	took := time.Since(start)
	if g.status != 200 || g.ans.Source != "rest" || fallbacks(s, "not_live") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if took < 300*time.Millisecond || took > 2*time.Second {
		t.Fatalf("answered after %v; want after LiveWait (300ms) and within the deadline (2s)", took)
	}
	start = time.Now()
	g = s.get(t, notesPath, "civitai_alice")
	if g.ans.Source != "rest" || fallbacks(s, "stalled") != 1 {
		t.Fatalf("%s", g.body)
	}
	if took := time.Since(start); took >= 300*time.Millisecond {
		t.Fatalf("a stalled stream made the read wait %v", took)
	}
}

func TestARequestDeadlineEndsAStuckRESTRead(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.srv.Deadline = 50 * time.Millisecond
	s.store.block = make(chan struct{})
	defer close(s.store.block)
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != http.StatusGatewayTimeout || !strings.Contains(g.body, `"deadline"`) {
		t.Fatalf("%d %s", g.status, g.body)
	}
}

// A revoked grant: the adapter sends Deletes, the next read no longer has the records, and once the
// stream holds nothing the read goes to REST, which answers the refusal itself.
func TestARevokedGrantLeavesTheCacheAndTheSiteAnswersTheRefusal(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_grantee"] = []registry.Entity{
		ent("urn:apps.civitai.com:todo-app/notes/r-1", "GRANTED-1"),
		ent("urn:apps.civitai.com:todo-app/notes/r-2", "GRANTED-2"),
	}
	s.store.by["civitai_grantee"] = restAnswer{403, `{"error":"import_not_granted","message":"not granted"}`}
	if g := s.get(t, notesPath, "civitai_grantee"); len(g.ans.Items) != 2 {
		t.Fatal(g.body)
	}
	s.reg.revoke("civitai_grantee", "urn:apps.civitai.com:todo-app/notes/r-1")
	deadline := time.Now().Add(2 * time.Second)
	for {
		g := s.get(t, notesPath, "civitai_grantee")
		if len(g.ans.Items) == 1 && !strings.Contains(g.body, "GRANTED-1") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the delete never left the cache: %s", g.body)
		}
		time.Sleep(time.Millisecond)
	}
	s.reg.revoke("civitai_grantee", "urn:apps.civitai.com:todo-app/notes/r-2")
	for {
		g := s.get(t, notesPath, "civitai_grantee")
		if g.status == 403 {
			if g.body != `{"error":"import_not_granted","message":"not granted"}` || fallbacks(s, "empty") < 1 {
				t.Fatalf("refusal not passed on: %s", g.body)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still served after both deletes: %d %s", g.status, g.body)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRESTFailuresAndBounds(t *testing.T) {
	cases := []struct {
		name, answer string
		status       int
		want         int
		code         string
	}{
		{"a server error", `{"error":"internal"}`, 500, 502, `"unavailable"`},
		{"an unreadable page", `not json`, 200, 502, `"unavailable"`},
		{"a page without items", `{"nextCursor":null}`, 200, 502, `"unavailable"`},
		{"a cursor that moves nothing", `{"items":[],"nextCursor":"same"}`, 200, 502, `"unavailable"`},
		{"too many records", `{"items":[{"key":"a","data":{},"version":1},{"key":"b","data":{},"version":1},{"key":"c","data":{},"version":1}],"nextCursor":null}`, 200, 502, `"too_large"`},
		{"a refusal with no body", ``, 404, 404, `"refused"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newStack(t, false, session.Options{MaxRecords: 2})
			s.store.by["civitai_alice"] = restAnswer{tc.status, tc.answer}
			g := s.get(t, notesPath, "civitai_alice")
			if g.status != tc.want || !strings.Contains(g.body, tc.code) {
				t.Fatalf("%d %s", g.status, g.body)
			}
		})
	}
}

// The site's rate-limited refusal reaches the app as the site sent it: the 429, its body with the
// house `rateLimit` meta byte for byte, and its Retry-After (exposed, so the frame can read it).
func TestASiteRateLimitIsPassedOnWithItsMetaAndRetryAfter(t *testing.T) {
	const body = `{"code":"rate_limited","message":"Too many reads","error":"Too many reads",` +
		`"details":{"bucket":"read","retryAfter":7},` +
		`"rateLimit":{"retryAfterSeconds":7,"retryAt":"2026-01-01T00:00:07.000Z","id":"apps.doc-store","kind":"abuse"}}`
	s := newStack(t, false, session.Options{})
	s.store.mu.Lock()
	s.store.by["civitai_alice"] = restAnswer{429, body}
	s.store.retryAfter["civitai_alice"] = "7"
	s.store.mu.Unlock()
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != 429 || g.body != body {
		t.Fatalf("refusal not passed on: %d %s", g.status, g.body)
	}
	if got := g.header.Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q, want 7", got)
	}
	if got := g.header.Get("Access-Control-Expose-Headers"); !strings.Contains(got, "Retry-After") {
		t.Fatalf("Retry-After not exposed to the frame: %q", got)
	}
	// CONTROL: a refusal that names no delay gets no Retry-After of ours.
	s.store.mu.Lock()
	s.store.by["civitai_alice"] = restAnswer{403, `{"error":"import_not_granted"}`}
	delete(s.store.retryAfter, "civitai_alice")
	s.store.mu.Unlock()
	if g := s.get(t, notesPath, "civitai_alice"); g.status != 403 || g.header.Get("Retry-After") != "" {
		t.Fatalf("%d Retry-After=%q", g.status, g.header.Get("Retry-After"))
	}
}

func TestRESTPagesAreFollowed(t *testing.T) {
	s := newStack(t, false, session.Options{})
	var n atomic.Int32
	s.store.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"items":[{"key":"p1","data":{},"version":1}],"nextCursor":"c1"}`)
			return
		}
		if r.URL.Query().Get("cursor") != "c1" {
			w.WriteHeader(400)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"key":"p2","data":{},"version":1}],"nextCursor":null}`)
	})
	g := s.get(t, notesPath, "civitai_alice")
	if len(g.ans.Items) != 2 || g.ans.Items[1].Key != "p2" {
		t.Fatal(g.body)
	}
}

func TestBusyRESTAnswers503(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.srv.RESTSlots = make(chan struct{}, 1)
	s.srv.RESTSlots <- struct{}{}
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != 503 || g.header.Get("Retry-After") != "1" || s.store.calls.Load() != 0 {
		t.Fatalf("%d %s", g.status, g.body)
	}
}

func TestBadRequests(t *testing.T) {
	s := newStack(t, true, session.Options{})
	for path, want := range map[string]int{
		"/v1/apps/Todo/collections/notes/records":       400,
		"/v1/apps/todo-app/collections/_x/records":      400,
		notesPath + "?major=0":                          400,
		notesPath + "?major=two":                        400,
		"/v1/apps/todo-app/collections/notes/records/x": 404,
	} {
		if g := s.get(t, path, "civitai_alice"); g.status != want {
			t.Errorf("%s: %d %s, want %d", path, g.status, g.body, want)
		}
	}
	g := s.get(t, notesPath, "")
	if g.status != 401 || g.header.Get("WWW-Authenticate") == "" {
		t.Fatalf("no token: %d", g.status)
	}
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, notesPath, http.NoBody)
	req.Header.Set("Authorization", "Basic abc")
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("basic auth: %d", rec.Code)
	}
	if s.reg.subs.Load() != 0 || s.store.calls.Load() != 0 {
		t.Fatal("a refused request reached an upstream")
	}
}

func TestProbesAndPreflight(t *testing.T) {
	s := newStack(t, true, session.Options{})
	ready := true
	s.srv.Ready = func() bool { return ready }
	s.h = s.srv.Handler()
	for path, want := range map[string]int{"/healthz": 200, "/readyz": 200, "/metrics": 200} {
		if g := s.get(t, path, ""); g.status != want {
			t.Errorf("%s: %d", path, g.status)
		}
	}
	if g := s.get(t, "/metrics", ""); !strings.Contains(g.body, "app_data_streams_open") || !strings.Contains(g.body, `app_data_fallbacks_total{reason="capacity"} 0`) {
		t.Fatal("metrics missing series")
	}
	ready = false
	if g := s.get(t, "/readyz", ""); g.status != 503 {
		t.Fatalf("draining readyz: %d", g.status)
	}
	req := httptest.NewRequestWithContext(t.Context(), http.MethodOptions, notesPath, http.NoBody)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if rec.Code != 204 || !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestEveryStreamErrorHasAFallbackReason(t *testing.T) {
	for err, want := range map[error]string{
		nil:                      "empty",
		session.ErrCapacity:      "capacity",
		session.ErrTokenCapacity: "token_capacity",
		session.ErrNotLive:       "not_live",
		session.ErrStalled:       "stalled",
		session.ErrCoolingDown:   "cooling_down",
		session.ErrInvalidToken:  "invalid_token",
		session.ErrTooLarge:      "too_large",
		session.ErrEnded:         "ended",
		session.ErrFailed:        "failed",
		session.ErrClosed:        "closed",
		session.ErrRefused:       "exchange_refused",
		session.ErrNotPrivate:    "not_private",
		session.ErrBlockSpent:    "block_spent",
		session.ErrBlockFull:     "block_cache_full",
		session.ErrCursorExpired: "cursor_expired",
	} {
		got := fallbackReason(err)
		if got != want {
			t.Errorf("%v: %q, want %q", err, got, want)
		}
		found := false
		for _, r := range metrics.FallbackReasons {
			found = found || r == got
		}
		if !found {
			t.Errorf("%q is not a declared fallback reason", got)
		}
	}
}

// 🔴 The user's hub token goes to the hub's exchange and the site's REST read only; the adapter sees
// the exchanged token. (The fakes' cleanup fails the test if the adapter is shown any other.)
func TestTheAdapterSeesOnlyTheExchangedToken(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "A")}
	if g := s.get(t, notesPath, "civitai_alice"); g.ans.Source != "registry" {
		t.Fatal(g.body)
	}
	if strings.Join(s.hub.subjects, ",") != "civitai_alice" || s.reg.raw.Load() != 0 {
		t.Fatalf("hub saw %q, adapter shown %d raw tokens", s.hub.subjects, s.reg.raw.Load())
	}
	if v, _ := s.reg.schemas.Load("civitai_alice"); v != notesSchema {
		t.Fatalf("subscribed to %v", v)
	}
}

func TestARefusedExchangeFallsBackToREST(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.hub.refuse["civitai_revoked"] = true
	s.store.by["civitai_revoked"] = restAnswer{401, `{"error":"unauthenticated"}`}
	g := s.get(t, notesPath, "civitai_revoked")
	if g.status != 401 || s.reg.subs.Load() != 0 || fallbacks(s, "exchange_refused") != 1 {
		t.Fatalf("%d %s, subs %d", g.status, g.body, s.reg.subs.Load())
	}
}

// A collection the private feed does not serve is out of contract: REST answers it.
func TestASharedCollectionIsReadFromREST(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.notPrivate["civitai_alice"] = true
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/shared-1", "PUBLIC-FEED")}
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[{"key":"shared-1","data":{"text":"REST-SHARED"},"version":1}],"nextCursor":null}`}
	for range 2 {
		g := s.get(t, notesPath, "civitai_alice")
		if g.ans.Source != "rest" || strings.Contains(g.body, "PUBLIC-FEED") {
			t.Fatalf("%s", g.body)
		}
	}
	if fallbacks(s, "not_private") != 1 || fallbacks(s, "cooling_down") != 1 || s.reg.subs.Load() != 1 {
		t.Fatalf("not_private %v, cooling_down %v, subs %d", fallbacks(s, "not_private"), fallbacks(s, "cooling_down"), s.reg.subs.Load())
	}
}

// Least privilege: the exchange asks for exactly AppDataRead, so the token the adapter sees holds
// nothing wider than a private stream reads. (The fake hub would issue its whole ceiling for a request
// naming no scope; the fakes' cleanup fails any test whose adapter is shown such a token.)
func TestTheExchangedTokenHoldsOnlyAppDataRead(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "A")}
	if g := s.get(t, notesPath, "civitai_alice"); g.ans.Source != "registry" {
		t.Fatal(g.body)
	}
	if n := s.reg.wide.Load(); n != 0 {
		t.Fatalf("the adapter was shown %d tokens wider than AppDataRead", n)
	}
	if n := s.reg.subs.Load(); n != 1 {
		t.Fatalf("%d subscriptions, want 1 (the positive control: a stream was opened)", n)
	}
}

// 🔴 Even if the handler's gate let a block token through while the block exchange is off, the
// router sends it nowhere: never to the user exchange, never to the hub. The read goes to REST.
func TestABlockTokenNeverReachesTheUserExchangeWithTheBlockExchangeOff(t *testing.T) {
	s := newStackWith(t, true, false, session.Options{})
	s.srv.Exchangeable = func(string) bool { return true } // a gate that disagrees with the router
	s.store.by[blockTok] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	g := s.get(t, notesPath, blockTok)
	if g.status != 200 || g.ans.Source != "rest" || fallbacks(s, "failed") != 1 {
		t.Fatalf("%d %s, failed %v", g.status, g.body, fallbacks(s, "failed"))
	}
	if len(s.hub.subjects) != 0 || s.reg.subs.Load() != 0 {
		t.Fatalf("hub sent %d tokens, %d subscriptions", len(s.hub.subjects), s.reg.subs.Load())
	}
}

// With no router given, only a hub token is exchanged: a block token reads REST and reaches no hub.
func TestWithoutARouterOnlyHubTokensReachAStream(t *testing.T) {
	s := newStackWith(t, true, false, session.Options{})
	s.srv.Exchangeable = nil
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "NIL-GATE-3c9d")}
	s.store.by[otherBlockTok] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	if g := s.get(t, notesPath, "civitai_alice"); g.ans.Source != "registry" {
		t.Fatalf("hub token: %d %s", g.status, g.body)
	}
	if g := s.get(t, notesPath, otherBlockTok); g.ans.Source != "rest" || fallbacks(s, "token_not_exchangeable") != 1 {
		t.Fatalf("block token: %d %s", g.status, g.body)
	}
	if s.hub.blockExchanges(otherBlockTok) != 0 {
		t.Fatal("a block token reached the hub")
	}
}

// otherBlockTok is a second block token, distinct from blockTok.
const otherBlockTok = "eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJibGstbmlsIn0.c2lnLW5pbA"

// getRegistryOnly is get with RegistryOnlyHeader set to value.
func (s *stack) getRegistryOnly(t *testing.T, path, token, value string) got {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(RegistryOnlyHeader, value)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	g := got{status: rec.Code, header: rec.Header(), body: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &g.ans)
	return g
}

// A registry-only read the registry answers is answered exactly as any read is.
func TestARegistryOnlyReadIsAnsweredFromTheStream(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-ro", "RO-ALICE-51e2")}
	g := s.getRegistryOnly(t, notesPath, "civitai_alice", "1")
	if g.status != 200 || g.ans.Source != "registry" || len(g.ans.Items) != 1 ||
		string(g.ans.Items[0].Data) != `{"text":"RO-ALICE-51e2"}` || strings.Contains(g.body, `"reason"`) {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if s.store.calls.Load() != 0 {
		t.Fatal("a registry answer also read REST")
	}
}

// 🔴 A registry-only read the registry cannot answer never reads REST: it answers source "none" with
// the fallback reason, and is not counted as a fallback.
func TestARegistryOnlyReadTheRegistryCannotAnswerNeverReadsREST(t *testing.T) {
	cases := []struct {
		name, token, reason string
		registryOn          bool
	}{
		{"the registry path off", "civitai_alice", "registry_off", false},
		{"a token the hub cannot exchange", "eyJro.block.token", "token_not_exchangeable", true},
		{"a stream that holds nothing", "civitai_carol", "empty", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newStack(t, tc.registryOn, session.Options{})
			// REST would answer, so a read that followed the fallback would show it.
			s.store.by[tc.token] = restAnswer{200, `{"items":[{"key":"k1","data":{"text":"REST-RO-9c1d"},"version":1}],"nextCursor":null}`}
			g := s.getRegistryOnly(t, notesPath, tc.token, "1")
			if g.status != 200 || g.ans.Source != "none" || g.ans.Reason != tc.reason ||
				!strings.Contains(g.body, `"items":[]`) || strings.Contains(g.body, "REST-RO-9c1d") {
				t.Fatalf("%d %s", g.status, g.body)
			}
			if n := s.store.calls.Load(); n != 0 {
				t.Fatalf("REST read %d times", n)
			}
			if fallbacks(s, tc.reason) != 0 {
				t.Fatal("a registry-only miss was counted as a fallback")
			}
			if v := testutil.ToFloat64(s.m.Reads.WithLabelValues("none", "registry_only")); v != 1 {
				t.Fatalf("registry_only reads counted %v", v)
			}
			if g.header.Get("Cache-Control") != "private, no-store" {
				t.Fatalf("Cache-Control %q", g.header.Get("Cache-Control"))
			}
		})
	}
}

// Only the value "1" asks for registry-only: any other value reads as an ordinary read.
func TestARegistryOnlyHeaderOtherThanOneIsAnOrdinaryRead(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[{"key":"k1","data":{"text":"REST-ORD-4b7e"},"version":2}],"nextCursor":null}`}
	g := s.getRegistryOnly(t, notesPath, "civitai_alice", "true")
	if g.status != 200 || g.ans.Source != "rest" || len(g.ans.Items) != 1 || s.store.calls.Load() != 1 ||
		fallbacks(s, "registry_off") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
}

// The preflight does not allow the header, so a browser can never send it.
func TestThePreflightDoesNotAllowTheRegistryOnlyHeader(t *testing.T) {
	s := newStack(t, false, session.Options{})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodOptions, notesPath, http.NoBody)
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if strings.Contains(strings.ToLower(rec.Header().Get("Access-Control-Allow-Headers")), strings.ToLower(RegistryOnlyHeader)) {
		t.Fatalf("preflight allows %s", RegistryOnlyHeader)
	}
}

// kent is ent with the storage key the adapter's private feed sends beside the body.
func kent(urn, key, canary string) registry.Entity {
	e := ent(urn, canary)
	e.Key = key
	return e
}

func itemKeys(a answer) string {
	keys := make([]string, 0, len(a.Items))
	for _, it := range a.Items {
		keys = append(keys, it.Key)
	}
	return strings.Join(keys, ",")
}

// A registry item carries its storage key beside its URN.
func TestARegistryItemCarriesItsKey(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{kent("urn:apps.civitai.com:todo-app/notes/r-k1", "note-a41", "KEY-ALICE-0e5c")}
	g := s.get(t, notesPath, "civitai_alice")
	if g.status != 200 || g.ans.Source != "registry" || len(g.ans.Items) != 1 ||
		g.ans.Items[0].URN != "urn:apps.civitai.com:todo-app/notes/r-k1" || g.ans.Items[0].Key != "note-a41" {
		t.Fatalf("%d %s", g.status, g.body)
	}
}

// keyPrefix keeps the registry records whose key starts with it; a prefix that keeps none is an empty
// registry answer (the stream holds records, so it was not refused), and REST is never read.
func TestAKeyPrefixFiltersTheRegistryAnswer(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{
		kent("urn:apps.civitai.com:todo-app/notes/r-1", "run:b7", "PFX-RUN-B-11aa"),
		kent("urn:apps.civitai.com:todo-app/notes/r-2", "cfg:x2", "PFX-CFG-X-22bb"),
		kent("urn:apps.civitai.com:todo-app/notes/r-3", "run:a3", "PFX-RUN-A-33cc"),
	}
	g := s.get(t, notesPath+"?keyPrefix=run:", "civitai_alice")
	if g.status != 200 || g.ans.Source != "registry" || itemKeys(g.ans) != "run:b7,run:a3" || strings.Contains(g.body, "PFX-CFG-X-22bb") {
		t.Fatalf("%d %s", g.status, g.body)
	}
	none := s.get(t, notesPath+"?keyPrefix=zzz", "civitai_alice")
	if none.status != 200 || none.ans.Source != "registry" || !strings.Contains(none.body, `"items":[]`) {
		t.Fatalf("%d %s", none.status, none.body)
	}
	if s.store.calls.Load() != 0 {
		t.Fatal("a registry answer read REST")
	}
}

// 🔴 A stream whose records carry no key cannot be filtered: a keyPrefix read goes to REST with the
// prefix (`unkeyed`), and a registry-only one answers the miss.
func TestAKeyPrefixReadOfAnUnkeyedStreamGoesToREST(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-u", "UNKEYED-ALICE-4f1d")}
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[{"key":"run:k","data":{"text":"REST-PFX-77e0"},"version":4}],"nextCursor":null}`}
	g := s.get(t, notesPath+"?keyPrefix=run:", "civitai_alice")
	if g.status != 200 || g.ans.Source != "rest" || itemKeys(g.ans) != "run:k" || fallbacks(s, "unkeyed") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
	if strings.Join(s.store.prefixes, ",") != "run:" {
		t.Fatalf("keyPrefix sent to REST: %q", s.store.prefixes)
	}
	ro := s.getRegistryOnly(t, notesPath+"?keyPrefix=run:", "civitai_alice", "1")
	if ro.ans.Source != "none" || ro.ans.Reason != "unkeyed" || s.store.calls.Load() != 1 {
		t.Fatalf("%d %s", ro.status, ro.body)
	}
	// Without a prefix the same unkeyed stream answers as before.
	if g := s.get(t, notesPath, "civitai_alice"); g.ans.Source != "registry" || len(g.ans.Items) != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
}

// With the registry off, the keyPrefix is passed through to REST; without one none is sent.
func TestTheRESTPathPassesTheKeyPrefixThrough(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	_ = s.get(t, notesPath+"?keyPrefix=bench.v2-", "civitai_alice")
	_ = s.get(t, notesPath, "civitai_alice")
	if strings.Join(s.store.prefixes, "|") != "bench.v2-|" {
		t.Fatalf("keyPrefix sent: %q", s.store.prefixes)
	}
}

func TestABadKeyPrefixIsRefused(t *testing.T) {
	s := newStack(t, true, session.Options{})
	for _, q := range []string{"?keyPrefix=", "?keyPrefix=a/b", "?keyPrefix=" + strings.Repeat("k", 129)} {
		if g := s.get(t, notesPath+q, "civitai_alice"); g.status != 400 {
			t.Errorf("%s: %d %s", q, g.status, g.body)
		}
	}
	if g := s.get(t, notesPath+"?keyPrefix="+strings.Repeat("k", 128), "civitai_alice"); g.status == 400 {
		t.Fatalf("a 128-character prefix was refused: %s", g.body)
	}
	if s.store.calls.Load() != 1 {
		t.Fatalf("%d REST reads, want only the valid one", s.store.calls.Load())
	}
}

func (s *stack) call(t *testing.T, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader = http.NoBody
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequestWithContext(t.Context(), method, path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	return rec
}

// writePaths is every write route and `info`, under the read's app and collection.
var writePaths = []struct{ method, path, body string }{
	{"POST", notesPath, `{"data":{"t":"c"}}`},
	{"PUT", notesPath + "/note-w1", `{"data":{"t":"p"}}`},
	{"DELETE", notesPath + "/note-w2", ""},
	{"GET", "/v1/apps/todo-app/info", ""},
	{"OPTIONS", notesPath + "/note-w4", ""},
	{"OPTIONS", "/v1/apps/todo-app/info", ""},
}

// 7. With APP_DATA_WRITES off every write route and `info` is the mux's 404, and the read route
// answers as before, its preflight unchanged.
// On origin/main the POST to the collection path is the mux's 405 (only GET and OPTIONS are
// registered there), so `rec.Code != 404` fails for it; the key and info paths are 404 there too, so
// for those this is an invariant guard.
func TestWithWritesOffEveryWriteRouteIs404AndReadsAreUnchanged(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_writes_off"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	for _, w := range writePaths {
		if rec := s.call(t, w.method, w.path, "civitai_writes_off", w.body); rec.Code != 404 {
			t.Errorf("%s %s: %d, want 404", w.method, w.path, rec.Code)
		}
	}
	if g := s.get(t, notesPath, "civitai_writes_off"); g.status != 200 || g.ans.Source != "rest" {
		t.Fatalf("the read: %d %s", g.status, g.body)
	}
	if rec := s.call(t, "OPTIONS", notesPath, "", ""); rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Methods") != "GET, OPTIONS" {
		t.Fatalf("the read's preflight: %d %v", rec.Code, rec.Header())
	}
	if s.store.calls.Load() != 1 {
		t.Fatalf("the site was called %d times, want only the read", s.store.calls.Load())
	}
}

// With writes on, each route reaches the forwarder (a fake site counts it), the read route is
// unchanged, and the collection path's preflight allows the create.
// Fails on origin/main: Server has no Writes field there (the test does not compile).
func TestWithWritesOnTheWriteRoutesAreServed(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_writes_on"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	var forwarded atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		if !strings.HasPrefix(r.URL.Path, writes.InternalPath) || r.URL.Query().Get("from") != "todo-app" {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(site.Close)
	base, _ := url.Parse(site.URL)
	s.srv.Writes = &writes.Forwarder{Site: base, Key: []byte("api-test-signing-key-0123456789-abc"), Timeout: 2 * time.Second, Metrics: s.m}
	s.h = s.srv.Handler()
	sent := int32(0)
	for _, w := range writePaths {
		rec := s.call(t, w.method, w.path, "civitai_writes_on", w.body)
		want := 200
		if w.method == "OPTIONS" {
			want = 204
		} else {
			sent++
		}
		if rec.Code != want || forwarded.Load() != sent {
			t.Errorf("%s %s: %d, %d forwarded; want %d, %d", w.method, w.path, rec.Code, forwarded.Load(), want, sent)
		}
	}
	// With the writes on a read is a cut-over app's: never REST, so with no registry it is refused.
	if g := s.get(t, notesPath, "civitai_writes_on"); g.status != 503 || !strings.Contains(g.body, `"registry_off"`) || s.store.calls.Load() != 0 {
		t.Fatalf("the read: %d %s", g.status, g.body)
	}
	if rec := s.call(t, "OPTIONS", notesPath, "", ""); rec.Code != 204 || !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") ||
		!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Content-Type") {
		t.Fatalf("the collection path's preflight: %d %v", rec.Code, rec.Header())
	}
}
