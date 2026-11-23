package hydrate

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The version-showcase cache as the curated-showcase guard reads it. Entries are written as
// getVersionShowcaseCache writes them (a CachedVersionShowcase record plus `cachedAt`); the literal
// expectations follow hasCuratedShowcase (src/server/services/version-showcase.service.ts):
// `rows.length` non-zero is curated, a failed read is curated; and createCachedArray's fetch: an
// entry past the cache's hour (`ttl: CacheTTL.hour`) is rebuilt by the reader that wins the
// revalidate lock, so the cache cannot answer it.

var showcaseNow = time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)

func showcaseEntry(id int, rows ...any) []byte {
	if rows == nil {
		rows = []any{}
	}
	return jspack.Pack(jspack.O("modelVersionId", id, "rows", rows, "community", []any{}, "cachedAt", showcaseNow.Add(-time.Minute)))
}

// showcaseAged is showcaseEntry written age before showcaseNow.
func showcaseAged(id int, age time.Duration, rows ...any) []byte {
	if rows == nil {
		rows = []any{}
	}
	return jspack.Pack(jspack.O("modelVersionId", id, "rows", rows, "community", []any{}, "cachedAt", showcaseNow.Add(-age)))
}

func showcaseRow(imageID int, site string) jspack.Obj {
	return jspack.O("imageId", imageID, "site", site, "source", "Owner", "position", 1, "excluded", false)
}

func TestVersionShowcaseState(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))                           // uncurated
	r.SetString(KeyVersionShowcase+":7102", showcaseEntry(7102, showcaseRow(9001, "com"))) // curated on .com
	r.SetString(KeyVersionShowcase+":7103", showcaseEntry(7103, showcaseRow(9002, "red"))) // curated on .red only
	r.SetString(KeyVersionShowcase+":7104", jspack.Pack(jspack.O("notFound", true)))       // a notFound marker
	r.SetString(KeyVersionShowcase+":7105", jspack.Pack(jspack.O("debounce", true)))       // a bust's marker
	r.SetString(KeyVersionShowcase+":7106", jspack.Pack(jspack.O("modelVersionId", 7106))) // no rows member
	r.SetString(KeyVersionShowcase+":7107", []byte{0xc1})                                  // undecodable
	// Past the hour TTL: the Node reader that wins the revalidate lock rebuilds it from the database.
	r.SetString(KeyVersionShowcase+":7109", showcaseAged(7109, 61*time.Minute))
	r.SetString(KeyVersionShowcase+":7111", showcaseAged(7111, 59*time.Minute))                                                 // inside the hour: fresh
	r.SetString(KeyVersionShowcase+":7112", showcaseAged(7112, 3*time.Hour, showcaseRow(9003, "com")))                          // stale and curated
	r.SetString(KeyVersionShowcase+":7113", jspack.Pack(jspack.O("notFound", true, "cachedAt", showcaseNow.Add(-3*time.Hour)))) // an old notFound marker
	// No cachedAt: `undefined < ttlExpiry` is false in Node, so never stale.
	r.SetString(KeyVersionShowcase+":7114", jspack.Pack(jspack.O("modelVersionId", 7114, "rows", []any{}, "community", []any{})))
	r.KeyErr = func(key string) error {
		if key == KeyVersionShowcase+":7110" {
			return errors.New("shard down")
		}
		return nil
	}
	src := &Sources{Packed: &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}}
	for _, c := range []struct {
		name string
		ids  []int
		want Showcase
	}{
		{"no versions", nil, ShowcaseUncurated},
		{"an empty rows entry", []int{7101}, ShowcaseUncurated},
		{"a stale empty entry", []int{7109}, ShowcaseStale},
		{"an empty entry inside the hour", []int{7111}, ShowcaseUncurated},
		{"stale beside fresh", []int{7101, 7111, 7109}, ShowcaseStale},
		{"a stale curated entry", []int{7112}, ShowcaseCurated},
		{"curated wins over stale", []int{7109, 7102}, ShowcaseCurated},
		{"a miss wins over stale", []int{7109, 7108}, ShowcaseUnknown},
		{"a miss wins over stale, either order", []int{7108, 7109}, ShowcaseUnknown},
		// fetch() serves a notFound marker before it looks at cachedAt.
		{"an old notFound marker", []int{7113}, ShowcaseUncurated},
		{"no cachedAt", []int{7114}, ShowcaseUncurated},
		{"a notFound marker", []int{7104}, ShowcaseUncurated},
		{"curated on .com", []int{7102}, ShowcaseCurated},
		{"curated on the other site only", []int{7103}, ShowcaseCurated},
		{"one curated among uncurated", []int{7101, 7109, 7103}, ShowcaseCurated},
		{"no key", []int{7108}, ShowcaseUnknown},
		{"a debounce marker", []int{7105}, ShowcaseUnknown},
		{"an undecodable value", []int{7107}, ShowcaseUnknown},
		{"uncurated and a miss", []int{7101, 7108}, ShowcaseUnknown},
		{"curated wins over a miss", []int{7108, 7102}, ShowcaseCurated},
		{"no rows member", []int{7106}, ShowcaseCurated},
		{"a failed read", []int{7110}, ShowcaseCurated},
		{"a failed read beside a miss", []int{7108, 7110}, ShowcaseCurated},
	} {
		if got := src.VersionShowcase(context.Background(), c.ids); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// Whatever fails the whole read is curated (a transport failure on every command), and no client at
// all, or no reader, cannot say: unknown.
func TestVersionShowcaseUnreadable(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))
	r.Err = errors.New("cluster down")
	if got := (&Sources{Packed: &PackedReader{Redis: r}}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseCurated {
		t.Errorf("transport failure: %v, want curated", got)
	}
	if got := (&Sources{Packed: &PackedReader{}}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseUnknown {
		t.Errorf("no client: %v, want unknown", got)
	}
	if got := (&Sources{}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseUnknown {
		t.Errorf("no reader: %v, want unknown", got)
	}
}

// State answers only the ids asked about: an entry queued but not asked about does not count, and
// an id asked about but never queued is unknown.
func TestShowcaseReadStateSubset(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))
	r.SetString(KeyVersionShowcase+":7102", showcaseEntry(7102, showcaseRow(9001, "com")))
	p := &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}
	b := NewBatch()
	read := p.QueueShowcases(b, []int{7101, 7102})
	b.Exec(context.Background())
	if got := read.State([]int{7101}); got != ShowcaseUncurated {
		t.Errorf("the uncurated one alone: %v, want uncurated", got)
	}
	if got := read.State([]int{7101, 7102}); got != ShowcaseCurated {
		t.Errorf("both: %v, want curated", got)
	}
	if got := read.State([]int{7103}); got != ShowcaseUnknown {
		t.Errorf("never queued: %v, want unknown", got)
	}
}
