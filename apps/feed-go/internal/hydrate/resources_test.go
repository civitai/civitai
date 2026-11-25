package hydrate

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// resourceRows answers sqlImageResources from literal rows per image, in the order given (the order
// the replica returns them), recording each query's ids; fail answers every query with an error.
type resourceRows struct {
	rows map[int][][]any // imageId -> [imageId, modelVersionId, strength, detected, modelId, modelName, modelType, versionName, baseModel, poi, minor]
	fail bool

	mu    sync.Mutex
	asked [][]int
}

var resourceCols = []string{"imageId", "modelVersionId", "strength", "detected", "modelId", "modelName", "modelType", "versionName", "baseModel", "poi", "minor"}

func (rr *resourceRows) route() testkit.Route {
	return testkit.Route{Match: `FROM "ImageResourceNew" ir && WHERE ir."imageId" = ANY($1::int[])`, Rows: func(args []any) (*testkit.Rows, error) {
		ids, _ := args[0].([]int)
		rr.mu.Lock()
		rr.asked = append(rr.asked, append([]int(nil), ids...))
		rr.mu.Unlock()
		if rr.fail {
			return nil, errors.New("replica down")
		}
		out := testkit.NewRows(resourceCols)
		for _, id := range ids {
			out.Data = append(out.Data, rr.rows[id]...)
		}
		return out, nil
	}}
}

func (rr *resourceRows) queries() [][]int {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	return rr.asked
}

// resourcesMissFixture is v1Fixture with images 11 and 14 missing from the image-resources cache
// (12 a notFound marker, 13 an empty list stay hits). On the replica image 14 has a LORA row before
// its Checkpoint row (the query orders by model version, and the row order is the cached order), and
// image 11 has none.
func resourcesMissFixture(t *testing.T) (*pageFixture, *resourceRows) {
	t.Helper()
	f := v1Fixture(t)
	f.del(KeyImageResources, 11)
	f.del(KeyImageResources, 14)
	rr := &resourceRows{rows: map[int][][]any{
		14: {
			{14, 903, 0.8, true, 77, "a lora", "LORA", "v1", "SDXL 1.0", false, false},
			{14, 905, 1.0, false, 78, "a checkpoint", "Checkpoint", "v2", "Pony", false, false},
		},
	}}
	return f, rr
}

// loadResources is f.load with rr's route ahead of the page replica's, and a MissCompute whose flag
// answer is fromReplica (nil: no reader).
func loadResources(f *pageFixture, rr *resourceRows, fromReplica func() bool) (*Sources, *testkit.Redis, *observed) {
	s, r, db := f.load()
	db.Routes = append([]testkit.Route{rr.route()}, db.Routes...)
	o := &observed{}
	s.Compute = &MissCompute{Observe: o.observe, ImageResourcesFromReplica: fromReplica}
	return s, r, o
}

func flagOff() bool { return true }
func flagOn() bool  { return false }

// With the miss computation on and image-resource-use-write known off, an image-resources miss is
// answered from the replica with the Node lookup's query, its rows in replica order, an image with no
// row absent (as its notFound marker is): one query over every miss, counted under the cache's label.
// The hits are unchanged.
func TestImageResourcesMissComputedFromTheReplica(t *testing.T) {
	f, rr := resourcesMissFixture(t)
	s, _, o := loadResources(f, rr, flagOff)
	got, err := s.V1Page(context.Background(), v1Request())
	if err != nil {
		t.Fatal(err)
	}
	want := map[int][]ImageResource{
		13: {},
		14: {{ModelVersionID: 903, Detected: true, ModelType: "LORA", BaseModel: "SDXL 1.0"}, {ModelVersionID: 905, ModelType: "Checkpoint", BaseModel: "Pony"}},
	}
	if !reflect.DeepEqual(got.Resources, want) {
		t.Fatalf("resources = %#v, want %#v", got.Resources, want)
	}
	if q := rr.queries(); !reflect.DeepEqual(q, [][]int{{11, 14}}) {
		t.Fatalf("queries = %v, want one over the misses [11 14]", q)
	}
	if n := o.get(); !reflect.DeepEqual(n, map[string]int{"image-resources/computed": 2}) {
		t.Fatalf("observed %v, want image-resources/computed 2", n)
	}
	if got := s.MissReason(MissImageResources); got != "" {
		t.Fatalf("MissReason = %q, want \"\" (computed)", got)
	}
	// Positive control on the reader: a page with no miss asks nothing.
	f2 := v1Fixture(t)
	s, _, o = loadResources(f2, rr, flagOff)
	if _, err := s.V1Page(context.Background(), v1Request()); err != nil || len(rr.queries()) != 1 || len(o.get()) != 0 {
		t.Fatalf("all hits: err %v, queries %v, observed %v; want no query", err, rr.queries(), o.get())
	}
}

// Every case the Node lookup would not answer from what this service reads falls back as before
// (`image-resources-miss`), with no query: no flag reader, the flag on or not known, a bust's debounce
// marker, a failed cache read, a missed image carrying the imageResource lag flag (or a failed flag
// read), and no miss computation at all. A failed query is its own reason.
func TestImageResourcesMissFallsBackWhereNodeReadsElsewhere(t *testing.T) {
	for _, c := range []struct {
		name        string
		fromReplica func() bool
		change      func(*pageFixture)
		redis       func(*testkit.Redis)
		noCompute   bool
		reason      string
	}{
		{name: "no flag reader", reason: "image-resources-miss"},
		{name: "flag on or unknown", fromReplica: flagOn, reason: "image-resources-miss"},
		{name: "debounce marker", fromReplica: flagOff, change: func(f *pageFixture) {
			f.put(t, KeyImageResources, 14, map[string]any{"debounce": true})
		}, reason: "image-resources-miss"},
		{name: "failed cache read", fromReplica: flagOff, redis: func(r *testkit.Redis) {
			failKeys(r, packedKey(KeyImageResources, 14))
		}, reason: "image-resources-miss"},
		{name: "lag flag on a missed image", fromReplica: flagOff, redis: func(r *testkit.Redis) {
			r.SetString(pageNS+"lag-helper:imageResource:14", []byte("1"))
		}, reason: "image-resources-miss"},
		{name: "lag flag read fails", fromReplica: flagOff, redis: func(r *testkit.Redis) {
			failKeys(r, pageNS+"lag-helper:imageResource:11")
		}, reason: "image-resources-miss"},
		{name: "no miss computation", fromReplica: flagOff, noCompute: true, reason: "image-resources-miss"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f, rr := resourcesMissFixture(t)
			if c.change != nil {
				c.change(f)
			}
			s, r, o := loadResources(f, rr, c.fromReplica)
			if c.redis != nil {
				c.redis(r)
			}
			if c.noCompute {
				s.Compute = nil
			}
			_, err := s.V1Page(context.Background(), v1Request())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("err = %v (reason %q), want %q", err, got, c.reason)
			}
			if q := rr.queries(); len(q) != 0 {
				t.Fatalf("queried %v, want no query", q)
			}
			if len(o.get()) != 0 {
				t.Fatalf("observed %v, want nothing", o.get())
			}
		})
	}
	// Controls for the two Redis cases: a lag flag on an image that did NOT miss, and an empty flag
	// value (the tracker's Boolean("") is false), are computed.
	for _, val := range []struct {
		key string
		v   string
	}{{pageNS + "lag-helper:imageResource:13", "1"}, {pageNS + "lag-helper:imageResource:14", ""}} {
		f, rr := resourcesMissFixture(t)
		s, r, _ := loadResources(f, rr, flagOff)
		r.SetString(val.key, []byte(val.v))
		if _, err := s.V1Page(context.Background(), v1Request()); err != nil || len(rr.queries()) != 1 {
			t.Fatalf("%s=%q: err %v, queries %v; want the miss computed", val.key, val.v, err, rr.queries())
		}
	}
	// The flag reader decides the probe's classification too.
	for _, c := range []struct {
		fromReplica func() bool
		want        string
	}{{nil, "image-resources-miss"}, {flagOn, "image-resources-miss"}, {flagOff, ""}} {
		s := &Sources{Replica: &testkit.DB{}, Compute: &MissCompute{ImageResourcesFromReplica: c.fromReplica}}
		if got := s.MissReason(MissImageResources); got != c.want {
			t.Errorf("MissReason with flag reader %v = %q, want %q", c.fromReplica != nil, got, c.want)
		}
	}
	if got := (&Sources{}).MissReason(MissImageResources); got != "image-resources-miss" {
		t.Errorf("no computation: MissReason = %q, want image-resources-miss", got)
	}

	// A failed query: its own reason, counted as an error.
	f, rr := resourcesMissFixture(t)
	rr.fail = true
	s, _, o := loadResources(f, rr, flagOff)
	_, err := s.V1Page(context.Background(), v1Request())
	if got := fallback.Reason(err); got != "image-resources-miss-failed" {
		t.Fatalf("failed query: err = %v (reason %q), want image-resources-miss-failed", err, got)
	}
	if n := o.get(); !reflect.DeepEqual(n, map[string]int{"image-resources/error": 2}) {
		t.Fatalf("failed query: observed %v, want image-resources/error 2", n)
	}
}

// Under a Go-first probe (WithPresence) the misses are recorded with their one lookup and answered as
// no entry, without a query and without being counted in Observe; the page is counted. The image meta
// misses likewise (withMeta).
func TestImageResourcesMissUnderAProbe(t *testing.T) {
	f, rr := resourcesMissFixture(t)
	s, _, o := loadResources(f, rr, flagOff)
	p := &PresenceProbe{}
	req := v1Request()
	req.MetaIDs = []int{11, 14} // no meta cached for either: both miss
	got, err := s.V1Page(WithPresence(context.Background(), p), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(rr.queries()) != 0 || len(o.get()) != 0 {
		t.Fatalf("queries %v, observed %v; want none under a probe", rr.queries(), o.get())
	}
	if _, ok := got.Resources[14]; ok {
		t.Fatalf("resources[14] = %v, want absent (no entry)", got.Resources[14])
	}
	if m := p.Misses(); m[MissImageResources] != 2 || m[MissImageMeta] != 2 {
		t.Fatalf("misses %v, want image-resources 2 and image-meta 2", m)
	}
	if r := p.DBReads(); r[MissImageResources] != 1 || r[MissImageMeta] != 1 {
		t.Fatalf("db reads %v, want one lookup each", r)
	}
	if _, pages := p.FirstCheck(); pages != 1 {
		t.Fatalf("pages = %d, want 1", pages)
	}
	// The flag unknown: the probe falls back on the miss, as serving would.
	s, _, _ = loadResources(f, rr, flagOn)
	_, err = s.V1Page(WithPresence(context.Background(), &PresenceProbe{}), v1Request())
	if got := fallback.Reason(err); got != "image-resources-miss" {
		t.Fatalf("flag unknown under a probe: reason %q, want image-resources-miss", got)
	}
}

// The query is the Node lookup's (tables, joins, columns), filtered on the image ids and ordered as
// imageResourcesQuery is, pinned by src/server/redis/__tests__/image-resources.sql.behavior.test.ts.
func TestImageResourcesQueryIsTheNodeLookup(t *testing.T) {
	for _, frag := range []string{
		`FROM "ImageResourceNew" ir`,
		`JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id`,
		`JOIN "Model" m ON mv."modelId" = m.id`,
		`WHERE ir."imageId" = ANY($1::int[])`,
		`ir."imageId", ir."modelVersionId", ir.strength, ir.detected, m.id AS "modelId", m.name AS "modelName", m.type::text AS "modelType", mv.name AS "versionName", mv."baseModel"::text AS "baseModel", m.poi, m.minor`,
	} {
		if !strings.Contains(sqlImageResources, frag) {
			t.Errorf("sqlImageResources lacks %q", frag)
		}
	}
	const orderBy = "\nORDER BY ir.\"imageId\", ir.\"modelVersionId\""
	if !strings.HasSuffix(sqlImageResources, orderBy) || strings.Count(sqlImageResources, "ORDER BY") != 1 {
		t.Errorf("sqlImageResources must end with %q, its one ORDER BY", orderBy)
	}
}
