package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// REGION through the handler (WRITES-DESIGN.md, "Region"): with APP_DATA_FORWARD_REGION on, the
// edge's region headers on a viewer's read go on the private subscription opened for them, as the
// adapter's region headers, so the adapter judges the viewer's region instead of holding everyone
// behind this relay to SFW. Off, none is ever sent. Fails on the commit before it: there is no
// session.Options.Region (the test does not compile), and no subscription carried a region header.

// regionStack is a registry stack with the region forwarded (on) or not, the private manager keyed
// by region as main builds it.
func regionStack(t *testing.T, on bool) *stack {
	t.Helper()
	s := newStack(t, true, session.Options{Region: on})
	s.reg.records["civitai_rhea"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-rhea", "RHEA-5be1")}
	return s
}

// readWith reads notesPath as civitai_rhea with the request headers h (each value its own header line).
func (s *stack) readWith(t *testing.T, h map[string][]string) int {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, notesPath, http.NoBody)
	req.Header.Set("Authorization", "Bearer civitai_rhea")
	for name, vals := range h {
		for _, v := range vals {
			req.Header.Add(name, v)
		}
	}
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	return rec.Code
}

func (s *stack) regionsSeen(tok string) string {
	s.reg.mu.Lock()
	defer s.reg.mu.Unlock()
	return strings.Join(s.reg.regions[tok], " | ")
}

func TestTheViewersRegionGoesOnTheirSubscription(t *testing.T) {
	// Every value distinct, and distinct from the ones another case sends.
	de := map[string][]string{"cf-ipcountry": {"DE"}}
	usny := map[string][]string{"cf-ipcountry": {"US"}, "cf-region-code": {"NY"}}
	uk := map[string][]string{"x-isuk": {"true"}}

	t.Run("on: sent, and a changed region opens its own stream", func(t *testing.T) {
		s := regionStack(t, true)
		for _, h := range []map[string][]string{de, de, usny, uk} {
			if code := s.readWith(t, h); code != http.StatusOK {
				t.Fatalf("read: %d", code)
			}
		}
		// The second DE read is the first one's stream: three subscriptions, one per region.
		if got, want := s.regionsSeen("civitai_rhea"), "DE,, | US,NY, | ,,true"; got != want {
			t.Fatalf("regions on the subscriptions: %q; want %q", got, want)
		}
	})

	t.Run("on: a malformed or repeated region is none", func(t *testing.T) {
		s := regionStack(t, true)
		// Two values (a client appending to the edge's), then one that is not a region value.
		for _, h := range []map[string][]string{
			{"cf-ipcountry": {"FR", "US"}},
			{"cf-ipcountry": {"US"}, "cf-region-code": {"N Y"}},
		} {
			if code := s.readWith(t, h); code != http.StatusOK {
				t.Fatalf("read: %d", code)
			}
		}
		if got, want := s.regionsSeen("civitai_rhea"), ",,"; got != want {
			t.Fatalf("regions on the subscriptions: %q; want one stream with none, %q", got, want)
		}
	})

	t.Run("off: never sent", func(t *testing.T) {
		s := regionStack(t, false)
		for _, h := range []map[string][]string{de, usny} {
			if code := s.readWith(t, h); code != http.StatusOK {
				t.Fatalf("read: %d", code)
			}
		}
		if got, want := s.regionsSeen("civitai_rhea"), ",,"; got != want {
			t.Fatalf("regions on the subscriptions: %q; want one stream with none, %q", got, want)
		}
	})
}
