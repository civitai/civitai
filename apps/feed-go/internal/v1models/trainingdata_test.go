package v1models

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The Training Data listing (trainingDataListing in src/server/services/training-data-restricted.service.ts).
// The statement's own refusals (owner legal hold, the placeholder owner, a hold marker, a CSAM report
// naming the owner as its subject or secondary user, a POI / minor / ToS-violation model, a post
// image needing review, blocked or with ingestion Blocked) all arrive here as the row's `restricted`;
// that the embedded statement computes each of them as Node's does is held on Postgres by
// src/server/services/__tests__/feed-go-training-data-listing.parity.test.ts, one case per reason.
// What is decided here is the predicate over the row, the candidates, the host, and the fail-closed
// read, each pinned below with a case that differs if its guard is removed.

// tdRow is a row the statement returns for a Training Data file: clean unless edited.
func tdRow(id int, restricted any) map[string]any {
	return map[string]any{
		"id": int64(id), "virusScanResult": "Success", "nsfwLevel": float64(1), "fullyRated": true,
		"restricted": restricted,
	}
}

const (
	redHost   = "red.example.test"
	greenHost = "site.example.test"
)

// nodeAt is a request on host from a Node that applies this build's rules (its statement hash).
func nodeAt(host string) listingRequest {
	return listingRequest{host: host, sqlHash: TrainingDataSQLHash}
}

// tdDeps answers the training-data statement with rows (or err), recording each read's candidates.
func tdDeps(rows []map[string]any, err error, reads *[][]int) *Deps {
	cols := []string{"id", "virusScanResult", "nsfwLevel", "fullyRated", "restricted"}
	db := &testkit.DB{Routes: []testkit.Route{{Match: `AS restricted`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
		if sql != trainingDataListingSQL {
			return nil, errors.New("not the training data statement")
		}
		ids, _ := args[0].([]int)
		*reads = append(*reads, ids)
		if err != nil {
			return nil, err
		}
		vals := make([][]any, 0, len(rows))
		for _, r := range rows {
			row := make([]any, len(cols))
			for i, c := range cols {
				row[i] = r[c]
			}
			vals = append(vals, row)
		}
		return testkit.NewRows(cols, vals...), nil
	}}}}
	return &Deps{DB: db, Config: Config{RedHosts: []string{redHost, "mirror.red.example.test"}}}
}

func tdFile(id int, typ string) superjson.Object {
	return meta("id", int64(id), "type", typ, "visibility", "Public")
}

// One version (6001) listing Training Data file 1: is file 1 listed on host, given row?
func listedFor(t *testing.T, row map[string]any, host string) bool {
	t.Helper()
	var reads [][]int
	d := tdDeps([]map[string]any{row}, nil, &reads)
	f, err := d.trainingDataListing(context.Background(), []superjson.Object{
		meta("id", int64(6001), "files", []any{tdFile(1, trainingDataType)}),
	}, nodeAt(host))
	if err != nil {
		t.Fatalf("listing: %v (%s)", err, reason(err))
	}
	if len(reads) != 1 || !reflect.DeepEqual(reads[0], []int{6001}) {
		t.Fatalf("reads %v", reads)
	}
	return f.listed(tdFile(1, trainingDataType))
}

func TestTrainingDataListingRefusals(t *testing.T) {
	edit := func(k string, v any) map[string]any {
		r := tdRow(1, false)
		r[k] = v
		return r
	}
	for _, c := range []struct {
		name            string
		row             map[string]any
		listedOnGreen   bool
		listedOnRedHost bool
	}{
		{"clean, rated PG", tdRow(1, false), true, true},
		// `r.restricted !== false`: the statement's restricted owner or content, on any host.
		{"restricted owner or content", tdRow(1, true), false, false},
		{"restricted NULL", tdRow(1, nil), false, false},
		{"restricted absent", func() map[string]any { r := tdRow(1, false); delete(r, "restricted"); return r }(), false, false},
		{"restricted as text", tdRow(1, "false"), false, false},
		// `r.virusScanResult !== ScanResultCode.Success`, on any host.
		{"scan Pending", edit("virusScanResult", "Pending"), false, false},
		{"scan Danger", edit("virusScanResult", "Danger"), false, false},
		{"scan Error", edit("virusScanResult", "Error"), false, false},
		{"scan NULL", edit("virusScanResult", nil), false, false},
		{"scan lowercase", edit("virusScanResult", "success"), false, false},
		{"scan as bytes", edit("virusScanResult", []byte("Success")), true, true},
		// trainingDataServableOnHost: off a red-capable host, a mature or partly rated dataset.
		{"rated R", edit("nsfwLevel", float64(4)), false, true},
		{"rated PG and R", edit("nsfwLevel", float64(5)), false, true},
		{"rated X", edit("nsfwLevel", float64(8)), false, true},
		{"rated PG-13", edit("nsfwLevel", float64(2)), true, true},
		{"rated PG|PG-13", edit("nsfwLevel", float64(3)), true, true},
		{"rated 0", edit("nsfwLevel", float64(0)), true, true},
		{"level a fraction under 4", edit("nsfwLevel", 3.9), true, true},
		{"level -1 (every bit)", edit("nsfwLevel", float64(-1)), false, true},
		{"level wrapping to 1", edit("nsfwLevel", float64(1<<32+1)), true, true},
		{"level wrapping to 4", edit("nsfwLevel", float64(1<<32+4)), false, true},
		{"level as a JSON number", edit("nsfwLevel", json.Number("4")), false, true},
		{"level as text", edit("nsfwLevel", "4"), true, true},
		{"level absent", edit("nsfwLevel", nil), true, true},
		{"level a boolean", edit("nsfwLevel", true), true, true},
		{"partly rated", edit("fullyRated", false), false, true},
		{"fullyRated as text", edit("fullyRated", "false"), true, true},
		{"fullyRated absent", edit("fullyRated", nil), true, true},
	} {
		if got := listedFor(t, c.row, greenHost); got != c.listedOnGreen {
			t.Errorf("%s, not red-capable: listed %v, want %v", c.name, got, c.listedOnGreen)
		}
		if got := listedFor(t, c.row, redHost); got != c.listedOnRedHost {
			t.Errorf("%s, red-capable: listed %v, want %v", c.name, got, c.listedOnRedHost)
		}
	}
}

func TestTrainingDataListingCandidatesAndFiles(t *testing.T) {
	ctx := context.Background()
	versions := []superjson.Object{
		meta("id", int64(6001), "files", []any{tdFile(10, "Model")}),
		// A Private dataset still makes its version a candidate (the list passes every file).
		meta("id", int64(6002), "files", []any{meta("id", int64(20), "type", trainingDataType, "visibility", "Private")}),
		meta("id", int64(6003), "files", []any{tdFile(30, "Model"), tdFile(31, trainingDataType), tdFile(32, trainingDataType)}),
		meta("id", int64(6004)),
		meta("id", int64(6005), "files", nil),
	}
	var reads [][]int
	// Row 31 refused; 32 has no row (a cached body naming a file since gone): listed, as Node lists it.
	// Model file 10 shares a refused row's id: only a Training Data file is ever left out.
	d := tdDeps([]map[string]any{tdRow(31, true), tdRow(10, true), tdRow(20, false)}, nil, &reads)
	f, err := d.trainingDataListing(ctx, versions, nodeAt(greenHost))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reads, [][]int{{6002, 6003}}) {
		t.Errorf("candidates %v, want [[6002 6003]]", reads)
	}
	for file, want := range map[string]bool{"31": false, "32": true, "10": true, "20": true} {
		typ := trainingDataType
		if file == "10" {
			typ = "Model"
		}
		id := map[string]int{"31": 31, "32": 32, "10": 10, "20": 20}[file]
		if got := f.listed(tdFile(id, typ)); got != want {
			t.Errorf("file %s: listed %v, want %v", file, got, want)
		}
	}
	// No candidate: no read, everything listed.
	reads = nil
	f, err = tdDeps(nil, nil, &reads).trainingDataListing(ctx, versions[:1], nodeAt(greenHost))
	if err != nil || f != nil || len(reads) != 0 || !f.listed(tdFile(1, trainingDataType)) {
		t.Errorf("no candidate: %v %v %v", f, err, reads)
	}
	// Fails closed: a read that fails is a fallback, never an answer.
	reads = nil
	if _, err := tdDeps(nil, errors.New("replica down"), &reads).trainingDataListing(ctx, versions, nodeAt(greenHost)); reason(err) != "v1-models-training-data-unread" {
		t.Errorf("read error: %v", err)
	}
	// Shapes the Node code would throw on fall back.
	for _, v := range []superjson.Object{
		meta("id", int64(1), "files", "x"),
		meta("id", int64(1), "files", []any{"x"}),
		meta("id", "x", "files", []any{tdFile(1, trainingDataType)}),
	} {
		if _, err := tdDeps(nil, nil, &reads).trainingDataListing(ctx, []superjson.Object{v}, nodeAt(greenHost)); reason(err) != "v1-models-training-data" {
			t.Errorf("%v: %v", v, err)
		}
	}
	// A row id that is not a number cannot be matched.
	if _, err := tdDeps([]map[string]any{{"id": "x", "restricted": false}}, nil, &reads).trainingDataListing(ctx, versions, nodeAt(greenHost)); reason(err) != "v1-models-training-data" {
		t.Errorf("row id: %v", err)
	}
}

func TestRedCapable(t *testing.T) {
	d := &Deps{Config: Config{RedHosts: []string{redHost, "mirror.red.example.test"}}}
	for host, want := range map[string]bool{
		"red.example.test":        true,
		"RED.Example.Test":        true,
		"mirror.red.example.test": true,
		// isHostForColor compares the whole header: a port is not stripped.
		"red.example.test:443": false,
		"site.example.test":    false,
		"":                     false,
		"example.test":         false,
	} {
		got, err := d.redCapable(host)
		if err != nil || got != want {
			t.Errorf("%q: %v %v, want %v", host, got, err, want)
		}
	}
	if _, err := d.redCapable("rİd.example.test"); reason(err) != "v1-models-host" {
		t.Errorf("non-ASCII host: %v", err)
	}
	d.Config.RedHosts = []string{"rİd.example.test"}
	if _, err := d.redCapable("red.example.test"); reason(err) != "v1-models-host" {
		t.Errorf("non-ASCII red host: %v", err)
	}
	if got, err := (&Deps{}).redCapable(redHost); err != nil || got {
		t.Errorf("no red domain: %v %v", got, err)
	}
}

func TestRedHosts(t *testing.T) {
	for _, c := range []struct {
		primary string
		hosts   []string
		want    []string
	}{
		// buildConfig: no primary, no red domain, whatever the aliases.
		{"", []string{"a.example.test"}, nil},
		{"Red.Example.Test", []string{"Red.Example.Test", " Mirror.Example.Test ", "", "b.example.test"},
			[]string{"red.example.test", "mirror.example.test", "b.example.test"}},
		// The shape main.go passes: config.HostPrimaries["red"] is lowercased, config.Hosts["red"]
		// starts with the raw primary. The primary is listed once.
		{"red.example.test", []string{"RED.Example.Test", "Mirror.Example.Test"},
			[]string{"red.example.test", "mirror.example.test"}},
	} {
		if got := RedHosts(c.primary, c.hosts); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q %v: %v, want %v", c.primary, c.hosts, got, c.want)
		}
	}
}

func TestWithListableTrainingData(t *testing.T) {
	ctx := context.Background()
	var reads [][]int
	d := tdDeps([]map[string]any{tdRow(2, true), tdRow(3, false), tdRow(5, true)}, nil, &reads)
	body := meta("id", int64(5001), "modelVersions", []any{
		meta("id", int64(6001), "files", []any{tdFile(1, "Model"), tdFile(2, trainingDataType), tdFile(3, trainingDataType)}, "x", int64(1)),
		// Every file refused: the version keeps `files: []`.
		meta("id", int64(6002), "files", []any{tdFile(5, trainingDataType)}),
		// No `files` key (removeEmpty dropped an empty list): the version as it is.
		meta("id", int64(6003), "images", []any{}),
	}, "tail", true)
	out, err := d.withListableTrainingData(ctx, body, nodeAt(greenHost))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := superjson.Plain(out)
	want := `{"id":5001,"modelVersions":[{"id":6001,"files":[{"id":1,"type":"Model","visibility":"Public"},` +
		`{"id":3,"type":"Training Data","visibility":"Public"}],"x":1},{"id":6002,"files":[]},{"id":6003,"images":[]}],"tail":true}`
	if string(got) != want {
		t.Errorf("body:\n got  %s\n want %s", got, want)
	}
	if !reflect.DeepEqual(reads, [][]int{{6001, 6002}}) {
		t.Errorf("candidates %v", reads)
	}
	// The input body is not modified (a cached entry is read once per request, but stays the cache's).
	if in, _ := superjson.Plain(body); strings.Contains(string(in), `"files":[]`) {
		t.Errorf("input changed: %s", in)
	}
	// `body.modelVersions ?? []`: none, or null, is an empty list, appended or set in place.
	for _, c := range []struct {
		body superjson.Object
		want string
	}{
		{meta("id", int64(1)), `{"id":1,"modelVersions":[]}`},
		{meta("modelVersions", nil, "id", int64(1)), `{"modelVersions":[],"id":1}`},
	} {
		out, err := d.withListableTrainingData(ctx, c.body, nodeAt(greenHost))
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := superjson.Plain(out); string(got) != c.want {
			t.Errorf("got %s, want %s", got, c.want)
		}
	}
	for _, b := range []superjson.Object{meta("modelVersions", "x"), meta("modelVersions", []any{"x"})} {
		if _, err := d.withListableTrainingData(ctx, b, nodeAt(greenHost)); reason(err) != "v1-models-training-data" {
			t.Errorf("%v: %v", b, err)
		}
	}
}

// The safety property end to end through both routes: a Training Data file the listing refuses is in
// neither body, its listed sibling is (without metadata), and a failed read answers nothing.
func TestServeTrainingDataNeverListsARefusedFile(t *testing.T) {
	files := func(w *testWorld) {
		w.entries[KeyFilesForVersion+":6001"] = append(meta("modelVersionId", int64(6001), "files", []any{
			meta("id", int64(7001), "name", "a.safetensors", "type", "Model", "visibility", "Public", "modelVersionId", int64(6001),
				"hashes", []any{}, "metadata", meta("format", "SafeTensor")),
			meta("id", int64(7002), "name", "refused.zip", "type", trainingDataType, "visibility", "Public", "modelVersionId", int64(6001),
				"hashes", []any{}, "metadata", meta("nsfwLevel", float64(1), "fullyRated", true)),
			meta("id", int64(7003), "name", "listed.zip", "type", trainingDataType, "visibility", "Public", "modelVersionId", int64(6001),
				"hashes", []any{}, "metadata", meta("nsfwLevel", float64(4), "datasetArchive", meta("status", "archived"))),
		}), superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)})
	}
	serve := func(t *testing.T, list bool, host string, rows []map[string]any, tdErr error) (string, error) {
		t.Helper()
		w := newTestWorld()
		files(w)
		w.tdRows, w.tdErr = rows, tdErr
		d := w.deps(t)
		d.Config.RedHosts = []string{redHost}
		var ans *Answer
		var err error
		if list {
			ans, err = ServeList(context.Background(), d, d.Sources, ListRequest{Query: "limit=5", Path: "/api/v1/models", Host: host, TrainingDataSQL: TrainingDataSQLHash})
		} else {
			ans, err = ServeDetail(context.Background(), d, DetailRequest{ID: "5001", Host: host, TrainingDataSQL: TrainingDataSQLHash})
		}
		if err != nil {
			return "", err
		}
		if len(w.tdCandidates) != 1 || !reflect.DeepEqual(w.tdCandidates[0], []int{6001}) {
			t.Errorf("candidates %v", w.tdCandidates)
		}
		body, _ := superjson.Plain(ans.Body)
		return string(body), nil
	}
	rows := []map[string]any{tdRow(7002, true), func() map[string]any { r := tdRow(7003, false); r["nsfwLevel"] = float64(4); return r }()}
	for _, list := range []bool{false, true} {
		// Not red-capable: 7002 refused (restricted), 7003 refused (rated R).
		body, err := serve(t, list, greenHost, rows, nil)
		if err != nil {
			t.Fatalf("list %v: %v (%s)", list, err, reason(err))
		}
		if strings.Contains(body, `"id":7002`) || strings.Contains(body, `"id":7003`) || !strings.Contains(body, `"id":7001`) {
			t.Errorf("list %v, green host: %s", list, body)
		}
		// Red-capable: 7003 listed, with no metadata (its rating and archive keys never shown); 7002 never.
		body, err = serve(t, list, "RED.example.test", rows, nil)
		if err != nil {
			t.Fatalf("list %v: %v", list, err)
		}
		if strings.Contains(body, `"id":7002`) || !strings.Contains(body, `"id":7003`) {
			t.Errorf("list %v, red host: %s", list, body)
		}
		i := strings.Index(body, `"id":7003`)
		if j := strings.Index(body[i:], `"metadata":{}`); j < 0 || strings.Contains(body, "datasetArchive") {
			t.Errorf("list %v: the listed dataset's metadata is not empty: %s", list, body)
		}
		// The read fails: nothing is answered.
		if _, err := serve(t, list, greenHost, rows, errors.New("replica down")); reason(err) != "v1-models-training-data-unread" {
			t.Errorf("list %v, read error: %v", list, err)
		}
	}
}

// The drift guard: a body with a Training Data candidate is answered only for a Node whose statement
// hash is this build's; a missing or different hash falls back before anything is read.
func TestTrainingDataListingDrift(t *testing.T) {
	ctx := context.Background()
	versions := []superjson.Object{meta("id", int64(6001), "files", []any{tdFile(1, trainingDataType)})}
	sum := sha256.Sum256([]byte(trainingDataListingSQL))
	sqlOnly := hex.EncodeToString(sum[:])
	for _, hash := range []string{
		"", "0000", strings.ToUpper(TrainingDataSQLHash), TrainingDataSQLHash + " ",
		// The statement matches but the decision does not: a Node whose predicate changed (its rules
		// version bumped), one that predates the version, and an older version.
		sqlOnly, sqlOnly + ";rules=" + strconv.Itoa(TrainingDataRulesVersion+1), sqlOnly + ";rules=0",
		// The decision matches but the statement does not.
		strings.Repeat("0", 64) + ";rules=" + strconv.Itoa(TrainingDataRulesVersion),
	} {
		var reads [][]int
		_, err := tdDeps([]map[string]any{tdRow(1, false)}, nil, &reads).trainingDataListing(ctx, versions,
			listingRequest{host: greenHost, sqlHash: hash})
		if reason(err) != "v1-models-training-data-drift" || len(reads) != 0 {
			t.Errorf("hash %q: %v, reads %v", hash, err, reads)
		}
	}
	var reads [][]int
	if _, err := tdDeps([]map[string]any{tdRow(1, false)}, nil, &reads).trainingDataListing(ctx, versions, nodeAt(greenHost)); err != nil || len(reads) != 1 {
		t.Errorf("this build's hash: %v, reads %v", err, reads)
	}
	// No candidate: nothing to decide, so no hash is needed.
	if f, err := tdDeps(nil, nil, &reads).trainingDataListing(ctx, []superjson.Object{meta("id", int64(1), "files", []any{tdFile(2, "Model")})},
		listingRequest{host: greenHost}); err != nil || f != nil {
		t.Errorf("no candidate: %v %v", f, err)
	}
	// Through the route: a built body with a dataset, sample without the hash.
	w := newTestWorld()
	w.entries[KeyFilesForVersion+":6001"] = append(meta("modelVersionId", int64(6001), "files", []any{
		meta("id", int64(7001), "name", "a.safetensors", "type", "Model", "visibility", "Public", "metadata", meta()),
		meta("id", int64(7002), "name", "d.zip", "type", trainingDataType, "visibility", "Public", "metadata", meta()),
	}), superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)})
	w.tdRows = []map[string]any{tdRow(7002, false)}
	if _, err := ServeDetail(ctx, w.deps(t), DetailRequest{ID: "5001"}); reason(err) != "v1-models-training-data-drift" {
		t.Errorf("route without the hash: %v", err)
	}
	if len(w.tdCandidates) != 0 {
		t.Errorf("read before the drift check: %v", w.tdCandidates)
	}
	// The value required is the embedded statement's hash and this build's decision version.
	if TrainingDataSQLHash != sqlOnly+";rules="+strconv.Itoa(TrainingDataRulesVersion) {
		t.Errorf("hash %q", TrainingDataSQLHash)
	}
}

// A jsonb value of a Go type pgx's jsonb decoding does not produce is not read as JS would: it falls
// back instead of deciding (fail closed).
func TestTrainingDataUnknownLevelType(t *testing.T) {
	for _, v := range []any{int64(4), int32(1), uint8(1), float32(4), json.Number("x")} {
		var reads [][]int
		r := tdRow(1, false)
		r["nsfwLevel"] = v
		_, err := tdDeps([]map[string]any{r}, nil, &reads).trainingDataListing(context.Background(),
			[]superjson.Object{meta("id", int64(6001), "files", []any{tdFile(1, trainingDataType)})}, nodeAt(greenHost))
		if reason(err) != "v1-models-training-data" {
			t.Errorf("%T %v: %v", v, v, err)
		}
	}
}

// The servability mask is browsing.SFWLevels (Node's sfwBrowsingLevelsFlag, pinned to the Go constants
// by the Node golden test): every PG/PG-13 combination servable, any other bit not.
func TestTrainingDataSFWMask(t *testing.T) {
	for level := 0; level < 64; level++ {
		got, err := trainingDataServableOnHost(float64(level), nil, false)
		want := level&^browsing.SFWLevels == 0
		if err != nil || got != want {
			t.Errorf("level %d: %v %v, want %v", level, got, err, want)
		}
	}
}
