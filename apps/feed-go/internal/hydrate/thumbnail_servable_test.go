package hydrate

import (
	"strings"
	"testing"
)

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
	if !strings.Contains(sqlThumbnailMiss, HasBlockMarkerSQL("t")+` AS "blockMarked"`) {
		t.Fatalf("the miss query lacks the marker column:\n%s", sqlThumbnailMiss)
	}
	if strings.Count(sqlThumbnailMiss, HasBlockMarkerSQL("t")) != 1 {
		t.Fatalf("the marker must be a column only, not a filter:\n%s", sqlThumbnailMiss)
	}
}
