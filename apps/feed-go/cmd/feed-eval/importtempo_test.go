package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// Canaries: values a realistic Tempo row can carry that no case may hold. The input-key ones are the
// credential words' (evalcorpus.credentialWords) in the shapes a client sends them; the line-level
// ones are fields a capture row does not have but a future one could (headers, address, agent).
const (
	canaryToken   = "CANARYTOKEN7781"
	canaryAPIKey  = "CANARYAPIKEY7782"
	canarySession = "CANARYSESSION7783"
	canaryQueryTk = "CANARYQUERYTOKEN7784"
	canaryCookie  = "CANARYCOOKIE7785"
	canaryAuth    = "CANARYAUTH7786"
	canaryAddress = "203.0.113.77"
	canaryAgent   = "CANARYAGENT7787"
	canarySearch  = "CANARYSEARCH7788"
	canaryOwnUser = "CANARYOWNUSER7789"
)

var importCanaries = []string{canaryToken, canaryAPIKey, canarySession, canaryQueryTk, canaryCookie, canaryAuth, canaryAddress,
	canaryAgent, canarySearch, canaryOwnUser}

// tempoRows are synthetic rows in feed-bench's capture format. t is 2026-11-25 12:00:00 UTC.
var tempoRows = strings.Join([]string{
	// 1-5: one as-posts signature (only modelVersionId differs), each with a credential-named key
	// (token); row 1 also has line-level fields the record type does not read.
	`{"t":1795608000000,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6001,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":41.5,"cookie":"__Secure-civitai-token=` + canaryCookie + `","authorization":"Bearer ` + canaryAuth + `","ip":"` + canaryAddress + `","userAgent":"` + canaryAgent + `"}`,
	`{"t":1795608000001,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6002,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":38.0}`,
	`{"t":1795608000002,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6003,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":38.0}`,
	`{"t":1795608000003,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6004,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":38.0}`,
	`{"t":1795608000004,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6005,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":38.0}`,
	// 6: row 2 again, later the same day: the same case.
	`{"t":1795608000005,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6002,\"token\":\"` + canaryToken + `\"}}","authed":false,"durMs":38.0}`,
	// 7: signed in, naming a user: refused (it may be the viewer's own).
	`{"t":1795608000006,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"username\":\"` + canaryOwnUser + `\",\"authed\":true}}","authed":true,"durMs":50.0}`,
	// 8: signed in, naming no user: imported as a member.
	`{"t":1795608000007,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6001,\"authed\":true}}","authed":true,"durMs":50.0}`,
	// 9: two other credential-named keys: a signature of its own.
	`{"t":1795608000008,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"modelVersionId\":6006,\"apiKey\":\"` + canaryAPIKey + `\",\"sessionId\":\"` + canarySession + `\"}}","authed":false}`,
	// 10: model.getAll with a search text: stored as $search.
	`{"endpoint":"model-getall","t":1795608000009,"host":"green.example.test","input":"{\"json\":{\"limit\":20,\"query\":\"` + canarySearch + `\",\"sort\":\"Newest\"}}"}`,
	// 11: REST with a token pair: the pair dropped, its class kept.
	`{"endpoint":"v1-models-id","t":1795608000010,"host":"green.example.test","path":"/api/v1/models/5001","query":"token=` + canaryQueryTk + `&nsfw=true"}`,
	// 12-13: not JSON; an unsupported endpoint.
	`not json`,
	`{"endpoint":"v1-images","host":"green.example.test","query":"limit=1"}`,
}, "\n") + "\n"

var importNow = time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)

func TestBuildTempoCasesStripsSignsAndLimits(t *testing.T) {
	env := parseHostsOrFail(t, "green=green.example.test")
	res, err := buildTempoCases(strings.NewReader(tempoRows), evalcorpus.EndpointAsPosts, env, 3, importNow)
	if err != nil {
		t.Fatal(err)
	}
	if res.bad != 1 || res.unsupported != 1 {
		t.Errorf("bad %d unsupported %d, want 1 and 1", res.bad, res.unsupported)
	}
	ap := res.perEndpoint["as-posts"]
	if ap == nil || *ap != (importCounts{Rows: 9, Imported: 5, KLimited: 2, Duplicate: 1, ViewerRef: 1}) {
		t.Errorf("as-posts counts %+v, want 9 rows, 5 imported (3 token rows, the member, the apiKey row), 2 over K, 1 duplicate, 1 refused", ap)
	}
	if len(res.cases) != 7 {
		t.Fatalf("%d cases, want 7 (5 as-posts, 1 model-getall, 1 v1-models-id)", len(res.cases))
	}
	all, _ := json.Marshal(res.cases)
	var reqs strings.Builder
	for _, c := range res.cases {
		reqs.WriteString(c.Request + "\n" + c.SigText + "\n")
	}
	for _, c := range importCanaries {
		if bytes.Contains(all, []byte(c)) || strings.Contains(reqs.String(), c) {
			t.Errorf("a case holds %q", c)
		}
	}
	// Positive control: what the cases must hold did reach them.
	for _, want := range []string{`\"modelVersionId\":6001`, `\"modelVersionId\":6003`, `\"query\":\"$search\"`, `"query":"nsfw=true"`,
		`"path":"/api/v1/models/5001"`, `"host":"green.example.test"`, `"credential":"query"`, `"class":"user"`} {
		if !strings.Contains(reqs.String(), want) {
			t.Errorf("the cases lack %q", want)
		}
	}
	sigs := map[uint64]int{}
	for _, c := range res.cases {
		if c.Origin != "tempo" || c.Pinned != 0 || c.NodeBody != "" || len(c.NodeHeaders) != 0 || c.ProdResult != "" ||
			c.FirstSeen != "2026-11-26T10:00:00.000Z" || c.LastSeen != "2026-11-26T10:00:00.000Z" {
			t.Errorf("case %+v", c)
		}
		// The stored signature is the hash of the stored shape.
		if evalcorpus.Signature(c.SigText) != evalHex(c.Sig) {
			t.Errorf("case %d: sig %x is not its shape's", c.CaseID, c.Sig)
		}
		// Never a captured case's id: the day is namespaced.
		if c.CaseID == evalcapture.CaseID("2026-11-25", c.Endpoint, evalHex(c.Sig), []byte(c.Request)) {
			t.Errorf("case %d: the id of a captured case", c.CaseID)
		}
		if c.CaseID != evalcapture.CaseID("tempo:2026-11-25", c.Endpoint, evalHex(c.Sig), []byte(c.Request)) {
			t.Errorf("case %d: not CaseID over the tempo day", c.CaseID)
		}
		sigs[c.Sig]++
		var stored evalcapture.StoredRequest
		if err := json.Unmarshal([]byte(c.Request), &stored); err != nil {
			t.Fatal(err)
		}
		if len(stored.Headers) != 1 || stored.Headers["host"] != "green.example.test" {
			t.Errorf("stored headers %v", stored.Headers)
		}
	}
	// Five signatures: the token rows' (3 cases, K), the member's, the apiKey row's, model-getall's,
	// v1-models-id's.
	perSig := []int{}
	for _, n := range sigs {
		perSig = append(perSig, n)
	}
	slices.Sort(perSig)
	if !slices.Equal(perSig, []int{1, 1, 1, 1, 3}) {
		t.Errorf("cases per signature %v, want [1 1 1 1 3]", perSig)
	}
}

// TestBuildTempoCasesKIsTheLimit: K bounds each signature, whatever K is. The token rows are five
// distinct requests of one signature (row 6 repeats row 2: a duplicate once row 2 is in, over K
// when it is not).
func TestBuildTempoCasesKIsTheLimit(t *testing.T) {
	for _, c := range []struct {
		k    int
		want importCounts
	}{
		{1, importCounts{Rows: 9, Imported: 3, KLimited: 5, Duplicate: 0, ViewerRef: 1}},
		{2, importCounts{Rows: 9, Imported: 4, KLimited: 3, Duplicate: 1, ViewerRef: 1}},
		{5, importCounts{Rows: 9, Imported: 7, KLimited: 0, Duplicate: 1, ViewerRef: 1}},
	} {
		res, err := buildTempoCases(strings.NewReader(tempoRows), evalcorpus.EndpointAsPosts, evalcorpus.Env{}, c.k, importNow)
		if err != nil {
			t.Fatal(err)
		}
		if got := *res.perEndpoint["as-posts"]; got != c.want {
			t.Errorf("k=%d: %+v, want %+v", c.k, got, c.want)
		}
	}
}

func evalHex(v uint64) string {
	const digits = "0123456789abcdef"
	b := make([]byte, 16)
	for i := 15; i >= 0; i-- {
		b[i] = digits[v&0xf]
		v >>= 4
	}
	return string(b)
}

// TestImportTempoWritesStrippedRows: the command end to end against a fake ClickHouse: one insert
// into cases, as the harness login, the rows as built, no canary in what was sent.
func TestImportTempoWritesStrippedRows(t *testing.T) {
	var (
		mu     sync.Mutex
		bodies []string
		qs     []string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "eval-user" || p != "eval-pass" || r.Method != http.MethodPost {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		qs = append(qs, r.URL.Query().Get("query")+" db="+r.URL.Query().Get("database"))
		mu.Unlock()
		w.Header().Set("X-ClickHouse-Summary", `{"written_rows":"7"}`)
	}))
	defer srv.Close()
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", srv.URL+"/evaldb")
	t.Setenv("FEED_EVAL_CLICKHOUSE_USER", "eval-user")
	t.Setenv("FEED_EVAL_CLICKHOUSE_PASSWORD", "eval-pass")
	var out, errOut bytes.Buffer
	if code := run([]string{"import-tempo", "--hosts", "green=green.example.test"}, strings.NewReader(tempoRows), &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 || qs[0] != "INSERT INTO cases FORMAT JSONEachRow db=evaldb" {
		t.Fatalf("inserts %v", qs)
	}
	if n := strings.Count(strings.TrimSpace(bodies[0]), "\n") + 1; n != 7 {
		t.Errorf("%d rows sent, want 7", n)
	}
	for _, c := range importCanaries {
		if strings.Contains(bodies[0], c) || strings.Contains(out.String(), c) || strings.Contains(errOut.String(), c) {
			t.Errorf("%q was sent or printed", c)
		}
	}
	if !strings.Contains(out.String(), "written: 7 cases (ClickHouse reported 7 rows)") {
		t.Errorf("output %q", out.String())
	}
	// --dry-run writes nothing and needs no ClickHouse.
	bodies = nil
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", "")
	out.Reset()
	mu.Unlock()
	code := run([]string{"import-tempo", "--dry-run"}, strings.NewReader(tempoRows), &out, &errOut)
	mu.Lock()
	if code != 0 || len(bodies) != 0 || !strings.Contains(out.String(), "dry run: nothing written") {
		t.Errorf("dry run: exit %d, %d inserts, %q", code, len(bodies), out.String())
	}
}
