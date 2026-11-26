package api

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// End to end through the handler, the session manager, the Guard and the Exchanger, as main wires
// them: a flood of made-up `civitai_` tokens from one address.

func guarded(s *stack, outcome string) float64 {
	return testutil.ToFloat64(s.m.UserExchangeGuard.WithLabelValues(outcome))
}

// hubAsked is how many exchanges of subjects starting with prefix reached the fake hub, and the
// X-Forwarded-For each carried.
func (s *stack) hubAsked(prefix string) (n int, forwarded map[string]int) {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	forwarded = map[string]int{}
	for i, sub := range s.hub.subjects {
		if strings.HasPrefix(sub, prefix) {
			n++
			forwarded[s.hub.forwarded[i]]++
		}
	}
	return n, forwarded
}

func TestAFloodOfMadeUpHubTokensFromOneAddressIsThrottledBeforeTheHub(t *testing.T) {
	s := newStack(t, true, session.Options{})
	frozen := time.Unix(1_700_000_000, 0)
	s.guard.Now = func() time.Time { return frozen } // no refill during the test
	const attacker, viewer = "198.51.100.7", "203.0.113.5"
	const flood = 3 * exchange.NewTokenBurst
	for i := range flood {
		s.hub.refuse[fmt.Sprintf("civitai_made-up-%03d", i)] = true
	}
	for i := range flood {
		s.getFrom(t, notesPath, fmt.Sprintf("civitai_made-up-%03d", i), attacker)
	}
	n, fwd := s.hubAsked("civitai_made-up-")
	if n != exchange.NewTokenBurst {
		t.Fatalf("🔴 the hub was asked %d exchanges of made-up tokens from one address, want the burst %d", n, exchange.NewTokenBurst)
	}
	// Each exchange that went names the viewer's address, so the hub can key its limit on it.
	if len(fwd) != 1 || fwd[attacker] != n {
		t.Fatalf("X-Forwarded-For sent %v, want %s on every one", fwd, attacker)
	}
	if got := guarded(s, exchange.GuardThrottled); got != flood-exchange.NewTokenBurst {
		t.Fatalf("throttled %v, want %d", got, flood-exchange.NewTokenBurst)
	}

	// Another viewer, at another address, is not held back: their read is the registry's.
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "ALICE")}
	if g := s.getFrom(t, notesPath, "civitai_alice", viewer); g.ans.Source != "registry" || !strings.Contains(g.body, "ALICE") {
		t.Fatalf("another address: %d %s", g.status, g.body)
	}
	// A read the edge named no address for (in-cluster) is not charged to anyone's budget.
	s.getFrom(t, notesPath, "civitai_made-up-no-address", "")
	if n, fwd := s.hubAsked("civitai_made-up-no-address"); n != 1 || fwd[""] != 1 {
		t.Fatalf("no address: asked %d, X-Forwarded-For %v", n, fwd)
	}
}

func TestTheSameMadeUpTokenIsRefusedFromMemoryNotReExchanged(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.hub.refuse["civitai_made-up"] = true
	// Each read names another collection, so no stream's cooldown answers it: only the Guard does.
	for i := range 10 {
		s.getFrom(t, fmt.Sprintf("/v1/apps/todo-app/collections/c%d/records", i), "civitai_made-up", "198.51.100.7")
	}
	if n, _ := s.hubAsked("civitai_made-up"); n != 1 {
		t.Fatalf("🔴 the hub was asked to exchange one refused token %d times, want 1", n)
	}
	if got := guarded(s, exchange.GuardRemembered); got != 9 {
		t.Fatalf("remembered %v, want 9", got)
	}
}

// One host rotating through the addresses of its IPv6 /64 is one budget; the hub is told each viewer's
// own address.
func TestAnIPv6HostRotatingItsAddressesIsThrottledBeforeTheHub(t *testing.T) {
	s := newStack(t, true, session.Options{})
	frozen := time.Unix(1_700_000_000, 0)
	s.guard.Now = func() time.Time { return frozen }
	const flood = 3 * exchange.NewTokenBurst
	for i := range flood {
		s.hub.refuse[fmt.Sprintf("civitai_v6-%03d", i)] = true
	}
	for i := range flood {
		s.getFrom(t, notesPath, fmt.Sprintf("civitai_v6-%03d", i), fmt.Sprintf("2001:db8:7:7::%x", i+1))
	}
	n, fwd := s.hubAsked("civitai_v6-")
	if n != exchange.NewTokenBurst {
		t.Fatalf("🔴 one /64 reached the hub %d times, want the burst %d", n, exchange.NewTokenBurst)
	}
	if len(fwd) != n || fwd["2001:db8:7:7::1"] != 1 {
		t.Fatalf("X-Forwarded-For %v, want each viewer's own address", fwd)
	}
}

// Many viewers behind one address, each with a real token the hub exchanges, are not throttled; the
// address's budget still binds made-up tokens.
func TestManyViewersBehindOneAddressAreNotThrottled(t *testing.T) {
	s := newStack(t, true, session.Options{MaxStreams: 200})
	frozen := time.Unix(1_700_000_000, 0)
	s.guard.Now = func() time.Time { return frozen }
	const shared, viewers = "198.51.100.7", 3 * exchange.NewTokenBurst
	for i := range 2 * exchange.NewTokenBurst {
		s.hub.refuse[fmt.Sprintf("civitai_made-up-%03d", i)] = true
	}
	for i := range viewers {
		s.getFrom(t, notesPath, fmt.Sprintf("civitai_viewer-%03d", i), shared)
	}
	if n, _ := s.hubAsked("civitai_viewer-"); n != viewers || guarded(s, exchange.GuardThrottled) != 0 {
		t.Fatalf("🔴 %d viewers behind one address: %d reached the hub, %v throttled", viewers, n, guarded(s, exchange.GuardThrottled))
	}
	for i := range 2 * exchange.NewTokenBurst {
		s.getFrom(t, notesPath, fmt.Sprintf("civitai_made-up-%03d", i), shared)
	}
	if n, _ := s.hubAsked("civitai_made-up-"); n != exchange.NewTokenBurst {
		t.Fatalf("made-up tokens from the shared address reached the hub %d times, want the burst %d", n, exchange.NewTokenBurst)
	}
}

// The hub's 429 on one viewer's made-up subjects (its per-viewer `token-exchange-miss` limit) is that
// viewer's answer: another viewer's exchange still reaches the hub.
func TestAHubLimitOnOneViewersMadeUpTokensHoldsNoOtherViewer(t *testing.T) {
	s := newStack(t, true, session.Options{})
	s.hub.limited["civitai_made-up"] = exchange.HubMissLimit
	s.getFrom(t, notesPath, "civitai_made-up", "198.51.100.7")
	s.reg.records["civitai_alice"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-a", "ALICE")}
	if g := s.getFrom(t, notesPath, "civitai_alice", "203.0.113.5"); g.ans.Source != "registry" {
		t.Fatalf("🔴 one viewer's 429 held another's exchange: %d %s", g.status, g.body)
	}
	// Control: the hub's per-client budget 429 still holds every exchange.
	s2 := newStack(t, true, session.Options{})
	s2.hub.limited["civitai_busy"] = "oauth.token-exchange"
	s2.getFrom(t, notesPath, "civitai_busy", "198.51.100.7")
	if g := s2.getFrom(t, notesPath, "civitai_alice", "203.0.113.5"); g.ans.Source == "registry" {
		t.Fatalf("the client budget's 429 did not hold: %s", g.body)
	}
	if n, _ := s2.hubAsked("civitai_alice"); n != 0 {
		t.Fatalf("the hub was asked %d times inside the client budget's hold", n)
	}
}
