// Package server is the HTTP surface: the public tRPC path for the one procedure, and the internal
// shadow-compare endpoints (that procedure, `image.getInfinite`, `model.getAll`, and the public REST
// `GET /api/v1/images`).
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/dbpool"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Procedure is the one tRPC path this service answers.
const Procedure = "image.getImagesAsPostsInfinite"

// ProcedureInfinite is the tRPC procedure shadowed (never served) at /internal/shadow/<it>.
const ProcedureInfinite = "image.getInfinite"

// ProcedureModelGetAll is the tRPC procedure shadowed (never served) at /internal/shadow/<it>.
const ProcedureModelGetAll = "model.getAll"

// Endpoint labels: every feed_go_* series carries `feed_endpoint`, one of these, so CPU per call and
// parity read per endpoint (DESIGN.md §10).
const (
	EndpointAsPosts     = "as-posts"     // tRPC image.getImagesAsPostsInfinite
	EndpointV1Images    = "v1-images"    // REST GET /api/v1/images
	EndpointInfinite    = "infinite"     // tRPC image.getInfinite (shadow only)
	EndpointModelGetAll = "model-getall" // tRPC model.getAll (shadow only)
)

// Endpoints is every feed_endpoint value, in a fixed order (the seeded series are per endpoint).
var Endpoints = []string{EndpointAsPosts, EndpointV1Images, EndpointInfinite, EndpointModelGetAll, EndpointV1Models, EndpointV1ModelsID}

// V1ImagesPath is the REST route the v1-images shadow describes.
const V1ImagesPath = "/api/v1/images"

// DefaultRequestBudget bounds one computation (Server.RequestBudget, FEED_GO_REQUEST_BUDGET_MS): the
// served path and a shadow sample's compute both run under it. Past it the request falls back
// (reason `deadline`) and nothing computed so far is sent.
const DefaultRequestBudget = 6 * time.Second

// shadowSampleTimeout bounds a whole shadow sample (compute under the request budget, then compare).
const shadowSampleTimeout = 30 * time.Second

// verifiedBotHeader is VERIFIED_BOT_HEADER: a verified crawler is "authorized" where NSFW is viewable.
const verifiedBotHeader = "x-civitai-verified-bot"

// Server wires a request to the port.
type Server struct {
	Resolver    *auth.Resolver
	Deps        *feed.Deps
	Hosts       browsing.HostColors
	RegionRules []browsing.RegionRule
	// RegionBlockRules is REGION_BLOCK_CONFIG (config.RegionBlockRules): a public request from a region
	// on it is handed to Fallback, where applyApiRequestPolicy answers the 451.
	RegionBlockRules []browsing.RegionRule
	// Fallback serves what this service does not (a reverse proxy to the Node app). Required to serve
	// public traffic; nil only in shadow-only deployments, where the public route is not exposed.
	Fallback http.Handler
	Metrics  *Metrics
	Log      *slog.Logger
	// ShadowQueue bounds concurrent shadow comparisons; a full queue drops (never blocks Node).
	ShadowQueue chan struct{}
	// ProbeQueue bounds concurrent Go-first probes (probe.go); a full queue drops the probe. Its own
	// queue, so a probe never takes a comparison's slot; the solo-phase CPU method sees both.
	ProbeQueue chan struct{}
	// AllowedOrigins is the app's origin allow-list (config.AllowedOriginHosts). A public request whose
	// Origin (else Referer) host is not on it is handed to Fallback: the app's isAcceptableOrigin then
	// answers it (401 in production), and this service never serves one the app would refuse.
	AllowedOrigins map[string]bool

	// shadowStarts counts shadow samples and probes admitted to their queues; a phase whose start and
	// end readings differ overlapped another sample (phase CPU is then not attributed).
	shadowStarts atomic.Uint64
	// V1 serves the REST `/api/v1/images` shadow; nil = every such sample falls back.
	V1 *feed.V1Deps
	// Infinite serves the `image.getInfinite` shadow; nil = every such sample falls back.
	Infinite *feed.InfiniteDeps
	// Models serves the `model.getAll` shadow; nil = every such sample falls back.
	Models *modelfeed.Deps
	// V1Models serves the REST `/api/v1/models` and `/api/v1/models/[id]` shadows (v1models.go); nil =
	// every such sample falls back.
	V1Models *V1ModelsDeps
	// RequestBudget bounds one computation (0 = DefaultRequestBudget).
	RequestBudget time.Duration
	// MaxInFlight caps the public requests this pod computes at once (ResolveMaxInFlight; 0 =
	// dbpool.DefaultMaxConns, never unlimited): the Node app's `heavy-image` bulkhead. A request past
	// it is not computed: it is the `bulkhead` fallback, proxied to the Node app. Shadow samples and
	// probes are bounded by their own queues and never take a serve slot.
	MaxInFlight int

	// inFlight counts the public requests holding a serve slot (feed_go_serve_in_flight).
	inFlight atomic.Int64

	// The shadow goroutines' lifetime: bg is cancelled by Close, which then waits on shadows.
	bgOnce   sync.Once
	bg       context.Context
	stopBG   context.CancelFunc
	shadowMu sync.Mutex
	closing  bool
	shadows  sync.WaitGroup

	// computeFn and computeV1Fn replace compute / computeV1 in the shadow path (tests only; nil in
	// production).
	computeFn         func(context.Context, *http.Request) (*computed, error)
	computeV1Fn       func(context.Context, *http.Request) (*computed, error)
	computeInfiniteFn func(context.Context, *http.Request) (*computed, error)
	computeModelsFn   func(context.Context, *http.Request) (*computed, error)
	// computeV1ModelsFn replaces both REST model computes (tests only).
	computeV1ModelsFn func(context.Context, *http.Request) (*computed, error)
}

// phaseClock is the start of one shadow phase.
type phaseClock struct {
	wall   time.Time
	cpu    time.Duration
	cpuOK  bool
	starts uint64
	solo   bool
}

// startPhase begins a shadow phase. The caller holds a queue slot, so a queue length of 1 (and no
// probe running) means this is the only sample in flight.
func (s *Server) startPhase() phaseClock {
	p := phaseClock{starts: s.shadowStarts.Load()}
	p.solo = s.aloneInFlight()
	p.cpu, p.cpuOK = processCPU()
	p.wall = time.Now()
	return p
}

// endPhase records a phase's wall time always, and the process CPU delta over it only when the phase
// was solo throughout: no other sample in flight at its start, none admitted before its end. Process
// CPU is then this sample's own (plus background runtime/GC work and any scrape, DESIGN.md §10).
func (s *Server) endPhase(p phaseClock, endpoint, phase, outcome string) {
	wall := time.Since(p.wall).Seconds()
	s.Metrics.ShadowPhase.WithLabelValues(endpoint, phase, outcome).Observe(wall)
	if !p.solo || !p.cpuOK {
		return
	}
	cpu, ok := processCPU()
	if !ok || s.shadowStarts.Load() != p.starts || !s.aloneInFlight() {
		return
	}
	s.Metrics.ShadowPhaseCPU.WithLabelValues(endpoint, phase, outcome).Add((cpu - p.cpu).Seconds())
	s.Metrics.ShadowPhaseSolo.WithLabelValues(endpoint, phase, outcome).Inc()
	s.Metrics.ShadowPhaseSoloWall.WithLabelValues(endpoint, phase, outcome).Add(wall)
}

// aloneInFlight: the caller's shadow sample is the only sample or probe holding a queue slot.
func (s *Server) aloneInFlight() bool {
	return len(s.ShadowQueue) == 1 && len(s.ProbeQueue) == 0
}

// computed is one answer. payload may be a pooled buffer's bytes (buf): whoever ends up holding the
// computed releases it once payload is written or compared, and never reads payload after that.
// computeWithin releases an answer it discards.
type computed struct {
	payload []byte
	// buf owns payload when it is pooled (nil when payload is an ordinary slice, as in tests).
	buf *superjson.Buffer
	ttl *trpc.CacheTTL
	// trivial: answered without loading any image (feed.V1Answer.Trivial). Recorded as outcome
	// served_empty and result match_empty, so the per-served-call CPU and the match rate cover only
	// answers that did the work.
	trivial bool
	// cached: the answer is a cached response body read as Node read it (v1models.Answer.Cached), no
	// build. Recorded as outcome served_cached and result match_cached, apart for the same reason.
	cached bool
}

// compute answers a request, or returns a fallback/other error.
func (s *Server) compute(ctx context.Context, r *http.Request) (*computed, error) {
	req, signedOut, err := s.prepare(ctx, r)
	if err != nil {
		return nil, err
	}
	res, err := feed.Serve(ctx, s.Deps, req)
	if err != nil {
		return nil, err
	}
	buf, err := superjson.SerializeBuffer(res.Value())
	if err != nil {
		return nil, err
	}
	out := &computed{payload: buf.Bytes(), buf: buf}
	if signedOut {
		// createContext: cacheable only without a session user (a banned user still has one).
		out.ttl = &trpc.SignedOutTTL
	}
	return out, nil
}

// prepare is compute up to the handler call: the request's input, viewer and domain cap as
// feed.Serve takes them, and whether there is no session user at all. The Go-first probe runs the
// same steps (probe.go).
func (s *Server) prepare(ctx context.Context, r *http.Request) (feed.Request, bool, error) {
	if r.Method != http.MethodGet {
		return feed.Request{}, false, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return feed.Request{}, false, fallback.Newf("input-envelope", "%v", err)
	}
	in, err := feed.Parse(raw)
	if err != nil {
		return feed.Request{}, false, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return feed.Request{}, false, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return feed.Request{}, false, err
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
	return req, user == nil, nil
}

// computeInfinite answers an `image.getInfinite` request (getInfiniteImagesHandler), or returns a
// fallback/other error. The viewer, the domain cap and the region rules are read as for the gallery
// procedure (the same middleware runs on both), and so is the cache policy: a signed-out answer
// carries createContext's public TTL. It is only shadowed here.
func (s *Server) computeInfinite(ctx context.Context, r *http.Request) (*computed, error) {
	req, signedOut, err := s.prepareInfinite(ctx, r)
	if err != nil {
		return nil, err
	}
	ans, err := feed.ServeInfinite(ctx, s.Infinite, req)
	if err != nil {
		return nil, err
	}
	buf, err := superjson.SerializeBuffer(ans.Value)
	if err != nil {
		return nil, err
	}
	out := &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial}
	if signedOut {
		// createContext: cacheable without a session user, as for the gallery procedure. Nothing in
		// this procedure's chain lowers it, so Node answers a signed-out unbatched call public.
		out.ttl = &trpc.SignedOutTTL
	}
	return out, nil
}

// prepareInfinite is computeInfinite up to the handler call, and whether there is no session user at
// all; the Go-first probe runs the same steps.
func (s *Server) prepareInfinite(ctx context.Context, r *http.Request) (feed.InfiniteRequest, bool, error) {
	if s.Infinite == nil {
		return feed.InfiniteRequest{}, false, fallback.New("infinite-unconfigured")
	}
	if r.Method != http.MethodGet {
		return feed.InfiniteRequest{}, false, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return feed.InfiniteRequest{}, false, fallback.Newf("input-envelope", "%v", err)
	}
	in, err := feed.ParseInfinite(raw)
	if err != nil {
		return feed.InfiniteRequest{}, false, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return feed.InfiniteRequest{}, false, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return feed.InfiniteRequest{}, false, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
	req := feed.InfiniteRequest{Input: in, Cap: browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator))}
	if authorized {
		req.Viewer = &feed.Viewer{ID: user.ID, IsModerator: isModerator}
		req.ViewerUsername = user.Username
	}
	return req, user == nil, nil
}

// computeModelGetAll answers a `model.getAll` request (getModelsInfiniteHandler), or returns a
// fallback/other error. The viewer, the domain cap and the region rules are read as for the gallery
// procedure (the same middleware runs on both). It is only shadowed here, so no cache header is
// computed (Node's: `public, s-maxage=60` signed out, none for a session).
func (s *Server) computeModelGetAll(ctx context.Context, r *http.Request) (*computed, error) {
	req, err := s.prepareModelGetAll(ctx, r)
	if err != nil {
		return nil, err
	}
	ans, err := modelfeed.Serve(ctx, s.Models, req)
	if err != nil {
		return nil, err
	}
	buf, err := superjson.SerializeBuffer(ans.Value)
	if err != nil {
		return nil, err
	}
	return &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial}, nil
}

// prepareModelGetAll is computeModelGetAll up to the handler call; the Go-first probe runs the same
// steps.
func (s *Server) prepareModelGetAll(ctx context.Context, r *http.Request) (modelfeed.Request, error) {
	if s.Models == nil {
		return modelfeed.Request{}, fallback.New("model-getall-unconfigured")
	}
	if r.Method != http.MethodGet {
		return modelfeed.Request{}, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return modelfeed.Request{}, fallback.Newf("input-envelope", "%v", err)
	}
	in, err := modelfeed.Parse(raw)
	if err != nil {
		return modelfeed.Request{}, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return modelfeed.Request{}, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return modelfeed.Request{}, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
	req := modelfeed.Request{Input: in, Cap: browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator))}
	if authorized {
		req.Viewer = &modelfeed.Viewer{ID: user.ID, Username: user.Username, IsModerator: isModerator}
	}
	return req, nil
}

// computeV1 answers a REST `/api/v1/images` request (handleImagesRequest), or returns a fallback/other
// error. The body is plain JSON, as `res.json` writes it.
func (s *Server) computeV1(ctx context.Context, r *http.Request) (*computed, error) {
	if s.V1 == nil {
		return nil, fallback.New("v1-unconfigured")
	}
	if r.Method != http.MethodGet {
		return nil, fallback.New("method")
	}
	in, err := feed.ParseV1(r.URL.RawQuery)
	if err != nil {
		return nil, err
	}
	// getApiAuthSession(whenBanned: 'anonymous'): a bearer/API key falls back (Resolve), a banned
	// session is no user at all.
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return nil, err
	}
	var viewer *feed.Viewer
	viewerUsername := ""
	if user != nil && !user.Banned {
		viewer = &feed.Viewer{ID: user.ID, IsModerator: user.IsModerator}
		viewerUsername = user.Username
	}
	restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
	ans, err := feed.ServeV1(ctx, s.V1, feed.V1Request{
		Input: in, Viewer: viewer, ViewerUsername: viewerUsername, RegionRestricted: restricted, Host: r.Host, Path: r.URL.Path,
	})
	if err != nil {
		return nil, err
	}
	buf, err := superjson.PlainBuffer(ans.Body)
	if err != nil {
		return nil, err
	}
	return &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial}, nil
}

// release hands a pooled payload back to its pool and drops payload, so a use after it reads nothing
// rather than another request's bytes. Safe on nil and when called twice.
func (c *computed) release() {
	if c == nil {
		return
	}
	c.buf.Release()
	c.buf, c.payload = nil, nil
}

// apiRequestPolicy is the part of applyApiRequestPolicy (src/server/middleware/api-request-policy.ts)
// that the tRPC route runs before anything else and this service hands to the app rather than answer:
//
//   - a region on REGION_BLOCK_CONFIG (getRegion: cf-ipcountry, cf-region-code for US states, x-isuk
//     true|1 as GB) is `region-blocked`, and the app answers its 451 with its own body and headers.
//   - a user agent matching a crawler pattern is `crawler-user-agent`: verifyBot may then set the
//     verified-crawler header (it also needs the IP in that crawler's published ranges), which changes
//     the answer, and only the app holds those ranges. A request whose user agent matches none can
//     never be verified, so its incoming header is the app's to strip; one that still carries it
//     falls back in prepare (`verified-bot`).
//
// The policy's default response headers need nothing here: Cache-Control is written with every
// answer (trpc.WriteResult; the app's private default unless the answer is edge-cacheable).
func (s *Server) apiRequestPolicy(r *http.Request) error {
	// IsRegionRestricted is isRegionBlocked's match over any rule list (same region key and date).
	if browsing.IsRegionRestricted(s.RegionBlockRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now()) {
		return fallback.New("region-blocked")
	}
	if apipolicy.IsCrawlerUserAgent(r.Header.Get("User-Agent")) {
		return fallback.New("crawler-user-agent")
	}
	return nil
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

// errBulkhead is the `bulkhead` fallback: one value, so a pod shedding under load allocates nothing
// to say so.
var errBulkhead = fallback.New("bulkhead")

func (s *Server) maxInFlight() int64 {
	if s.MaxInFlight > 0 {
		return int64(s.MaxInFlight)
	}
	return dbpool.DefaultMaxConns
}

// ResolveMaxInFlight is the serve cap from FEED_GO_MAX_IN_FLIGHT (explicit, 0 = not set) and the
// replica pool's connection ceiling (poolMaxConns, as dbpool resolved it: FEED_GO_DB_MAX_CONNS, a
// pool_max_conns in the URL, or the default). Unset, the cap is the ceiling: every admitted compute
// can then hold a connection, so a full pod sheds at once instead of admitting computes that wait in
// the pool until the budget turns them into `deadline` fallbacks. An explicit cap wins, and one above
// the ceiling is logged as a warning (not refused). Both values are logged under their env names.
func ResolveMaxInFlight(log *slog.Logger, explicit, poolMaxConns int) int {
	if poolMaxConns <= 0 {
		poolMaxConns = dbpool.DefaultMaxConns
	}
	limit := poolMaxConns
	if explicit > 0 {
		limit = explicit
	}
	log.Info("serving limits", "FEED_GO_MAX_IN_FLIGHT", limit, "explicit", explicit > 0, "db_max_conns", poolMaxConns)
	if limit > poolMaxConns {
		log.Warn("FEED_GO_MAX_IN_FLIGHT exceeds the replica pool's max connections: computes past the pool wait for a connection, up to the request budget, instead of shedding",
			"FEED_GO_MAX_IN_FLIGHT", limit, "db_max_conns", poolMaxConns)
	}
	return limit
}

// acquireServe takes a serve slot, or reports false at once when MaxInFlight are already held: never
// a wait, as the Node bulkhead (acquireBulkheadSlot) never queues. No allocation either way.
func (s *Server) acquireServe() bool {
	limit := s.maxInFlight()
	for {
		n := s.inFlight.Load()
		if n >= limit {
			return false
		}
		if s.inFlight.CompareAndSwap(n, n+1) {
			s.Metrics.ServeInFlight.Inc()
			return true
		}
	}
}

func (s *Server) releaseServe() {
	s.inFlight.Add(-1)
	s.Metrics.ServeInFlight.Dec()
}

// InFlight is the number of public requests computing now.
func (s *Server) InFlight() int64 { return s.inFlight.Load() }

// computeServe is computeWithin for a public request, inside a serve slot. A full pod is the
// `bulkhead` fallback without computing anything. The slot is held for the computation only, never
// for the proxied fallback that may follow, and is released however the computation ends (answer,
// fallback, error, panic, deadline, client gone) by the deferred release.
func (s *Server) computeServe(r *http.Request, fn func(context.Context, *http.Request) (*computed, error)) (*computed, error) {
	if !s.acquireServe() {
		return nil, errBulkhead
	}
	defer s.releaseServe()
	return s.computeWithin(r.Context(), r, "serve", fn)
}

func (s *Server) budget() time.Duration {
	if s.RequestBudget > 0 {
		return s.RequestBudget
	}
	return DefaultRequestBudget
}

// background is the parent context of every shadow sample; Close cancels it.
func (s *Server) background() context.Context {
	s.bgOnce.Do(func() { s.bg, s.stopBG = context.WithCancel(context.Background()) })
	return s.bg
}

// Close stops the shadow path for shutdown: new samples are dropped, the running ones are cancelled,
// and Close waits for them to return (each releases its queue slot) or for ctx to end. Call it before
// closing the stores the samples read.
func (s *Server) Close(ctx context.Context) error {
	s.shadowMu.Lock()
	s.closing = true
	s.shadowMu.Unlock()
	s.background()
	s.stopBG()
	done := make(chan struct{})
	go func() {
		s.shadows.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// panicked records a recovered panic: the counter and one log line with the stack.
func (s *Server) panicked(where string, value any, stack []byte) {
	s.Metrics.Panics.WithLabelValues(where).Inc()
	s.Log.Error("recovered panic", "where", where, "panic", value, "stack", string(stack))
}

// computeWithin runs fn under the request budget. Whatever fn returns, the answer is all or nothing:
// past a deadline — the budget's, or an earlier one parent carries (a shadow sample's own bound) —
// even when fn returned a value (e.g. after a store read failed open on the expired context), it is
// the `deadline` fallback; once parent was cancelled (the client left, or shutdown) it is the
// `canceled` fallback; a panic anywhere in the computation, its errgroup workers included, is counted
// under where and is the `panic` fallback.
func (s *Server) computeWithin(parent context.Context, r *http.Request, where string, fn func(context.Context, *http.Request) (*computed, error)) (*computed, error) {
	var c *computed
	err := s.within(parent, where, func(ctx context.Context) (err error) {
		c, err = fn(ctx, r)
		return err
	})
	if err != nil {
		c.release()
		return nil, err
	}
	return c, nil
}

// within is computeWithin for any computation (the Go-first probe's too): fn under the request
// budget, its panic, cancellation and deadline turned into the same fallbacks. An error from within
// means whatever fn produced must be discarded.
func (s *Server) within(parent context.Context, where string, fn func(context.Context) error) error {
	budget := s.budget()
	ctx, cancel := context.WithTimeout(parent, budget)
	defer cancel()
	_, err := safe.Call(func() (struct{}, error) { return struct{}{}, fn(ctx) })
	var pe *safe.PanicError
	if errors.As(err, &pe) {
		s.panicked(where, pe.Value, pe.Stack)
		return fallback.New("panic")
	}
	if errors.Is(parent.Err(), context.Canceled) {
		return fallback.New("canceled")
	}
	if ctx.Err() != nil {
		return fallback.Newf("deadline", "budget %v", budget)
	}
	return err
}

// ServeHTTP is the public route.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	var (
		c   *computed
		err error
	)
	switch err = s.apiRequestPolicy(r); {
	case err != nil:
	case AcceptableOrigin(r, s.AllowedOrigins):
		fn := s.compute
		if s.computeFn != nil {
			fn = s.computeFn
		}
		c, err = s.computeServe(r, fn)
	default:
		// The app's answer differs by environment and credential (non-production and bearer callers
		// are accepted, a cookie caller in production is refused): never decided here.
		err = fallback.New("origin")
	}
	if err == nil {
		trpc.WriteResult(w, c.payload, c.ttl)
		c.release() // WriteResult has sent payload and keeps no reference
		s.Metrics.Requests.WithLabelValues(EndpointAsPosts, "serve", "served").Inc()
		s.Metrics.Duration.WithLabelValues(EndpointAsPosts, "serve", "served").Observe(time.Since(start).Seconds())
		return
	}
	outcome := "fallback"
	reason := fallback.Reason(err)
	if reason == "" {
		outcome, reason = "error", "error"
		s.Log.Error("feed compute failed; falling back", "err", err)
	}
	s.Metrics.Requests.WithLabelValues(EndpointAsPosts, "serve", outcome).Inc()
	s.Metrics.Fallbacks.WithLabelValues(EndpointAsPosts, "serve", reason).Inc()
	s.Metrics.Duration.WithLabelValues(EndpointAsPosts, "serve", outcome).Observe(time.Since(start).Seconds())
	if reason == "canceled" {
		// The client has gone: nobody would read a proxied answer, and proxying would only make the
		// Node app compute one.
		return
	}
	if s.Fallback == nil {
		trpc.WriteError(w, Procedure, &trpc.Error{Code: "INTERNAL_SERVER_ERROR", HTTPStatus: 503, Message: "unavailable"})
		return
	}
	// The original request (and its context): the budget bounded only this service's own compute.
	s.Fallback.ServeHTTP(w, r)
}

// ShadowRequest is what the Node app posts after it has answered a sampled request.
type ShadowRequest struct {
	// Input is the raw `input` query parameter Node received (tRPC), or the request's raw query string
	// without the `?` (REST).
	Input string `json:"input"`
	// Path is the REST request's path (nextPage is built from it); unused for tRPC.
	Path string `json:"path,omitempty"`
	// Headers are the request headers the answer depends on: cookie, host, cf-ipcountry,
	// cf-region-code, x-isuk, authorization (presence only matters), x-civitai-verified-bot.
	Headers map[string]string `json:"headers"`
	// Node is Node's response: the superjson envelope (`{json, meta}`) for tRPC, the JSON body for REST.
	Node json.RawMessage `json:"node"`
	// ResponseHeaders are Node's response headers of shadow.ComparedHeaders, lowercased, Set-Cookie as
	// `present` (nil = a sampler that predates them: not compared).
	ResponseHeaders map[string]string `json:"responseHeaders,omitempty"`
}

// maxShadowBody bounds a shadow request body (a response page can be large).
const maxShadowBody = 32 << 20

// ShadowHandler is the internal compare endpoint for the tRPC procedure.
func (s *Server) ShadowHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointAsPosts) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// ShadowInfiniteHandler is the internal compare endpoint for the tRPC procedure `image.getInfinite`.
func (s *Server) ShadowInfiniteHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointInfinite) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// ShadowModelGetAllHandler is the internal compare endpoint for the tRPC procedure `model.getAll`.
func (s *Server) ShadowModelGetAllHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointModelGetAll) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// ShadowV1Handler is the internal compare endpoint for REST `GET /api/v1/images`.
func (s *Server) ShadowV1Handler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointV1Images) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// shadowHandler answers 202 at once and compares in the background; a full queue drops the sample.
// Every endpoint shares one queue, so the solo-phase CPU method (DESIGN.md §10.1) sees every sample.
func (s *Server) shadowHandler(w http.ResponseWriter, r *http.Request, endpoint string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// Register with the shutdown wait first: once Close has begun, a sample is dropped, and every
	// sample Close does not see starting here cannot start at all.
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		s.Metrics.ShadowDropped.WithLabelValues(endpoint).Inc()
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
	// Take a queue slot BEFORE reading the body: a full queue drops the sample without buffering up to
	// maxShadowBody for it, so concurrent callers cannot hold more bodies than there are workers.
	select {
	case s.ShadowQueue <- struct{}{}:
	default:
		s.Metrics.ShadowDropped.WithLabelValues(endpoint).Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.shadowStarts.Add(1)
	decode := s.startPhase()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxShadowBody))
	if err != nil {
		s.endPhase(decode, endpoint, "decode", "bad_request")
		<-s.ShadowQueue
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var req ShadowRequest
	if err := json.Unmarshal(body, &req); err != nil || len(req.Node) == 0 {
		s.endPhase(decode, endpoint, "decode", "bad_request")
		<-s.ShadowQueue
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "bad_request").Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.endPhase(decode, endpoint, "decode", "ok")
	w.WriteHeader(http.StatusAccepted)
	started = true
	go func() {
		// Deferred in this order so they run in reverse: recover first (a panic in compare or
		// classify is counted, never fatal), then the queue slot is released, then shutdown is told.
		defer s.shadows.Done()
		defer func() { <-s.ShadowQueue }()
		defer func() {
			if p := recover(); p != nil {
				s.panicked("shadow", p, debug.Stack())
			}
		}()
		// Marked as shadow: its feed-service calls carry the shadow headers (feedsvc.WithShadow).
		ctx, cancel := context.WithTimeout(feedsvc.WithShadow(s.background()), shadowSampleTimeout)
		defer cancel()
		s.compare(ctx, endpoint, req)
	}()
}

// SyntheticRequest rebuilds the public request a shadow sample describes.
func SyntheticRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	return syntheticTRPCRequest(ctx, req, Procedure)
}

// SyntheticInfiniteRequest rebuilds the `image.getInfinite` request an infinite sample describes.
func SyntheticInfiniteRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	return syntheticTRPCRequest(ctx, req, ProcedureInfinite)
}

// SyntheticModelGetAllRequest rebuilds the `model.getAll` request a model-getall sample describes.
func SyntheticModelGetAllRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	return syntheticTRPCRequest(ctx, req, ProcedureModelGetAll)
}

func syntheticTRPCRequest(ctx context.Context, req ShadowRequest, procedure string) (*http.Request, error) {
	u := &url.URL{Path: "/api/trpc/" + procedure, RawQuery: url.Values{"input": {req.Input}}.Encode()}
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

// SyntheticV1Request rebuilds the REST request a v1-images sample describes: its path and raw query
// string as Node received them, and the forwarded headers.
func SyntheticV1Request(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, V1ImagesPath, nil)
	if err != nil {
		return nil, err
	}
	path := req.Path
	if path == "" {
		path = V1ImagesPath
	}
	r.URL = &url.URL{Path: path, RawQuery: req.Input}
	r.RequestURI = ""
	for k, v := range req.Headers {
		r.Header.Set(k, v)
	}
	if h := req.Headers["host"]; h != "" {
		r.Host = h
	}
	return r, nil
}

func (s *Server) compare(ctx context.Context, endpoint string, req ShadowRequest) {
	build, computeFn := SyntheticRequest, s.compute
	compareFn, classify := shadow.Compare, shadow.Classify
	if s.computeFn != nil {
		computeFn = s.computeFn
	}
	switch endpoint {
	case EndpointV1Images:
		build, computeFn = SyntheticV1Request, s.computeV1
		compareFn, classify = shadow.CompareJSON, shadow.ClassifyJSON
		if s.computeV1Fn != nil {
			computeFn = s.computeV1Fn
		}
	case EndpointInfinite:
		// The superjson envelope, as for the gallery; classified by image id (a flat page).
		build, computeFn = SyntheticInfiniteRequest, s.computeInfinite
		classify = shadow.ClassifyFlat
		if s.computeInfiniteFn != nil {
			computeFn = s.computeInfiniteFn
		}
	case EndpointModelGetAll:
		// The superjson envelope, as for the gallery; classified by model id (a flat page).
		build, computeFn = SyntheticModelGetAllRequest, s.computeModelGetAll
		classify = shadow.ClassifyFlat
		if s.computeModelsFn != nil {
			computeFn = s.computeModelsFn
		}
	}
	if b, c, cl, ok := s.v1ModelsRoute(endpoint); ok {
		build, computeFn, compareFn, classify = b, c, shadow.CompareJSON, cl
	}
	r, err := build(ctx, req)
	if err != nil {
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "bad_request").Inc()
		return
	}
	start := time.Now()
	phase := s.startPhase()
	c, err := s.computeWithin(ctx, r, "shadow", computeFn)
	if err != nil {
		if reason := fallback.Reason(err); reason != "" {
			s.endPhase(phase, endpoint, "compute", "fallback")
			s.Metrics.Requests.WithLabelValues(endpoint, "shadow", "fallback").Inc()
			s.Metrics.Fallbacks.WithLabelValues(endpoint, "shadow", reason).Inc()
			// A compute cut by the budget is its own result, not `unsupported`: the match-rate
			// denominator leaves both out, and this keeps the budget's share visible (DESIGN.md §10).
			result := "unsupported"
			if reason == "deadline" {
				result = "deadline"
			}
			s.Metrics.ShadowResults.WithLabelValues(endpoint, result).Inc()
			s.Metrics.Duration.WithLabelValues(endpoint, "shadow", "fallback").Observe(time.Since(start).Seconds())
			return
		}
		s.endPhase(phase, endpoint, "compute", "error")
		s.Metrics.Requests.WithLabelValues(endpoint, "shadow", "error").Inc()
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "go_error").Inc()
		s.Log.Warn("shadow compute failed", "endpoint", endpoint, "err", err)
		return
	}
	// Released once the comparison and its classification (the last readers of payload) are done.
	defer c.release()
	served := "served"
	switch {
	case c.trivial:
		served = "served_empty"
	case c.cached:
		served = "served_cached"
	}
	s.endPhase(phase, endpoint, "compute", served)
	s.Metrics.Requests.WithLabelValues(endpoint, "shadow", served).Inc()
	s.Metrics.Duration.WithLabelValues(endpoint, "shadow", served).Observe(time.Since(start).Seconds())
	phase = s.startPhase()
	report, err := compareFn(c.payload, req.Node)
	if err != nil {
		s.endPhase(phase, endpoint, "compare", "bad_request")
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "bad_request").Inc()
		return
	}
	result := classify(report, c.payload, req.Node)
	if c.trivial && result == "match" {
		// A trivial answer that differs is still counted as the diff it is (fields, membership, …).
		result = "match_empty"
	}
	if c.cached && result == "match" {
		result = "match_cached"
	}
	// The compared headers, a separate result from the body's: the body's match rate keeps its
	// meaning, and the response's is its own figure. The status is not compared (DESIGN.md §7).
	var respDiffs []shadow.Diff
	switch {
	case isRESTEndpoint(endpoint) || req.ResponseHeaders == nil:
		// The REST ports write no headers of their own yet, and a sampler that predates the field sends
		// none: nothing to compare.
		s.Metrics.ShadowResponse.WithLabelValues(endpoint, "uncompared").Inc()
	default:
		respDiffs = shadow.CompareResponse(trpc.ResultHeaders(c.ttl), req.ResponseHeaders)
		if len(respDiffs) > 0 {
			s.Metrics.ShadowResponse.WithLabelValues(endpoint, "mismatch").Inc()
		} else {
			s.Metrics.ShadowResponse.WithLabelValues(endpoint, "match").Inc()
		}
	}
	s.endPhase(phase, endpoint, "compare", "ok")
	s.Metrics.ShadowResults.WithLabelValues(endpoint, result).Inc()
	diffs := make([]shadow.Diff, 0, len(report.Diffs)+len(respDiffs))
	diffs = append(diffs, report.Diffs...)
	diffs = append(diffs, respDiffs...)
	for _, d := range diffs {
		s.Metrics.ShadowDiffs.WithLabelValues(endpoint, d.Category, d.Kind).Inc()
	}
	unexpected := 0
	for _, d := range respDiffs {
		if !expectedResponseDiff(endpoint, d, c.ttl, req.ResponseHeaders) {
			unexpected++
		}
	}
	if result != "match" || len(respDiffs) > 0 {
		// Paths only (no values): enough to find the field, and never user data in logs.
		paths := make([]string, 0, len(diffs))
		for _, d := range diffs {
			paths = append(paths, d.Kind+":"+d.Path)
		}
		// Info for a body difference or a header difference not yet explained; a known one is Debug,
		// so the log is not filled with differences already on the list (DESIGN.md §7).
		level := slog.LevelDebug
		if bodyDiffers(result) || unexpected > 0 {
			level = slog.LevelInfo
		}
		s.Log.Log(ctx, level, "shadow diff", "endpoint", endpoint, "result", result, "paths", paths,
			"truncated", report.Truncated)
	}
}

// isRESTEndpoint: the REST ports (v1-images, v1-models, v1-models-id).
func isRESTEndpoint(endpoint string) bool {
	switch endpoint {
	case EndpointV1Images, EndpointV1Models, EndpointV1ModelsID:
		return true
	}
	return false
}

// bodyDiffers: the body's result is not one of the match results.
func bodyDiffers(result string) bool {
	switch result {
	case "match", "match_empty", "match_cached":
		return false
	}
	return true
}

// expectedResponseDiff reports whether a header difference is one of the expected differences DESIGN.md
// §7 lists: x-update-required only from Node (this service never tells a bundle to reload), and on
// model.getAll a public Cache-Control from Node where this compute recorded no edge TTL (§15).
func expectedResponseDiff(endpoint string, d shadow.Diff, ttl *trpc.CacheTTL, nodeHeaders map[string]string) bool {
	switch {
	case d.Category == "header:x-update-required" && d.Kind == "missing-in-go":
		return true
	case endpoint == EndpointModelGetAll && d.Category == "header:cache-control" && d.Kind == "value" && ttl == nil:
		return strings.HasPrefix(strings.ToLower(strings.TrimSpace(nodeHeaders["cache-control"])), "public")
	}
	return false
}
