package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// API credentials on GET /api/v1/images (FEED_GO_V1_IMAGES_BEARER_AUTH for the shadow,
// FEED_GO_V1_IMAGES_SERVE_BEARER for the public route; DESIGN.md §13.8.1). bearerResolver holds
// `k-full-user` (full scope) and `k-media-read` (MediaRead only), both of user 42.

// recordingFeed is a feed service that answers an empty page and records each query it was asked.
type recordingFeed struct {
	mu      sync.Mutex
	queries []string
}

func (f *recordingFeed) Fetch(_ context.Context, q string) (feedsvc.Answer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, q)
	return feedsvc.Answer{Status: 200}, nil
}

func (f *recordingFeed) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) == 0 {
		return ""
	}
	return f.queries[len(f.queries)-1]
}

// keyedV1Deps is the images port over rec: no Postgres is reached (the feed answers no ids), and one
// browsing addon excludes tag 5 at PG, so the feed query shows whether the page was the viewer's own.
func keyedV1Deps(rec *recordingFeed) *feed.V1Deps {
	return &feed.V1Deps{
		Feed:          rec,
		ImageLocation: "https://img.example/abc",
		Addons: func(context.Context) []browsing.Addon {
			return []browsing.Addon{{Type: "some", NsfwLevels: []int{1}, ExcludedTagIDs: []int{5}}}
		},
	}
}

// sampleKey (v1models_bearer_test.go) is the Node sampler's description of a key: `key:` and
// generateSecretHash written out, the same for apiCredentialDescriptor.

// The feed queries a userId=42 page asks for: as its owner (no addon exclusions), as anyone else
// with user 42 as the viewer (a scoped key), and signed out. Literals (TestServeV1ViewerAndCreator's
// shape).
const (
	ownerFeedQuery  = "levels=1&userIds=42&excludeMinor=1&excludePoi=1&viewerId=42&sort=reactions&limit=100"
	scopedFeedQuery = "levels=1&excludedTags=5&userIds=42&excludeMinor=1&excludePoi=1&viewerId=42&sort=reactions&limit=100"
	anonFeedQuery   = "levels=1&excludedTags=5&userIds=42&excludeMinor=1&excludePoi=1&sort=reactions&limit=100"
)

// The shadow compute of a credentialed images sample: off (the default, and the pre-change code), every
// one is `bearer-token` with no principal-cache read; on, the sample's description is decided as the
// key would be, and the page is read with credentialViews. Each "on" row is red on the pre-change code,
// which fell back `bearer-token` on all of them.
func TestV1ImagesShadowDecidesAPIKeysBehindItsSwitch(t *testing.T) {
	sample := func(desc string) *http.Request {
		headers := map[string]string{"host": "site.example.test", "authorization": "present"}
		if desc != "" {
			headers[SampleCredentialHeader] = desc
		}
		r, err := SyntheticV1Request(context.Background(), ShadowRequest{Input: "userId=42", Path: V1ImagesPath, Headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		if r.Header.Get(SampleCredentialHeader) != "" {
			t.Fatal("the description stayed on the rebuilt request's headers")
		}
		return r
	}

	t.Run("off: bearer-token, no key read", func(t *testing.T) {
		resolver, reads := bearerResolver(t)
		rec := &recordingFeed{}
		s := &Server{Resolver: resolver, V1: keyedV1Deps(rec)}
		r := sample(sampleKey("k-full-user"))
		if _, err := s.v1ImagesCompute(false)(r.Context(), r); fallback.Reason(err) != "bearer-token" {
			t.Fatalf("reason %q, want bearer-token", fallback.Reason(err))
		}
		if reads.Load() != 0 || rec.last() != "" {
			t.Fatalf("principal reads %d, feed query %q; want 0 and none", reads.Load(), rec.last())
		}
	})

	for _, c := range []struct {
		name, desc, class, query, reason string
	}{
		{"full-scope key: its user's own page", sampleKey("k-full-user"), V1ViewerAPIKey, ownerFeedQuery, ""},
		{"scoped key: not the owner, still the feed's viewer", sampleKey("k-media-read"), V1ImagesViewerAPIKeyScoped, scopedFeedQuery, ""},
		{"a credential with no session: anyone's page", auth.SampleCredentialProvider, V1ImagesViewerAPIKeyAnon, anonFeedQuery, ""},
		{"cache miss: Node reads the primary", sampleKey("k-unknown"), "", "", "bearer-key-cache-miss"},
		{"no description (an older sampler)", "", "", "", "bearer-token"},
	} {
		t.Run("on: "+c.name, func(t *testing.T) {
			resolver, _ := bearerResolver(t)
			rec := &recordingFeed{}
			s := &Server{Resolver: resolver, V1: keyedV1Deps(rec), V1ImagesBearerAuth: true}
			r := sample(c.desc)
			got, err := s.v1ImagesCompute(false)(r.Context(), r)
			if reason := fallback.Reason(err); reason != c.reason {
				t.Fatalf("reason %q (%v), want %q", reason, err, c.reason)
			}
			if c.reason != "" {
				return
			}
			if got.viewerClass != c.class || rec.last() != c.query {
				t.Fatalf("class %q feed query %q, want %q %q", got.viewerClass, rec.last(), c.class, c.query)
			}
			// PublicEndpoint's credentialed arm: the answer is private to the caller.
			h := map[string]string{}
			for _, x := range got.headers {
				h[x.Name] = x.Value
			}
			if h["Vary"] != "Authorization, Cookie" || h["Cache-Control"] != "max-age=0, private, no-cache" {
				t.Fatalf("headers %v, want the credentialed Vary and the private default", h)
			}
		})
	}

	// The shadow switch does not open the public route.
	resolver, _ := bearerResolver(t)
	s := &Server{Resolver: resolver, V1: keyedV1Deps(&recordingFeed{}), V1ImagesBearerAuth: true}
	pub := v1Request("/api/v1/images?userId=42", map[string]string{"Authorization": "Bearer k-full-user"})
	if _, err := s.v1ImagesCompute(true)(pub.Context(), pub); fallback.Reason(err) != "bearer-token" {
		t.Fatalf("public route with the shadow switch only: reason %q, want bearer-token", fallback.Reason(err))
	}
}

// The public route with FEED_GO_V1_IMAGES_SERVE_BEARER reads the real Authorization header: a
// full-scope key is served its own page, a scoped key the page as anyone else (with its user as the
// feed's viewer); a session cookie is still handed back. Red on the pre-change code (bearer-token).
func TestServeV1ImagesBearerServesTheKeysViewer(t *testing.T) {
	for _, c := range []struct {
		name, authz, cookie, query, reason string
	}{
		{"full-scope key", "Bearer k-full-user", "", ownerFeedQuery, ""},
		{"scoped key", "Bearer k-media-read", "", scopedFeedQuery, ""},
		{"unknown key", "Bearer k-unknown", "", "", "bearer-key-cache-miss"},
		{"a key and a session cookie", "Bearer k-full-user", "__Secure-civ-token=t", "", "v1-images-session-cookie"},
		{"?token=", "", "", "", "bearer-query-token"},
	} {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, up, _ := serveV1ImagesServer(t, reg, true)
			s.computeV1Fn = nil // the real port
			resolver, _ := bearerResolver(t)
			rec := &recordingFeed{}
			s.Resolver, s.V1, s.ServeV1ImagesBearer = resolver, keyedV1Deps(rec), true
			target := "/api/v1/images?userId=42"
			if c.authz == "" {
				target += "&token=k-full-user"
			}
			headers := map[string]string{}
			if c.authz != "" {
				headers["Authorization"] = c.authz
			}
			if c.cookie != "" {
				headers["Cookie"] = c.cookie
			}
			w := httptest.NewRecorder()
			s.ServeV1ImagesHTTP(w, v1Request(target, headers))
			if c.reason != "" {
				if up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"mode": "serve", "reason": c.reason}) != 1 {
					t.Fatalf("proxied %d, want 1 with reason %s", up.count(), c.reason)
				}
				return
			}
			if w.Code != http.StatusOK || up.count() != 0 || w.Header().Get(ServedByHeader) != ServedByGo || rec.last() != c.query {
				t.Fatalf("code %d proxied %d served-by %q feed query %q, want 200 0 go %q", w.Code, up.count(), w.Header().Get(ServedByHeader), rec.last(), c.query)
			}
			if w.Header().Get("Cache-Control") != "max-age=0, private, no-cache" {
				t.Fatalf("Cache-Control %q, want the credentialed private default", w.Header().Get("Cache-Control"))
			}
		})
	}
	// Off (the default), the same full-scope key is handed back, as before.
	reg := prometheus.NewRegistry()
	s, up, _ := serveV1ImagesServer(t, reg, true)
	s.computeV1Fn = nil
	resolver, reads := bearerResolver(t)
	s.Resolver, s.V1 = resolver, keyedV1Deps(&recordingFeed{})
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?userId=42", map[string]string{"Authorization": "Bearer k-full-user"}))
	if up.count() != 1 || reads.Load() != 0 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"mode": "serve", "reason": "bearer-token"}) != 1 {
		t.Fatalf("switch off: proxied %d, principal reads %d; want 1 bearer-token and 0", up.count(), reads.Load())
	}
}

// A credentialed images sample compared end to end: counted under its viewer class
// (feed_go_shadow_compare_viewer_total{feed_endpoint="v1-images"}), every class seeded at 0.
func TestV1ImagesShadowCountsTheKeysViewerClass(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	resolver, _ := bearerResolver(t)
	s.Resolver, s.V1, s.V1ImagesBearerAuth = resolver, keyedV1Deps(&recordingFeed{}), true
	s.RequestBudget = time.Second
	viewer := func(v, r string) (float64, bool) {
		return metricValue(t, reg, "feed_go_shadow_compare_viewer_total", map[string]string{"feed_endpoint": EndpointV1Images, "viewer": v, "result": r})
	}
	for _, v := range []string{"anon", "crawler", "banned", "user", "moderator", "api-key", "api-key-scoped", "api-key-anon"} {
		if n, found := viewer(v, "match"); !found || n != 0 {
			t.Fatalf("%s match: %v found=%v, want a 0 series", v, n, found)
		}
	}
	b, err := json.Marshal(ShadowRequest{Input: "userId=42", Path: V1ImagesPath, Node: json.RawMessage(`{"items":[],"metadata":{}}`),
		Headers: map[string]string{"host": "site.example.test", "authorization": "present", SampleCredentialHeader: sampleKey("k-media-read")}})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowV1Handler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/images", bytes.NewReader(b)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
	waitFor(t, "the scoped key's compare", func() bool {
		n, _ := viewer("api-key-scoped", "match_empty")
		return n == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointV1Images, "mode": "shadow", "reason": "bearer-token"}); n != 0 {
		t.Fatalf("bearer-token shadow fallbacks %v, want 0", n)
	}
}

// Serve-parity on the images route (FEED_GO_SERVE_PARITY_V1_IMAGES): a served answer, an API key's
// included, is replayed once to the route's own Node app (V1ImagesUpstream) with the request's own
// credential; with no images upstream nothing is replayed. The pre-change sampler never replayed this
// route (no upstream for it) and skipped every credentialed answer (skipped_credential).
func TestServeParityV1ImagesReplaysAPIKeyAnswers(t *testing.T) {
	const nodeBody = `{"items":[],"metadata":{}}`
	run := func(t *testing.T, withUpstream bool, headers map[string]string) (*nodeStub, *prometheus.Registry) {
		t.Helper()
		reg := prometheus.NewRegistry()
		s, up, _ := serveV1ImagesServer(t, reg, true)
		s.computeV1Fn = nil
		resolver, _ := bearerResolver(t)
		s.Resolver, s.V1, s.ServeV1ImagesBearer = resolver, keyedV1Deps(&recordingFeed{}), true
		node := restAnswer(http.StatusOK, nodeBody, "max-age=0, private, no-cache", `"x"`)
		s.Parity = &ServeParity{Rate: 1, Upstream: nodeAnswering(servedPayload), V1Upstream: restAnswer(http.StatusOK, nodeBody, "", ""),
			Queue: make(chan struct{}, 4), Timeout: 2 * time.Second, Random: func() float64 { return 0 }}
		if withUpstream {
			s.Parity.V1ImagesUpstream = node
		}
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, v1Request("/api/v1/images?userId=42", headers))
		s.shadows.Wait()
		if w.Code != http.StatusOK || up.count() != 0 {
			t.Fatalf("code %d proxied %d, want a served 200", w.Code, up.count())
		}
		return node, reg
	}

	t.Run("an API key's answer is replayed with its key", func(t *testing.T) {
		node, reg := run(t, true, map[string]string{"Authorization": "Bearer k-media-read"})
		if node.callCount() != 1 || node.headers[0].Get("Authorization") != "Bearer k-media-read" || node.headers[0].Get(ParityReplayHeader) != "1" {
			t.Fatalf("replays %d, want 1 carrying the key and the replay marker", node.callCount())
		}
		if v := v1ParityOutcome(t, reg, EndpointV1Images, ParityCompared); v != 1 {
			t.Fatalf("serve_parity{v1-images,compared} = %v, want 1", v)
		}
		if v := v1ParityOutcome(t, reg, EndpointV1Images, ParitySkippedCredential); v != 0 {
			t.Fatalf("serve_parity{v1-images,skipped_credential} = %v, want 0", v)
		}
		if v := compareCount(t, reg, EndpointV1Images, "match_empty", SourceServeParity); v != 1 {
			t.Fatalf("compare{v1-images,match_empty,serve-parity} = %v, want 1", v)
		}
	})
	t.Run("a signed-out answer is replayed too", func(t *testing.T) {
		node, _ := run(t, true, nil)
		if node.callCount() != 1 || node.headers[0].Get("Authorization") != "" {
			t.Fatalf("replays %d, want 1 with no credential", node.callCount())
		}
	})
	t.Run("no images upstream: no replay", func(t *testing.T) {
		node, reg := run(t, false, map[string]string{"Authorization": "Bearer k-full-user"})
		if node.callCount() != 0 || v1ParityTotal(t, reg, EndpointV1Images) != 0 {
			t.Fatalf("replays %d outcomes %v, want 0 0", node.callCount(), v1ParityTotal(t, reg, EndpointV1Images))
		}
	})
}

// parityReplaysCredential's set is exactly the images route's two classes of a key's user (api-key,
// api-key-scoped): any other endpoint, a credential that stands for no session (api-key-anon), or an
// images answer for a cookie or no credential, is not a credentialed replay. Literal ledger.
func TestParityReplaysCredentialOnlyOnImagesKeyAnswers(t *testing.T) {
	for _, c := range []struct {
		endpoint, class string
		want            bool
	}{
		{EndpointV1Images, V1ViewerAPIKey, true},
		{EndpointV1Images, V1ImagesViewerAPIKeyScoped, true},
		{EndpointV1Images, V1ImagesViewerAPIKeyAnon, false}, // a service token is never re-sent
		{EndpointV1Images, FeedViewerUser, false},
		{EndpointV1Images, FeedViewerAnon, false},
		{EndpointV1Images, "", false},
		{EndpointV1ModelsID, V1ViewerAPIKey, false},
		{EndpointAsPosts, V1ViewerAPIKey, false},
	} {
		if got := parityReplaysCredential(c.endpoint, &computed{viewerClass: c.class}); got != c.want {
			t.Errorf("%s / %q: %v, want %v", c.endpoint, c.class, got, c.want)
		}
	}
	if parityReplaysCredential(EndpointV1Images, nil) {
		t.Error("a nil answer replays")
	}
	if !strings.HasPrefix(V1ImagesViewerAPIKeyScoped, V1ViewerAPIKey) {
		t.Error("the scoped class no longer reads as an api-key class")
	}
}
