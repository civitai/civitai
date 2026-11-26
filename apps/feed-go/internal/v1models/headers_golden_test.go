package v1models

// Response-header goldens for GET /api/v1/models and /api/v1/models/[id]: each case under
// testdata/golden/v1-models-headers (gen-v1-models-headers.mjs) names a body fixture of
// testdata/golden/v1-models, adds request headers, and holds the headers Node's REAL route sets on
// its 200 (src/server/__tests__/feed-go-v1-models.golden.test.ts runs the wrappers and handlers over
// the case and requires them), its ETag Next's own over the fixture's body. Here Go computes the body
// over the same world and the headers from the same request, and must produce exactly those headers,
// plus configheaders.json's (the router's, not the route's).

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

const (
	headerGoldenDir = "../../testdata/golden/v1-models-headers"
	// The cases gen-v1-models-headers.mjs writes: fewer found means the glob matched the wrong place.
	headerGoldenMin = 10
)

type headerGolden struct {
	Name    string `json:"name"`
	Fixture string `json:"fixture"`
	Request struct {
		Headers map[string]string `json:"headers"`
	} `json:"request"`
	Expect struct {
		// Status is the status Node answers the case with (0: 200; the body fixture's).
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
	} `json:"expect"`
}

func TestGoldenV1ModelsHeaders(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(headerGoldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < headerGoldenMin {
		t.Fatalf("%d header cases, want at least %d (did the glob match nothing?)", len(files), headerGoldenMin)
	}
	sort.Strings(files)
	arms := map[string]bool{}
	for _, path := range files {
		raw, err := os.ReadFile(path) //nolint:gosec // G304: a case from the testdata glob
		if err != nil {
			t.Fatal(err)
		}
		hc := &headerGolden{}
		if err := json.Unmarshal(raw, hc); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		arms[hc.Expect.Headers["vary"]+" | "+hc.Expect.Headers["cache-control"]] = true
		t.Run(hc.Name, func(t *testing.T) { headerGoldenRun(t, hc) })
	}
	// Every arm of the wrappers is among the cases (a case set that lost one would still pass).
	for _, arm := range []string{
		"Authorization | public, s-maxage=300, stale-while-revalidate=150",
		"Authorization | private, no-store",
		"Authorization | max-age=0, private, no-cache",
		"Authorization, Cookie | private, no-store",
	} {
		if !arms[arm] {
			t.Errorf("no case covers %q", arm)
		}
	}
}

func headerGoldenRun(t *testing.T, hc *headerGolden) {
	fx := goldenLoad(t, filepath.Join(goldenDir, hc.Fixture))
	if fx.Expect.Fallback != "" || fx.Expect.Body == nil {
		t.Fatalf("%s is not a served body fixture", hc.Fixture)
	}
	env := goldenSetup(t, fx)
	ans, err := goldenServe(context.Background(), env, fx)
	if err != nil {
		t.Fatalf("compute: %v (fallback reason %q)", err, fallback.Reason(err))
	}
	if hc.Expect.Status != fx.Expect.Status {
		t.Fatalf("the case's status %d is not its body fixture's %d", hc.Expect.Status, fx.Expect.Status)
	}
	if err := fx.sameStatus(ans); err != nil {
		t.Fatal(err)
	}
	plain, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := NodeBody(plain)
	if !ok || string(body) != *fx.Expect.Body {
		t.Fatalf("not Node's body (ok %v):\n go:   %s\n node: %s", ok, body, *fx.Expect.Body)
	}
	h := http.Header{}
	for k, v := range fx.Request.Headers {
		h.Set(k, v)
	}
	for k, v := range hc.Request.Headers {
		h.Set(k, v)
	}
	detail := strings.HasPrefix(fx.Request.Path, "/api/v1/models/")
	in := HeaderInput{
		Detail:       detail,
		Credentialed: CarriesCallerCredentials(h, fx.Request.Query),
		// The server reads the header this way on a shadow sample (server.verifiedCrawler): the API
		// policy's own decision, `googlebot` or `bingbot`.
		VerifiedCrawler: h.Get("x-civitai-verified-bot") == "googlebot" || h.Get("x-civitai-verified-bot") == "bingbot",
	}
	if !detail {
		list, err := ParseList(fx.Request.Query)
		if err != nil {
			t.Fatal(err)
		}
		in.Nsfw = list.Nsfw
	}
	got := HeaderMap(ResponseHeaders(in, body))
	for _, c := range configHeaders {
		name := strings.ToLower(c.Name)
		if got[name] != c.Value {
			t.Errorf("config header %s = %q, want %q", c.Name, got[name], c.Value)
		}
		delete(got, name)
	}
	if !reflect.DeepEqual(got, hc.Expect.Headers) {
		t.Fatalf("headers differ from Node's:\n go:   %v\n node: %v", got, hc.Expect.Headers)
	}
}
