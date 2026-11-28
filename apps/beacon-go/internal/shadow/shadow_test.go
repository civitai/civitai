package shadow

import (
	"context"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/golden"
)

// rawOnly are fallback reasons about the raw body, which a shadow sample (already decoded by Node)
// cannot hit: the sample is compared instead.
var rawOnly = map[string]bool{"charset": true, "body-too-large": true}

// TestGoldenSamples feeds each fixture's shadow sample — built by gen.ts with the sampler's real
// payload code (src/server/beacon/beacon-go-shadow-payload.ts) from what the Node code did — through
// Decode, Request, the engine and Compare: every one must match, or fall back for its reason.
func TestGoldenSamples(t *testing.T) {
	fixtures := golden.LoadFixtures(t, golden.Dir)
	matched, fellBack := 0, 0
	for _, fx := range fixtures {
		if fx.Shadow == "" {
			continue
		}
		t.Run(fx.Endpoint+"/"+fx.Name, func(t *testing.T) {
			s, err := Decode([]byte(fx.Shadow))
			if err != nil {
				t.Fatal(err)
			}
			req, err := s.Request(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			out, err := fx.Engine().Compute(context.Background(), fx.Endpoint, req)
			v := Compare(out, err, s.Node)
			want := ResultMatch
			if fx.Fallback != "" && !rawOnly[fx.Fallback] {
				want = ResultFallback
			}
			if v.Result != want {
				t.Fatalf("result %s (reason %q, diffs %v), want %s", v.Result, v.Reason, v.Diffs, want)
			}
			if want == ResultFallback {
				if v.Reason != fx.Fallback {
					t.Fatalf("reason %q, want %q", v.Reason, fx.Fallback)
				}
				fellBack++
				return
			}
			matched++
		})
	}
	if matched < 60 || fellBack < 5 {
		t.Fatalf("matched %d, fell back %d: the samples did not load", matched, fellBack)
	}
}

// One sample, each part of Node's side mutated in turn: every mutation must be caught under its own
// result, and a write mutation must name the row key that moved (not just "something differs").
func TestCompareCatchesEachPart(t *testing.T) {
	var base *golden.Fixture
	for _, fx := range golden.LoadFixtures(t, golden.Dir) {
		if fx.Endpoint == beacon.EndpointPing && fx.Name == "signed-in-tier" {
			base = &fx
			break
		}
	}
	if base == nil {
		t.Fatal("fixture ping/signed-in-tier not found")
	}
	run := func(mutate func(n *NodeSide)) Verdict {
		s, err := Decode([]byte(base.Shadow))
		if err != nil {
			t.Fatal(err)
		}
		mutate(s.Node)
		req, _ := s.Request(context.Background())
		out, err := base.Engine().Compute(context.Background(), base.Endpoint, req)
		return Compare(out, err, s.Node)
	}
	if v := run(func(*NodeSide) {}); v.Result != ResultMatch {
		t.Fatalf("unmutated: %+v", v)
	}
	cases := []struct {
		name   string
		mutate func(n *NodeSide)
		result string
		diff   string
	}{
		{"status", func(n *NodeSide) { n.Status = 204 }, ResultMismatchStatus, "status"},
		{"header value", func(n *NodeSide) { n.Headers["vary"] = "Cookie" }, ResultMismatchHeaders, "header:vary"},
		{"header absent", func(n *NodeSide) { delete(n.Headers, "cache-control") }, ResultMismatchHeaders, "header:cache-control"},
		{"set-cookie", func(n *NodeSide) { n.Headers["set-cookie"] = "<redacted>" }, ResultMismatchHeaders, "header:set-cookie"},
		{"body", func(n *NodeSide) { n.Body = "x" }, ResultMismatchBody, "body"},
		{"no write", func(n *NodeSide) { n.Writes = nil }, ResultMismatchWrites, "writes:count"},
		{"table", func(n *NodeSide) { n.Writes[0].Table = "views" }, ResultMismatchWrites, "write:views:table"},
		{"row value", func(n *NodeSide) {
			n.Writes[0].Body = strings.Replace(n.Writes[0].Body, `"memberType":"gold"`, `"memberType":"free"`, 1)
		}, ResultMismatchWrites, "write:pageViews:memberType"},
		{"row key order", func(n *NodeSide) {
			n.Writes[0].Body = strings.Replace(n.Writes[0].Body, `{"userId":1001,"memberType":"gold",`, `{"memberType":"gold","userId":1001,`, 1)
		}, ResultMismatchWrites, "write:pageViews:order"},
		{"row whitespace", func(n *NodeSide) { n.Writes[0].Body = " " + n.Writes[0].Body }, ResultMismatchWrites, "write:pageViews:order"},
		{"row not json", func(n *NodeSide) { n.Writes[0].Body = "nope" }, ResultMismatchWrites, "write:pageViews:unparsed"},
	}
	for _, c := range cases {
		v := run(c.mutate)
		if v.Result != c.result {
			t.Errorf("%s: result %s, want %s (diffs %v)", c.name, v.Result, c.result, v.Diffs)
			continue
		}
		found := false
		for _, d := range v.Diffs {
			found = found || d == c.diff
		}
		if !found {
			t.Errorf("%s: diffs %v, want %s among them", c.name, v.Diffs, c.diff)
		}
	}
}

func TestCompareErrors(t *testing.T) {
	if v := Compare(beacon.Outcome{}, fallback.New("url"), &NodeSide{}); v.Result != ResultFallback || v.Reason != "url" {
		t.Fatalf("fallback: %+v", v)
	}
	if v := Compare(beacon.Outcome{}, context.Canceled, &NodeSide{}); v.Result != ResultError {
		t.Fatalf("error: %+v", v)
	}
}

func TestDecodeRefusesMalformedSamples(t *testing.T) {
	good := `{"method":"POST","target":"/api/internal/ping","query":"","headers":{},"body":"","bodyIsString":true,"node":{"status":200,"headers":{},"body":"","writes":[]}}`
	if _, err := Decode([]byte(good)); err != nil {
		t.Fatalf("good sample: %v", err)
	}
	bad := []string{
		``, `[]`, `{}`, "\xff",
		strings.Replace(good, `"method":"POST"`, `"method":""`, 1),
		strings.Replace(good, `"target":"/api/internal/ping"`, `"target":1`, 1),
		strings.Replace(good, `"query":""`, `"query":"x=1"`, 1),
		strings.Replace(good, `"query":"",`, ``, 1),
		strings.Replace(good, `"headers":{}`, `"headers":{"a":1}`, 1),
		strings.Replace(good, `"body":"",`, `"body":null,`, 1),
		strings.Replace(good, `"bodyIsString":true`, `"bodyIsString":"yes"`, 1),
		strings.Replace(good, `"status":200`, `"status":200.5`, 1),
		strings.Replace(good, `"writes":[]`, `"writes":[1]`, 1),
		strings.Replace(good, `"writes":[]`, `"writes":[{"table":"t"}]`, 1),
		strings.Replace(good, `"writes":[]`, `"writes":{}`, 1),
		strings.Replace(good, `"node":{"status":200,"headers":{},"body":"","writes":[]}`, `"node":null`, 1),
	}
	for _, b := range bad {
		if _, err := Decode([]byte(b)); err == nil {
			t.Errorf("Decode(%q) accepted a malformed sample", b)
		}
	}
}

// `hattedViews` is optional (absent is 0, as every ping and pulse sample sends it) and a
// non-negative integer; an answered batch for which Node awarded any is a writes mismatch.
func TestHattedViews(t *testing.T) {
	base := `{"method":"POST","target":"/api/track/batch","query":"","headers":{},"body":"","bodyIsString":true,"node":{"status":200,"headers":{},"body":"","writes":[]%s}}`
	for _, c := range []struct {
		extra string
		n     int
		ok    bool
	}{{"", 0, true}, {`,"hattedViews":3`, 3, true}, {`,"hattedViews":-1`, 0, false}, {`,"hattedViews":1.5`, 0, false}, {`,"hattedViews":"2"`, 0, false}} {
		s, err := Decode([]byte(strings.Replace(base, "%s", c.extra, 1)))
		if (err == nil) != c.ok || (err == nil && s.Node.HattedViews != c.n) {
			t.Errorf("%q: err %v", c.extra, err)
		}
	}
	out := beacon.Outcome{Response: beacon.Response{Status: 200}}
	if v := Compare(out, nil, &NodeSide{Status: 200, Headers: map[string]string{}}); v.Result != ResultMatch {
		t.Fatalf("no hatted views: %+v", v)
	}
	v := Compare(out, nil, &NodeSide{Status: 200, Headers: map[string]string{}, HattedViews: 1})
	if v.Result != ResultMismatchWrites || len(v.Diffs) != 1 || v.Diffs[0] != DiffPointsViews {
		t.Fatalf("hatted views: %+v", v)
	}
}

// Rows are compared table by table: the same rows in a different order ACROSS tables match, a
// different order within one table does not.
func TestCompareWritesPerTable(t *testing.T) {
	out := beacon.Outcome{Response: beacon.Response{Status: 200}, Writes: []beacon.Write{
		{Table: "search", Body: []byte(`{"a":1}`)}, {Table: "impressions", Body: []byte(`{"e":1}`)}, {Table: "impressions", Body: []byte(`{"e":2}`)},
	}}
	node := &NodeSide{Status: 200, Headers: map[string]string{}, Writes: []NodeWrite{
		{Table: "impressions", Body: `{"e":1}`}, {Table: "search", Body: `{"a":1}`}, {Table: "impressions", Body: `{"e":2}`},
	}}
	if v := Compare(out, nil, node); v.Result != ResultMatch {
		t.Fatalf("across tables: %+v", v)
	}
	node.Writes[0].Body, node.Writes[2].Body = `{"e":2}`, `{"e":1}`
	if v := Compare(out, nil, node); v.Result != ResultMismatchWrites || len(v.Diffs) != 2 || v.Diffs[0] != "write:impressions:e" {
		t.Fatalf("within a table: %+v", v)
	}
	// A Node feed row this service did not write, with the counts equal.
	node.Writes[2] = NodeWrite{Table: "feedEvents", Body: `{}`}
	v := Compare(out, nil, node)
	if v.Result != ResultMismatchWrites || strings.Join(v.Diffs, ",") != "write:feedEvents:table,write:impressions:table" {
		t.Fatalf("a feed row: %+v", v)
	}
}

// The query marker rebuilds what the engine needs: HasQuery, and a token for the session resolver,
// without the key itself.
func TestQueryMarker(t *testing.T) {
	base := `{"method":"POST","target":"/api/internal/ping","query":"%s","headers":{},"body":"","bodyIsString":true,"node":{"status":200,"headers":{},"body":"","writes":[]}}`
	for _, c := range []struct {
		query    string
		hasQuery bool
		token    string
	}{{"", false, ""}, {"present", true, ""}, {"token", true, "present"}} {
		s, err := Decode([]byte(strings.Replace(base, "%s", c.query, 1)))
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.Request(context.Background())
		if err != nil || r.HasQuery != c.hasQuery || r.HTTP.URL.Query().Get("token") != c.token || r.HTTP.URL.Path != "/api/internal/ping" {
			t.Errorf("query %q: HasQuery %v token %q path %q (%v)", c.query, r.HasQuery, r.HTTP.URL.Query().Get("token"), r.HTTP.URL.Path, err)
		}
	}
}

// A JS string can hold an unpaired surrogate; the sample keeps it (encoding/json would not).
func TestDecodeKeepsALoneSurrogate(t *testing.T) {
	s, err := Decode([]byte(`{"method":"POST","target":"/","query":"","headers":{},"body":"\ud800","bodyIsString":true,"node":{"status":200,"headers":{},"body":"","writes":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if s.Body != "\xed\xa0\x80" {
		t.Fatalf("body %x", s.Body)
	}
}

// FuzzDecode: Decode never panics, and a decoded sample always rebuilds into a request.
func FuzzDecode(f *testing.F) {
	f.Add(`{"method":"POST","target":"/api/internal/ping","query":"token","headers":{"cookie":"a=1","authorization":"present"},"body":"{}","bodyIsString":false,"node":{"status":200,"headers":{},"body":"","writes":[{"table":"t","body":"{}"}]}}`)
	f.Add(`{"method":"POST","target":"","query":"","headers":{},"body":"","bodyIsString":true,"node":{"status":0,"headers":{},"body":"","writes":[]}}`)
	f.Fuzz(func(t *testing.T, s string) {
		sample, err := Decode([]byte(s))
		if err != nil {
			return
		}
		if _, err := sample.Request(context.Background()); err != nil && err != ErrInvalidSample { //nolint:errorlint // sentinel
			t.Fatalf("Request: %v", err)
		}
	})
}

// The replayed request keeps the host the browser addressed, which picks the site's session cookie names.
func TestRequestKeepsHost(t *testing.T) {
	s, err := Decode([]byte(`{"method":"POST","target":"/api/internal/ping","query":"","headers":{"host":"civitai.red"},"body":"","bodyIsString":true,"node":{"status":200,"headers":{},"body":"","writes":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Request(context.Background())
	if err != nil || r.HTTP.Host != "civitai.red" {
		t.Fatalf("host %q (%v)", r.HTTP.Host, err)
	}
}
