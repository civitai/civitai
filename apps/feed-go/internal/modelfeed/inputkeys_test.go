package modelfeed

import (
	"sort"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Every key of model.getAll's input is read, a fallback, or knowingly ignored, and nothing else is
// listed: the ledger goes red when the schema gains or loses a key.
func TestInputKeyLedger(t *testing.T) {
	seen := map[string]int{}
	for _, list := range [][]string{parsedKeys, unsupportedKeys, ignoredKeys} {
		for _, k := range list {
			seen[k]++
		}
	}
	schema := map[string]bool{}
	for _, k := range modelsSchema.Keys() {
		schema[k] = true
		if seen[k] != 1 {
			t.Errorf("schema key %q is classified %d times, want once", k, seen[k])
		}
	}
	stale := make([]string, 0, len(seen))
	for k := range seen {
		if !schema[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("classified keys the schema does not have: %v", stale)
	}
}

// A key outside the schema falls back, after the unsupported keys (so the reason names the parity gap);
// the tRPC client's own keys do not.
func TestParseUnknownKeyFallsBack(t *testing.T) {
	for raw, want := range map[string]string{
		`{"json":{"limit":10,"someNewFilter":true}}`:                       "input-unknown-key",
		`{"json":{"someNewFilter":null}}`:                                  "input-unknown-key",
		`{"json":{"query":"x","someNewFilter":1}}`:                         "input-query", // the unsupported key wins
		`{"json":{"ids":[],"someNewFilter":1}}`:                            "input-ids",
		`{"json":{"query":"","someNewFilter":1}}`:                          "input-unknown-key", // an empty one does not
		`{"json":{"limit":10,"authed":true,"direction":"forward"}}`:        "",
		`{"json":{"limit":10,"favorites":true,"collectionItemStatus":[]}}`: "", // ignored schema keys
	} {
		_, err := parseJSON(t, raw)
		if got := fallback.Reason(err); got != want || (want == "" && err != nil) {
			t.Errorf("%s: reason %q (err %v), want %q", raw, got, err, want)
		}
	}
}

// The defaults come from the schema (schemas.json), pinned here as the Node schema's literals; the
// limit is the handler's.
func TestParseDefaultsAreTheSchemas(t *testing.T) {
	in, err := parseJSON(t, `{"json":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 100 || in.Sort != "Highest Rated" || in.Period != "AllTime" || in.PeriodMode != "published" {
		t.Fatalf("defaults = limit %d sort %q period %q periodMode %q, want 100, Highest Rated, AllTime, published",
			in.Limit, in.Sort, in.Period, in.PeriodMode)
	}
	if !knownSorts[in.Sort] || in.Sort == SortRecentlyAdded || !knownPeriods[in.Period] {
		t.Fatal("the schema's default sort or period is not one this port serves")
	}
}
