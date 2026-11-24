package writes

import (
	"bytes"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
)

// The fake site is an httptest server that records every request it receives, exactly as received,
// and answers as the case sets. Block tokens are real RS256 JWTs checked by the real
// exchange.BlockVerifier against a JWKS served the way the site serves it. Every case's slug,
// collection, key, body and token are distinct from every other case's.

const testKey = "writes-test-signing-key-7f3a-0123456789" //nolint:gosec // G101: a synthetic test fixture, not a credential

type seen struct {
	method, path, rawPath, query string
	header                       http.Header
	body                         []byte
}

type fakeSite struct {
	srv *httptest.Server
	mu  sync.Mutex
	got []seen
	// answer answers each request; nil is 200 {"ok":true}.
	answer func(w http.ResponseWriter, r *http.Request)
}

func newSite(t *testing.T) *fakeSite {
	t.Helper()
	s := &fakeSite{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.got = append(s.got, seen{method: r.Method, path: r.URL.Path, rawPath: r.URL.EscapedPath(), query: r.URL.RawQuery,
			header: r.Header.Clone(), body: body})
		answer := s.answer
		s.mu.Unlock()
		if answer == nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		answer(w, r)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *fakeSite) requests() []seen {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seen(nil), s.got...)
}

func (s *fakeSite) set(answer func(w http.ResponseWriter, r *http.Request)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answer = answer
}

func answerWith(status int, body string, headers map[string]string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// --- block tokens ---

var (
	keysOnce           sync.Once
	siteKey, forgerKey *rsa.PrivateKey
)

func testKeys() {
	keysOnce.Do(func() {
		gen := func() *rsa.PrivateKey {
			k, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				panic(err)
			}
			return k
		}
		siteKey, forgerKey = gen(), gen()
	})
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func kidOf(k *rsa.PublicKey) string { return exchange.BlockKeyID(b64(k.N.Bytes())) }

// blockToken is a block token for user 77, signed by signer under the site key's kid, with over
// applied to its claims.
func blockToken(t *testing.T, signer *rsa.PrivateKey, over map[string]any) string {
	t.Helper()
	testKeys()
	now := time.Now().Unix()
	c := map[string]any{
		"iss": "civitai", "aud": "civitai-app-block", "sub": "user:77",
		"iat": now, "exp": now + 900, "jti": "blk-w1",
		"appId": "appblk-bench", "appBlockId": "apb_01bench", "blockInstanceId": "inst-w1",
		"scopes": []string{"apps:storage"},
	}
	for k, v := range over {
		c[k] = v
	}
	h, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": kidOf(&siteKey.PublicKey)})
	cl, _ := json.Marshal(c)
	input := b64(h) + "." + b64(cl)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, signer, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + b64(sig)
}

type jwks struct {
	srv  *httptest.Server
	down atomic.Bool
}

func newJWKS(t *testing.T) *jwks {
	t.Helper()
	testKeys()
	j := &jwks{}
	pub := &siteKey.PublicKey
	j.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if j.down.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kidOf(pub), "n": b64(pub.N.Bytes()),
			"e": b64(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	}))
	t.Cleanup(j.srv.Close)
	return j
}

// --- the rig ---

type rig struct {
	site *fakeSite
	jwks *jwks
	f    *Forwarder
	m    *metrics.Metrics
	h    http.Handler
}

func newRig(t *testing.T, tweak ...func(*Forwarder)) *rig {
	t.Helper()
	r := &rig{site: newSite(t), jwks: newJWKS(t)}
	r.m = metrics.New(prometheus.NewRegistry(), func() (int, int, int, int) { return 0, 0, 0, 0 })
	site, err := url.Parse(r.site.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	tr := &http.Transport{}
	t.Cleanup(tr.CloseIdleConnections)
	verifier := &exchange.BlockVerifier{JWKSURL: r.jwks.srv.URL}
	r.f = &Forwarder{
		Site: site, Key: []byte(testKey), HTTP: &http.Client{Transport: tr}, Timeout: 2 * time.Second,
		Verify: verifier.Check, Metrics: r.m, Log: slog.New(slog.DiscardHandler),
	}
	for _, tw := range tweak {
		tw(r.f)
	}
	mux := http.NewServeMux()
	r.f.Register(mux)
	r.h = mux
	return r
}

type call struct {
	method, path, auth string
	body               []byte
	header             map[string]string
}

func (r *rig) do(t *testing.T, c call) *httptest.ResponseRecorder {
	t.Helper()
	var body io.Reader = http.NoBody
	if c.body != nil {
		body = bytes.NewReader(c.body)
	}
	req := httptest.NewRequestWithContext(t.Context(), c.method, c.path, body)
	if c.auth != "" {
		req.Header.Set("Authorization", c.auth)
	}
	for k, v := range c.header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec
}

func (r *rig) writes(op, outcome string) float64 {
	return testutil.ToFloat64(r.m.Writes.WithLabelValues(op, outcome))
}

type envelope struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Error   string         `json:"error"`
	Outcome string         `json:"outcome"`
	Details map[string]any `json:"details"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) envelope {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("not a JSON envelope: %q", rec.Body.String())
	}
	return e
}

// clientHeaders are what a client (or anything in front of this service) may send that must never
// reach the site.
var clientHeaders = map[string]string{
	"X-Forwarded-For": "203.0.113.9", "Forwarded": "for=203.0.113.9", "X-Real-Ip": "203.0.113.9",
	"Cookie": "session=client-cookie-1", "X-Client-Region": "eu-west",
}

// allowedOutbound is every header name a forward may carry: those set here, the three region headers
// (only when the client sent them), and Go's own transport headers.
var allowedOutbound = map[string]bool{
	"Authorization": true, "Accept": true, "User-Agent": true, "Content-Type": true,
	"Cf-Ipcountry": true, "Cf-Region-Code": true, "X-Isuk": true,
	"X-App-Data-Ts": true, "X-App-Data-Sig": true, "Content-Length": true, "Accept-Encoding": true,
}

// 1. Every route's forward: the method, path, query, body bytes and Authorization the site sees,
// and the site's status, body and Content-Type / Retry-After passed back.
// Fails on origin/main: none of these routes exists there, so every call is the mux's 404 and the
// site receives nothing (`len(got) != 1`).
func TestEachRouteIsForwardedExactly(t *testing.T) {
	cases := []struct {
		name, op   string
		in         call
		wantMethod string
		wantPath   string
		wantQuery  string
		siteStatus int
		siteBody   string
	}{
		{"create", "create",
			call{method: "POST", path: "/v1/apps/model-benchmarking/collections/records/records", auth: "Bearer civitai_tok-create-41",
				body: []byte(`{"data":{"score":91}}`)},
			"POST", "/api/internal/blocks/storage/records", "from=model-benchmarking", 201, `{"key":"01JXCREATE","seq":7}`},
		{"put", "put",
			call{method: "PUT", path: "/v1/apps/todo-app/collections/kv/records/run-01", auth: "bearer civitai_tok-put-52",
				body: []byte(` {"data":{"n":2},"ifVersion":0}`)},
			"PUT", "/api/internal/blocks/storage/kv/run-01", "from=todo-app", 200, `{"key":"run-01","version":1,"seq":8}`},
		{"delete", "delete",
			call{method: "DELETE", path: "/v1/apps/pixel-board/collections/tiles/records/tile_44", auth: "Bearer civitai_tok-del-63"},
			"DELETE", "/api/internal/blocks/storage/tiles/tile_44", "from=pixel-board", 200, `{"deleted":true,"seq":12}`},
		{"delete with ifVersion", "delete",
			call{method: "DELETE", path: "/v1/apps/vote-wall/collections/board/records/post.9?ifVersion=3", auth: "Bearer civitai_tok-delv-74"},
			"DELETE", "/api/internal/blocks/storage/board/post.9", "from=vote-wall&ifVersion=3", 409, `{"code":"version_conflict","details":{"currentVersion":4}}`},
		// The client names major before ifVersion; the forward's order is from, ifVersion, major.
		{"delete with a major and ifVersion", "delete",
			call{method: "DELETE", path: "/v1/apps/order-check/collections/slots/records/slot-8?major=2&ifVersion=6", auth: "Bearer civitai_tok-order-31"},
			"DELETE", "/api/internal/blocks/storage/slots/slot-8", "from=order-check&ifVersion=6&major=2", 200, `{"deleted":true,"seq":21}`},
		{"create with a major", "create",
			call{method: "POST", path: "/v1/apps/major-pass/collections/runs/records?major=3", auth: "Bearer civitai_tok-majc-42",
				body: []byte(`{"data":{"run":3}}`)},
			"POST", "/api/internal/blocks/storage/runs", "from=major-pass&major=3", 201, `{"key":"01JXMAJOR","seq":30}`},
		{"delete with a padded ifVersion", "delete",
			call{method: "DELETE", path: "/v1/apps/stamp-book/collections/pages/records/p:2?ifVersion=007", auth: "Bearer civitai_tok-delz-85"},
			"DELETE", "/api/internal/blocks/storage/pages/p:2", "from=stamp-book&ifVersion=7", 200, `{"deleted":false}`},
		{"mark", "mark",
			call{method: "PATCH", path: "/v1/apps/meme-poll/collections/entries/records/e-5", auth: "Bearer civitai_tok-mark-96",
				body: []byte(`{"$mark":"vote"}`)},
			"PATCH", "/api/internal/blocks/storage/entries/e-5", "from=meme-poll", 200, `{"marked":true,"count":4,"markSeq":3}`},
		{"unmark", "unmark",
			call{method: "PATCH", path: "/v1/apps/star-chart/collections/stars/records/s-6", auth: "Bearer civitai_tok-unmark-17",
				body: []byte(`{"$unmark":"fave"}`)},
			"PATCH", "/api/internal/blocks/storage/stars/s-6", "from=star-chart", 200, `{"marked":false,"count":0,"markSeq":9}`},
		{"increment", "increment",
			call{method: "PATCH", path: "/v1/apps/click-count/collections/counters/records/c-7", auth: "Bearer civitai_tok-inc-28",
				body: []byte(`{"$inc":{"clicks":2}}`)},
			// The site's 429 carries the house rateLimit meta; it is passed on byte for byte. An INVARIANT
			// guard: the pass-through predates the meta, so this pins it rather than covering a regression.
			"PATCH", "/api/internal/blocks/storage/counters/c-7", "from=click-count", 429,
			`{"code":"rate_limited","rateLimit":{"retryAfterSeconds":7,"retryAt":"2026-01-01T00:00:07.000Z","id":"apps.doc-store","kind":"abuse"}}`},
		{"info", "info",
			call{method: "GET", path: "/v1/apps/quota-view/info", auth: "Bearer civitai_tok-info-39"},
			"GET", "/api/internal/blocks/storage", "from=quota-view", 200, `{"usage":{"bytes":10}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			retryAfter := ""
			if tc.siteStatus == 429 {
				retryAfter = "7"
			}
			r.site.set(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("X-Site-Internal", "never-passed-on")
				if retryAfter != "" {
					w.Header().Set("Retry-After", retryAfter)
				}
				w.WriteHeader(tc.siteStatus)
				_, _ = io.WriteString(w, tc.siteBody)
			})
			tc.in.header = clientHeaders
			rec := r.do(t, tc.in)

			got := r.site.requests()
			if len(got) != 1 {
				t.Fatalf("the site received %d requests, want 1 (answer %d %s)", len(got), rec.Code, rec.Body.String())
			}
			s := got[0]
			if s.method != tc.wantMethod || s.path != tc.wantPath || s.query != tc.wantQuery {
				t.Fatalf("site saw %s %s ?%s; want %s %s ?%s", s.method, s.path, s.query, tc.wantMethod, tc.wantPath, tc.wantQuery)
			}
			if !bytes.Equal(s.body, tc.in.body) {
				t.Fatalf("site saw body %q, want %q", s.body, tc.in.body)
			}
			if s.header.Get("Authorization") != tc.in.auth {
				t.Fatalf("site saw Authorization %q, want %q", s.header.Get("Authorization"), tc.in.auth)
			}
			wantCT := ""
			if tc.in.body != nil {
				wantCT = "application/json"
			}
			if s.header.Get("Content-Type") != wantCT {
				t.Fatalf("site saw Content-Type %q, want %q", s.header.Get("Content-Type"), wantCT)
			}
			for name := range s.header {
				if !allowedOutbound[name] {
					t.Errorf("🔴 the forward carried %s: %q", name, s.header.Get(name))
				}
			}
			for name := range clientHeaders {
				if s.header.Get(name) != "" {
					t.Errorf("🔴 the client's %s reached the site", name)
				}
			}

			if rec.Code != tc.siteStatus || rec.Body.String() != tc.siteBody {
				t.Fatalf("answered %d %q; want the site's %d %q", rec.Code, rec.Body.String(), tc.siteStatus, tc.siteBody)
			}
			if rec.Header().Get("Content-Type") != "application/json; charset=utf-8" || rec.Header().Get("Retry-After") != retryAfter {
				t.Fatalf("answer headers %v", rec.Header())
			}
			if rec.Header().Get("X-Site-Internal") != "" {
				t.Fatal("a site header other than Content-Type and Retry-After was passed on")
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" || rec.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("answer headers %v", rec.Header())
			}
			class := strconv.Itoa(tc.siteStatus/100) + "xx"
			if n := r.writes(tc.op, class); n != 1 {
				t.Fatalf("app_data_writes_total{op=%q,outcome=%q} = %v, want 1", tc.op, class, n)
			}
			if n := testutil.CollectAndCount(r.m.WriteForward); n != len(metrics.WriteOps) {
				t.Fatalf("forward histogram series %d, want one per op (%d)", n, len(metrics.WriteOps))
			}
		})
	}
}

// recompute is the canonical rule written out again, independently of package sign: the region line
// is read from the headers the site received.
func recompute(key, method, path, query, ts string, body []byte, h http.Header) string {
	bh := sha256.Sum256(body)
	region := h.Get("Cf-Ipcountry") + "," + h.Get("Cf-Region-Code") + "," + h.Get("X-Isuk")
	if region == ",," {
		region = ""
	}
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(method + "\n" + path + "\n" + query + "\n" + ts + "\n" + hex.EncodeToString(bh[:]) + "\n" + region))
	return hex.EncodeToString(mac.Sum(nil))
}

// 2. The signature the site receives verifies under the canonical rule, recomputed from what the
// site received, for a body and for none, with region headers and without, under a site URL with a
// path prefix (signed as sent).
// Fails on origin/main: no forward, so no signature (`len(got) != 2`).
func TestTheForwardIsSignedOverWhatTheSiteReceives(t *testing.T) {
	const clock = 1_795_000_123
	r := newRig(t, func(f *Forwarder) { f.Now = func() time.Time { return time.Unix(clock, 0) } })
	prefixed, _ := url.Parse(r.site.srv.URL + "/site-root/")
	r.f.Site = prefixed
	r.do(t, call{method: "PUT", path: "/v1/apps/sign-check/collections/ledger/records/entry-3?major=4", auth: "Bearer civitai_tok-sig-50",
		body: []byte(`{"data":{"amount":12}}`), header: map[string]string{"cf-ipcountry": "US", "cf-region-code": "CA"}})
	r.do(t, call{method: "DELETE", path: "/v1/apps/sign-check/collections/ledger/records/entry-4?ifVersion=2", auth: "Bearer civitai_tok-sig-61"})
	got := r.site.requests()
	if len(got) != 2 {
		t.Fatalf("the site received %d requests, want 2", len(got))
	}
	wantPaths := []string{"/site-root/api/internal/blocks/storage/ledger/entry-3", "/site-root/api/internal/blocks/storage/ledger/entry-4"}
	for i, s := range got {
		if s.rawPath != wantPaths[i] {
			t.Fatalf("site saw path %q, want %q", s.rawPath, wantPaths[i])
		}
		ts := s.header.Get("X-App-Data-Ts")
		if ts != strconv.Itoa(clock) {
			t.Fatalf("timestamp %q, want %d", ts, clock)
		}
		want := recompute(testKey, s.method, s.rawPath, s.query, ts, s.body, s.header)
		if sig := s.header.Get("X-App-Data-Sig"); sig != want {
			t.Fatalf("%s: signature %q, want %q", s.method, sig, want)
		}
		// A signature under another key, or over another body, would differ: the check can fail.
		if recompute("another-key", s.method, s.rawPath, s.query, ts, s.body, s.header) == want ||
			recompute(testKey, s.method, s.rawPath, s.query, ts, append(append([]byte(nil), s.body...), ' '), s.header) == want ||
			recompute(testKey, s.method, s.rawPath, s.query, ts, s.body, http.Header{"X-Isuk": {"1"}}) == want {
			t.Fatal("the recomputation cannot tell keys, bodies or regions apart")
		}
	}
	if got[0].query != "from=sign-check&major=4" || got[1].query != "from=sign-check&ifVersion=2" {
		t.Fatalf("queries %q, %q", got[0].query, got[1].query)
	}
	if got[0].header.Get("Cf-Ipcountry") != "US" || got[0].header.Get("Cf-Region-Code") != "CA" || got[0].header.Get("X-Isuk") != "" ||
		got[1].header.Get("Cf-Ipcountry") != "" {
		t.Fatalf("region headers %v / %v", got[0].header, got[1].header)
	}
}

// 3. A block token is verified here first: a valid one is forwarded unchanged; a forged, expired or
// anonymous one is 401 and the site receives nothing. An opaque token and no token are 401 too.
// Fails on origin/main: the routes are 404 there (`rec.Code != 401`).
func TestBlockTokensAreVerifiedBeforeAnythingIsSent(t *testing.T) {
	r := newRig(t)
	valid := blockToken(t, siteKey, nil)
	rec := r.do(t, call{method: "POST", path: "/v1/apps/block-ok/collections/notes/records", auth: "Bearer " + valid,
		body: []byte(`{"data":{"t":"block"}}`)})
	if rec.Code != 200 || len(r.site.requests()) != 1 || r.site.requests()[0].header.Get("Authorization") != "Bearer "+valid {
		t.Fatalf("a valid block token: %d %s, %d requests", rec.Code, rec.Body.String(), len(r.site.requests()))
	}
	now := time.Now().Unix()
	for name, tc := range map[string]struct {
		auth, code, reason string
	}{
		"forged":     {"Bearer " + blockToken(t, forgerKey, map[string]any{"jti": "blk-forged"}), "unauthenticated", "signature or claims"},
		"expired":    {"Bearer " + blockToken(t, siteKey, map[string]any{"jti": "blk-old", "iat": now - 4000, "exp": now - 3000}), "unauthenticated", "signature or claims"},
		"anonymous":  {"Bearer " + blockToken(t, siteKey, map[string]any{"jti": "blk-anon", "sub": "anon"}), "sign_in_required", ""},
		"opaque":     {"Bearer opaque-token-not-an-app-token", "unauthenticated", ""},
		"no token":   {"", "unauthenticated", ""},
		"not bearer": {"Basic dXNlcjpwYXNz", "unauthenticated", ""},
	} {
		t.Run(name, func(t *testing.T) {
			before := len(r.site.requests())
			rec := r.do(t, call{method: "PUT", path: "/v1/apps/block-refused/collections/notes/records/n-" + strings.ReplaceAll(name, " ", "-"),
				auth: tc.auth, body: []byte(`{"data":{"t":"` + name + `"}}`)})
			e := decode(t, rec)
			if rec.Code != 401 || e.Code != tc.code || rec.Header().Get("WWW-Authenticate") == "" {
				t.Fatalf("%d %+v; want 401 %s", rec.Code, e, tc.code)
			}
			if tc.reason != "" && (e.Details["refusal"] != "local" || e.Details["reason"] != tc.reason) {
				t.Fatalf("details %v; want refusal local, reason %q", e.Details, tc.reason)
			}
			if n := len(r.site.requests()) - before; n != 0 {
				t.Fatalf("🔴 the site received %d requests for a refused token", n)
			}
		})
	}
	if n := r.writes("put", "refused_here"); n != 6 {
		t.Fatalf("refused_here %v, want 6", n)
	}
}

// 4. An answer that is lost is 504 outcome unknown, and the site saw exactly one request: never a
// retry. A site 501 (the import refusal, raised before any write) is passed on as it is.
// Fails on origin/main: the route is 404 there (`rec.Code != 504`).
func TestALostAnswerIsUnknownAndNeverRetried(t *testing.T) {
	cases := []struct {
		name   string
		answer func(http.ResponseWriter, *http.Request)
	}{
		{"500", answerWith(500, `{"code":"internal_error"}`, nil)},
		{"503", answerWith(503, `{"code":"service_unavailable"}`, map[string]string{"Retry-After": "5"})},
		{"502", answerWith(502, `bad gateway`, nil)},
		{"hang past the timeout", func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }},
		{"connection closed", func(w http.ResponseWriter, _ *http.Request) {
			c, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = c.Close()
			}
		}},
		{"a redirect", answerWith(307, ``, map[string]string{"Location": "/elsewhere"})},
		{"an answer cut short", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", "100")
			w.WriteHeader(201)
			_, _ = io.WriteString(w, `{"key":`)
		}},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, func(f *Forwarder) { f.Timeout = 300 * time.Millisecond })
			r.site.set(tc.answer)
			start := time.Now()
			rec := r.do(t, call{method: "POST", path: "/v1/apps/lost-answer/collections/runs/records", auth: "Bearer civitai_tok-lost-" + strconv.Itoa(i),
				body: []byte(`{"data":{"case":` + strconv.Itoa(i) + `}}`)})
			e := decode(t, rec)
			if rec.Code != 504 || e.Code != "outcome_unknown" || e.Outcome != "unknown" || e.Message == "" {
				t.Fatalf("%d %s; want 504 outcome_unknown", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Retry-After") != "" {
				t.Fatal("an unknown outcome must not invite a resend")
			}
			if n := len(r.site.requests()); n != 1 {
				t.Fatalf("🔴 the site received %d requests, want exactly 1 (no retry, no redirect followed)", n)
			}
			if d := time.Since(start); d > 2*time.Second {
				t.Fatalf("took %v", d)
			}
			if n := r.writes("create", "unknown"); n != 1 {
				t.Fatalf("unknown %v, want 1", n)
			}
		})
	}
	t.Run("501 is passed on", func(t *testing.T) {
		r := newRig(t)
		r.site.set(answerWith(501, `{"code":"not_supported_here"}`, map[string]string{"Content-Type": "application/json"}))
		rec := r.do(t, call{method: "POST", path: "/v1/apps/import-try/collections/shared/records", auth: "Bearer civitai_tok-import-1",
			body: []byte(`{"data":{"x":1}}`)})
		if rec.Code != 501 || rec.Body.String() != `{"code":"not_supported_here"}` || len(r.site.requests()) != 1 {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		if r.writes("create", "501") != 1 {
			t.Fatal("not counted as 501")
		}
	})
}

// An answer too large to pass on whole is unknown, never truncated.
func TestAnAnswerPastTheBoundIsUnknown(t *testing.T) {
	r := newRig(t)
	r.site.set(answerWith(200, strings.Repeat("x", maxAnswerBytes+1), nil))
	rec := r.do(t, call{method: "GET", path: "/v1/apps/huge-answer/info", auth: "Bearer civitai_tok-huge-1"})
	if rec.Code != 504 || decode(t, rec).Outcome != "unknown" || len(r.site.requests()) != 1 {
		t.Fatalf("%d", rec.Code)
	}
}

// 5. `503 not_forwarded` is only this service's own refusal, before anything is sent: the key set
// unavailable, shutting down, no verifier, the request not buildable. The site receives nothing.
// Fails on origin/main: the routes are 404 there (`rec.Code != 503`).
func TestNotForwardedIsRefusedHereBeforeAnythingIsSent(t *testing.T) {
	cases := map[string]struct {
		tweak func(*rig)
		auth  string
	}{
		"the key set unavailable": {func(r *rig) { r.jwks.down.Store(true) }, ""},
		"shutting down":           {func(r *rig) { r.f.Ready = func() bool { return false } }, "Bearer civitai_tok-drain-1"},
		"no verifier":             {func(r *rig) { r.f.Verify = nil }, ""},
		"the request cannot be built": {func(r *rig) {
			r.f.Site = &url.URL{Scheme: "http", Host: "bad host%zz"}
		}, "Bearer civitai_tok-build-1"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			tc.tweak(r)
			auth := tc.auth
			if auth == "" {
				auth = "Bearer " + blockToken(t, siteKey, map[string]any{"jti": "blk-nf-" + strings.ReplaceAll(name, " ", "-")})
			}
			rec := r.do(t, call{method: "PATCH", path: "/v1/apps/not-sent/collections/votes/records/v-1", auth: auth,
				body: []byte(`{"$mark":"vote"}`)})
			e := decode(t, rec)
			if rec.Code != 503 || e.Code != "not_forwarded" || rec.Header().Get("Retry-After") == "" {
				t.Fatalf("%d %+v; want 503 not_forwarded with Retry-After", rec.Code, e)
			}
			if n := len(r.site.requests()); n != 0 {
				t.Fatalf("🔴 the site received %d requests", n)
			}
			if r.writes("mark", "unavailable") != 1 {
				t.Fatal("not counted as unavailable")
			}
		})
	}
}

// 6. A named major is forwarded and judged by the site: its `409 stale_major` is relayed byte for byte,
// status, body and Content-Type, and counted as the store's 4xx.
// Fails on origin/main: the route is 404 there (`rec.Code != 409`).
func TestTheSitesStaleMajorIsRelayedUnchanged(t *testing.T) {
	r := newRig(t)
	const stale = `{"code":"stale_major","message":"stale major","error":"stale major","details":{"currentMajor":2}}`
	r.site.set(answerWith(409, stale, map[string]string{"Content-Type": "application/json; charset=utf-8"}))
	rec := r.do(t, call{method: "PUT", path: "/v1/apps/major-check/collections/scores/records/s-old?major=1", auth: "Bearer civitai_tok-major-1",
		body: []byte(`{"data":{"v":1}}`)})
	got := r.site.requests()
	if len(got) != 1 || got[0].query != "from=major-check&major=1" {
		t.Fatalf("%d requests %+v; want the major sent", len(got), got)
	}
	if rec.Code != 409 || rec.Body.String() != stale || rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("%d %q; want the site's 409 unchanged", rec.Code, rec.Body.String())
	}
	if r.writes("put", "4xx") != 1 {
		t.Fatal("not counted as the store's 4xx")
	}
}

// The site's refusals of the forward itself (its signature check, its internal route off) are 503
// not_forwarded, outcome signature, never the user's own 401 or 404; every other 401 and 404 is relayed.
// Fails on origin/main: the route is 404 there; on the previous commit the two refusals were relayed
// as 401 and 404 (`rec.Code != 503`).
func TestTheSitesRefusalOfTheForwardIsNotForwarded(t *testing.T) {
	cases := []struct {
		name, body string
		status     int
		want       int
		outcome    string
	}{
		{"a bad signature", `{"code":"service_signature","message":"bad signature"}`, 401, 503, "signature"},
		{"the internal route off", `{"code":"service_route_off","message":"off"}`, 404, 503, "signature"},
		{"the user's own 401", `{"code":"unauthenticated","message":"sign in"}`, 401, 401, "4xx"},
		{"the user's own 404", `{"code":"not_found","message":"no such record"}`, 404, 404, "4xx"},
		{"a 404 naming the signature code", `{"code":"service_signature"}`, 404, 404, "4xx"},
		{"a 401 naming the route-off code", `{"code":"service_route_off"}`, 401, 401, "4xx"},
		{"a 401 that is not JSON", `unauthorized`, 401, 401, "4xx"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			r.site.set(answerWith(tc.status, tc.body, map[string]string{"Content-Type": "application/json"}))
			rec := r.do(t, call{method: "DELETE", path: "/v1/apps/sig-refused/collections/items/records/i-" + strconv.Itoa(i),
				auth: "Bearer civitai_tok-sigref-" + strconv.Itoa(i)})
			if rec.Code != tc.want {
				t.Fatalf("%d %s; want %d", rec.Code, rec.Body.String(), tc.want)
			}
			if tc.want == 503 {
				if e := decode(t, rec); e.Code != "not_forwarded" || rec.Header().Get("Retry-After") == "" {
					t.Fatalf("%+v; want not_forwarded with Retry-After", e)
				}
			} else if rec.Body.String() != tc.body {
				t.Fatalf("body %q, want the site's %q", rec.Body.String(), tc.body)
			}
			if r.writes("delete", tc.outcome) != 1 || len(r.site.requests()) != 1 {
				t.Fatalf("outcome %s not counted once, or %d requests", tc.outcome, len(r.site.requests()))
			}
		})
	}
}

// The region headers the client sent are copied onto the forward, only those present, and a
// malformed or repeated one is refused 400 invalid_region with nothing sent.
// Fails on origin/main: the route is 404 there; on the previous commit no region header was copied
// (`Cf-Ipcountry != "GB"`).
func TestTheRegionHeadersAreForwardedAndChecked(t *testing.T) {
	r := newRig(t)
	rec := r.do(t, call{method: "PATCH", path: "/v1/apps/region-app/collections/polls/records/q-1", auth: "Bearer civitai_tok-region-1",
		body: []byte(`{"$unmark":"vote"}`), header: map[string]string{"CF-IPCountry": "GB", "X-IsUK": "1"}})
	got := r.site.requests()
	if rec.Code != 200 || len(got) != 1 {
		t.Fatalf("%d, %d requests", rec.Code, len(got))
	}
	h := got[0].header
	if h.Get("Cf-Ipcountry") != "GB" || h.Get("X-Isuk") != "1" || len(h.Values("Cf-Region-Code")) != 0 {
		t.Fatalf("region headers %v", h)
	}
	if sig := h.Get("X-App-Data-Sig"); sig != recompute(testKey, got[0].method, got[0].rawPath, got[0].query, h.Get("X-App-Data-Ts"), got[0].body, h) {
		t.Fatal("the region line was not signed as GB,,1")
	}
	for name, hdr := range map[string][][2]string{
		"a space":          {{"Cf-Ipcountry", "U S"}},
		"too long":         {{"Cf-Region-Code", "ABCDEFGHIJKLMNOPQ"}},
		"empty":            {{"X-Isuk", ""}},
		"a comma":          {{"Cf-Ipcountry", "US,CA"}},
		"repeated":         {{"Cf-Ipcountry", "US"}, {"Cf-Ipcountry", "GB"}},
		"repeated, cased":  {{"x-isuk", "1"}, {"X-IsUK", "0"}},
		"a bad second one": {{"Cf-Ipcountry", "US"}, {"Cf-Region-Code", "C/A"}},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), "PUT", "/v1/apps/region-app/collections/polls/records/q-2", strings.NewReader(`{"data":{}}`))
			req.Header.Set("Authorization", "Bearer civitai_tok-region-2")
			for _, kv := range hdr {
				req.Header.Add(kv[0], kv[1])
			}
			rec := httptest.NewRecorder()
			r.h.ServeHTTP(rec, req)
			if e := decode(t, rec); rec.Code != 400 || e.Code != "invalid_region" {
				t.Fatalf("%d %+v; want 400 invalid_region", rec.Code, e)
			}
		})
	}
	if n := len(r.site.requests()); n != 1 {
		t.Fatalf("🔴 the site received %d requests, want only the valid one", n)
	}
}

// A write on a REUSED keep-alive connection that the site reads in full and then drops without an
// answer is 504 unknown, and the site saw exactly one copy of it: nothing re-sends it.
// Fails on origin/main: the route is 404 there (`rec.Code != 504`). Over HTTP/1 a POST was never
// replayed by Go's transport, so against the previous commit this is an invariant guard; the
// `GetBody = nil` it pins matters for transports that replay from GetBody (HTTP/2).
func TestAWriteOnAReusedConnectionIsNeverReplayed(t *testing.T) {
	var n atomic.Int32
	var mu sync.Mutex
	var remotes []string
	var bodies []string
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		remotes = append(remotes, r.RemoteAddr)
		bodies = append(bodies, string(body))
		mu.Unlock()
		if n.Add(1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"key":"first","seq":1}`)
			return
		}
		// The second: read whole, then dropped with no answer.
		if c, _, err := w.(http.Hijacker).Hijack(); err == nil {
			_ = c.Close()
		}
	}))
	t.Cleanup(site.Close)
	r := newRig(t)
	base, _ := url.Parse(site.URL)
	r.f.Site = base
	first := r.do(t, call{method: "POST", path: "/v1/apps/reuse-app/collections/logs/records", auth: "Bearer civitai_tok-reuse-1",
		body: []byte(`{"data":{"n":"first"}}`)})
	second := r.do(t, call{method: "POST", path: "/v1/apps/reuse-app/collections/logs/records", auth: "Bearer civitai_tok-reuse-2",
		body: []byte(`{"data":{"n":"second"}}`)})
	mu.Lock()
	defer mu.Unlock()
	if first.Code != 200 || len(remotes) < 2 || remotes[0] != remotes[1] {
		t.Fatalf("first %d, remotes %v: the second request did not reuse the first's connection, so this proves nothing", first.Code, remotes)
	}
	if e := decode(t, second); second.Code != 504 || e.Outcome != "unknown" {
		t.Fatalf("second %d %s; want 504 outcome unknown", second.Code, second.Body.String())
	}
	copies := 0
	for _, b := range bodies {
		if b == `{"data":{"n":"second"}}` {
			copies++
		}
	}
	if copies != 1 || len(bodies) != 2 {
		t.Fatalf("🔴 the site saw %d copies of the second write (%d requests), want exactly 1", copies, len(bodies))
	}
}

// 8. Shape refusals: 4xx with a code, and the site receives nothing. The boundary body (exactly
// BodyLimit bytes) is the positive control: it is sent.
// Fails on origin/main: the routes are 404 there (`rec.Code != tc.status`, every case's status is
// 400 or 413).
func TestShapeRefusalsSendNothing(t *testing.T) {
	r := newRig(t)
	pad := func(n int) []byte {
		// A JSON object of exactly n bytes: {"data":"xxx…"}.
		return []byte(`{"data":"` + strings.Repeat("x", n-len(`{"data":""}`)) + `"}`)
	}
	tok := "Bearer civitai_tok-shape-1"
	cases := []struct {
		name   string
		in     call
		status int
		code   string
		op     string
	}{
		{"bad slug", call{method: "POST", path: "/v1/apps/Bad_Slug/collections/notes/records", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"bad collection", call{method: "POST", path: "/v1/apps/shape-app/collections/Notes/records", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"bad key", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/bad*key", body: []byte(`{}`)}, 400, "invalid_request", "put"},
		{"key too long", call{method: "DELETE", path: "/v1/apps/shape-app/collections/notes/records/" + strings.Repeat("k", 129)}, 400, "invalid_request", "delete"},
		{"oversized body", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/big-1", body: pad(BodyLimit + 1)}, 413, "too_large", "put"},
		{"two operators", call{method: "PATCH", path: "/v1/apps/shape-app/collections/notes/records/p-1", body: []byte(`{"$mark":"vote","$unmark":"vote"}`)}, 400, "invalid_request", "patch"},
		{"one operator twice", call{method: "PATCH", path: "/v1/apps/shape-app/collections/notes/records/p-2", body: []byte(`{"$mark":"vote","$mark":"star"}`)}, 400, "invalid_request", "patch"},
		{"another operator", call{method: "PATCH", path: "/v1/apps/shape-app/collections/notes/records/p-3", body: []byte(`{"$set":{"a":1}}`)}, 400, "invalid_request", "patch"},
		{"no operator", call{method: "PATCH", path: "/v1/apps/shape-app/collections/notes/records/p-4", body: []byte(`{}`)}, 400, "invalid_request", "patch"},
		{"an array body", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/a-1", body: []byte(`[{"data":1}]`)}, 400, "invalid_request", "put"},
		{"invalid JSON", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/a-2", body: []byte(`{"data":`)}, 400, "invalid_request", "put"},
		{"two values", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/a-3", body: []byte(`{} {}`)}, 400, "invalid_request", "put"},
		{"no body", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records"}, 400, "invalid_request", "create"},
		{"a delete with a body", call{method: "DELETE", path: "/v1/apps/shape-app/collections/notes/records/d-1", body: []byte(`{"x":1}`)}, 400, "invalid_request", "delete"},
		{"an unknown parameter", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/q-1?limit=5", body: []byte(`{}`)}, 400, "invalid_request", "put"},
		{"ifVersion on a put", call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/q-2?ifVersion=1", body: []byte(`{}`)}, 400, "invalid_request", "put"},
		{"a negative ifVersion", call{method: "DELETE", path: "/v1/apps/shape-app/collections/notes/records/q-3?ifVersion=-1"}, 400, "invalid_request", "delete"},
		{"a 16-digit ifVersion", call{method: "DELETE", path: "/v1/apps/shape-app/collections/notes/records/q-4?ifVersion=1234567890123456"}, 400, "invalid_request", "delete"},
		{"major zero", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records?major=0", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"a 7-digit major", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records?major=1000000", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"a padded major", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records?major=02", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"major twice", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records?major=1&major=1", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"a bad query escape", call{method: "POST", path: "/v1/apps/shape-app/collections/notes/records?major=%zz", body: []byte(`{}`)}, 400, "invalid_request", "create"},
		{"major on info", call{method: "GET", path: "/v1/apps/shape-app/info?major=1"}, 400, "invalid_request", "info"},
		{"bad slug on info", call{method: "GET", path: "/v1/apps/-bad/info"}, 400, "invalid_request", "info"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.in.auth = tok
			before := r.writes(tc.op, "refused_here")
			rec := r.do(t, tc.in)
			if e := decode(t, rec); rec.Code != tc.status || e.Code != tc.code || e.Error != e.Message {
				t.Fatalf("%d %+v; want %d %s", rec.Code, e, tc.status, tc.code)
			}
			if r.writes(tc.op, "refused_here") != before+1 {
				t.Fatalf("not counted as refused_here under op %s", tc.op)
			}
		})
	}
	if n := len(r.site.requests()); n != 0 {
		t.Fatalf("🔴 the site received %d requests for refused shapes", n)
	}
	// Positive control: a body of exactly the limit is sent.
	rec := r.do(t, call{method: "PUT", path: "/v1/apps/shape-app/collections/notes/records/big-ok", auth: tok, body: pad(BodyLimit)})
	if got := r.site.requests(); rec.Code != 200 || len(got) != 1 || len(got[0].body) != BodyLimit {
		t.Fatalf("a body of exactly %d bytes: %d, %d requests", BodyLimit, rec.Code, len(got))
	}
}

// A body of unknown length past the limit is refused as it is read, and an unreadable body is a
// 400: neither is sent.
func TestABodyReadIsBounded(t *testing.T) {
	r := newRig(t)
	for name, tc := range map[string]struct {
		body   io.Reader
		status int
	}{
		"unknown length, too large": {io.MultiReader(strings.NewReader(`{"data":"`), strings.NewReader(strings.Repeat("y", BodyLimit))), 413},
		"unreadable":                {io.MultiReader(strings.NewReader(`{"da`), failingReader{}), 400},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), "PUT", "/v1/apps/body-read/collections/notes/records/b-1", tc.body)
			req.ContentLength = -1
			req.Header.Set("Authorization", "Bearer civitai_tok-body-1")
			rec := httptest.NewRecorder()
			r.h.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("%d %s; want %d", rec.Code, rec.Body.String(), tc.status)
			}
		})
	}
	if n := len(r.site.requests()); n != 0 {
		t.Fatalf("the site received %d requests", n)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("the client went away") }

// The preflights of the write paths allow every write method and a JSON body.
func TestThePreflightsAllowTheWrites(t *testing.T) {
	r := newRig(t)
	for _, path := range []string{"/v1/apps/cors-app/collections/notes/records/k-1", "/v1/apps/cors-app/info"} {
		rec := r.do(t, call{method: "OPTIONS", path: path})
		methods := strings.Split(rec.Header().Get("Access-Control-Allow-Methods"), ", ")
		sort.Strings(methods)
		if rec.Code != 204 || strings.Join(methods, ",") != "DELETE,GET,OPTIONS,PATCH,POST,PUT" ||
			rec.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" ||
			rec.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("%s: %d %v", path, rec.Code, rec.Header())
		}
	}
}

// Every write series exists from the start, at zero, and none carries an app, a collection or a key.
func TestEveryWriteSeriesStartsAtZero(t *testing.T) {
	r := newRig(t)
	if n := testutil.CollectAndCount(r.m.Writes); n != len(metrics.WriteOps)*len(metrics.WriteOutcomes) {
		t.Fatalf("%d write series, want %d", n, len(metrics.WriteOps)*len(metrics.WriteOutcomes))
	}
	for _, op := range metrics.WriteOps {
		for _, o := range metrics.WriteOutcomes {
			if r.writes(op, o) != 0 {
				t.Fatalf("%s/%s not zero", op, o)
			}
		}
	}
}
