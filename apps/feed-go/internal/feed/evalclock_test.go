package feed

import (
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
)

// FEED_GO_EVAL_NOW reaches the publish filter: with no Now of its own, ServeV1 reads clock.Now, so an
// image scheduled for 2030 is hidden at a frozen instant before then and served at one after (the wall
// clock is before it, so the wall clock cannot pass this test).
func TestEvalClockReachesV1PublishFilter(t *testing.T) {
	t.Cleanup(clock.Reset)
	scheduled := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		at    time.Time
		shown bool
	}{
		{scheduled.Add(-time.Hour), false},
		{scheduled.Add(time.Hour), true},
	} {
		clock.Freeze(tc.at)
		later := row(11, 101, "image", "img-uuid.png", 1, "")
		later.PublishedAt = &scheduled
		f := newV1Fixture([]RawImage{row(10, 100, "video", "vid-uuid", 1, `{"width":640,"height":360,"duration":45}`), later})
		f.deps.Now = nil
		got, err := serveV1(t, f, "modelVersionId=9&limit=2&sort=Newest", nil)
		if err != nil {
			t.Fatalf("at %v: %v", tc.at, err)
		}
		if !strings.Contains(got, `"id":10,`) {
			t.Fatalf("at %v: the published image is missing: %s", tc.at, got)
		}
		if shown := strings.Contains(got, `"id":11,`); shown != tc.shown {
			t.Fatalf("at %v: scheduled image shown=%v, want %v: %s", tc.at, shown, tc.shown, got)
		}

		// The legacy path (`ids`: no feed call) filters on its own read of the clock.
		legacyLater := legacyRow(13, 100, 13)
		legacyLater.PublishedAt = &scheduled
		f = newV1Fixture([]RawImage{legacyRow(10, 100, 10), legacyLater})
		f.deps.Now = nil
		got, err = serveV1(t, f, "ids=10,13", nil)
		if err != nil {
			t.Fatalf("legacy at %v: %v", tc.at, err)
		}
		if !strings.Contains(got, `"id":10,`) {
			t.Fatalf("legacy at %v: the published image is missing: %s", tc.at, got)
		}
		if shown := strings.Contains(got, `"id":13,`); shown != tc.shown {
			t.Fatalf("legacy at %v: scheduled image shown=%v, want %v: %s", tc.at, shown, tc.shown, got)
		}
	}
}
