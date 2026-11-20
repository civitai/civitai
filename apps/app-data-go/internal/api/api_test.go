package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/rest"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// End to end: the real handler, the real session manager and registry client over HTTP to a fake
// registry, and the real REST client to a fake document store. Both fakes judge by bearer token, as
// the adapter and the site do, and every token's fixtures are distinct.

const notesSchema = "urn:schema:apps.civitai.com:todo-app/notes@v1"

// fakeRegistry serves the HTTP binding. Each token's stream is sent its records, then Live (unless
// the token is in stall), and stays open; deletes pushed with revoke are sent on every open stream
// of that token.
type fakeRegistry struct {
	srv     *httptest.Server
	mu      sync.Mutex
	records map[string][]registry.Entity
	stall   map[string]bool
	revokes map[string][]chan string
	subs    atomic.Int32
	schemas sync.Map // token → schema last asked
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{records: map[string][]registry.Entity{}, stall: map[string]bool{}, revokes: map[string][]chan string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.subs.Add(1)
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		f.schemas.Store(tok, r.URL.Query().Get("schema"))
		ch := make(chan string, 16)
		f.mu.Lock()
		recs, stall := f.records[tok], f.stall[tok]
		f.revokes[tok] = append(f.revokes[tok], ch)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, e := range recs {
			raw, _ := json.Marshal(map[string]any{"entity": e, "cursor": ""})
			_, _ = fmt.Fprintf(w, "event: upsert\ndata: %s\n\n", raw)
		}
		if !stall {
			_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"c1\"}\n\n")
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

type restAnswer struct {
	status int
	body   string
}

// fakeStore is the site's document store list.
type fakeStore struct {
	srv   *httptest.Server
	mu    sync.Mutex
	by    map[string]restAnswer // token → answer
	calls atomic.Int32
	froms []string
	block chan struct{}
}

func newFakeStore(t *testing.T) *fakeStore {
	t.Helper()
	f := &fakeStore{by: map[string]restAnswer{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.mu.Lock()
		f.froms = append(f.froms, r.URL.Query().Get("from"))
		a, ok := f.by[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
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
		w.WriteHeader(a.status)
		_, _ = io.WriteString(w, a.body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

type stack struct {
	reg   *fakeRegistry
	store *fakeStore
	mgr   *session.Manager
	m     *metrics.Metrics
	h     http.Handler
	srv   *Server
}

func newStack(t *testing.T, registryOn bool, opts session.Options) *stack {
	t.Helper()
	s := &stack{reg: newFakeRegistry(t), store: newFakeStore(t)}
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
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
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
}

func TestWithTheRegistryOffEveryReadIsREST(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_alice"] = restAnswer{200, `{"items":[],"nextCursor":null}`}
	g := s.get(t, notesPath+"?import=1", "civitai_alice")
	if g.status != 200 || g.ans.Source != "rest" || s.reg.subs.Load() != 0 || fallbacks(s, "registry_off") != 1 {
		t.Fatalf("%d %s", g.status, g.body)
	}
	// An import reads the source app through the site's import path.
	if s.store.froms[0] != "todo-app" {
		t.Fatalf("from %q", s.store.froms[0])
	}
	_ = s.get(t, notesPath, "civitai_alice")
	if s.store.froms[1] != "" {
		t.Fatalf("an own read sent from=%q", s.store.froms[1])
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
	g = s.get(t, "/v1/apps/todo-app/collections/lists/records", "civitai_alice")
	_ = g // a second collection for alice is over the process cap too
	if fallbacks(s, "capacity") != 2 {
		t.Fatalf("capacity fallbacks %v", fallbacks(s, "capacity"))
	}
}

// The deadline: a stream that never reaches Live (a relay stalled, civitai-registry#50) is given up
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
	if g := s.get(t, notesPath+"?import=1", "civitai_grantee"); len(g.ans.Items) != 2 {
		t.Fatal(g.body)
	}
	s.reg.revoke("civitai_grantee", "urn:apps.civitai.com:todo-app/notes/r-1")
	deadline := time.Now().Add(2 * time.Second)
	for {
		g := s.get(t, notesPath+"?import=1", "civitai_grantee")
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
		g := s.get(t, notesPath+"?import=1", "civitai_grantee")
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
		notesPath + "?import=yes":                       400,
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
