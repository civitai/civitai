package server

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Eval mode's hand-back stub (DESIGN.md §19.7) is a wire contract with the replay harness: the status
// and the header name are literals here, never the constants.
const (
	wantHandbackStatus = 599
	wantHandbackHeader = "X-Feed-Go-Handback-Reason"
)

// evalUpstreams sets every route upstream to one recorder, so every route is mounted and any proxying
// is seen.
func evalUpstreams(s *Server) *proxyRecorder {
	fb := &proxyRecorder{}
	s.Fallback, s.V1Fallback, s.V1ImagesFallback, s.SearchFallback = fb, fb, fb, fb
	return fb
}

// assertStub fails unless w is the stub carrying reason, and nothing was proxied.
func assertStub(t *testing.T, w *httptest.ResponseRecorder, fb *proxyRecorder, reason string) {
	t.Helper()
	if w.Code != wantHandbackStatus || fb.calls != 0 {
		t.Fatalf("code=%d proxied=%d, want %d and 0", w.Code, fb.calls, wantHandbackStatus)
	}
	if got := w.Header().Values(wantHandbackHeader); len(got) != 1 || got[0] != reason {
		t.Fatalf("%s = %q, want [%q]", wantHandbackHeader, got, reason)
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served = %q, want [\"node\"]", got)
	}
	if w.Body.Len() != 0 {
		t.Fatalf("stub body = %q, want empty", w.Body.String())
	}
}

// Every route PublicMux mounts answers its hand-back with the stub, never the upstream. The route set
// is a ledger: a route added to (or dropped from) publicRoutes fails here until its expected hand-back
// is written down, so no route can join the public mux without being shown to stub.
func TestEvalModeStubsEveryPublicRoute(t *testing.T) {
	for _, upstreams := range []bool{true, false} {
		t.Run(map[bool]string{true: "upstreams", false: "no upstreams"}[upstreams], func(t *testing.T) {
			testEvalModeStubsEveryPublicRoute(t, upstreams)
		})
	}
}

// testEvalModeStubsEveryPublicRoute is TestEvalModeStubsEveryPublicRoute with every route upstream set
// (a recorder that must never be called), or none: an eval pod mounts and stubs every route either way.
func testEvalModeStubsEveryPublicRoute(t *testing.T, upstreams bool) {
	s := muxServer()
	s.EvalMode = true
	fb := &proxyRecorder{}
	if upstreams {
		fb = evalUpstreams(s)
	}
	// Every serve switch is off (the zero Server), so each route hands back for its own off reason;
	// the gallery procedure has no switch and hands back a request with no Origin (`origin`).
	want := map[string]string{
		"/api/trpc/" + Procedure:            "origin",
		"/api/trpc/" + ProcedureModelGetAll: "model-getall-off",
		"/api/trpc/" + ProcedureInfinite:    "infinite-off",
		V1ModelsPath:                        "v1-models-off",
		V1ModelsPath + "/":                  "v1-models-off",
		V1ImagesPath:                        "v1-images-off",
		SearchPath + "/":                    "search-off",
	}
	got := make([]string, 0, len(want))
	for _, rt := range publicRoutes(s) {
		got = append(got, rt.pattern)
	}
	wantPatterns := make([]string, 0, len(want))
	for p := range want {
		wantPatterns = append(wantPatterns, p)
	}
	sort.Strings(got)
	sort.Strings(wantPatterns)
	if strings.Join(got, " ") != strings.Join(wantPatterns, " ") {
		t.Fatalf("public routes = %v, want %v", got, wantPatterns)
	}
	mux := PublicMux(s)
	for pattern, reason := range want {
		t.Run(pattern, func(t *testing.T) {
			path := pattern
			if strings.HasSuffix(path, "/") {
				path += "123"
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
			assertStub(t, w, fb, reason)
		})
	}
}

// The stub carries the exact reason of each kind of hand-back serve has: a refused origin, a fallback
// a real compute returns (`method`), the bulkhead, the request budget, a fallback from the compute,
// and a compute error (no reason: `error`).
func TestEvalModeStubCarriesTheReason(t *testing.T) {
	cases := []struct {
		name   string
		fn     func(context.Context, *http.Request) (*computed, error)
		setup  func(*Server, *http.Request) *http.Request
		reason string
	}{
		{name: "origin", fn: served(nil), reason: "origin", setup: func(_ *Server, r *http.Request) *http.Request {
			r.Header.Set("Origin", "https://elsewhere.example")
			return r
		}},
		{name: "method (the real compute)", reason: "method", setup: func(s *Server, r *http.Request) *http.Request {
			s.computeFn = nil
			r.Method = http.MethodPost
			return r
		}},
		{name: "bulkhead", fn: served(nil), reason: "bulkhead", setup: func(s *Server, r *http.Request) *http.Request {
			s.MaxInFlight = 1
			s.inFlight.Store(1)
			return r
		}},
		{name: "deadline", reason: "deadline", fn: func(ctx context.Context, _ *http.Request) (*computed, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}},
		{name: "fallback from compute", reason: "unported-filter", fn: func(context.Context, *http.Request) (*computed, error) {
			return nil, fallback.New("unported-filter")
		}},
		{name: "compute error", reason: "error", fn: func(context.Context, *http.Request) (*computed, error) {
			return nil, errors.New("replica on fire")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := &proxyRecorder{}
			s := serveServer(prometheus.NewRegistry(), tc.fn, fb)
			s.EvalMode = true
			r := publicRequest()
			if tc.setup != nil {
				r = tc.setup(s, r)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			assertStub(t, w, fb, tc.reason)
		})
	}
}

// Positive control: off, the same hand-back is proxied and carries no stub header.
func TestEvalModeOffProxies(t *testing.T) {
	fb := &proxyRecorder{}
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, fallback.New("unported-filter")
	}, fb)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusTeapot || fb.calls != 1 || w.Header().Get(wantHandbackHeader) != "" {
		t.Fatalf("code=%d proxied=%d reason=%q, want the proxy's 418, 1 call and no reason", w.Code, fb.calls, w.Header().Get(wantHandbackHeader))
	}
}

// Eval mode needs no upstream: a pod with no FEED_GO_FALLBACK_URL still answers the stub (not the
// unavailable error a shadow-only deployment's public route would write).
func TestEvalModeStubsWithoutAnUpstream(t *testing.T) {
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, fallback.New("unported-filter")
	}, nil)
	s.EvalMode = true
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	assertStub(t, w, &proxyRecorder{}, "unported-filter")
}

// An eval pod is never sampled: the shadow and probe routes are not mounted (404), its health and
// metrics routes are.
func TestEvalModeUnmountsShadowAndProbe(t *testing.T) {
	paths := []string{
		"/internal/shadow/" + Procedure, "/internal/shadow" + V1ImagesPath, "/internal/shadow" + V1ModelsPath,
		"/internal/shadow" + V1ModelsPath + "/id", "/internal/shadow/" + ProcedureInfinite,
		"/internal/shadow/" + ProcedureModelGetAll, "/internal/shadow/" + ProcedureAssociated,
		"/internal/shadow" + SearchPath, ProbePathPrefix + Procedure,
	}
	for _, eval := range []bool{false, true} {
		s := muxServer()
		s.EvalMode = eval
		internal := InternalMux(s, okHandler(), false)
		for _, p := range paths {
			// A GET: every shadow and probe handler refuses it with 405, so mounted reads 405, not 404.
			code := statusOf(internal, p)
			if eval && code != http.StatusNotFound {
				t.Errorf("eval mode: %s = %d, want 404", p, code)
			}
			if !eval && code == http.StatusNotFound {
				t.Errorf("eval mode off: %s = 404, want it mounted", p)
			}
		}
		for _, p := range []string{"/healthz", "/metrics"} {
			if code := statusOf(internal, p); code != http.StatusOK {
				t.Errorf("eval=%v: %s = %d, want 200", eval, p, code)
			}
		}
	}
}

// handBack is the one place a request reaches an upstream: proxyVia (the only caller of a route
// upstream's ServeHTTP) is called from handBack alone, so a route cannot proxy past the eval stub.
func TestProxyViaIsCalledOnlyFromHandBack(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	callers := map[string]int{}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f) //nolint:gosec // G304: a file of this package's own directory, from filepath.Glob
		if err != nil {
			t.Fatal(err)
		}
		file, err := parser.ParseFile(fset, f, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "proxyVia" {
					callers[fn.Name.Name]++
				}
				return true
			})
		}
	}
	if scanned < 10 {
		t.Fatalf("scanned %d files: not the package directory", scanned)
	}
	if len(callers) != 1 || callers["handBack"] != 1 {
		t.Fatalf("proxyVia callers = %v, want exactly handBack once", callers)
	}
}

// FEED_GO_EVAL_NOW reaches the region rules every route reads (regionMatches): a request from a
// region whose block starts in 2030 is handed back as `region-blocked` only when the clock is frozen
// past that date, whatever the wall clock says.
func TestEvalClockReachesRegionRules(t *testing.T) {
	t.Cleanup(clock.Reset)
	effective := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		at     time.Time
		reason string
	}{
		{effective.Add(-time.Hour), "unported-filter"},
		{effective.Add(time.Hour), "region-blocked"},
	} {
		clock.Freeze(tc.at)
		fb := &proxyRecorder{}
		s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
			return nil, fallback.New("unported-filter")
		}, fb)
		s.EvalMode = true
		s.RegionBlockRules = []browsing.RegionRule{{Region: "FR", Effective: effective}}
		r := publicRequest()
		r.Header.Set("cf-ipcountry", "FR")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		assertStub(t, w, fb, tc.reason)
	}
}
