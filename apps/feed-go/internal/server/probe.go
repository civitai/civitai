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
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

// ProbePathPrefix is the internal route of the probes: `<prefix><procedure>`.
const ProbePathPrefix = "/internal/probe/"

// Probe results (`result` on feed_go_gofirst_total).
const (
	// ProbeWouldServe: every cache a page needs answered, or missed (or raced) only where Go answers
	// the miss itself (hydrate.PageCache.Reason ""); a Go-first serve would have answered.
	ProbeWouldServe = "would_serve"
	// ProbeWouldMiss: a cache Go falls back on missed (feed_go_gofirst_miss_total says which).
	ProbeWouldMiss = "would_miss"
	// ProbeUnsupported: Go falls back for a reason that is not a cache miss (an input shape, a
	// bearer token, the request budget, ...): the reason is on feed_go_fallback_total{mode="probe"}.
	ProbeUnsupported = "unsupported"
	// ProbeError: the probe failed (a store error, a panic, a malformed probe).
	ProbeError = "error"
	// ProbeRaced: every cache answered (or missed only where Go answers the miss itself), but an entry
	// of a cache Go falls back on was filled at or after the request began (RaceSkewMargin before its
	// start): most likely by the Node request this probe races, so a Go-first serve would have found
	// it missing and fallen back. A raced entry on a cache Go answers itself does not make it raced
	// (a miss there is served too; its lookup is costed instead). Not would_serve;
	// feed_go_gofirst_raced_total says which cache, for every raced cache.
	ProbeRaced = "raced"
)

// RaceSkewMargin widens the race threshold below the request's start: an entry filled from then on
// counts as raced. It covers the clock difference between the Node pod that stamped `startedAt` and
// the one that stamped the entry, and a fill by a concurrent request for the same ids just before
// (which a Go-first serve could have missed too). Wider is more conservative: more raced entries, so
// more database reads counted for the caches Go answers itself, and more `raced` results (on the
// caches Go falls back on only).
const RaceSkewMargin = 100 * time.Millisecond

// Caches checked before hydration: the fallback reasons a request raises on a miss there, by the
// cache label they are reported under. A miss on these is as much a Go-first miss as a page cache's.
// The per-entity page caches are hydrate.PageCaches (the one enumeration of those).
const (
	CacheSessionUser     = "session-user"
	CacheGallerySettings = "gallery-settings"
	CacheBlockedTags     = "blocked-tags" // image.getInfinite only
	// CacheUserFollows is the viewer's follow list (image.getInfinite with `followed`): read before
	// the page, and a miss on it falls back without the miss computation (hydrate.MissUserFollows).
	CacheUserFollows = hydrate.MissUserFollows
	// CacheNewCreators is the "new & upcoming" board (image.getInfinite with `newCreators`): read
	// before the page; a missing or expired entry falls back (Node rebuilds or refreshes it).
	CacheNewCreators = "new-creators"
)

// model.getAll's caches (internal/hydrate/models.go, official.go). Its probe runs the serving path
// itself and reports the cache its fallback names; a miss Go computes (the model data and tags, the
// model frames and decorations, the version showcases, the official models: hydrate.MissCaches) is
// recorded instead (hydrate.WithPresence).
const (
	CacheModelData          = hydrate.MissModelData
	CacheModelTags          = hydrate.MissModelTags
	CacheModelFrames        = hydrate.MissModelFrames
	CacheModelDecorations   = hydrate.MissModelDecorations
	CacheVersionImages      = hydrate.MissVersionImages
	CacheOfficialModels     = hydrate.MissOfficialModels
	CacheCreatorMemberships = "creator-memberships"
)

// GET /api/v1/images's caches (internal/hydrate/v1page.go) beyond the page caches it shares: its probe
// runs the serving path itself, as model.getAll's does; a miss Go computes (the image resources while
// the Node lookup reads the replica, the image meta, the metric hashes with a ClickHouse reader) is
// recorded instead (hydrate.WithPresence), and one it falls back on is reported by its reason.
const (
	CacheImageResources = hydrate.MissImageResources
	CacheImageMeta      = hydrate.MissImageMeta
)

var preHydrateMissReasons = map[string]string{
	"session-cache-miss":     CacheSessionUser,     // the session user is fetched from the auth hub
	"session-cache-cleared":  CacheSessionUser,     // a cleared entry is refetched the same way
	"gallery-settings-miss":  CacheGallerySettings, // the settings are rebuilt from the database
	"gallery-settings-stale": CacheGallerySettings, // a key from before the SFW hold is rebuilt
	"blocked-tags-miss":      CacheBlockedTags,     // the blocked-tag list is rebuilt from the database
	"blocked-tags-stale":     CacheBlockedTags,     // a value Node would replace
	"user-follows-miss":      CacheUserFollows,     // the follow list is looked up (without the miss computation)
	"new-creators-miss":      CacheNewCreators,     // the board is read from the database
	"new-creators-stale":     CacheNewCreators,     // an expired board is refreshed
	// model.getAll's hydration falls back on each of these cache misses (on a model data, model tags,
	// frame, decoration, showcase or official-models miss only without the miss computation).
	"official-models-miss":  CacheOfficialModels,
	"model-data-miss":       CacheModelData,
	"model-tags-miss":       CacheModelTags,
	"model-frame-miss":      CacheModelFrames,
	"model-decoration-miss": CacheModelDecorations,
	"model-images-miss":     CacheVersionImages,
	"membership-miss":       CacheCreatorMemberships,
	// GET /api/v1/images falls back on these without their miss computation (the image resources also
	// while the Node lookup reads the primary, or for a miss it would not write back).
	"image-resources-miss": CacheImageResources,
	"image-meta-miss":      CacheImageMeta,
}

// fallbackMissCache is the cache a fallback reason is a miss on: a pre-hydration or model cache, or
// a page cache whose miss falls back (PageCaches' Reason: model.getAll falls back on a user-cosmetics
// miss); "" for any other reason.
func fallbackMissCache(reason string) string {
	if reason == "" {
		return ""
	}
	if c := preHydrateMissReasons[reason]; c != "" {
		return c
	}
	for _, c := range hydrate.PageCaches {
		if c.Reason == reason {
			return c.Name
		}
	}
	return ""
}

// probeCaches is every `cache` label value, in report order.
func probeCaches() []string {
	out := make([]string, 0, 12+len(hydrate.PageCaches))
	out = append(out, CacheSessionUser, CacheGallerySettings, CacheBlockedTags, CacheUserFollows, CacheNewCreators)
	for _, c := range hydrate.PageCaches {
		out = append(out, c.Name)
	}
	return append(out, CacheModelData, CacheModelTags, CacheModelFrames, CacheModelDecorations,
		CacheVersionImages, CacheOfficialModels, CacheCreatorMemberships, CacheImageResources, CacheImageMeta)
}

// ProbeRequest is what the Node app posts at the start of a sampled request.
type ProbeRequest struct {
	// Input is the raw `input` query parameter, or a REST request's raw query string, as in
	// ShadowRequest.
	Input string `json:"input"`
	// Path is a REST request's path, as in ShadowRequest (unused for tRPC).
	Path string `json:"path,omitempty"`
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
// the recorder it is handed stands in for the page hydrator. run also returns the request's viewer
// class (feedViewerClass, as the endpoint's compute reports it) once the viewer is resolved, and ""
// when the probe ended before that (or the endpoint reports none): `viewer` on feed_go_gofirst_total,
// GoFirstViewerUnknown for "".
type probeSpec struct {
	endpoint string
	run      func(s *Server, ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) (string, error)
}

// GoFirstViewerUnknown is the `viewer` of a go-first probe whose viewer class is not known: one that
// ended before its viewer was resolved (a malformed probe, an input or request fallback taken before
// the session is read, a session-cache miss), or a GET /api/v1/images probe (an endpoint that reports
// no viewer class). Every other probe reports its class, one of FeedViewerClasses.
const GoFirstViewerUnknown = "unknown"

// GoFirstViewers is every `viewer` value of feed_go_gofirst_total an endpoint can report, in a fixed
// order: FeedViewerClasses and GoFirstViewerUnknown on the tRPC feeds (FeedViewerEndpoints), only
// GoFirstViewerUnknown on the others.
func GoFirstViewers(endpoint string) []string {
	if !isFeedViewerEndpoint(endpoint) {
		return []string{GoFirstViewerUnknown}
	}
	return append(append([]string(nil), FeedViewerClasses...), GoFirstViewerUnknown)
}

// goFirstViewer is the `viewer` label of a probe's viewer class ("" = unknown).
func goFirstViewer(class string) string {
	if class == "" {
		return GoFirstViewerUnknown
	}
	return class
}

// ProbeEndpoints are the feed_endpoint labels the registered probes report under.
var ProbeEndpoints = []string{EndpointAsPosts, EndpointInfinite, EndpointModelGetAll, EndpointV1Images}

// ProbeV1Images is the probe registry's key for `GET /api/v1/images`: its probe path is
// `/internal/probe/api/v1/images`.
const ProbeV1Images = "api/v1/images"

// probes is the registry, by procedure (or REST path without its leading slash). A ported endpoint
// plugs in with one entry (its endpoint label and its run); ProbeEndpoints lists the labels for
// seeding.
var probes = map[string]probeSpec{
	Procedure:         {endpoint: EndpointAsPosts, run: (*Server).probeAsPosts},
	ProcedureInfinite: {endpoint: EndpointInfinite, run: (*Server).probeInfinite},
	// model.getAll: every cache miss falls back, so the serving path itself is the probe.
	ProcedureModelGetAll: {endpoint: EndpointModelGetAll, run: (*Server).probeModelGetAll},
	// GET /api/v1/images: as model.getAll, the serving path itself is the probe.
	ProbeV1Images: {endpoint: EndpointV1Images, run: (*Server).probeV1Images},
}

// probeAsPosts resolves an image.getImagesAsPostsInfinite page exactly as compute does — the same
// input, viewer and gates (prepare), the same feed.Serve over the same feed service and replica —
// with the hydrator replaced by the presence recorder and the page-query cache read-only. Its answer
// is discarded unserialized.
func (s *Server) probeAsPosts(ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) (string, error) {
	r, err := SyntheticRequest(ctx, ShadowRequest{Input: req.Input, Headers: req.Headers})
	if err != nil {
		return "", err
	}
	freq, user, err := s.prepareViewer(ctx, r)
	if err != nil {
		return "", err
	}
	viewer := feedViewerClass(user, false) // as compute reports it
	_, err = feed.Serve(ctx, probeDeps(s.Deps, rec), freq)
	return viewer, err
}

// probeInfinite is probeAsPosts for image.getInfinite: computeInfinite's steps (prepareInfiniteViewer,
// feed.ServeInfinite) over the same deps with the same two swaps.
func (s *Server) probeInfinite(ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) (string, error) {
	r, err := SyntheticInfiniteRequest(ctx, ShadowRequest{Input: req.Input, Headers: req.Headers})
	if err != nil {
		return "", err
	}
	ireq, user, crawler, err := s.prepareInfiniteViewer(ctx, r)
	if err != nil {
		return "", err
	}
	viewer := feedViewerClass(user, crawler) // as computeInfinite reports it
	d := *s.Infinite
	d.Deps = probeDeps(s.Infinite.Deps, rec)
	_, err = feed.ServeInfinite(ctx, &d, ireq)
	return viewer, err
}

// probeModelGetAll runs model.getAll's serving path under hydrate.WithPresence(rec): misses Go
// computes are recorded on rec and never looked up, except the version showcases (read on the
// replica: a model without images is dropped); any other cache miss falls back, and its reason is the
// presence answer. Replica reads are not counted.
func (s *Server) probeModelGetAll(ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) (string, error) {
	ctx = hydrate.WithPresence(ctx, rec)
	r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: req.Input, Headers: req.Headers})
	if err != nil {
		return "", err
	}
	mreq, user, err := s.prepareModelGetAllViewer(ctx, r)
	if err != nil {
		return "", err
	}
	viewer := feedViewerClass(user, false) // as computeModelGetAll reports it
	_, err = modelfeed.Serve(ctx, s.Models, mreq)
	return viewer, err
}

// probeV1Images runs `GET /api/v1/images`'s serving compute (v1ImagesCompute(true): the serve-only
// checks, a session handed back, the port, the body and headers) under hydrate.WithPresence(rec):
// misses Go computes are recorded on rec and never looked up; any other cache miss falls back, and its
// reason is the presence answer. The feed service is asked for the page as serving asks (marked as
// shadow traffic), and the replica reads for misses Go answers from the replica (basic users,
// thumbnails, the gallery hold's lookups) run and are not counted. Its answer is discarded. The
// endpoint reports no viewer class (GoFirstViewerUnknown).
func (s *Server) probeV1Images(ctx context.Context, req ProbeRequest, rec *hydrate.PresenceProbe) (string, error) {
	ctx = hydrate.WithPresence(ctx, rec)
	r, err := SyntheticV1Request(ctx, ShadowRequest{Input: req.Input, Path: req.Path, Headers: req.Headers})
	if err != nil {
		return "", err
	}
	c, err := s.v1ImagesCompute(true)(ctx, r)
	c.release()
	return "", err
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
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	spec, ok := probes[strings.TrimPrefix(r.URL.Path, ProbePathPrefix)]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	withProfileLabels(r.Context(), spec.endpoint, "probe", func(ctx context.Context) {
		s.probeHandlerLabelled(w, r.WithContext(ctx), spec) //nolint:contextcheck // the background work runs on the server's background context after the 202 is written: it must outlive the request
	})
}

// probeHandlerLabelled is probeHandler under the probe's profile labels (withProfileLabels); its
// background goroutine runs the probe under them too.
func (s *Server) probeHandlerLabelled(w http.ResponseWriter, r *http.Request, spec probeSpec) {
	// The probe's span (as the shadow sample's): ends with the probe, or here when it is not run.
	_, span := s.startSpan(r.Context(), r.Header, "probe", spec.endpoint)
	spanHandedOff := false
	defer func() {
		if !spanHandedOff {
			span.End()
		}
	}()
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
		s.Metrics.GoFirst.WithLabelValues(spec.endpoint, ProbeError, GoFirstViewerUnknown).Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	started = true
	spanHandedOff = true
	go func() { //nolint:contextcheck // runs after the 202 on the server's background context (Close cancels it): it must outlive the request
		defer s.shadows.Done()
		defer func() { <-s.ProbeQueue }()
		defer func() {
			if p := recover(); p != nil {
				s.panicked("probe", p, debug.Stack())
			}
		}()
		defer span.End()
		// Marked as shadow: its feed-service calls carry the shadow headers (feedsvc.WithShadow), so the
		// probe's load stays out of the feed service's live series.
		ctx, cancel := context.WithTimeout(feedsvc.WithShadow(s.background()), shadowSampleTimeout)
		defer cancel()
		if s.Tracer != nil {
			ctx = trace.ContextWithSpan(ctx, span)
		}
		withProfileLabels(ctx, spec.endpoint, "probe", func(ctx context.Context) { s.probe(ctx, spec, req) })
	}()
}

// probe runs one probe and records its result.
func (s *Server) probe(ctx context.Context, spec probeSpec, req ProbeRequest) {
	checker, ok := s.Deps.Hydrator.(hydrate.PresenceChecker)
	if !ok {
		s.Metrics.GoFirst.WithLabelValues(spec.endpoint, ProbeError, GoFirstViewerUnknown).Inc()
		s.Log.Error("go-first probe", "endpoint", spec.endpoint, "err", errNoPresence)
		return
	}
	rec := &hydrate.PresenceProbe{Checker: checker, RacedSince: racedSince(req.StartedAt)}
	// The sample's credential is the sampler's placeholder, never a key (auth.WithRedactedCredentials).
	viewer := ""
	err := s.within(auth.WithRedactedCredentials(ctx), "probe", func(ctx context.Context) error {
		var err error
		viewer, err = spec.run(s, ctx, req, rec)
		return err
	})
	first, pages := rec.FirstCheck()
	if pages > 0 {
		observeLag(s.Metrics.GoFirstCheckLag, spec.endpoint, first, req.StartedAt)
	}
	raced := rec.Raced()
	result, missed := classifyProbe(err, rec.Misses(), raced, checker.MissReason)
	s.Metrics.GoFirst.WithLabelValues(spec.endpoint, result, goFirstViewer(viewer)).Inc()
	for _, c := range missed {
		s.Metrics.GoFirstMiss.WithLabelValues(spec.endpoint, c).Inc()
	}
	for c := range raced {
		s.Metrics.GoFirstRaced.WithLabelValues(spec.endpoint, c).Inc()
	}
	if result == ProbeWouldServe || result == ProbeRaced {
		// The cost gate: database reads a Go-first serve of this request would have made (its misses
		// and raced entries on caches Go answers itself), over its pages. Served probes only, so the
		// ratio reads per served page.
		for c, n := range rec.DBReads() {
			s.Metrics.GoFirstDBReads.WithLabelValues(spec.endpoint, c).Add(float64(n))
		}
		s.Metrics.GoFirstPages.WithLabelValues(spec.endpoint).Add(float64(pages))
	}
	setOutcome(trace.SpanFromContext(ctx), result)
	if reason := fallback.Reason(err); reason != "" {
		s.Metrics.Fallbacks.WithLabelValues(spec.endpoint, "probe", reason).Inc()
		s.noteFallback(ctx, "probe", spec.endpoint, err)
	} else if err != nil {
		s.noteError(ctx, slog.LevelWarn, "go-first probe failed", "probe", spec.endpoint, err)
	}
}

// classifyProbe is a probe's result from how its resolution ended and the page misses it recorded,
// and the caches it saw miss (each once, in probeCaches order). missReason is the deployment's
// fallback reason for a miss on a page cache (hydrate.Sources.MissReason: "" where Go answers the
// miss itself, from the replica or by computing it). A cache Go answers is listed when it missed, but
// only a cache Go falls back on makes the result would_miss. raced is the raced-entry count per cache
// (entries filled after the request began); the same rule holds for it: only a raced entry on a cache
// Go falls back on turns would_serve into raced, as a Go-first serve would have missed it and fallen
// back, while a raced entry on a cache Go answers itself would have been answered (and is costed as a
// database read: hydrate.PresenceProbe.DBReads). would_miss wins over raced (a miss was seen anyway).
// The misses are listed whatever the result: a fallback for another reason can come after a page was
// checked.
func classifyProbe(err error, misses, raced map[string]int, missReason func(string) string) (string, []string) {
	reason := fallback.Reason(err)
	wouldRace := false
	for name, n := range raced {
		if n > 0 && missReason(name) != "" {
			wouldRace = true
		}
	}
	pre := fallbackMissCache(reason)
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
		if missReason(name) != "" {
			wouldMiss = true
		}
	}
	switch {
	case err == nil && wouldMiss, pre != "":
		return ProbeWouldMiss, missed
	case err == nil && wouldRace:
		return ProbeRaced, missed
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

// racedSince is the race threshold for a request that started at startedAtMs (epoch ms):
// RaceSkewMargin before it; zero (no race check) when the start is unknown.
func racedSince(startedAtMs float64) time.Time {
	if startedAtMs <= 0 {
		return time.Time{}
	}
	return time.UnixMicro(int64(startedAtMs * 1e3)).Add(-RaceSkewMargin)
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
