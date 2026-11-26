package v1models

import (
	"context"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// getShowcaseImageFilter (blocked-browsing-tags.service.ts): while any tag is excluded, an image is
// shown only when `image.tags != null` and none of its tags is excluded. An image with no tags list
// at all is HIDDEN, not shown. Regression: the filter read a missing `tags` as [] and showed it.
func TestShowcaseFilterHidesAnImageWithNoTagsWhileATagIsExcluded(t *testing.T) {
	shows := (&Deps{}).showcaseFilter(context.Background(), RawInput{ExcludedTagIDs: []int{77}})

	img := func(tags any, set bool) superjson.Object {
		o := superjson.Object{}
		o.Set("id", float64(1))
		if set {
			o.Set("tags", tags)
		}
		return o
	}
	cases := []struct {
		name string
		img  superjson.Object
		want bool
	}{
		{"no tags key", img(nil, false), false},
		{"tags null", img(nil, true), false},
		{"empty tags", img([]any{}, true), true},
		{"unexcluded tag", img([]any{float64(12)}, true), true},
		{"excluded tag", img([]any{float64(77)}, true), false},
	}
	for _, c := range cases {
		if got := shows(c.img); got != c.want {
			t.Errorf("%s: shown = %v, want %v", c.name, got, c.want)
		}
	}
}
