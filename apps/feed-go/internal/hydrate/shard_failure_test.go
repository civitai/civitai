package hydrate

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// failKeys makes the fake fail exactly these keys with a transport error, as one shard of a cluster
// that is down would, while every other command of the same pipeline answers.
func failKeys(r *testkit.Redis, keys ...string) {
	set := map[string]bool{}
	for _, k := range keys {
		set[k] = true
	}
	r.KeyErr = func(key string) error {
		if set[key] {
			return testkit.ErrDown
		}
		return nil
	}
}

func packedKey(key string, id int) string { return pageNS + key + ":" + strconv.Itoa(id) }

// One key failing inside the shared stage pipeline costs only its own lookup: a fail-open lookup
// (basic users in stage 1, cosmetics in stage 2) reads that id from the replica, and every other
// lookup of the page still answers from the cache exactly as with no failure. Batch.Exec's claim that
// a failure on one shard never masks another lookup's good answers is what this pins.
func TestPageOneFailingKeyCostsOnlyItsLookup(t *testing.T) {
	f := basePageFixture(t)
	s, _, db := f.load()
	healthy, err := s.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if q := db.userQueries(); !reflect.DeepEqual(q, [][]int{{1002}}) {
		t.Fatalf("healthy basic-users replica queries = %v, want [[1002]] (the debounced id)", q)
	}

	t.Run("stage 1: a basic user", func(t *testing.T) {
		s, r, db := f.load()
		failKeys(r, packedKey(KeyBasicUsers, 1001))
		got, err := s.Page(context.Background(), pageRequest())
		if err != nil {
			t.Fatal(err)
		}
		if r.Calls != 2 {
			t.Fatalf("%d pipelines, want 2", r.Calls)
		}
		if q := db.userQueries(); !reflect.DeepEqual(q, [][]int{{1001, 1002}}) {
			t.Fatalf("basic-users replica queries = %v, want [[1001 1002]]: the failed id joins the misses", q)
		}
		if u := got.Basic[1001]; u.Username != "db-user-1001" {
			t.Fatalf("failed user = %+v, want the replica's row", u)
		}
		if !reflect.DeepEqual(got.Basic[1002], healthy.Basic[1002]) || !reflect.DeepEqual(got.Basic[1003], healthy.Basic[1003]) {
			t.Fatal("a basic user on a healthy key changed")
		}
		want := *healthy
		want.Basic = got.Basic
		if !reflect.DeepEqual(*got, want) {
			t.Fatalf("a lookup on healthy keys changed:\n got %#v\nwant %#v", *got, want)
		}
		if q := db.cosmeticQueries(); !reflect.DeepEqual(q, [][]int{{502, 505, 509}}) {
			t.Fatalf("cosmetic replica queries = %v, want the healthy [[502 505 509]]", q)
		}
	})

	t.Run("stage 2: a cosmetic", func(t *testing.T) {
		s, r, db := f.load()
		failKeys(r, packedKey(KeyCosmetics, 501))
		got, err := s.Page(context.Background(), pageRequest())
		if err != nil {
			t.Fatal(err)
		}
		if q := db.cosmeticQueries(); !reflect.DeepEqual(q, [][]int{{501, 502, 505, 509}}) {
			t.Fatalf("cosmetic replica queries = %v, want [[501 502 505 509]]", q)
		}
		if s := pagePlain(t, got.UserCosmetics[1001][0]); !strings.Contains(s, `"name":"c501-db"`) {
			t.Fatalf("user 1001's cosmetic 501 = %s, want the replica's record", s)
		}
		if !reflect.DeepEqual(got.UserCosmetics[1001][1], healthy.UserCosmetics[1001][1]) || !reflect.DeepEqual(got.UserCosmetics[1002], healthy.UserCosmetics[1002]) {
			t.Fatal("a cosmetic on a healthy key changed")
		}
		want := *healthy
		want.UserCosmetics = got.UserCosmetics
		if !reflect.DeepEqual(*got, want) {
			t.Fatalf("a lookup on healthy keys changed:\n got %#v\nwant %#v", *got, want)
		}
	})

	// A lookup with no miss path fails as it does alone, with the same reason through the per-lookup
	// reference.
	for _, c := range []struct {
		name, key, reason string
	}{
		{"stage 1: a tag-id entry", packedKey(KeyTagIDs, 11), "tag-ids-miss"},
		{"stage 1: a frame", packedKey(KeyImageFrames, 12), "image-frame-miss"},
		{"stage 1: a user-cosmetics entry", packedKey(KeyUserCosmetics, 1002), "user-cosmetics-miss"},
		{"stage 1: a metric hash", "metrics:Image:12", "metrics-read-failed"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, r, _ := f.load()
			failKeys(r, c.key)
			_, err := s.Page(context.Background(), pageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("Page err = %v (reason %q), want %q", err, got, c.reason)
			}
			if c.reason == "metrics-read-failed" && !strings.Contains(err.Error(), testkit.ErrDown.Error()) {
				t.Fatalf("Page err = %v, want it to name the transport error", err)
			}
			s, r, _ = f.load()
			failKeys(r, c.key)
			_, err = perLookup(context.Background(), s, pageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("per-lookup err = %v (reason %q), want %q", err, got, c.reason)
			}
		})
	}
}

// v1Fixture is basePageFixture plus the image-resources entries the public endpoint reads.
func v1Fixture(tb testing.TB) *pageFixture {
	tb.Helper()
	f := basePageFixture(tb)
	f.put(tb, KeyImageResources, 11, map[string]any{"imageId": 11, "resources": []any{
		map[string]any{"modelVersionId": 901, "detected": true, "modelType": "Checkpoint", "baseModel": "SDXL 1.0"},
		map[string]any{"modelVersionId": 902, "detected": false, "modelType": "LORA", "baseModel": nil},
	}})
	f.put(tb, KeyImageResources, 12, map[string]any{"notFound": true})
	f.put(tb, KeyImageResources, 13, map[string]any{"imageId": 13, "resources": []any{}})
	f.put(tb, KeyImageResources, 14, map[string]any{"imageId": 14, "resources": []any{
		map[string]any{"modelVersionId": 903, "detected": false, "modelType": "Checkpoint", "baseModel": "Pony"},
	}})
	return f
}

func v1Request() V1PageRequest {
	return V1PageRequest{UserIDs: []int{1001, 1002, 1003, 1001}, ImageIDs: []int{11, 12, 13, 14}, VideoIDs: []int{13, 14}}
}

// v1PerLookup is the public endpoint's hydration before V1Page: four reads one after another.
func v1PerLookup(ctx context.Context, s *Sources, req V1PageRequest) (*V1Page, error) {
	out := &V1Page{}
	var err error
	if out.Basic, err = s.BasicUsers(ctx, req.UserIDs); err != nil {
		return nil, err
	}
	if out.Thumbs, err = s.Thumbnails(ctx, req.VideoIDs); err != nil {
		return nil, err
	}
	if out.Metrics, err = s.ImageMetrics(ctx, req.ImageIDs); err != nil {
		return nil, err
	}
	if out.Resources, err = s.ImageResources(ctx, req.ImageIDs); err != nil {
		return nil, err
	}
	return out, nil
}

// V1Page answers what the four sequential reads answered, in 1 pipeline instead of 4.
func TestV1PageMatchesPerLookupInOnePipeline(t *testing.T) {
	f := v1Fixture(t)
	s, r, _ := f.load()
	got, err := s.V1Page(context.Background(), v1Request())
	if err != nil {
		t.Fatal(err)
	}
	pipelines := r.Calls
	s, r, _ = f.load()
	want, err := v1PerLookup(context.Background(), s, v1Request())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("V1Page differs from the per-lookup answer:\n got %#v\nwant %#v", got, want)
	}
	if pipelines != 1 || r.Calls != 4 {
		t.Fatalf("pipelines: V1Page %d, per-lookup %d; want 1 and 4", pipelines, r.Calls)
	}
	wantRes := map[int][]ImageResource{
		11: {{ModelVersionID: 901, Detected: true, ModelType: "Checkpoint", BaseModel: "SDXL 1.0"}, {ModelVersionID: 902, ModelType: "LORA"}},
		13: {},
		14: {{ModelVersionID: 903, ModelType: "Checkpoint", BaseModel: "Pony"}},
	}
	if !reflect.DeepEqual(got.Resources, wantRes) {
		t.Fatalf("resources = %#v, want %#v", got.Resources, wantRes)
	}
	if got.Basic[1002].Username != "db-user-1002" || got.Thumbs[14].URL != "t14.jpeg" || !reflect.DeepEqual(got.Metrics[11], Metrics{"Like": 3}) {
		t.Fatalf("basic %+v, thumb %+v, metrics %v", got.Basic[1002], got.Thumbs[14], got.Metrics[11])
	}

	// No video: still one pipeline, and no thumbnail read.
	s, r, _ = f.load()
	req := v1Request()
	req.VideoIDs = nil
	got, err = s.V1Page(context.Background(), req)
	if err != nil || r.Calls != 1 || len(got.Thumbs) != 0 || got.Thumbs == nil {
		t.Fatalf("no videos: %d pipelines, thumbs %#v, err %v; want 1, an empty map, nil", r.Calls, got.Thumbs, err)
	}
}

// With several lookups failing, V1Page reports the one the sequential reads reported first.
func TestV1PageReportsTheFirstFailureInReadOrder(t *testing.T) {
	for _, c := range []struct {
		name   string
		change func(*pageFixture)
		reason string
	}{
		{"metrics then resources", func(f *pageFixture) {
			delete(f.hashes, "metrics:Image:13")
			f.del(KeyImageResources, 11)
		}, "metrics-miss"},
		{"resources only", func(f *pageFixture) { f.del(KeyImageResources, 14) }, "image-resources-miss"},
		{"resources shape", func(f *pageFixture) {
			f.strings[packedKey(KeyImageResources, 13)] = packValue(t, map[string]any{"resources": "not-an-array"})
		}, "image-resources-shape"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := v1Fixture(t)
			c.change(f)
			s, _, _ := f.load()
			_, err := s.V1Page(context.Background(), v1Request())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("V1Page err = %v (reason %q), want %q", err, got, c.reason)
			}
			s, _, _ = f.load()
			_, err = v1PerLookup(context.Background(), s, v1Request())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("per-lookup err = %v (reason %q), want %q", err, got, c.reason)
			}
		})
	}
}

// One failing key in V1Page's pipeline costs only its own lookup too.
func TestV1PageOneFailingKey(t *testing.T) {
	f := v1Fixture(t)
	s, _, _ := f.load()
	healthy, err := s.V1Page(context.Background(), v1Request())
	if err != nil {
		t.Fatal(err)
	}
	s, r, db := f.load()
	failKeys(r, packedKey(KeyBasicUsers, 1001))
	got, err := s.V1Page(context.Background(), v1Request())
	if err != nil {
		t.Fatal(err)
	}
	if got.Basic[1001].Username != "db-user-1001" || !reflect.DeepEqual(db.userQueries(), [][]int{{1001, 1002}}) {
		t.Fatalf("failed user = %+v, queries %v; want the replica's row from one query", got.Basic[1001], db.userQueries())
	}
	want := *healthy
	want.Basic = got.Basic
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("a lookup on healthy keys changed:\n got %#v\nwant %#v", *got, want)
	}
	s, r, _ = f.load()
	failKeys(r, packedKey(KeyImageResources, 11))
	if _, err := s.V1Page(context.Background(), v1Request()); fallback.Reason(err) != "image-resources-miss" {
		t.Fatalf("failed resources key: err = %v, want image-resources-miss", err)
	}
}
