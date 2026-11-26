package evalharness

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

type selectCall struct {
	endpoint string
	from, to time.Time
	day      string
	limit    int
}

// memStore is a Store in memory.
type memStore struct {
	mu      sync.Mutex
	cases   map[string][]Case
	selects []selectCall
	results []ResultRow
	runs    []RunRow
}

func (m *memStore) SelectCases(_ context.Context, endpoint string, from, to time.Time, day string, limit int) ([]Case, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.selects = append(m.selects, selectCall{endpoint, from, to, day, limit})
	return m.cases[endpoint], nil
}

func (m *memStore) AddResult(r ResultRow) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.results = append(m.results, r)
	return true
}

func (m *memStore) AddRun(r RunRow) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runs = append(m.runs, r)
	return true
}

func (m *memStore) Close(context.Context) error { return nil }

const testHost = "site.example"

func v1Case(id uint64, modelID int, viewer evalcorpus.ViewerDescriptor) Case {
	return Case{ID: id, Endpoint: evalcorpus.EndpointV1ModelsID, Sig: id + 0x5000, SigText: `{"v":1}`, Weight: float64(id % 7),
		Request: evalcapture.StoredRequest{Path: "/api/v1/models/" + strconv.Itoa(modelID), Query: "nsfw=false",
			Headers: map[string]string{"host": testHost, "cf-ipcountry": "DE"}, Credential: "none", Viewer: viewer}}
}

// arms are the Node and Go test servers: each answers per scenario (the model id in the path, or the
// tRPC procedure), and records what it was sent.
type arms struct {
	t          *testing.T
	ownerToken string
	mu         sync.Mutex
	nodeCalls  map[string]int
	goCalls    map[string]int
	problems   []string
}

func (a *arms) problem(s string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.problems = append(a.problems, s)
}

func (a *arms) count(m map[string]int, path string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	m[path]++
	return m[path]
}

const postsBody = `{"result":{"data":{"json":{"items":[{"postId":61,"id":61}]},"meta":{}}}}`

// checkTRPC checks the owner case's request: the cookie, and `$self` replaced by the owner's id.
func (a *arms) checkTRPC(r *http.Request, side string) {
	if got := r.Header.Get("Cookie"); got != "eval-session="+a.ownerToken {
		a.problem(side + ": owner cookie missing")
	}
	var env struct {
		JSON map[string]any `json:"json"`
	}
	if err := json.Unmarshal([]byte(r.URL.Query().Get("input")), &env); err != nil || env.JSON["userId"] != float64(7301) {
		a.problem(side + ": input " + r.URL.Query().Get("input"))
	}
}

// API-key scenarios: model 111 replays a `header` credential, 112 a `query` one. Every other
// request must carry neither.
const (
	headerKeyPath = "/api/v1/models/111"
	queryKeyPath  = "/api/v1/models/112"
)

func (a *arms) common(r *http.Request, side string) {
	if r.Host != testHost {
		a.problem(side + ": host " + r.Host)
	}
	auth, query := r.Header.Get("Authorization"), r.URL.RawQuery
	switch r.URL.Path {
	case headerKeyPath:
		if auth != "Bearer "+testAPIKey || query != "nsfw=false" || r.Header.Get("Cookie") != "" {
			a.problem(side + ": header key case: auth/query/cookie wrong")
		}
	case queryKeyPath:
		if auth != "" || query != "nsfw=false&token=apikey%2Bsec%2F9931%3D" || r.Header.Get("Cookie") != "" { // gitleaks:allow synthetic test key
			a.problem(side + ": query key case: auth/query/cookie wrong")
		}
	default:
		if auth != "" || r.URL.Query().Has("token") {
			a.problem(side + ": a key on a case that had none: " + r.URL.Path)
		}
	}
	if r.Header.Get("Cf-Ipcountry") != "DE" || r.Header.Get("Referer") != "https://"+testHost+"/" {
		a.problem(side + ": stored headers or referer missing")
	}
}

func (a *arms) node(w http.ResponseWriter, r *http.Request) {
	a.common(r, "node")
	if r.Header.Get(server.ParityReplayHeader) != "1" {
		a.problem("node: no replay header")
	}
	k := a.count(a.nodeCalls, r.URL.Path)
	h := w.Header()
	h.Set("Cache-Control", "public, max-age=61")
	switch r.URL.Path {
	case "/api/trpc/" + server.Procedure:
		a.checkTRPC(r, "node")
		_, _ = w.Write([]byte(postsBody))
	case "/api/v1/models/101":
		_, _ = w.Write([]byte(`{"id":101,"name":"a101"}`))
	case headerKeyPath, queryKeyPath:
		_, _ = w.Write([]byte(`{"id":111,"name":"key"}`))
	case "/api/v1/models/102":
		if k == 1 {
			h.Set("Cache-Control", "public, max-age=17")
		}
		_, _ = w.Write([]byte(`{"id":102,"name":"a102"}`))
	case "/api/v1/models/103":
		_, _ = w.Write([]byte(`{"id":103,"name":"n103"}`))
	case "/api/v1/models/107":
		_, _ = w.Write([]byte(`{"id":107,"count":` + strconv.Itoa(k) + `}`))
	case "/api/v1/models/108":
		if k == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"id":108}`))
	default:
		_, _ = w.Write([]byte(`{"id":1}`))
	}
}

func (a *arms) goArm(w http.ResponseWriter, r *http.Request) {
	a.common(r, "go")
	if r.Header.Get(server.ParityReplayHeader) != "" {
		a.problem("go: got the replay header")
	}
	a.count(a.goCalls, r.URL.Path)
	h := w.Header()
	h.Set("Cache-Control", "max-age=61, public")
	switch r.URL.Path {
	case "/api/trpc/" + server.Procedure:
		a.checkTRPC(r, "go")
		_, _ = w.Write([]byte(postsBody))
	case "/api/v1/models/101":
		_, _ = w.Write([]byte(`{"name":"a101","id":101}`))
	case headerKeyPath, queryKeyPath:
		_, _ = w.Write([]byte(`{"id":111,"name":"key"}`))
	case "/api/v1/models/102":
		_, _ = w.Write([]byte(`{"id":102,"name":"a102"}`))
	case "/api/v1/models/103":
		_, _ = w.Write([]byte(`{"id":103,"name":"g103"}`))
	case "/api/v1/models/104":
		h.Set(server.HandbackReasonHeader, "origin")
		w.WriteHeader(server.HandbackStatus)
	case "/api/v1/models/105":
		w.WriteHeader(http.StatusServiceUnavailable)
	case "/api/v1/models/106":
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	case "/api/v1/models/107":
		_, _ = w.Write([]byte(`{"id":107,"count":1}`))
	default:
		_, _ = w.Write([]byte(`{"id":108}`))
	}
}

func TestRunEveryVerdict(t *testing.T) {
	path := writeAccounts(t, nil, RoleFiltered)
	accounts, err := LoadAccounts(path, time.Now(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	a := &arms{t: t, ownerToken: accounts.Role(RoleOwner).token, nodeCalls: map[string]int{}, goCalls: map[string]int{}}
	nodeSrv := httptest.NewServer(http.HandlerFunc(a.node))
	defer nodeSrv.Close()
	goSrv := httptest.NewServer(http.HandlerFunc(a.goArm))
	defer goSrv.Close()

	anon := evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerAnon}
	store := &memStore{cases: map[string][]Case{
		evalcorpus.EndpointV1ModelsID: {
			v1Case(0x1101, 101, anon), v1Case(0x1102, 102, anon), v1Case(0x1103, 103, anon), v1Case(0x1104, 104, anon),
			v1Case(0x1105, 105, anon), v1Case(0x1106, 106, anon), v1Case(0x1107, 107, anon), v1Case(0x1108, 108, anon),
			v1Case(0x1109, 109, evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerModerator}),
			withCredential(v1Case(0x1111, 111, evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerUser}), "header"),
			withCredential(v1Case(0x1112, 112, anon), "query"),
		},
		evalcorpus.EndpointAsPosts: {{ID: 0x1110, Endpoint: evalcorpus.EndpointAsPosts, Sig: 0x6110, SigText: `{"v":1}`,
			Request: evalcapture.StoredRequest{Input: `{"json":{"userId":"$self","limit":20}}`,
				Headers: map[string]string{"host": testHost, "cf-ipcountry": "DE"}, Credential: "session",
				Viewer: evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerUser, Self: true}}}},
	}}
	var log bytes.Buffer
	cfg := RunConfig{NodeURL: nodeSrv.URL, GoURL: goSrv.URL, ForceWindow: true, AllowNoHealth: true, RPS: 1000,
		CallTimeout: 300 * time.Millisecond, Lookback: 48 * time.Hour, PerEndpointCap: 37, Log: &log,
		NodeImage: "node-img-a", GoImage: "go-img-b", SnapshotID: "snap-c"}
	row, err := Run(context.Background(), cfg, accounts, store)
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, p := range a.problems {
		t.Error(p)
	}
	type want struct {
		verdict, reason, class string
		cats, unstable         []string
		viewer                 string
		node, goStatus         uint16
	}
	wants := map[uint64]want{
		0x1101: {VerdictPass, "", "", []string{}, []string{}, "anon", 200, 200},
		0x1102: {VerdictPass, "", "", []string{}, []string{}, "anon", 200, 200},
		0x1103: {VerdictBug, "", "fields", []string{"name"}, []string{}, "anon", 200, 200},
		0x1104: {VerdictGap, "origin", "", []string{}, []string{}, "anon", 200, server.HandbackStatus},
		0x1105: {VerdictError, "go-status-503", "", []string{}, []string{}, "anon", 200, 503},
		0x1106: {VerdictError, "go-timeout", "", []string{}, []string{}, "anon", 200, 0},
		0x1107: {VerdictNodeUnstable, "body", "fields", []string{"count"}, []string{"$.count"}, "anon", 200, 200},
		0x1108: {VerdictInfraMiss, "node1-status-5xx", "", []string{}, []string{}, "anon", 500, 200},
		0x1109: {VerdictNotReplayable, "viewer:moderator", "", []string{}, []string{}, "", 0, 0},
		0x1110: {VerdictPass, "", "", []string{}, []string{}, RoleOwner, 200, 200},
		0x1111: {VerdictPass, "", "", []string{}, []string{}, "apikey:member-filtered", 200, 200},
		0x1112: {VerdictPass, "", "", []string{}, []string{}, "apikey:member-filtered", 200, 200},
	}
	if len(store.results) != len(wants) {
		t.Fatalf("%d results, want %d", len(store.results), len(wants))
	}
	for _, r := range store.results {
		w, ok := wants[r.CaseID]
		if !ok {
			t.Errorf("unexpected case %x", r.CaseID)
			continue
		}
		got := want{r.Verdict, r.Reason, r.ResultClass, r.DiffCategories, r.UnstablePaths, r.ViewerUsed, r.NodeStatus, r.GoStatus}
		if !reflect.DeepEqual(got, w) {
			t.Errorf("case %x:\n got %+v\nwant %+v", r.CaseID, got, w)
		}
		if r.RunID != row.RunID || r.TS == "" {
			t.Errorf("case %x: run %q ts %q", r.CaseID, r.RunID, r.TS)
		}
	}
	// The moderator's case never reached either side; every replayed case is a sandwich.
	if a.nodeCalls["/api/v1/models/109"] != 0 || a.goCalls["/api/v1/models/109"] != 0 {
		t.Error("a not_replayable case was sent")
	}
	if a.nodeCalls["/api/v1/models/101"] != 2 || a.goCalls["/api/v1/models/101"] != 1 {
		t.Errorf("sandwich: node %d go %d", a.nodeCalls["/api/v1/models/101"], a.goCalls["/api/v1/models/101"])
	}
	// The selection's window and cap.
	for _, s := range store.selects {
		if s.limit != 37 || s.to.Sub(s.from) != 48*time.Hour || s.day != s.to.Format(time.DateOnly) {
			t.Errorf("select %+v", s)
		}
	}
	if len(store.runs) != 1 {
		t.Fatalf("%d run rows", len(store.runs))
	}
	run := store.runs[0]
	if run.Phase != PhaseLive || run.NodeImage != "node-img-a" || run.GoImage != "go-img-b" || run.SnapshotID != "snap-c" ||
		!strings.HasPrefix(run.RunID, "live-") || !runIDRE.MatchString(run.RunID) {
		t.Errorf("run row %+v", run)
	}
	var settings Settings
	if err := json.Unmarshal([]byte(run.Settings), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.EndReason != EndDone || settings.Verdicts[VerdictPass] != 5 || settings.Verdicts[VerdictError] != 2 ||
		settings.Selected[evalcorpus.EndpointV1ModelsID] != 11 {
		t.Errorf("settings %+v", settings)
	}
	// Both arms saw each key case (the checks above ran on each).
	for _, p := range []string{headerKeyPath, queryKeyPath} {
		if a.nodeCalls[p] != 2 || a.goCalls[p] != 1 {
			t.Errorf("%s: node %d go %d", p, a.nodeCalls[p], a.goCalls[p])
		}
	}
	for _, leak := range []string{nodeSrv.URL, goSrv.URL, "127.0.0.1", a.ownerToken, testAPIKey} {
		if strings.Contains(run.Settings, leak) || strings.Contains(log.String(), leak) {
			t.Errorf("settings or log hold %q", leak)
		}
	}
}

func withCredential(c Case, credential string) Case {
	c.Request.Credential = credential
	return c
}

func TestRunStopsAtMaxCases(t *testing.T) {
	soon := time.Now().Add(2 * 24 * time.Hour).UTC().Truncate(time.Second)
	accounts, err := LoadAccounts(writeAccounts(t, map[string]string{RoleMature: fakeJWT(t, soon.Unix())}, ""), time.Now(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"id":1}`)) }))
	defer srv.Close()
	anon := evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerAnon}
	store := &memStore{cases: map[string][]Case{evalcorpus.EndpointV1ModelsID: {
		v1Case(0x2201, 201, anon), v1Case(0x2202, 202, anon), v1Case(0x2203, 203, anon), v1Case(0x2204, 204, anon)}}}
	cfg := RunConfig{NodeURL: srv.URL, GoURL: srv.URL, ForceWindow: true, AllowNoHealth: true, RPS: 1000, MaxCases: 3,
		Endpoints: []string{evalcorpus.EndpointV1ModelsID}}
	if _, err := Run(context.Background(), cfg, accounts, store); err != nil {
		t.Fatal(err)
	}
	if len(store.results) != 3 || !strings.Contains(store.runs[0].Settings, `"end_reason":"max-cases"`) {
		t.Fatalf("%d results, settings %s", len(store.results), store.runs[0].Settings)
	}
	// The expiring account is recorded on the run (role and date; never the token).
	wantNote := `"accounts":[{"role":"member-mature","expires":"` + soon.Format(time.RFC3339) + `","state":"expiring"}]`
	if !strings.Contains(store.runs[0].Settings, wantNote) {
		t.Errorf("settings %s lack %s", store.runs[0].Settings, wantNote)
	}
}

func TestInterleave(t *testing.T) {
	c := func(id uint64) Case { return Case{ID: id} }
	got := interleave([][]Case{{c(1), c(2), c(3)}, {c(4)}, {c(5), c(6)}})
	ids := make([]uint64, 0, len(got))
	for _, x := range got {
		ids = append(ids, x.ID)
	}
	if !reflect.DeepEqual(ids, []uint64{1, 4, 5, 2, 6, 3}) {
		t.Fatalf("%v", ids)
	}
}

// TestCallSeparatesCancelFromTimeout: a call cut by its own timeout is Timeout; one cut by the run's
// cancellation is Canceled and never Timeout, and a sandwich holding one scores infra_miss canceled.
func TestCallSeparatesCancelFromTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer srv.Close()
	p := &Prepared{Path: "/slow", Header: http.Header{}}
	r := &runner{cfg: RunConfig{CallTimeout: 100 * time.Millisecond, HTTP: &http.Client{}}}
	if a := r.call(context.Background(), srv.URL, p, false); !a.Timeout || a.Canceled || a.Err == nil {
		t.Fatalf("own timeout: %+v", a)
	}
	r.cfg.CallTimeout = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	a := r.call(ctx, srv.URL, p, true)
	if !a.Canceled || a.Timeout || a.Err == nil {
		t.Fatalf("parent cancelled: %+v", a)
	}
	ok := ans(200, `{"id":1}`)
	sel := server.CompareSelection(evalcorpus.EndpointV1ModelsID)
	for i, sandwich := range [][3]Answer{{a, ok, ok}, {ok, a, ok}, {ok, ok, a}} {
		if got := Score(sel, nil, sandwich[0], sandwich[1], sandwich[2]); !reflect.DeepEqual(got, Outcome{Verdict: VerdictInfraMiss, Reason: ReasonCanceled}) {
			t.Errorf("cancelled call %d: %+v", i, got)
		}
	}
}

// TestRunCancelledMidCase: a case in flight when the run is cancelled is infra_miss `canceled`, not a
// Go timeout (the per-call timeout here is far longer than the test).
func TestRunCancelledMidCase(t *testing.T) {
	accounts, err := LoadAccounts(writeAccounts(t, nil, ""), time.Now(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 1)
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"id":1}`)) }))
	defer node.Close()
	goSrv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	defer goSrv.Close()
	store := &memStore{cases: map[string][]Case{evalcorpus.EndpointV1ModelsID: {
		v1Case(0x4401, 401, evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerAnon})}}}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-started
		cancel()
	}()
	cfg := RunConfig{NodeURL: node.URL, GoURL: goSrv.URL, ForceWindow: true, AllowNoHealth: true, RPS: 1000,
		CallTimeout: 30 * time.Second, Endpoints: []string{evalcorpus.EndpointV1ModelsID}}
	if _, err := Run(ctx, cfg, accounts, store); err != nil {
		t.Fatal(err)
	}
	if len(store.results) != 1 || store.results[0].Verdict != VerdictInfraMiss || store.results[0].Reason != ReasonCanceled {
		t.Fatalf("results %+v", store.results)
	}
}

// TestRunRefusesAnEndpointWithoutASelection: an endpoint with masks (so it passes the corpus check)
// but no compare selection of its own is refused, never scored by the gallery default; one with
// neither is refused by the corpus check.
func TestRunRefusesAnEndpointWithoutASelection(t *testing.T) {
	const fake = "eval-test-unselected"
	evalcorpus.Masks[fake] = []string{}
	t.Cleanup(func() { delete(evalcorpus.Masks, fake) })
	cfg := RunConfig{NodeURL: "http://127.0.0.1:1", GoURL: "http://127.0.0.1:2", AllowNoHealth: true, ForceWindow: true,
		Endpoints: []string{evalcorpus.EndpointAsPosts, fake}}
	_, err := Run(context.Background(), cfg, nil, &memStore{})
	if err == nil || !strings.Contains(err.Error(), `endpoint "eval-test-unselected": no compare selection`) {
		t.Fatalf("err %v", err)
	}
	cfg.Endpoints = []string{"v1-images"}
	if _, err := Run(context.Background(), cfg, nil, &memStore{}); err == nil || !strings.Contains(err.Error(), "not a corpus endpoint") {
		t.Fatalf("non-corpus endpoint: %v", err)
	}
}
