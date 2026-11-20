package v1models

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// getImagesForModelVersionCache's appendFn drops, for every viewer, a showcase image the minor content
// rule restricts, before any other showcase filter. The addons here carry no minor exclusion, so the
// rule alone decides: 8002 (minor-flagged, R) is left out; 8001 (PG), 8003 (minor-flagged, PG-13) and
// 8004 (unflagged, R) stay.
func TestServeDetailLeavesOutMinorMatureShowcaseImages(t *testing.T) {
	w := newTestWorld()
	cached := superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)}
	w.entries[KeyImagesForVersion+":6001"] = append(meta("modelVersionId", int64(6001), "images", []any{
		meta("id", int64(8001), "url", "u1", "nsfwLevel", int64(1), "type", "image", "poi", false, "minor", false),
		meta("id", int64(8002), "url", "u2", "nsfwLevel", int64(4), "type", "image", "poi", false, "minor", true),
		meta("id", int64(8003), "url", "u3", "nsfwLevel", int64(2), "type", "image", "poi", false, "minor", true),
		meta("id", int64(8004), "url", "u4", "nsfwLevel", int64(4), "type", "image", "poi", false, "minor", false),
	}), cached)
	for _, id := range []string{"8002", "8003", "8004"} {
		w.entries[KeyTagIDsForImages+":"+id] = append(meta("imageId", int64(0), "tags", []any{int64(1)}), cached)
	}
	d := w.deps(t)
	w.sys.SetString("system:browsing-setting-addons", []byte(`[{"type":"some","nsfwLevels":[1,2,4,8,16],"disablePoi":true,"excludedTagIds":[9901]}]`))
	ans, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001"})
	if err != nil {
		t.Fatalf("serve: %v (%s)", err, reason(err))
	}
	body, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	for _, kept := range []string{`/u1/original=true/8001.jpeg`, `/u3/original=true/8003.jpeg`, `/u4/original=true/8004.jpeg`} {
		if !strings.Contains(string(body), kept) {
			t.Errorf("body lacks %s:\n%s", kept, body)
		}
	}
	if strings.Contains(string(body), `"id":8002`) || strings.Contains(string(body), `/u2/`) {
		t.Errorf("the minor-flagged R image 8002 is served:\n%s", body)
	}
}
