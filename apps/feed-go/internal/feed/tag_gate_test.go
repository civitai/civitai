package feed

import (
	"context"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// ImageTagGate is getImageTagGateIds: the blocked tags' ids, the default addons' excludedTagIds and
// the configured addons' (both lists, whatever the configured one holds); a blocked list that cannot
// be read is the gate's error, as is no list at all.
func TestImageTagGate(t *testing.T) {
	ctx := context.Background()
	r := testkit.NewRedis()
	r.SetString(BlockedTagsKey, []byte(`[{"id":9001,"name":"blocked"}]`))
	configured := []browsing.Addon{{Type: "some", NsfwLevels: []int{browsing.X}, ExcludedTagIDs: []int{9002}}}
	gate := ImageTagGate(&BlockedTags{Cache: r}, func(context.Context) []browsing.Addon { return configured })
	got, err := gate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]bool{9001: true, 9002: true}
	for _, a := range browsing.DefaultAddons {
		for _, id := range a.ExcludedTagIDs {
			want[id] = true
		}
	}
	if len(want) < 4 {
		t.Fatalf("the defaults name %d tags: the control needs some", len(want)-2)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gate %v, want %v", got, want)
	}
	// The answer is the caller's: changing it leaves the blocked list's memo alone.
	got[1] = true
	if again, _ := gate(ctx); again[1] {
		t.Fatal("the gate returned a shared map")
	}

	if _, err := ImageTagGate(&BlockedTags{Cache: testkit.NewRedis()}, nil)(ctx); fallback.Reason(err) != "blocked-tags-miss" {
		t.Fatalf("absent blocked list: %v, want blocked-tags-miss", err)
	}
	if _, err := ImageTagGate(nil, nil)(ctx); err == nil {
		t.Fatal("no blocked list: want an error")
	}
	// No addon source: the defaults still count.
	only, err := ImageTagGate(&BlockedTags{Cache: r}, nil)(ctx)
	if err != nil || only[9002] || !only[9001] || len(only) != len(want)-1 {
		t.Fatalf("no addon source: %v, %v", only, err)
	}
}
