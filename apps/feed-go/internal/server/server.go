// Package server is the HTTP surface: the public tRPC path for the one procedure, and the internal
// shadow-compare endpoint.
package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Procedure is the one tRPC path this service answers.
const Procedure = "image.getImagesAsPostsInfinite"

// verifiedBotHeader is VERIFIED_BOT_HEADER: a verified crawler is "authorized" where NSFW is viewable.
const verifiedBotHeader = "x-civitai-verified-bot"

// Server wires a request to the port.
type Server struct {
	Resolver    *auth.Resolver
	Deps        *feed.Deps
	Hosts       browsing.HostColors
	RegionRules []browsing.RegionRule
	// Fallback serves what this service does not (a reverse proxy to the Node app). Required to serve
	// public traffic; nil only in shadow-only deployments, where the public route is not exposed.
	Fallback http.Handler
	Metrics  *Metrics
	Log      *slog.Logger
	// ShadowQueue bounds concurrent shadow comparisons; a full queue drops (never blocks Node).
	ShadowQueue chan struct{}
	// AllowedOrigins is the app's origin allow-list (config.AllowedOriginHosts). A public request whose
	// Origin (else Referer) host is not on it is handed to Fallback: the app's isAcceptableOrigin then
	// answers it (401 in production), and this service never serves one the app would refuse.
	AllowedOrigins map[string]bool

	// shadowStarts counts shadow samples admitted to the queue; a phase whose start and end readings
	// differ overlapped another sample (phase CPU is then not attributed).
	shadowStarts atomic.Uint64
	// computeFn replaces compute in the shadow path (tests only; nil in production).
	computeFn func(context.Context, *http.Request) (*computed, error)
}

// phaseClock is the start of one shadow phase.
type phaseClock struct {
	wall   time.Time
	cpu    time.Duration
	cpuOK  bool
	starts uint64
	solo   bool
}

// startPhase begins a shadow phase. The caller holds a queue slot, so a queue length of 1 means this
// is the only sample in flight.
func (s *Server) startPhase() phaseClock {
	p := phaseClock{starts: s.shadowStarts.Load()}
	p.solo = len(s.ShadowQueue) == 1
	p.cpu, p.cpuOK = processCPU()
	p.wall = time.Now()
	return p
}

// endPhase records a phase's wall time always, and the process CPU delta over it only when the phase
// was solo throughout: no other sample in flight at its start, none admitted before its end. Process
// CPU is then this sample's own (plus background runtime/GC work and any scrape, DESIGN.md §10).
func (s *Server) endPhase(p phaseClock, phase, outcome string) {
	s.Metrics.ShadowPhase.WithLabelValues(phase, outcome).Observe(time.Since(p.wall).Seconds())
	if !p.solo || !p.cpuOK {
		return
	}
	cpu, ok := processCPU()
	if !ok || s.shadowStarts.Load() != p.starts || len(s.ShadowQueue) != 1 {
		return
	}
	s.Metrics.ShadowPhaseCPU.WithLabelValues(phase, outcome).Add((cpu - p.cpu).Seconds())
	s.Metrics.ShadowPhaseSolo.WithLabelValues(phase, outcome).Inc()
}

// computed is one answer.
type computed struct {
	payload []byte
	ttl     *trpc.CacheTTL
}

// compute answers a request, or returns a fallback/other error.
func (s *Server) compute(ctx context.Context, r *http.Request) (*computed, error) {
	if r.Method != http.MethodGet {
		return nil, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return nil, fallback.Newf("input-envelope", "%v", err)
	}
	in, err := feed.Parse(raw)
	if err != nil {
		return nil, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return nil, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return nil, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
	cap := browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator))

	req := feed.Request{Input: in, Cap: cap, BannedSession: user != nil && user.Banned}
	if authorized {
		req.Viewer = &feed.Viewer{ID: user.ID, IsModerator: isModerator}
	}
	res, err := feed.Serve(ctx, s.Deps, req)
	if err != nil {
		return nil, err
	}
	payload, err := superjson.Serialize(res.Value())
	if err != nil {
		return nil, err
	}
	out := &computed{payload: payload}
	if user == nil {
		// createContext: cacheable only without a session user (a banned user still has one).
		out.ttl = &trpc.SignedOutTTL
	}
	return out, nil
}

func countryOf(r *http.Request) string {
	if v := r.Header.Get("x-isuk"); v == "true" || v == "1" {
		return "GB"
	}
	return r.Header.Get("cf-ipcountry")
}

// AcceptableOrigin is isAllowedOriginRequest (src/server/utils/origin-helpers.ts): the Origin header's
// host, else the Referer's, must be on the allow-list; neither header means not acceptable.
func AcceptableOrigin(r *http.Request, allowed map[string]bool) bool {
	host := config.HostFromURL(r.Header.Get("Origin"))
	if host == "" {
		host = config.HostFromURL(r.Header.Get("Referer"))
	}
	return host != "" && allowed[host]
}

// ServeHTTP is the public route.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	var (
		c   *computed
		err error
	)
	if AcceptableOrigin(r, s.AllowedOrigins) {
		c, err = s.compute(r.Context(), r)
	} else {
		// The app's answer differs by environment and credential (non-production and bearer callers
		// are accepted, a cookie caller in production is refused): never decided here.
		err = fallback.New("origin")
	}
	if err == nil {
		trpc.WriteResult(w, c.payload, c.ttl)
		s.Metrics.Requests.WithLabelValues("serve", "served").Inc()
		s.Metrics.Duration.WithLabelValues("serve", "served").Observe(time.Since(start).Seconds())
		return
	}
	outcome := "fallback"
	reason := fallback.Reason(err)
	if reason == "" {
		outcome, reason = "error", "error"
		s.Log.Error("feed compute failed; falling back", "err", err)
	}
	s.Metrics.Requests.WithLabelValues("serve", outcome).Inc()
	s.Metrics.Fallbacks.WithLabelValues("serve", reason).Inc()
	s.Metrics.Duration.WithLabelValues("serve", outcome).Observe(time.Since(start).Seconds())
	if s.Fallback == nil {
		trpc.WriteError(w, Procedure, &trpc.Error{Code: "INTERNAL_SERVER_ERROR", HTTPStatus: 503, Message: "unavailable"})
		return
	}
	s.Fallback.ServeHTTP(w, r)
}

// ShadowRequest is what the Node app posts after it has answered a sampled request.
type ShadowRequest struct {
	// Input is the raw `input` query parameter Node received.
	Input string `json:"input"`
	// Headers are the request headers the answer depends on: cookie, host, cf-ipcountry,
	// cf-region-code, x-isuk, authorization (presence only matters), x-civitai-verified-bot.
	Headers map[string]string `json:"headers"`
	// Node is Node's superjson envelope for the response (`{json, meta}`).
	Node json.RawMessage `json:"node"`
}

// maxShadowBody bounds a shadow request body (a response page can be large).
const maxShadowBody = 32 << 20

// ShadowHandler is the internal compare endpoint. It answers 202 at once and compares in the
// background; a full queue drops the sample.
func (s *Server) ShadowHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// Take a queue slot BEFORE reading the body: a full queue drops the sample without buffering up to
	// maxShadowBody for it, so concurrent callers cannot hold more bodies than there are workers.
	select {
	case s.ShadowQueue <- struct{}{}:
	default:
		s.Metrics.ShadowDropped.Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.shadowStarts.Add(1)
	decode := s.startPhase()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxShadowBody))
	if err != nil {
		s.endPhase(decode, "decode", "bad_request")
		<-s.ShadowQueue
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var req ShadowRequest
	if err := json.Unmarshal(body, &req); err != nil || len(req.Node) == 0 {
		s.endPhase(decode, "decode", "bad_request")
		<-s.ShadowQueue
		s.Metrics.ShadowResults.WithLabelValues("bad_request").Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.endPhase(decode, "decode", "ok")
	w.WriteHeader(http.StatusAccepted)
	go func() {
		defer func() { <-s.ShadowQueue }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.compare(ctx, req)
	}()
}

// SyntheticRequest rebuilds the public request a shadow sample describes.
func SyntheticRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	u := &url.URL{Path: "/api/trpc/" + Procedure, RawQuery: url.Values{"input": {req.Input}}.Encode()}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	for k, v := range req.Headers {
		r.Header.Set(k, v)
	}
	if h := req.Headers["host"]; h != "" {
		r.Host = h
	}
	return r, nil
}

func (s *Server) compare(ctx context.Context, req ShadowRequest) {
	r, err := SyntheticRequest(ctx, req)
	if err != nil {
		s.Metrics.ShadowResults.WithLabelValues("bad_request").Inc()
		return
	}
	computeFn := s.compute
	if s.computeFn != nil {
		computeFn = s.computeFn
	}
	start := time.Now()
	phase := s.startPhase()
	c, err := computeFn(ctx, r)
	if err != nil {
		if reason := fallback.Reason(err); reason != "" {
			s.endPhase(phase, "compute", "fallback")
			s.Metrics.Requests.WithLabelValues("shadow", "fallback").Inc()
			s.Metrics.Fallbacks.WithLabelValues("shadow", reason).Inc()
			s.Metrics.ShadowResults.WithLabelValues("unsupported").Inc()
			s.Metrics.Duration.WithLabelValues("shadow", "fallback").Observe(time.Since(start).Seconds())
			return
		}
		s.endPhase(phase, "compute", "error")
		s.Metrics.Requests.WithLabelValues("shadow", "error").Inc()
		s.Metrics.ShadowResults.WithLabelValues("go_error").Inc()
		s.Log.Warn("shadow compute failed", "err", err)
		return
	}
	s.endPhase(phase, "compute", "served")
	s.Metrics.Requests.WithLabelValues("shadow", "served").Inc()
	s.Metrics.Duration.WithLabelValues("shadow", "served").Observe(time.Since(start).Seconds())
	phase = s.startPhase()
	report, err := shadow.Compare(c.payload, req.Node)
	if err != nil {
		s.endPhase(phase, "compare", "bad_request")
		s.Metrics.ShadowResults.WithLabelValues("bad_request").Inc()
		return
	}
	result := shadow.Classify(report, c.payload, req.Node)
	s.endPhase(phase, "compare", "ok")
	s.Metrics.ShadowResults.WithLabelValues(result).Inc()
	for _, d := range report.Diffs {
		s.Metrics.ShadowDiffs.WithLabelValues(d.Category, d.Kind).Inc()
	}
	if result != "match" {
		// Paths only (no values): enough to find the field, and never user data in logs.
		paths := make([]string, 0, len(report.Diffs))
		for _, d := range report.Diffs {
			paths = append(paths, d.Kind+":"+d.Path)
		}
		s.Log.Info("shadow diff", "result", result, "paths", paths, "truncated", report.Truncated)
	}
}
