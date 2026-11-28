package hydrate

import (
	"strings"
	"testing"
)

// ownerMediaAllowedT is ownerMediaAllowedSql('t') (src/server/common/image-visibility.ts) with
// OWNER_MEDIA_EXEMPT_BLOCKS (image-block-marker.ts) inlined: written out, not derived from the Go.
const ownerMediaAllowedT = `(CASE WHEN "t"."blockedFor" IS NOT NULL THEN "t"."blockedFor" IN ('AiNotVerified') ELSE "t"."ingestion" <> 'Blocked'::"ImageIngestionStatus" END)`

// OwnerMediaAllowed is an "ownerMediaAllowed" field that is exactly true: false, null or no field
// (an entry cached before Node read it) is not allowed, as in feedThumbnailFields.
func TestThumbnailOwnerMediaAllowed(t *testing.T) {
	for _, c := range []struct {
		m    map[string]any
		want bool
	}{
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true, "ownerMediaAllowed": true}, true},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true, "ownerMediaAllowed": false}, false},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true, "ownerMediaAllowed": nil}, false},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true}, false},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true, "ownerMediaAllowed": "true"}, false},
	} {
		if got := thumbFrom(c.m); got.OwnerMediaAllowed != c.want || got.Servable {
			t.Errorf("%v: ownerMediaAllowed %v servable %v, want %v false", c.m, got.OwnerMediaAllowed, got.Servable, c.want)
		}
	}
}

func TestThumbnailServable(t *testing.T) {
	for _, c := range []struct {
		m    map[string]any
		want bool
	}{
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": false}, true},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": true}, false},
		{map[string]any{"url": "u", "nsfwLevel": 1, "blockMarked": nil}, false},
		{map[string]any{"url": "u", "nsfwLevel": 1}, false},
	} {
		if got := thumbFrom(c.m); got.Servable != c.want || got.URL != "u" {
			t.Errorf("%v: servable %v url %v, want %v", c.m, got.Servable, got.URL, c.want)
		}
	}
	if strings.Count(sqlThumbnailMiss, `"ownerMediaAllowed"`) != 1 {
		t.Fatalf("the miss query must read ownerMediaAllowed once, as a column:\n%s", sqlThumbnailMiss)
	}
	if !strings.Contains(sqlThumbnailMiss, ownerMediaAllowedT+` AS "ownerMediaAllowed"`) {
		t.Fatalf("the miss query lacks ownerMediaAllowedSql('t'):\n%s", sqlThumbnailMiss)
	}
	if !strings.Contains(sqlThumbnailMiss, HasBlockMarkerSQL("t")+` AS "blockMarked"`) {
		t.Fatalf("the miss query lacks the marker column:\n%s", sqlThumbnailMiss)
	}
	if strings.Count(sqlThumbnailMiss, HasBlockMarkerSQL("t")) != 1 {
		t.Fatalf("the marker must be a column only, not a filter:\n%s", sqlThumbnailMiss)
	}
}
