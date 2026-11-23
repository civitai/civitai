package feed

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// computeInfinite withholds the public TTL from a signed-out answer to any viewer-scoped input.
func TestInfiniteInputViewerScoped(t *testing.T) {
	for input, want := range map[string]bool{
		`{"limit":10}`:                      false,
		`{"limit":10,"followed":false}`:     false,
		`{"limit":10,"reactions":[]}`:       false,
		`{"limit":10,"pending":false}`:      false,
		`{"limit":10,"userId":7}`:           false,
		`{"limit":10,"reactions":["Like"]}`: true,
		`{"limit":10,"followed":true}`:      true,
		`{"limit":10,"pending":true}`:       true,
	} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", input, fallback.Reason(err), err)
			continue
		}
		if got := in.ViewerScoped(); got != want {
			t.Errorf("ParseInfinite %s: ViewerScoped() = %v, want %v", input, got, want)
		}
	}
}
