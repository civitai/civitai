package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

var allowed = map[string]bool{"site.example": true, "alias.example": true}

func TestAcceptableOrigin(t *testing.T) {
	cases := []struct {
		name            string
		origin, referer string
		want            bool
	}{
		{"origin on the list", "https://site.example", "", true},
		{"origin case-folded", "https://SITE.example", "", true},
		{"referer when no origin", "", "https://alias.example/images?x=1", true},
		{"origin wins over referer", "https://evil.example", "https://site.example/", false},
		{"neither header", "", "", false},
		{"off-list origin", "https://evil.example", "", false},
		{"null origin", "null", "", false},
		{"port mismatch", "https://site.example:8443", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/trpc/"+Procedure, nil)
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if c.referer != "" {
				r.Header.Set("Referer", c.referer)
			}
			if got := AcceptableOrigin(r, allowed); got != c.want {
				t.Fatalf("AcceptableOrigin = %v, want %v", got, c.want)
			}
		})
	}
}

type countingReader struct{ n int }

func (c *countingReader) Read(p []byte) (int, error) {
	c.n++
	return 0, io.EOF
}

func TestShadowHandlerQueueBeforeBody(t *testing.T) {
	s := &Server{
		Metrics:     NewMetrics(prometheus.NewRegistry()),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ShadowQueue: make(chan struct{}, 1),
	}
	// Full queue: dropped with 202, and the body is never read.
	s.ShadowQueue <- struct{}{}
	body := &countingReader{}
	w := httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequest(http.MethodPost, "/internal/shadow/"+Procedure, body))
	if w.Code != http.StatusAccepted || body.n != 0 {
		t.Fatalf("full queue: code=%d body reads=%d, want 202 and 0", w.Code, body.n)
	}
	<-s.ShadowQueue
	// A bad body releases the slot it took.
	w = httptest.NewRecorder()
	s.ShadowHandler(w, httptest.NewRequest(http.MethodPost, "/internal/shadow/"+Procedure, &countingReader{}))
	if w.Code != http.StatusBadRequest || len(s.ShadowQueue) != 0 {
		t.Fatalf("bad body: code=%d queued=%d, want 400 and 0", w.Code, len(s.ShadowQueue))
	}
}

// fallbackCount reads feed_go_fallback_total{mode="serve",reason=<reason>} from the registry.
func fallbackCount(t *testing.T, reg *prometheus.Registry, reason string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_fallback_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			labels := map[string]string{}
			for _, l := range m.GetLabel() {
				labels[l.GetName()] = l.GetValue()
			}
			if labels["mode"] == "serve" && labels["reason"] == reason {
				return m.GetCounter().GetValue()
			}
		}
	}
	return 0
}

func TestServeHTTPHandsOffOriginsTheAppWouldRefuse(t *testing.T) {
	reg := prometheus.NewRegistry()
	proxied := 0
	s := &Server{
		Metrics:        NewMetrics(reg),
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		AllowedOrigins: allowed,
		Fallback:       http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proxied++ }),
	}
	// No Origin/Referer: handed to the app before any compute.
	s.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/trpc/"+Procedure, nil))
	if proxied != 1 || fallbackCount(t, reg, "origin") != 1 {
		t.Fatalf("missing origin: proxied=%d origin-fallbacks=%v, want 1 and 1", proxied, fallbackCount(t, reg, "origin"))
	}
	// Positive control: an allowed origin reaches compute, which falls back for its own reason (a POST).
	r := httptest.NewRequest(http.MethodPost, "/api/trpc/"+Procedure, nil)
	r.Header.Set("Origin", "https://site.example")
	s.ServeHTTP(httptest.NewRecorder(), r)
	if proxied != 2 || fallbackCount(t, reg, "method") != 1 || fallbackCount(t, reg, "origin") != 1 {
		t.Fatalf("allowed origin: proxied=%d method=%v origin=%v, want 2, 1, 1",
			proxied, fallbackCount(t, reg, "method"), fallbackCount(t, reg, "origin"))
	}
}
