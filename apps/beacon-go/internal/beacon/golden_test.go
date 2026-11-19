package beacon_test

import (
	"context"
	"testing"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/golden"
)

// TestGolden runs every fixture through the serve path's request construction (FromHTTP over the
// header bytes) and compares the response and the tracker rows with what the Node code produced.
func TestGolden(t *testing.T) {
	fixtures := golden.LoadFixtures(t, golden.Dir)
	// Positive control: the fixture set loaded (a moved directory would otherwise pass vacuously).
	counts := map[string]int{}
	for _, fx := range fixtures {
		counts[fx.Endpoint]++
	}
	if counts[beacon.EndpointPing] < 50 || counts[beacon.EndpointPulse] < 30 {
		t.Fatalf("fixtures loaded: %v", counts)
	}
	served, fellBack := 0, 0
	for _, fx := range fixtures {
		t.Run(fx.Endpoint+"/"+fx.Name, func(t *testing.T) {
			hreq, body := fx.HTTPRequest(t)
			out, err := fx.Engine().Compute(context.Background(), fx.Endpoint, beacon.FromHTTP(hreq, body))
			if fx.Fallback != "" {
				if got := fallback.Reason(err); got != fx.Fallback {
					t.Fatalf("fallback %q (err %v), want %q", got, err, fx.Fallback)
				}
				fellBack++
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			fx.CheckOutcome(t, out)
			served++
		})
	}
	if served < 70 || fellBack < 8 {
		t.Fatalf("served %d, fell back %d: fewer than the fixtures hold", served, fellBack)
	}
}
