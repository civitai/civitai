package server

// The Go-first probe (DESIGN.md "Go-first probe"): at the START of a sampled request, before the
// Node app computes its page, the Node sampler posts what Go needs to resolve the same page. Go
// resolves the page ids exactly as serving would and checks, read-only, whether every per-entity
// cache the hydration needs answers them — the cache state a Go-first serve would meet, before
// Node's own fills land. The shadow comparison cannot see it: Node posts its sample only after it
// has answered, by which time it has filled those caches itself.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// ProbePathPrefix is the internal route of the probes: `<prefix><procedure>`.
const ProbePathPrefix = "/internal/probe/"

// Probe results (`result` on feed_go_gofirst_total).
const (
	// ProbeWouldServe: every cache a page needs answered, or missed only where Go answers the miss
	// itself (hydrate.PageCache.Reason ""); a Go-first serve would have answered.
	ProbeWouldServe = "would_serve"
	// ProbeWouldMiss: a cache Go falls back on missed (feed_go_gofirst_miss_total says which).
	ProbeWouldMiss = "would_miss"
	// ProbeUnsupported: Go falls back for a reason that is not a cache miss (an input shape, a
	// bearer token, the request budget, ...): the reason is on feed_go_fallback_total{mode="probe"}.
	ProbeUnsupported = "unsupported"
	// ProbeError: the probe failed (a store error, a panic, a malformed probe).
	ProbeError = "error"
)

// Caches checked before hydration: the fallback reasons a request raises on a miss there, by the
// cache label they are reported under. A miss on these is as much a Go-first miss as a page cache's.
// The per-entity page caches are hydrate.PageCaches (the one enumeration of those).
const (
	CacheSessionUser     = "session-user"
	CacheGallerySettings = "gallery-settings"
)

var preHydrateMissReasons = map[string]string{
	"session-cache-miss":     CacheSessionUser,     // the session user is fetched from the auth hub
	"session-cache-cleared":  CacheSessionUser,     // a cleared entry is refetched the same way
	"gallery-settings-miss":  CacheGallerySettings, // the settings are rebuilt from the database
	"gallery-settings-stale": CacheGallerySettings, // a key from before the SFW hold is rebuilt
}

// probeCaches is every `cache` label value, in report order.
func probeCaches() []string {
	out := make([]string, 0, 2+len(hydrate.PageCaches))
	out = append(out, CacheSessionUser, CacheGallerySettings)
	for _, c := range hydrate.PageCaches {
		out = append(out, c.Name)
	}
	return out
}

// ProbeRequest is what the Node app posts at the start of a sampled request.
type ProbeRequest struct {
	// Input is the raw `input` query parameter, as in ShadowRequest.
	Input string `json:"input"`
	// Headers are the request headers the page depends on, as in ShadowRequest.
	Headers map[string]string `json:"headers"`
	// StartedAt is when Node's route began handling the request, in epoch milliseconds (fractional).
	// 0 = unknown: the lag histograms are not observed.
	StartedAt float64 `json:"startedAt"`
}

// maxProbeBody bounds a probe body: an input and a few headers, never a response.
const maxProbeBody = 1 << 20

// probeSpec is one procedure's probe: the feed_endpoint label it reports under, and how it resolves
// the page ids and checks presence. run must resolve exactly what serving resolves and read only;
// the recorder it is handed stands in for the page hydrator.
type probeSpec struct {
	endpoint string
	run      func(s *Server, ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) error
}

// probes is the registry, by procedure. A ported procedure plugs in with one entry (its endpoint
// label and its run).
var probes = map[string]probeSpec{
	Procedure: {endpoint: EndpointAsPosts, run: (*Server).probeAsPosts},
}

// probeAsPosts resolves an image.getImagesAsPostsInfinite page exactly as compute does — the same
// input, viewer and gates (prepare), the same feed.Serve over the same feed service and replica —
// with the hydrator replaced by the presence recorder and the page-query cache read-only. Its answer
// is discarded unserialized.
func (s *Server) probeAsPosts(ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) error {
	r, err := SyntheticRequest(ctx, ShadowRequest{Input: req.Input, Headers: req.Headers})
	if err != nil {
		return err
	}
	freq, _, err := s.prepare(ctx, r)
	if err != nil {
		return err
	}
	_, err = feed.Serve(ctx, probeDeps(s.Deps, rec), freq)
	return err
}

// probeDeps is d with the page hydrator replaced by rec and the query cache read-only.
func probeDeps(d *feed.Deps, rec *hydrate.PresenceProbe) *feed.Deps {
	pd := *d
	pd.Hydrator = rec
	if d.Cache != nil {
		c := *d.Cache
		c.ReadOnly = true
		pd.Cache = &c
	}
	return &pd
}

// errNoPresence: the deployment's hydrator has no presence check (never in production).
var errNoPresence = errors.New("probe: the page hydrator has no presence check")

// ProbeHandler is the internal probe endpoint, `/internal/probe/<procedure>`. It answers 202 at once
// and probes in the background, as the shadow endpoint does; an unknown procedure is a 404, a full
// probe queue drops the probe.
func (s *Server) ProbeHandler(w http.ResponseWriter, r *http.Request) {
	s.probeHandler(w, r) //nolint:contextcheck // the probe runs after the 202 is written, on the server's background context: it must outlive the request
}

func (s *Server) probeHandler(w http.ResponseWriter, r *http.Request) {
	received := time.Now()
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	spec, ok := probes[strings.TrimPrefix(r.URL.Path, ProbePathPrefix)]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		s.Metrics.GoFirstDropped.WithLabelValues(spec.endpoint).Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.shadows.Add(1)
	s.shadowMu.Unlock()
	started := false
	defer func() {
		if !started {
			s.shadows.Done()
		}
	}()
	select {
	case s.ProbeQueue <- struct{}{}:
	default:
		s.Metrics.GoFirstDropped.WithLabelValues(spec.endpoint).Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	// Counted as a sample admitted: a shadow phase it overlaps is not solo (DESIGN.md §10.1).
	s.shadowStarts.Add(1)
	var req ProbeRequest
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProbeBody))
	if err == nil {
		err = json.Unmarshal(body, &req)
	}
	if err != nil {
		<-s.ProbeQueue
		s.Metrics.GoFirst.WithLabelValues(spec.endpoint, ProbeError).Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	observeLag(s.Metrics.GoFirstReceiptLag, spec.endpoint, received, req.StartedAt)
	w.WriteHeader(http.StatusAccepted)
	started = true
	go func() {
		defer s.shadows.Done()
		defer func() { <-s.ProbeQueue }()
		defer func() {
			if p := recover(); p != nil {
				s.panicked("probe", p, debug.Stack())
			}
		}()
		// Marked as shadow: its feed-service calls carry the shadow headers (feedsvc.WithShadow), so the
		// probe's load stays out of the feed service's live series.
		ctx, cancel := context.WithTimeout(feedsvc.WithShadow(s.background()), shadowSampleTimeout)
		defer cancel()
		s.probe(ctx, spec, req)
	}()
}

// probe runs one probe and records its result.
func (s *Server) probe(ctx context.Context, spec probeSpec, req ProbeRequest) {
	checker, ok := s.Deps.Hydrator.(hydrate.PresenceChecker)
	if !ok {
		s.Metrics.GoFirst.WithLabelValues(spec.endpoint, ProbeError).Inc()
		s.Log.Error("go-first probe", "endpoint", spec.endpoint, "err", errNoPresence)
		return
	}
	rec := &hydrate.PresenceProbe{Checker: checker}
	err := s.within(ctx, "probe", func(ctx context.Context) error { return spec.run(s, ctx, req, rec) })
	if first, pages := rec.FirstCheck(); pages > 0 {
		observeLag(s.Metrics.GoFirstCheckLag, spec.endpoint, first, req.StartedAt)
	}
	result, missed := classifyProbe(err, rec.Misses())
	s.Metrics.GoFirst.WithLabelValues(spec.endpoint, result).Inc()
	for _, c := range missed {
		s.Metrics.GoFirstMiss.WithLabelValues(spec.endpoint, c).Inc()
	}
	if reason := fallback.Reason(err); reason != "" {
		s.Metrics.Fallbacks.WithLabelValues(spec.endpoint, "probe", reason).Inc()
	} else if err != nil {
		s.Log.Warn("go-first probe failed", "endpoint", spec.endpoint, "err", err)
	}
}

// classifyProbe is a probe's result from how its resolution ended and the page misses it recorded,
// and the caches it saw miss (each once, in probeCaches order). A cache with a miss path is listed
// when it missed, but only a cache Go falls back on makes the result would_miss. The misses are
// listed whatever the result: a fallback for another reason can come after a page was checked.
func classifyProbe(err error, misses map[string]int) (string, []string) {
	reason := fallback.Reason(err)
	pre := preHydrateMissReasons[reason]
	var missed []string
	wouldMiss := pre != ""
	for _, name := range probeCaches() {
		if name == pre {
			missed = append(missed, name)
			continue
		}
		if misses[name] == 0 {
			continue
		}
		missed = append(missed, name)
		if c, ok := hydrate.PageCacheNamed(name); ok && c.Reason != "" {
			wouldMiss = true
		}
	}
	switch {
	case err == nil && wouldMiss, pre != "":
		return ProbeWouldMiss, missed
	case err == nil:
		return ProbeWouldServe, missed
	case reason == "panic":
		return ProbeError, missed
	case reason != "":
		return ProbeUnsupported, missed
	default:
		return ProbeError, missed
	}
}

// observeLag records at - startedAt (epoch ms) on h. A negative difference (the two pods' clocks
// disagree by more than the margin) is recorded as 0; DESIGN.md "Go-first probe" reads it with that.
func observeLag(h *prometheus.HistogramVec, endpoint string, at time.Time, startedAtMs float64) {
	if startedAtMs <= 0 {
		return
	}
	lag := float64(at.UnixNano())/1e9 - startedAtMs/1e3
	if lag < 0 {
		lag = 0
	}
	h.WithLabelValues(endpoint).Observe(lag)
}
