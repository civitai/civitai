package beacon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// refVectors is the part of testdata/golden/vectors.json this package checks (gen.ts runs Node's
// `new URL`, net.isIP, the app's resolveClientIp and getMatchingPathname).
type refVectors struct {
	URLs []struct {
		In     string `json:"in"`
		Host   string `json:"host"`
		Throws bool   `json:"throws"`
	} `json:"urls"`
	IsIP []struct {
		In  string `json:"in"`
		Out int    `json:"out"`
	} `json:"isIP"`
	ClientIP []struct {
		Headers map[string]string `json:"headers"`
		Out     string            `json:"out"`
	} `json:"clientIp"`
	Pathnames []struct{ In, Out string } `json:"pathnames"`
}

func loadRef(t *testing.T) refVectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v refVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestURLHostMatchesNode(t *testing.T) {
	certain := 0
	for _, c := range loadRef(t).URLs {
		host, res := urlHostOf(c.In)
		switch res {
		case urlUncertain:
			continue
		case urlThrows:
			if !c.Throws {
				t.Errorf("new URL(%q): beacon-go throws, Node gives host %q", c.In, c.Host)
			}
		case urlHost:
			if c.Throws || host != c.Host {
				t.Errorf("new URL(%q).host = %q, Node %q (throws %v)", c.In, host, c.Host, c.Throws)
			}
		}
		certain++
	}
	// Positive control: most vectors are inside the reproduced subset.
	if certain < 20 {
		t.Fatalf("only %d URL vectors answered exactly", certain)
	}
}

func TestNodeIsIPMatchesNode(t *testing.T) {
	v := loadRef(t).IsIP
	if len(v) < 15 {
		t.Fatalf("only %d isIP vectors", len(v))
	}
	for _, c := range v {
		want := c.Out != 0 && !strings.Contains(c.In, "%") && len(c.In) <= 45
		if got := isIPAddress(c.In); got != want {
			t.Errorf("isIpAddress(%q) = %v; Node isIP = %d", c.In, got, c.Out)
		}
	}
}

func TestResolveClientIPMatchesNode(t *testing.T) {
	answered := 0
	for _, c := range loadRef(t).ClientIP {
		got, err := resolveClientIP(&Request{Headers: c.Headers})
		if err != nil {
			// The socket step: Node answers 'unknown' there (the generator's socket has no address).
			if fallback.Reason(err) == "client-ip-socket" && c.Out != "unknown" {
				t.Errorf("%v: fell back to the socket, Node resolved %q", c.Headers, c.Out)
			}
			continue
		}
		if got != c.Out {
			t.Errorf("%v: %q, Node %q", c.Headers, got, c.Out)
		}
		answered++
	}
	if answered < 12 {
		t.Fatalf("only %d client-ip vectors answered", answered)
	}
}

func TestMatchingPathnameMatchesNode(t *testing.T) {
	v := loadRef(t).Pathnames
	if len(v) < 20 {
		t.Fatalf("only %d pathname vectors", len(v))
	}
	for _, c := range v {
		if got := matchingPathname(c.In); got != c.Out {
			t.Errorf("getMatchingPathname(%q) = %q, Node %q", c.In, got, c.Out)
		}
	}
}

// The pathname list is a copy: pin it, in order, against the Node source it copies.
func TestPathnamesMatchTheNodeList(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "src", "shared", "constants", "pathname.constants.ts"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := strings.Index(src, "const pathnamesTokens = [")
	end := strings.Index(src, "].reduce")
	if start < 0 || end < start {
		t.Fatal("pathnamesTokens not found in pathname.constants.ts")
	}
	matches := regexp.MustCompile(`(?m)^\s*'([^']*)',`).FindAllStringSubmatch(src[start:end], -1)
	node := make([]string, 0, len(matches))
	for _, m := range matches {
		node = append(node, m[1])
	}
	if len(node) < 90 || strings.Join(node, "\n") != strings.Join(pathnames, "\n") {
		t.Fatalf("pathnames (%d) differ from pathname.constants.ts (%d): regenerate pathname.go", len(pathnames), len(node))
	}
}

func TestParseContentType(t *testing.T) {
	cases := []struct {
		in, typ, charset string
	}{
		{"", "text/plain", ""},
		{"application/json", "application/json", ""},
		{"Application/JSON; Charset=UTF-8", "application/json", "UTF-8"},
		{` application/json ; charset="ut\f-8"`, "application/json", "utf-8"},
		{"application/json; charset", "text/plain", ""},
		{"application/json;", "text/plain", ""},
		{"json", "text/plain", ""},
		{"application/json; a=1; a=2", "application/json", ""},
		{"text/plain; charset=latin1", "text/plain", "latin1"},
	}
	for _, c := range cases {
		typ, params := parseContentType(c.in)
		if typ != c.typ || params["charset"] != c.charset {
			t.Errorf("%q: %q %v, want %q charset %q", c.in, typ, params, c.typ, c.charset)
		}
	}
	if _, p := parseContentType("a/b; a=1; a=2"); p["a"] != "2" {
		t.Fatalf("a later parameter wins: %v", p)
	}
}

func TestIconvName(t *testing.T) {
	for in, want := range map[string]string{"UTF-8": "utf8", "utf_8": "utf8", "u.t.f.8": "utf8", "ISO-8859-1": "iso88591", "cp1252:2000": "cp1252", "a:12": "a12"} {
		if got := iconvName(in); got != want {
			t.Errorf("iconvName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClampToColumn(t *testing.T) {
	cases := []struct{ in, limit, want float64 }{
		{12.9, 100, 12}, {-0.5, 100, 0}, {-3, 100, 0}, {1e20, uint32Max, uint32Max}, {32768, int16Max, int16Max},
	}
	for _, c := range cases {
		if got := clampToColumn(c.in, c.limit); got != c.want {
			t.Errorf("clamp(%v, %v) = %v, want %v", c.in, c.limit, got, c.want)
		}
	}
}

// The rare request shapes Node answers on paths this service does not reproduce fall back, each
// under its own reason, and before anything else is read.
func TestRareShapesFallBack(t *testing.T) {
	base := func() *Request {
		return &Request{
			Method:  http.MethodPost,
			Headers: map[string]string{"host": "a.test", "referer": "https://a.test/", "origin": "https://a.test"},
			Body:    []byte(`{"path":"/"}`),
		}
	}
	cases := []struct {
		name   string
		mutate func(r *Request)
		reason string
	}{
		{"preflight", func(r *Request) { r.Method = "OPTIONS" }, "preflight"},
		{"if-none-match", func(r *Request) { r.Headers["if-none-match"] = "*" }, "conditional-request"},
		{"if-modified-since", func(r *Request) { r.Headers["if-modified-since"] = "x" }, "conditional-request"},
		{"urlencoded", func(r *Request) { r.Headers["content-type"] = "application/x-www-form-urlencoded" }, "form-body"},
		{"urlencoded, shadow", func(r *Request) {
			r.Headers["content-type"] = "application/x-www-form-urlencoded"
			r.BodyDecoded = true
		}, "form-body"},
	}
	e := &Engine{Sessions: fixedUser{}, TrackerEnabled: true}
	for _, endpoint := range []string{EndpointPing, EndpointPulse} {
		for _, c := range cases {
			r := base()
			c.mutate(r)
			if _, err := e.Compute(context.Background(), endpoint, r); fallback.Reason(err) != c.reason {
				t.Errorf("%s %s: %v, want fallback %q", endpoint, c.name, err, c.reason)
			}
		}
	}
	// Empty conditional headers are not conditional (`fresh` reads them as absent).
	r := base()
	r.Headers["if-none-match"], r.Headers["if-modified-since"] = "", ""
	r.Headers["cf-connecting-ip"] = "192.0.2.1"
	r.HTTP = httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil)
	if out, err := e.Compute(context.Background(), EndpointPing, r); err != nil || out.Response.Status != 200 {
		t.Fatalf("empty conditional headers: %+v %v", out.Response, err)
	}
	// A 400 carries its ETag and no 304 path exists any more.
	out := send400(wrapperHeaders(base()), "invalid input")
	if etag, _ := out.Get("etag"); out.Status != 400 || out.Body != "invalid input" || etag != `"17fa7f31cyhd"` {
		t.Fatalf("send400: %+v", out)
	}
}

func TestCarriesCallerCredentials(t *testing.T) {
	cases := map[string]bool{
		"":                          false,
		"a=1; b=2":                  false,
		"a=1; __Host-civ-token=x":   true,
		"civ-token":                 true,
		" civitai-token = ":         true,
		"x=civ-token":               false,
		"__Secure-civ-tokenx=1":     false,
		"__Secure-civitai-token=v;": true,
	}
	for cookie, want := range cases {
		r := &Request{Headers: map[string]string{"cookie": cookie}}
		if got := carriesCallerCredentials(r); got != want {
			t.Errorf("cookie %q: %v, want %v", cookie, got, want)
		}
	}
	if !carriesCallerCredentials(&Request{Headers: map[string]string{"authorization": "x"}}) {
		t.Fatal("an Authorization header is a credential")
	}
	if carriesCallerCredentials(&Request{Headers: map[string]string{"authorization": ""}}) {
		t.Fatal("an empty Authorization header is not")
	}
}

func TestNodeHeaders(t *testing.T) {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/internal/ping", nil)
	r.Host = "h\xe9.test"
	r.Header["Referer"] = []string{"first", "second"}
	r.Header["X-Forwarded-For"] = []string{"1.1.1.1", "2.2.2.2"}
	r.Header["Cookie"] = []string{"a=1", "b=2"}
	r.Header["User-Agent"] = []string{"caf\xe9"}
	h := NodeHeaders(r)
	want := map[string]string{
		"host": "hé.test", "referer": "first", "x-forwarded-for": "1.1.1.1, 2.2.2.2",
		"cookie": "a=1; b=2", "user-agent": "café",
	}
	for k, v := range want {
		if h[k] != v {
			t.Errorf("%s = %q, want %q", k, h[k], v)
		}
	}
	if len(h) != len(want) {
		t.Errorf("extra headers: %v", h)
	}
	q := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/internal/ping?", nil)
	if !FromHTTP(q, nil).HasQuery || FromHTTP(r, nil).HasQuery {
		t.Fatal("HasQuery")
	}
}

func TestRollDue(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	user := func(cookie string, iat string) *auth.SessionUser {
		return &auth.SessionUser{ID: 1, CookieName: cookie, Claims: &auth.Claims{Iat: json.RawMessage(iat)}}
	}
	old := "1900000000"
	cases := []struct {
		name   string
		e      Engine
		u      *auth.SessionUser
		expect bool
	}{
		{"shared slot, shared mode", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", old), true},
		{"shared slot, host mode", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("host", false)}, user("__Secure-civ-token", old), false},
		{"host slot, host mode", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("host", false)}, user("__Host-civ-token", old), true},
		{"no hub origin", Engine{UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", old), false},
		{"fresh token", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", "1999999999.5"), false},
		{"exactly the age", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", "1999999999"), true},
		{"iat zero", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", "0"), false},
		{"iat a string", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", `"1"`), false},
		{"iat absent", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", false)}, user("__Secure-civ-token", ""), false},
		{"dev cookie, shared mode", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("shared", true)}, user("civ-token", old), true},
		{"dev cookie, host mode, legacy on", Engine{HubOrigin: "x", UpdateAgeMs: 1000, ModeFor: fixedMode("host", true)}, user("civ-token", old), true},
	}
	for _, c := range cases {
		c.e.Now = func() time.Time { return now }
		if c.u.Claims != nil && len(c.u.Claims.Iat) == 0 {
			c.u.Claims.Iat = nil
		}
		if got := c.e.rollDue(c.u, ""); got != c.expect {
			t.Errorf("%s: rollDue = %v, want %v", c.name, got, c.expect)
		}
	}
}

// Literal pulse row, written from tracker.ts track() ({...actor, ...values}) and addViewSchema's
// shape order, independent of the generator.
func TestPulseRowLiteral(t *testing.T) {
	e := &Engine{Sessions: fixedUser{u: &auth.SessionUser{ID: 42}}, TrackerEnabled: true}
	r := &Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"host": "a.test", "origin": "https://a.test", "content-type": "application/json",
			"user-agent": "ua", "cf-connecting-ip": "192.0.2.1",
		},
		Body: []byte(`{"nsfw":true,"entityId":5,"entityType":"Post","type":"PostView","details":{"z":1,"0":2}}`),
		HTTP: httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil),
	}
	out, err := e.Pulse(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"userId":42,"ip":"192.0.2.1","userAgent":"ua","type":"PostView","entityType":"Post","entityId":5,"nsfw":true,"details":{"0":2,"z":1}}`
	if len(out.Writes) != 1 || out.Writes[0].Table != "views" || string(out.Writes[0].Body) != want {
		t.Fatalf("writes %+v\nwant %s", out.Writes, want)
	}
	if out.Response.Status != 200 || out.Response.Body != "" {
		t.Fatalf("response %+v", out.Response)
	}
}

// Literal ping row, written from tracker.ts pageView() ({userId, memberType, ip, ...rest, clamped}).
func TestPingRowLiteral(t *testing.T) {
	e := &Engine{Sessions: fixedUser{u: &auth.SessionUser{ID: 7, Tier: "free", TierSet: true}}, TrackerEnabled: true}
	r := &Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"host": "a.test", "referer": "https://a.test/images/9", "cf-connecting-ip": "192.0.2.2", "cf-ipcountry": "DE",
		},
		Body: []byte(`{"path":"/images/9","duration":"99.9","windowWidth":40000,"windowHeight":800.7,"ads":1}`),
		HTTP: httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil),
	}
	out, err := e.Ping(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"userId":7,"memberType":"free","ip":"192.0.2.2","pageId":"/images/[imageId]","path":"/images/9","host":"a.test","country":"DE","ads":false,"duration":99,"windowWidth":32767,"windowHeight":800}`
	if len(out.Writes) != 1 || out.Writes[0].Table != "pageViews" || string(out.Writes[0].Body) != want {
		t.Fatalf("writes %+v\nwant %s", out.Writes, want)
	}
	if v, _ := out.Response.Get("cache-control"); v != publicCacheControl {
		t.Fatalf("cache-control %q", v)
	}
}

func TestComputeUnknownEndpointAndSessionFallback(t *testing.T) {
	e := &Engine{Sessions: fixedUser{err: fallback.New("session-cache-miss")}, TrackerEnabled: true}
	if _, err := e.Compute(context.Background(), "track", &Request{}); fallback.Reason(err) != "unknown-endpoint" {
		t.Fatalf("unknown endpoint: %v", err)
	}
	r := &Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"host": "a.test", "referer": "https://a.test/", "cf-connecting-ip": "192.0.2.2"},
		Body:    []byte(`{"path":"/"}`),
		HTTP:    httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil),
	}
	if _, err := e.Compute(context.Background(), EndpointPing, r); fallback.Reason(err) != "session-cache-miss" {
		t.Fatalf("a session fallback must propagate: %v", err)
	}
	big := &Request{Method: http.MethodPost, Headers: map[string]string{}, Body: make([]byte, MaxBody+1)}
	if _, err := e.Compute(context.Background(), EndpointPulse, big); fallback.Reason(err) != "body-too-large" {
		t.Fatalf("over Next's limit: %v", err)
	}
	deep := &Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"host": "a.test", "origin": "https://a.test"},
		Body:    []byte(strings.Repeat("[", jsvalue.MaxDepth+1)),
	}
	if _, err := e.Compute(context.Background(), EndpointPulse, deep); fallback.Reason(err) != "json-depth" {
		t.Fatalf("too deep: %v", err)
	}
}

type fixedUser struct {
	u   *auth.SessionUser
	err error
}

func (f fixedUser) Resolve(context.Context, *http.Request) (*auth.SessionUser, error) {
	return f.u, f.err
}

// fixedMode is an Engine.ModeFor that gives the same mode for every host.
func fixedMode(mode string, legacyRead bool) func(string) (string, bool) {
	return func(string) (string, bool) { return mode, legacyRead }
}

// The roll follows the request host's mode: on a site listed host, a shared-slot read never rolls.
func TestRollDuePerSite(t *testing.T) {
	e := Engine{HubOrigin: "x", UpdateAgeMs: 1000, Now: func() time.Time { return time.Unix(2_000_000_000, 0) }}
	e.ModeFor = func(host string) (string, bool) {
		if host == "civitai.red" {
			return "host", false
		}
		return "shared", true
	}
	shared := &auth.SessionUser{ID: 1, CookieName: "__Secure-civ-token", Claims: &auth.Claims{Iat: json.RawMessage("1900000000")}}
	if e.rollDue(shared, "civitai.red") {
		t.Error("civitai.red rolled a shared-slot token")
	}
	if !e.rollDue(shared, "civitai.com") {
		t.Error("civitai.com did not roll its shared-slot token")
	}
}
