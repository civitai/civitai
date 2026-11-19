package metrics

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

func TestContextLabel(t *testing.T) {
	for _, c := range policy.ContextNames {
		if ContextLabel(c) != c {
			t.Errorf("ContextLabel(%q) = %q", c, ContextLabel(c))
		}
	}
	for _, c := range []string{"", "feed", "SITE"} {
		if ContextLabel(c) != InvalidContext {
			t.Errorf("ContextLabel(%q) = %q, want %q", c, ContextLabel(c), InvalidContext)
		}
	}
}

// Endpoints is the ports manifest's label set: it must be exactly the contexts.
func TestEndpointsAreTheContexts(t *testing.T) {
	if len(Endpoints) != len(policy.Contexts) {
		t.Fatalf("Endpoints %v, contexts %v", Endpoints, policy.ContextNames)
	}
	for i, c := range policy.ContextNames {
		if Endpoints[i] != c {
			t.Errorf("Endpoints[%d] = %q, want %q", i, Endpoints[i], c)
		}
	}
}

func TestSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	New(reg)
	// The three fallback series per context (three contexts and `invalid`), and every lookup result.
	if n := testutil.CollectAndCount(reg, "content_policy_decisions_total"); n != 12 {
		t.Fatalf("%d seeded decision series, want 12", n)
	}
	if n := testutil.CollectAndCount(reg, "content_policy_user_lookups_total"); n != len(LookupResults) {
		t.Fatalf("%d seeded lookup series, want %d", n, len(LookupResults))
	}
}
