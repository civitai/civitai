package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/sitesearch"
)

// The site-search golden fixtures (testdata/golden/site-search, README "site-search"): each names a
// request, the viewer, the host and the search backend's answer, and expects Node's answer — the call
// it makes and the bytes it writes — or the fallback Go must take. src/server/__tests__/
// feed-go-site-search.golden.test.ts runs the real Node handler over the same fixtures and requires
// the same call and bytes, so the two are held to each other through the files.
const siteSearchGoldenDir = "../../testdata/golden/site-search"

// goldenSiteSearchMin bounds the fixtures found: a glob that matched nothing would pass every case.
const goldenSiteSearchMin = 14

type siteSearchFixture struct {
	Name    string `json:"name"`
	Request struct {
		Path string `json:"path"`
		Body string `json:"body"`
		Host string `json:"host"`
	} `json:"request"`
	Viewer   map[string]any `json:"viewer"`
	Upstream *struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	} `json:"upstream"`
	Expect struct {
		Fallback string `json:"fallback"`
		Call     *struct {
			Path string          `json:"path"`
			Body json.RawMessage `json:"body"`
		} `json:"call"`
		Body string `json:"body"`
	} `json:"expect"`
}

// recordingUpstream answers every call with the fixture's backend answer and records the call.
type recordingUpstream struct {
	res   *sitesearch.Response
	calls []sitesearch.UpstreamCall
}

func (u *recordingUpstream) Post(_ context.Context, path string, body []byte) (*sitesearch.Response, error) {
	u.calls = append(u.calls, sitesearch.UpstreamCall{Path: path, Body: append([]byte(nil), body...)})
	if u.res == nil {
		return nil, context.Canceled
	}
	return u.res, nil
}

// siteSearchGoldenHosts are the fixtures' hosts: green.example.test is the SFW site.
var siteSearchGoldenHosts = browsing.HostColors{
	"green": {"green.example.test"},
	"blue":  {"blue.example.test"},
	"red":   {"red.example.test"},
}

func loadSiteSearchFixtures(t *testing.T) []siteSearchFixture {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(siteSearchGoldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < goldenSiteSearchMin {
		t.Fatalf("found %d site-search fixtures, want at least %d", len(files), goldenSiteSearchMin)
	}
	out := make([]siteSearchFixture, 0, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var fx siteSearchFixture
		if err := json.Unmarshal(raw, &fx); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, fx)
	}
	return out
}

// goldenSessionUser is the fixture's viewer as the session cache holds it, read by auth.SessionUserFrom
// (so the browsing preferences are read as the resolver reads them).
func goldenSessionUser(t *testing.T, v map[string]any) *auth.SessionUser {
	t.Helper()
	if v == nil {
		return nil
	}
	m := map[string]any{}
	for k, val := range v {
		if f, ok := val.(float64); ok {
			val = int64(f)
		}
		m[k] = val
	}
	id, _ := m["id"].(int64)
	u, err := auth.SessionUserFrom(int(id), m)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func runSiteSearchFixture(t *testing.T, fx siteSearchFixture) (*computed, *recordingUpstream, error) {
	t.Helper()
	s := &Server{Resolver: &auth.Resolver{}, Hosts: siteSearchGoldenHosts}
	up := &recordingUpstream{}
	if fx.Upstream != nil {
		up.res = &sitesearch.Response{Status: fx.Upstream.Status, Body: []byte(fx.Upstream.Body)}
	}
	ctx := auth.WithResolved(context.Background(), goldenSessionUser(t, fx.Viewer), nil)
	ctx = context.WithValue(withSearchBody(ctx, []byte(fx.Request.Body)), searchRecordedKey{}, sitesearch.Upstream(up))
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, fx.Request.Path, strings.NewReader(fx.Request.Body))
	r.Host = fx.Request.Host
	r.Header.Set("Content-Type", "application/json")
	c, err := s.searchCompute(false)(ctx, r)
	return c, up, err
}

func TestSiteSearchGolden(t *testing.T) {
	served := 0
	for _, fx := range loadSiteSearchFixtures(t) {
		t.Run(fx.Name, func(t *testing.T) {
			c, up, err := runSiteSearchFixture(t, fx)
			if fx.Expect.Fallback != "" {
				if got := fallback.Reason(err); got != fx.Expect.Fallback {
					t.Fatalf("fallback %q (err %v), want %q", got, err, fx.Expect.Fallback)
				}
				return
			}
			if err != nil {
				t.Fatalf("compute: %v", err)
			}
			served++
			if len(up.calls) != 1 {
				t.Fatalf("%d backend calls, want 1", len(up.calls))
			}
			call := up.calls[0]
			if call.Path != fx.Expect.Call.Path {
				t.Errorf("call path %q, want %q", call.Path, fx.Expect.Call.Path)
			}
			var got, want any
			if err := json.Unmarshal(call.Body, &got); err != nil {
				t.Fatalf("call body: %v", err)
			}
			if err := json.Unmarshal(fx.Expect.Call.Body, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("call body\n got %s\nwant %s", call.Body, fx.Expect.Call.Body)
			}
			// The shadow's document: the call and the answer, the answer's bytes exactly Node's.
			var doc struct {
				Upstream struct {
					Path string          `json:"path"`
					Body json.RawMessage `json:"body"`
				} `json:"upstream"`
				Body json.RawMessage `json:"body"`
			}
			if err := json.Unmarshal(c.payload, &doc); err != nil {
				t.Fatalf("shadow document: %v", err)
			}
			if string(doc.Body) != fx.Expect.Body {
				t.Errorf("body\n got %s\nwant %s", doc.Body, fx.Expect.Body)
			}
			if doc.Upstream.Path != call.Path || string(doc.Upstream.Body) != string(call.Body) {
				t.Errorf("shadow document call %s %s, want the call made", doc.Upstream.Path, doc.Upstream.Body)
			}
		})
	}
	if served < 8 {
		t.Errorf("%d served fixtures, want at least 8", served)
	}
}

// The public route's compute answers the same bytes as the shadow's document carries (only the
// rate limit and the backend differ): one fixture through searchCompute(true).
func TestSiteSearchGoldenServedBody(t *testing.T) {
	for _, fx := range loadSiteSearchFixtures(t) {
		if fx.Name != "multi-signed-out" {
			continue
		}
		up := &recordingUpstream{res: &sitesearch.Response{Status: fx.Upstream.Status, Body: []byte(fx.Upstream.Body)}}
		s := &Server{Resolver: &auth.Resolver{}, Hosts: siteSearchGoldenHosts,
			Search: &SearchDeps{Upstream: up, Rate: newFakeRate()}}
		ctx := withSearchBody(context.Background(), []byte(fx.Request.Body))
		r := httptest.NewRequestWithContext(ctx, http.MethodPost, fx.Request.Path, strings.NewReader(fx.Request.Body))
		r.Host = fx.Request.Host
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cf-Connecting-Ip", "192.0.2.7")
		c, err := s.searchCompute(true)(ctx, r)
		if err != nil {
			t.Fatal(err)
		}
		if string(c.payload) != fx.Expect.Body {
			t.Fatalf("served body\n got %s\nwant %s", c.payload, fx.Expect.Body)
		}
		return
	}
	t.Fatal("fixture multi-signed-out not found")
}
