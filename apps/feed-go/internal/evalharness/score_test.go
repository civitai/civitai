package evalharness

import (
	"errors"
	"net/http"
	"reflect"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

func trpcBody(env string) []byte { return []byte(`{"result":{"data":` + env + `}}`) }

func ans(status int, body string, kv ...string) Answer {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Add(kv[i], kv[i+1])
	}
	return Answer{Status: status, Header: h, Body: []byte(body)}
}

func TestScore(t *testing.T) {
	v1 := server.CompareSelection(evalcorpus.EndpointV1ModelsID)
	posts := server.CompareSelection(evalcorpus.EndpointAsPosts)
	node := ans(200, `{"id":501,"name":"n-501"}`, "Cache-Control", "public, max-age=61")
	goSame := ans(200, `{"id":501,"name":"n-501"}`, "Cache-Control", "max-age=61, public")
	cases := []struct {
		name      string
		sel       server.Selection
		masks     []string
		n1, g, n2 Answer
		want      Outcome
	}{
		{"pass via N1", v1, nil, node, goSame, node, Outcome{Verdict: VerdictPass}},
		{"pass via N2 only (N1's headers differ)", v1, nil,
			ans(200, `{"id":501,"name":"n-501"}`, "Cache-Control", "public, max-age=17"), goSame, node, Outcome{Verdict: VerdictPass}},
		{"bug: a field", v1, nil, node, ans(200, `{"id":501,"name":"g-501"}`, "Cache-Control", "public, max-age=61"), node,
			Outcome{Verdict: VerdictBug, ResultClass: "fields", DiffCategories: []string{"name"}}},
		{"bug: not found against Node's model", v1, nil, node, ans(200, `{"error":"No model"}`, "Cache-Control", "public, max-age=61"), node,
			Outcome{Verdict: VerdictBug, ResultClass: "membership", DiffCategories: []string{"error", "id", "name"}}},
		{"bug: a header", v1, nil, node, ans(200, `{"id":501,"name":"n-501"}`, "Cache-Control", "private"), node,
			Outcome{Verdict: VerdictBug, ResultClass: "match", DiffCategories: []string{"header:cache-control"}}},
		{"bug: a status", v1, nil, node, ans(404, `{"id":501,"name":"n-501"}`, "Cache-Control", "public, max-age=61"), node,
			Outcome{Verdict: VerdictBug, ResultClass: "match", DiffCategories: []string{"status"}}},
		{"bug: set-cookie only from Go", v1, nil, node,
			ans(200, `{"id":501,"name":"n-501"}`, "Cache-Control", "public, max-age=61", "Set-Cookie", "k=v"), node,
			Outcome{Verdict: VerdictBug, ResultClass: "match", DiffCategories: []string{"header:set-cookie"}}},
		{"gap", v1, nil, node, ans(server.HandbackStatus, "", server.HandbackReasonHeader, "origin"), node,
			Outcome{Verdict: VerdictGap, Reason: "origin"}},
		{"gap: a camelCase input key reason", v1, nil, node, ans(server.HandbackStatus, "", server.HandbackReasonHeader, "input-browsingLevel"), node,
			Outcome{Verdict: VerdictGap, Reason: "input-browsingLevel"}},
		{"gap: a reason not shaped as a fallback reason", v1, nil, node, ans(server.HandbackStatus, "", server.HandbackReasonHeader, "Not a reason/x"), node,
			Outcome{Verdict: VerdictGap, Reason: "invalid-reason"}},
		{"stub without reason", v1, nil, node, ans(server.HandbackStatus, ""), node,
			Outcome{Verdict: VerdictError, Reason: "go-stub-without-reason"}},
		{"go 503", v1, nil, node, ans(503, `{}`), node, Outcome{Verdict: VerdictError, Reason: "go-status-503"}},
		{"go timeout", v1, nil, node, Answer{Err: errors.New("deadline"), Timeout: true}, node, Outcome{Verdict: VerdictError, Reason: "go-timeout"}},
		{"go transport", v1, nil, node, Answer{Err: errors.New("refused")}, node, Outcome{Verdict: VerdictError, Reason: "go-transport"}},
		{"node1 5xx", v1, nil, ans(502, ""), goSame, node, Outcome{Verdict: VerdictInfraMiss, Reason: "node1-status-5xx"}},
		{"node1 transport", v1, nil, Answer{Err: errors.New("refused")}, goSame, node, Outcome{Verdict: VerdictInfraMiss, Reason: "node1-transport"}},
		{"node2 timeout", v1, nil, node, goSame, Answer{Err: errors.New("deadline"), Timeout: true}, Outcome{Verdict: VerdictInfraMiss, Reason: "node2-timeout"}},
		{"node statuses differ", v1, nil, node, goSame, ans(404, `{"error":"x"}`), Outcome{Verdict: VerdictInfraMiss, Reason: "node-status-mismatch"}},
		{"node unstable", v1, nil, ans(200, `{"id":501,"stats":{"downloads":11}}`), goSame, ans(200, `{"id":501,"stats":{"downloads":12}}`),
			Outcome{Verdict: VerdictNodeUnstable, Reason: "body", ResultClass: "fields", DiffCategories: []string{"stats.downloads"},
				UnstablePaths: []string{"$.stats.downloads"}}},
		{"node unstable masked away: pass", v1, []string{"$.stats.downloads"},
			ans(200, `{"id":501,"stats":{"downloads":11}}`), ans(200, `{"id":501,"stats":{"downloads":13}}`),
			ans(200, `{"id":501,"stats":{"downloads":12}}`), Outcome{Verdict: VerdictPass}},
		{"node unstable checked before a gap", v1, nil, ans(200, `{"a":1}`), ans(server.HandbackStatus, "", server.HandbackReasonHeader, "origin"),
			ans(200, `{"a":2}`), Outcome{Verdict: VerdictNodeUnstable, Reason: "body", ResultClass: "fields", DiffCategories: []string{"a"},
				UnstablePaths: []string{"$.a"}}},
		{"trpc node 200 without a result", posts, nil, ans(200, `{"error":{}}`), goSame, ans(200, `{"error":{}}`),
			Outcome{Verdict: VerdictInfraMiss, Reason: "node-bad-body"}},
		{"trpc unstable: masks are envelope paths", posts, nil,
			ans(200, string(trpcBody(`{"json":{"items":[{"postId":1,"stats":{"likes":3}}]}}`))), goSame,
			ans(200, string(trpcBody(`{"json":{"items":[{"postId":1,"stats":{"likes":4}}]}}`))),
			Outcome{Verdict: VerdictNodeUnstable, Reason: "body", ResultClass: "fields", DiffCategories: []string{"items.*.stats.likes"},
				UnstablePaths: []string{"$.json.items[*].stats.likes"}}},
		{"trpc error both sides, same status: compared by status and headers", posts, nil,
			ans(400, `{"error":{"message":"bad"}}`), ans(400, `{"error":{"message":"other"}}`), ans(400, `{"error":{"message":"bad"}}`),
			Outcome{Verdict: VerdictPass}},
	}
	for _, c := range cases {
		got := Score(c.sel, c.masks, c.n1, c.g, c.n2)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
}

// TestScoreAgreesWithServerSelection: the harness's verdict and class for a (Go, Node) pair are what
// the server's comparison (server.CompareSelection, on the bodies the shadow and parity compare: the
// envelope a tRPC result wraps) gives, for every first-wave endpoint. The expected class is also
// pinned as a literal, so a selection that moved in both places at once still fails.
func TestScoreAgreesWithServerSelection(t *testing.T) {
	cases := []struct {
		endpoint, goDoc, nodeDoc, wantClass string
	}{
		{evalcorpus.EndpointAsPosts, `{"json":{"items":[{"postId":11},{"postId":12}]}}`, `{"json":{"items":[{"postId":12},{"postId":11}]}}`, "order"},
		{evalcorpus.EndpointAsPosts, `{"json":{"items":[{"postId":11,"n":1}]}}`, `{"json":{"items":[{"postId":11,"n":2}]}}`, "fields"},
		{evalcorpus.EndpointAsPosts, `{"json":{"items":[{"postId":11}]}}`, `{"json":{"items":[{"postId":11}]}}`, "match"},
		{evalcorpus.EndpointInfinite, `{"json":{"items":[{"id":21},{"id":22}]}}`, `{"json":{"items":[{"id":21},{"id":23}]}}`, "membership"},
		// as-posts would read these items as postless (fields); a flat page reads them by id.
		{evalcorpus.EndpointInfinite, `{"json":{"items":[{"id":21},{"id":22}]}}`, `{"json":{"items":[{"id":22},{"id":21}]}}`, "order"},
		{evalcorpus.EndpointModelGetAll, `{"json":{"items":[{"id":31,"name":"a"}]}}`, `{"json":{"items":[{"id":31,"name":"b"}]}}`, "fields"},
		// An omitted undefined member (feed-go before 0.0.51) against Node's annotated null: both
		// annotate it, decoded the same.
		{evalcorpus.EndpointModelGetAll, `{"json":{"items":[{"id":31}]},"meta":{"values":{"nextCursor":["undefined"]}}}`,
			`{"json":{"items":[{"id":31}],"nextCursor":null},"meta":{"values":{"nextCursor":["undefined"]}}}`, "match"},
		{evalcorpus.EndpointV1ModelsID, `{"error":"No model with id 41"}`, `{"id":41}`, "membership"},
		{evalcorpus.EndpointV1ModelsID, `{"id":41,"name":"x"}`, `{"id":41,"name":"y"}`, "fields"},
		{evalcorpus.EndpointV1ModelsID, `{"id":41,"n":1.0}`, `{"id":41,"n":1}`, "match"},
	}
	seen := map[string]bool{}
	for _, c := range cases {
		seen[c.endpoint] = true
		sel := server.CompareSelection(c.endpoint)
		rep, err := sel.Compare([]byte(c.goDoc), []byte(c.nodeDoc))
		if err != nil {
			t.Fatalf("%s: %v", c.endpoint, err)
		}
		serverClass := sel.Classify(rep, []byte(c.goDoc), []byte(c.nodeDoc))
		if serverClass != c.wantClass {
			t.Fatalf("%s %s: server class %s, want %s", c.endpoint, c.goDoc, serverClass, c.wantClass)
		}
		goBody, nodeBody := c.goDoc, c.nodeDoc
		if isTRPC(c.endpoint) {
			goBody, nodeBody = string(trpcBody(c.goDoc)), string(trpcBody(c.nodeDoc))
		}
		n := ans(200, nodeBody, "Cache-Control", "public, max-age=5")
		g := ans(200, goBody, "Cache-Control", "public, max-age=5")
		got := Score(sel, nil, n, g, n)
		wantVerdict := VerdictBug
		if rep.Match {
			wantVerdict = VerdictPass
		}
		if got.Verdict != wantVerdict {
			t.Errorf("%s %s: verdict %s, want %s", c.endpoint, c.goDoc, got.Verdict, wantVerdict)
		}
		if wantVerdict == VerdictBug && got.ResultClass != serverClass {
			t.Errorf("%s %s: class %s, server %s", c.endpoint, c.goDoc, got.ResultClass, serverClass)
		}
	}
	for _, e := range evalcorpus.Endpoints {
		if !seen[e] {
			t.Errorf("no agreement case for %s", e)
		}
	}
}

func TestApplyMasks(t *testing.T) {
	doc := `{"json":{"items":[{"id":1,"s":{"v":2,"k":3}},{"id":4,"s":{"v":5}}],"n":7},"meta":{"values":{}}}`
	got, err := ApplyMasks([]byte(doc), []string{"$.json.items[*].s.v", "$.json.n", "$.json.absent.x"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"json":{"items":[{"id":1,"s":{"k":3}},{"id":4,"s":{}}]},"meta":{"values":{}}}`
	if !reflect.DeepEqual(decodeEnv(t, string(got)), decodeEnv(t, want)) {
		t.Fatalf("got %s", got)
	}
	got, _ = ApplyMasks([]byte(`{"a":[1,2],"b":1}`), []string{"$.a[*]"})
	if string(got) != `{"a":[],"b":1}` {
		t.Fatalf("array elements: %s", got)
	}
	if _, err := ApplyMasks([]byte(`{}`), []string{"items"}); err == nil {
		t.Fatal("an invalid mask path is an error")
	}
}

func TestProposedMasksAreValidMaskPaths(t *testing.T) {
	sel := server.CompareSelection(evalcorpus.EndpointAsPosts)
	rep, err := sel.Compare([]byte(`{"json":{"items":[{"a-b":1,"c":{"d":1}}],"x":1}}`), []byte(`{"json":{"items":[{"a-b":2,"c":{"d":2}}],"x":2}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := ProposedMasks(true, rep)
	want := []string{"$.json.items[*].c.d", "$.json.x"} // `a-b` cannot be named by a mask
	if !slices.Equal(got, want) {
		t.Fatalf("%v, want %v", got, want)
	}
	for _, p := range got {
		if !evalcorpus.ValidMaskPath(p) {
			t.Errorf("%s is not a mask path", p)
		}
	}
}
