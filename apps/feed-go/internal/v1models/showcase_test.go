package v1models

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The curated-showcase guard on both model routes (DESIGN.md §16.9). The world's one version, 6001,
// has an uncurated entry (newTestWorld); the cases edit it.

const showcaseKey6001 = hydrate.KeyVersionShowcase + ":6001"

// curatedRow is one ModelVersionShowcaseItem row as the cache holds it.
func curatedRow(imageID int64, site string) superjson.Object {
	return meta("imageId", imageID, "site", site, "source", "Owner", "position", int64(1), "excluded", false)
}

func showcaseOf(rows ...any) superjson.Object {
	if rows == nil {
		rows = []any{}
	}
	return meta("modelVersionId", int64(6001), "rows", rows, "community", []any{}, "cachedAt", testNow.Add(-time.Minute))
}

// showcaseAged is showcaseOf written age before testNow.
func showcaseAged(age time.Duration, rows ...any) superjson.Object {
	return append(omit(showcaseOf(rows...), "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-age)})
}

// serveBoth answers the world on `[id]` and on the list.
func serveBoth(t *testing.T, edit func(*testWorld), after func(*testWorld)) (detail, list []byte, detailErr, listErr error) {
	t.Helper()
	run := func(serve func(d *Deps) (*Answer, error)) ([]byte, error) {
		w := newTestWorld()
		w.usernames["artist_one"] = 1001
		if edit != nil {
			edit(w)
		}
		d := w.deps(t)
		if after != nil {
			after(w)
		}
		ans, err := serve(d)
		if err != nil {
			return nil, err
		}
		body, err := superjson.Plain(ans.Body)
		if err != nil {
			t.Fatal(err)
		}
		return body, nil
	}
	detail, detailErr = run(func(d *Deps) (*Answer, error) {
		return ServeDetail(context.Background(), d, DetailRequest{ID: "5001", TrainingDataSQL: TrainingDataSQLHash})
	})
	list, listErr = run(func(d *Deps) (*Answer, error) {
		return ServeList(context.Background(), d, d.Sources, ListRequest{Query: "username=artist_one", Path: "/api/v1/models", Host: "site.example.test"})
	})
	return
}

func TestCuratedShowcaseGuardServesUncurated(t *testing.T) {
	const image = `"url":"https://image.example.test/u1/original=true/8001.jpeg"`
	for _, c := range []struct {
		name string
		edit func(*testWorld)
	}{
		{"an empty rows entry", nil},
		// Inside the cache's hour Node serves the entry as it is, so its rows decide.
		{"an empty entry inside the hour", func(w *testWorld) { w.entries[showcaseKey6001] = showcaseAged(59 * time.Minute) }},
	} {
		detail, list, dErr, lErr := serveBoth(t, c.edit, nil)
		if dErr != nil || lErr != nil {
			t.Fatalf("%s: detail %v (%s), list %v (%s)", c.name, dErr, reason(dErr), lErr, reason(lErr))
		}
		// The version's own image, as without a showcase.
		if !strings.Contains(string(detail), image) || !strings.Contains(string(list), `"images":[{"id":8001,`+image) {
			t.Errorf("%s: the own image is not served:\n%s\n%s", c.name, detail, list)
		}
	}
}

func TestCuratedShowcaseGuardFallsBack(t *testing.T) {
	for _, c := range []struct {
		name   string
		edit   func(*testWorld)
		after  func(*testWorld)
		reason string
	}{
		{"curated on .com", func(w *testWorld) { w.entries[showcaseKey6001] = showcaseOf(curatedRow(8001, "com")) }, nil, "v1-models-curated-showcase"},
		// Curated on the other site only: Node serves that curation on this one too (curatedSiteFor).
		{"curated on .red only", func(w *testWorld) { w.entries[showcaseKey6001] = showcaseOf(curatedRow(8002, "red")) }, nil, "v1-models-curated-showcase"},
		// Excluding an image is curation too: the version's list is no longer its own.
		{"an excluded row", func(w *testWorld) {
			w.entries[showcaseKey6001] = showcaseOf(meta("imageId", int64(8001), "site", "com", "source", "Owner", "position", nil, "excluded", true))
		}, nil, "v1-models-curated-showcase"},
		{"the read fails", nil, func(w *testWorld) {
			w.cache.KeyErr = func(key string) error {
				if key == showcaseKey6001 {
					return errors.New("shard down")
				}
				return nil
			}
		}, "v1-models-curated-showcase"},
		{"no entry", func(w *testWorld) { w.entries[showcaseKey6001] = nil }, nil, "v1-models-showcase-miss"},
		// Past the cache's hour the Node reader that wins the revalidate lock rebuilds the entry from
		// the database: after a curation whose refresh failed, the curated list.
		{"a stale empty entry", func(w *testWorld) { w.entries[showcaseKey6001] = showcaseAged(61 * time.Minute) }, nil, "v1-models-showcase-stale"},
		{"a stale curated entry", func(w *testWorld) { w.entries[showcaseKey6001] = showcaseAged(3*time.Hour, curatedRow(8001, "com")) }, nil, "v1-models-curated-showcase"},
		{"a bust's debounce marker", func(w *testWorld) { w.entries[showcaseKey6001] = meta("debounce", true) }, nil, "v1-models-showcase-miss"},
	} {
		_, _, dErr, lErr := serveBoth(t, c.edit, c.after)
		if reason(dErr) != c.reason || reason(lErr) != c.reason {
			t.Errorf("%s: detail %q (%v), list %q (%v), want %q", c.name, reason(dErr), dErr, reason(lErr), lErr, c.reason)
		}
	}
}

// A version whose images entry is a notFound marker is not in Node's images answer, so
// withCuratedShowcases never reads its showcase: no entry for it is no fallback.
func TestCuratedShowcaseGuardSkipsVersionsWithoutImages(t *testing.T) {
	detail, list, dErr, lErr := serveBoth(t, func(w *testWorld) {
		w.entries[KeyImagesForVersion+":6001"] = meta("notFound", true)
		w.entries[showcaseKey6001] = nil
	}, nil)
	if dErr != nil || lErr != nil {
		t.Fatalf("detail %v (%s), list %v (%s)", dErr, reason(dErr), lErr, reason(lErr))
	}
	if strings.Contains(string(detail), "8001") || strings.Contains(string(list), "8001") {
		t.Errorf("an image was served for a version with none:\n%s\n%s", detail, list)
	}
}
