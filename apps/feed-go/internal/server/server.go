// Package server is the HTTP surface: the public tRPC path for the one procedure (and `model.getAll`'s
// and `image.getInfinite`'s, computed only with ServeModelGetAll / ServeInfinite), the public REST
// `GET /api/v1/models` routes (computed only with ServeV1Models, v1models_serve.go) and
// `GET /api/v1/images` route (computed only with ServeV1Images, v1images_serve.go), and the internal
// shadow-compare endpoints (that procedure, `image.getInfinite`, `model.getAll`, and the public REST
// `GET /api/v1/images` and `/api/v1/models` routes).
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
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/dbpool"
	"github.com/civitai/civitai/apps/feed-go/internal/devalue"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// Procedure is the one tRPC path this service answers.
const Procedure = "image.getImagesAsPostsInfinite"

// ProcedureInfinite is the tRPC procedure shadowed at /internal/shadow/<it>, and served on the public
// route only with Server.ServeInfinite (FEED_GO_SERVE_INFINITE, default off).
const ProcedureInfinite = "image.getInfinite"

// ProcedureModelGetAll is the tRPC procedure shadowed at /internal/shadow/<it>, and served on the public
// route only with Server.ServeModelGetAll (FEED_GO_SERVE_MODEL_GETALL, default off).
const ProcedureModelGetAll = "model.getAll"

// Endpoint labels: every feed_go_* series carries `feed_endpoint`, one of these, so CPU per call and
// parity read per endpoint (DESIGN.md §10).
const (
	EndpointAsPosts     = "as-posts"     // tRPC image.getImagesAsPostsInfinite
	EndpointV1Images    = "v1-images"    // REST GET /api/v1/images
	EndpointInfinite    = "infinite"     // tRPC image.getInfinite (served only with ServeInfinite)
	EndpointModelGetAll = "model-getall" // tRPC model.getAll (served only with ServeModelGetAll)
)

// Endpoints is every feed_endpoint value, in a fixed order (the seeded series are per endpoint).
var Endpoints = []string{EndpointAsPosts, EndpointV1Images, EndpointInfinite, EndpointModelGetAll, EndpointV1Models, EndpointV1ModelsID, EndpointAssociated, EndpointSearch}

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

// sampledKey marks a request rebuilt from a Node sample (a shadow comparison or a Go-first probe):
// its headers are the ones the app's route saw after applyApiRequestPolicy.
type sampledKey struct{}

func withSampled(ctx context.Context) context.Context {
	return context.WithValue(ctx, sampledKey{}, true)
}

func isSampled(ctx context.Context) bool {
	v, _ := ctx.Value(sampledKey{}).(bool)
	return v
}

// verifiedCrawler is requestVerifiedCrawler (src/server/utils/browsing-level.ts) as the app reads it
// after applyApiRequestPolicy has decided the header:
//
//   - on a Node sample, the app has already decided it, so its value is read as the app parses it
//     (parseVerifiedBotHeader: `googlebot` or `bingbot`, anything else is no crawler);
//   - on a public request, a crawler's user agent never gets here: apiRequestPolicy (serve) hands it
//     back first (`crawler-user-agent`: only the app holds the address ranges that verify it). For
//     any other user agent the app's policy removes whatever header came in, so it is no crawler
//     whatever it carries.
func verifiedCrawler(r *http.Request) bool {
	if isSampled(r.Context()) {
		v := r.Header.Get(verifiedBotHeader)
		return v == "googlebot" || v == "bingbot"
	}
	return false
}

// Server wires a request to the port.
type Server struct {
	// Readiness answers the internal /readyz (the zero value is ready); Drain fails it at shutdown.
	Readiness Readiness
	Resolver  *auth.Resolver
	Deps      *feed.Deps
	Hosts     browsing.HostColors
	// HostPrimaries is each color's SERVER_DOMAIN_<COLOR> (config.HostPrimaries): the board color of
	// image.getInfinite's `newCreators` reads it.
	HostPrimaries map[string]string
	RegionRules   []browsing.RegionRule
	// RegionBlockRules is REGION_BLOCK_CONFIG (config.RegionBlockRules): a public request from a region
	// on it is the app's 451, answered here with AnswerRegionBlocked, else handed to the route's
	// fallback, where applyApiRequestPolicy answers it.
	RegionBlockRules []browsing.RegionRule
	// AnswerRegionBlocked is FEED_GO_ANSWER_REGION_BLOCKED (default off): write the app's 451 to a
	// request from a blocked region here (writeRegionBlocked, outcome `region_blocked`) instead of
	// proxying it as the `region-blocked` fallback. Off, the request is handed back as before.
	AnswerRegionBlocked bool
	// AnswerInfiniteFeedUnavailable is FEED_GO_INFINITE_ANSWER_FEED_UNAVAILABLE (default off): on the
	// public image.getInfinite route, write the app's 503 here (writeFeedUnavailable, outcome
	// `feed_unavailable`) for a feed-service failure the app answers with it whatever
	// feed-service-degrade says (feed.UnavailableError), instead of handing the request back as the
	// `feed-unavailable` / `feed-status` fallback, where the app calls the feed again. Off, the request
	// is handed back as before.
	AnswerInfiniteFeedUnavailable bool
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
	// Parity is the serve-side parity sampler (serveparity.go): a sampled served answer is replayed to
	// the Node app after it is written, and compared. nil (or a zero Rate) = off.
	Parity *ServeParity
	// EvalCapture is the eval capture (evalcapture.go, FEED_GO_EVAL_CAPTURE): nil = off, and then no
	// tap does anything.
	EvalCapture *EvalCapture
	// AllowedOrigins is the app's origin allow-list (config.AllowedOriginHosts). A public request whose
	// Origin (else Referer) host is not on it is handed to Fallback: the app's isAcceptableOrigin then
	// answers it (401 in production), and this service never serves one the app would refuse.
	AllowedOrigins map[string]bool

	// shadowStarts counts shadow samples and probes admitted to their queues; a phase whose start and
	// end readings differ overlapped another sample (phase CPU is then not attributed).
	shadowStarts atomic.Uint64
	// V1 serves the REST `/api/v1/images` shadow; nil = every such sample falls back.
	V1 *feed.V1Deps
	// Infinite serves the `image.getInfinite` shadow (and the public route, with ServeInfinite); nil =
	// every such sample or request falls back.
	Infinite *feed.InfiniteDeps
	// ServeInfinite is FEED_GO_SERVE_INFINITE (default off): compute `image.getInfinite` on the public
	// route. Off, every request there is the `infinite-off` fallback (proxied to the Node app) before
	// anything is computed or a serve slot taken.
	ServeInfinite bool
	// Models serves the `model.getAll` shadow (and the public route, with ServeModelGetAll); nil = every
	// such sample or request falls back.
	Models *modelfeed.Deps
	// ServeModelGetAll is FEED_GO_SERVE_MODEL_GETALL (default off): compute `model.getAll` on the public
	// route. Off, every request there is the `model-getall-off` fallback (proxied to the Node app)
	// before anything is computed or a serve slot taken.
	ServeModelGetAll bool
	// PersonalHotLead reads the `personal-hot-lead` flag per viewer (personal_lead.go); nil = every
	// request that flag could lead is the model-getall-personal-hot-lead-unknown fallback.
	PersonalHotLead UserFlagReader
	// UserHubs reads the `user-hubs` flag per viewer (hubs.go) for an image.getInfinite `hubId`; nil =
	// every such request is the infinite-hub-flag-unknown fallback.
	UserHubs UserFlagReader
	// FliptDeploymentID is FLIPT_DEPLOYMENT_ID: the `deploymentId` targeting property Node's
	// buildFliptContext adds when it is set.
	FliptDeploymentID string
	// WriteDevalue is TRPC_WRITE_DEVALUE, the main app's own switch (default off: every answer is
	// superjson). On, an answer this service computes on a public route is written as devalue, byte for
	// byte as the app writes it, exactly when the app would: a web bundle that can read it
	// (trpc.CanDecodeDevalueResponse) and an answer that is not edge-cacheable (trpc.DevalueWrite).
	// Proxied answers are the app's own bytes, and the shadow comparison always computes superjson.
	WriteDevalue bool
	// V1Models serves the REST `/api/v1/models` and `/api/v1/models/[id]` shadows (v1models.go), and
	// their public routes with ServeV1Models; nil = every such sample or request falls back.
	V1Models *V1ModelsDeps
	// ServeV1Models is FEED_GO_SERVE_V1_MODELS (default off); off, every request is the v1-models-off fallback.
	ServeV1Models bool
	// ServeV1Images is FEED_GO_SERVE_V1_IMAGES (default off); off, every request on the public
	// `/api/v1/images` route is the v1-images-off fallback (v1images_serve.go).
	ServeV1Images bool
	// V1BearerAuth is FEED_GO_V1_BEARER_AUTH (default off; needs FEED_GO_BEARER_AUTH, so Resolver.APIKeys
	// is set): `[id]`, shadow and public alike, decides an API credential as the Node route does
	// (v1DetailCredential, auth.Resolver.DetailCredential; DESIGN.md §16.10) instead of falling back on
	// every one (`bearer-token`). The list is unaffected either way. Off, both routes behave exactly as
	// before it existed.
	V1BearerAuth bool
	// V1Fallback serves what the public `/api/v1/models` routes do not (a reverse proxy to the Node app
	// that answers `/api/v1`, FEED_GO_V1_FALLBACK_URL: a different upstream from Fallback). The routes
	// are mounted only when it is set.
	V1Fallback http.Handler
	// V1ImagesFallback serves what the public `/api/v1/images` route does not
	// (FEED_GO_V1_IMAGES_FALLBACK_URL: the Node pool that answers that route). The route is mounted
	// only when it is set; V1Fallback is never used for it.
	V1ImagesFallback http.Handler
	// Associated serves the `model.getAssociatedResourcesCardData` shadow (associated.go); nil = every
	// such sample falls back.
	Associated *modelfeed.AssocDeps
	// Search serves the public `POST /api/search/*` route (sitesearch.go): the search backend and the
	// rate-limit store. The shadow needs neither (it reshapes the backend response Node recorded).
	Search *SearchDeps
	// ServeSearch is FEED_GO_SERVE_SEARCH (default off); off, every request on the public
	// `/api/search/*` route is the search-off fallback.
	ServeSearch bool
	// SearchFallback serves what the public `/api/search/*` route does not (FEED_GO_SEARCH_FALLBACK_URL:
	// the Node app answering it). The route is mounted only when it is set.
	SearchFallback http.Handler
	// EvalMode is FEED_GO_EVAL_MODE (default off; config.LoadEval, DESIGN.md §19.7): every request a
	// public route hands back is answered with the hand-back stub (handBack: HandbackStatus and
	// HandbackReasonHeader) instead of being proxied, so no fallback upstream is ever dialled; and the
	// internal shadow and probe routes are not mounted (InternalMux).
	EvalMode bool
	// RequestBudget bounds one computation (0 = DefaultRequestBudget).
	RequestBudget time.Duration
	// MaxInFlight caps the public requests this pod computes at once (ResolveMaxInFlight; 0 =
	// dbpool.DefaultMaxConns, never unlimited), across EVERY public route: the gallery procedure,
	// model.getAll and image.getInfinite share one pool of slots, so one route can hold slots another
	// then sheds for. For the gallery and image.getInfinite it stands in for the Node app's
	// `heavy-image` bulkhead; Node has no bulkhead on model.getAll. A request past it is not computed:
	// it is the `bulkhead` fallback, proxied to the Node app (feed_go_fallback_total and
	// feed_go_serve_in_flight are per endpoint). Shadow samples and probes are bounded by their own
	// queues and never take a serve slot.
	MaxInFlight int

	// Tracer starts the request spans (DESIGN.md §10.3); nil = tracing off: no span, no header read or
	// written, no exemplar.
	Tracer trace.Tracer
	// Propagator extracts an inbound traceparent (public and internal routes); used only with Tracer.
	Propagator propagation.TextMapPropagator
	// Events writes the fallback and error lines (events.go); nil = an EventLog over Log with fallback
	// lines off and errors at the default rate.
	Events     *EventLog
	eventsOnce sync.Once
	ev         *EventLog

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
	// computeAssociatedFn replaces computeAssociated (tests only).
	computeAssociatedFn func(context.Context, *http.Request) (*computed, error)
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
// ctx carries the sample's span: a sampled one is the wall histogram's exemplar.
func (s *Server) endPhase(ctx context.Context, p phaseClock, endpoint, phase, outcome string) {
	wall := time.Since(p.wall).Seconds()
	tracing.Observe(ctx, s.Metrics.ShadowPhase.WithLabelValues(endpoint, phase, outcome), wall)
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

// aloneInFlight: the caller's shadow sample is the only sample, probe or serve-parity replay holding a
// queue slot.
func (s *Server) aloneInFlight() bool {
	return len(s.ShadowQueue) == 1 && len(s.ProbeQueue) == 0 && s.parityQueueLen() == 0
}

// computed is one answer. payload may be a pooled buffer's bytes (buf): whoever ends up holding the
// computed releases it once payload is written or compared, and never reads payload after that.
// computeWithin releases an answer it discards.
type computed struct {
	payload []byte
	// buf owns payload when it is a pooled superjson payload, dbuf when it is a pooled devalue one (both
	// nil when payload is an ordinary slice, as in tests).
	buf  *superjson.Buffer
	dbuf *devalue.Buffer
	// value is the answer payload encodes (nil for the REST answers and in tests that set payload).
	value any
	// devalue: payload is devalue (a JSON string literal), not the superjson envelope (encode).
	devalue bool
	// devalueRefused is why devalue refused a value encode would have written as devalue (payload is
	// then superjson); nil otherwise.
	devalueRefused error
	ttl            *trpc.CacheTTL
	// trivial: answered without loading any image (feed.V1Answer.Trivial). Recorded as outcome
	// served_empty and result match_empty, so the per-served-call CPU and the match rate cover only
	// answers that did the work.
	trivial bool
	// viewerClass is the sample's viewer class when the endpoint reports one (model-associated:
	// modelfeed.ViewerClasses; the tRPC feeds: FeedViewerClasses); "" = not reported. The body's
	// comparison result, and the headers' for the tRPC feeds, are also counted under it.
	viewerClass string
	// cached: the answer is a cached response body read as Node read it (v1models.Answer.Cached), no
	// build. Recorded as outcome served_cached and result match_cached, apart for the same reason.
	cached bool
	// notFound: the `/api/v1/models/[id]` not-found body, which Node answers with a 404
	// (v1models.Answer.NotFound). Compared in the shadow. The public route writes it as Node's 404 only
	// when absent is also set, and falls back on every other one (v1models_serve.go).
	notFound bool
	// absent: a notFound answer the public route may write as Node's 404 (v1models.Answer.Absent:
	// FEED_GO_V1_MODELS_ANSWER_NOT_FOUND on, no statement row, the lag flag clean). Recorded as outcome
	// not_found (OutcomeNotFound).
	absent bool
	// headers are a REST answer's response headers (v1models.ResponseHeaders): what the public route
	// writes and what the shadow compares. nil for the tRPC answers and for /api/v1/images.
	headers []v1models.Header
}

// compute answers a request, or returns a fallback/other error.
func (s *Server) compute(ctx context.Context, r *http.Request) (*computed, error) {
	req, user, err := s.prepareViewer(ctx, r)
	if err != nil {
		return nil, err
	}
	signedOut := user == nil
	res, err := feed.Serve(ctx, s.Deps, req)
	if err != nil {
		return nil, err
	}
	out := &computed{value: res.Value(), viewerClass: feedViewerClass(user, false)}
	if signedOut {
		// createContext: cacheable only without a session user (a banned user still has one).
		out.ttl = &trpc.SignedOutTTL
	}
	if err := out.encode(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// prepare is compute up to the handler call: the request's input, viewer and domain cap as
// feed.Serve takes them, and whether there is no session user at all. The Go-first probe runs the
// same steps (probe.go).
func (s *Server) prepare(ctx context.Context, r *http.Request) (feed.Request, bool, error) {
	req, user, err := s.prepareViewer(ctx, r)
	if err != nil {
		return feed.Request{}, false, err
	}
	return req, user == nil, nil
}

// prepareViewer is prepare with the session user it resolved (nil: none) instead of whether there is one.
func (s *Server) prepareViewer(ctx context.Context, r *http.Request) (feed.Request, *auth.SessionUser, error) {
	if r.Method != http.MethodGet {
		return feed.Request{}, nil, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return feed.Request{}, nil, fallback.Wrap("input-envelope", err)
	}
	in, err := feed.Parse(raw)
	if err != nil {
		return feed.Request{}, nil, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return feed.Request{}, nil, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return feed.Request{}, nil, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := regionMatches(s.RegionRules, r)
	cap := browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator))

	req := feed.Request{Input: in, Cap: cap, BannedSession: user != nil && user.Banned}
	if authorized {
		req.Viewer = &feed.Viewer{ID: user.ID, IsModerator: isModerator}
	}
	return req, user, nil
}

// computeInfinite answers an `image.getInfinite` request (getInfiniteImagesHandler), or returns a
// fallback/other error. The viewer, the domain cap and the region rules are read as for the gallery
// procedure (the same middleware runs on both), and so is the cache policy: a signed-out answer
// carries createContext's public TTL unless its input is viewer-scoped (InfiniteInput.ViewerScoped).
// Shadowed, and served on the public route only with ServeInfinite.
func (s *Server) computeInfinite(ctx context.Context, r *http.Request) (*computed, error) {
	req, user, crawler, err := s.prepareInfiniteViewer(ctx, r)
	if err != nil {
		return nil, err
	}
	cacheable := user == nil && !crawler
	ans, err := feed.ServeInfinite(ctx, s.Infinite, req)
	if err != nil {
		return nil, err
	}
	out := &computed{value: ans.Value, trivial: ans.Trivial, viewerClass: feedViewerClass(user, crawler)}
	if cacheable && !req.Input.ViewerScoped() {
		// createContext: cacheable without a session user and without a verified crawler, unless
		// noEdgeCacheWhen(isViewerScopedInfiniteFeed) lowers it, as it does for a viewer-scoped input.
		out.ttl = &trpc.SignedOutTTL
	}
	if err := out.encode(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// prepareInfiniteViewer is computeInfinite up to the handler call, with the session user it resolved
// (nil: none) and whether the request is a verified crawler's (createContext makes the answer
// edge-cacheable with neither); the Go-first probe runs the same steps. A verified crawler
// (verifiedCrawler) counts as signed in for the domain cap where NSFW is viewable
// (requestDomainBrowsingLevelCap) and is never cached; it is no viewer.
func (s *Server) prepareInfiniteViewer(ctx context.Context, r *http.Request) (feed.InfiniteRequest, *auth.SessionUser, bool, error) {
	if s.Infinite == nil {
		return feed.InfiniteRequest{}, nil, false, fallback.New("infinite-unconfigured")
	}
	if r.Method != http.MethodGet {
		return feed.InfiniteRequest{}, nil, false, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return feed.InfiniteRequest{}, nil, false, fallback.Wrap("input-envelope", err)
	}
	in, err := feed.ParseInfiniteWith(raw, s.Infinite.Ports)
	if err != nil {
		return feed.InfiniteRequest{}, nil, false, err
	}
	crawler := verifiedCrawler(r)
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return feed.InfiniteRequest{}, nil, false, err
	}
	if in.HubID != 0 {
		// getInfiniteImagesHandler's first step: the `userHubs` feature gate.
		if err := s.userHubs(ctx, user); err != nil {
			return feed.InfiniteRequest{}, nil, false, err
		}
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := regionMatches(s.RegionRules, r)
	canViewNsfw := browsing.CanViewNsfw(color, restricted, isModerator)
	req := feed.InfiniteRequest{
		Input:      in,
		Cap:        browsing.DomainCap(authorized || (crawler && canViewNsfw), canViewNsfw),
		BoardColor: s.Hosts.BoardColorOf(r.Host, s.HostPrimaries),
	}
	if authorized {
		req.Viewer = &feed.Viewer{ID: user.ID, IsModerator: isModerator}
		req.ViewerUsername = user.Username
	}
	return req, user, crawler, nil
}

// computeModelGetAll answers a `model.getAll` request (getModelsInfiniteHandler), or returns a
// fallback/other error. Viewer, domain cap and region rules are read as for the gallery procedure.
// Cache policy is createContext's, not edgeCacheIt's (model.router.ts's skipEdgeCache hands it a copy
// of ctx.cache): public TTL signed out, none for a session.
//
// A viewer the `personal-hot-lead` flag is on for falls back on every page of a feed Node leads
// (personalHotLead), here and so in the shadow too (an `unsupported` sample, never a diff). The
// Go-first probe does not run that gate: it measures cache presence, which the gate does not read.
func (s *Server) computeModelGetAll(ctx context.Context, r *http.Request) (*computed, error) {
	req, user, err := s.prepareModelGetAllViewer(ctx, r)
	if err != nil {
		return nil, err
	}
	if err := s.personalHotLead(ctx, req, user); err != nil {
		return nil, err
	}
	signedOut := user == nil
	ans, err := modelfeed.Serve(ctx, s.Models, req)
	if err != nil {
		return nil, err
	}
	out := &computed{value: ans.Value, trivial: ans.Trivial, viewerClass: feedViewerClass(user, false)}
	if signedOut {
		// createContext: cacheable without a session user (a banned user still has one).
		out.ttl = &trpc.SignedOutTTL
	}
	if err := out.encode(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// prepareModelGetAllViewer is computeModelGetAll up to the handler call, with the session user it
// resolved (nil: none); the Go-first probe runs the same steps.
func (s *Server) prepareModelGetAllViewer(ctx context.Context, r *http.Request) (modelfeed.Request, *auth.SessionUser, error) {
	if s.Models == nil {
		return modelfeed.Request{}, nil, fallback.New("model-getall-unconfigured")
	}
	if r.Method != http.MethodGet {
		return modelfeed.Request{}, nil, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return modelfeed.Request{}, nil, fallback.Wrap("input-envelope", err)
	}
	in, err := modelfeed.ParseWith(raw, s.Models.Config.Ports)
	if err != nil {
		return modelfeed.Request{}, nil, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return modelfeed.Request{}, nil, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return modelfeed.Request{}, nil, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := regionMatches(s.RegionRules, r)
	req := modelfeed.Request{Input: in, Cap: browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator))}
	if authorized {
		req.Viewer = &modelfeed.Viewer{ID: user.ID, Username: user.Username, IsModerator: isModerator}
	}
	return req, user, nil
}

// computeV1 answers a REST `/api/v1/images` request (handleImagesRequest), or returns a fallback/other
// error. The body is plain JSON, as `res.json` writes it.
func (s *Server) computeV1(ctx context.Context, r *http.Request) (*computed, error) {
	return s.computeV1For(ctx, r, false)
}

// computeV1For is computeV1; serving, a request whose session resolves to a user (a banned one
// included) falls back (`v1-images-session`) instead of being answered for that viewer: the public
// route serves signed-out callers only (v1ImagesServeOnly hands a session cookie back first; this
// holds whatever cookie name the resolver reads).
func (s *Server) computeV1For(ctx context.Context, r *http.Request, serving bool) (*computed, error) {
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
	// getApiAuthSession(whenBanned: 'anonymous'): a banned session is no user at all. An API credential
	// falls back: PublicEndpoint's credentialed cache headers and REST_SCOPE_ENFORCE are not ported
	// (DESIGN.md §4.2), and the sampler never sends one.
	if auth.HasAPICredential(r) {
		return nil, fallback.New("bearer-token")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return nil, err
	}
	if serving && user != nil {
		return nil, fallback.New("v1-images-session")
	}
	if serving && r.URL != nil && r.URL.Host != "" {
		// An absolute-form request line: r.Host is the URL's host and the Host header Node reads for
		// nextPage is gone (v1ModelsHost). A Node sample is rebuilt in origin form.
		return nil, fallback.New("v1-host")
	}
	var viewer *feed.Viewer
	viewerUsername := ""
	if user != nil && !user.Banned {
		viewer = &feed.Viewer{ID: user.ID, IsModerator: user.IsModerator}
		viewerUsername = user.Username
	}
	restricted := regionMatches(s.RegionRules, r)
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
	c.dbuf.Release()
	c.buf, c.dbuf, c.payload = nil, nil, nil
}

// encode writes c.value into payload in the format the app writes this answer in: devalue when the
// request is marked for it (Server.WriteDevalue and a capable client, see serve) and the answer is not
// edge-cacheable (c.ttl), else superjson. Set c.ttl first. The shadow and probe paths never mark their
// requests, so their answers are superjson, the format the Node sampler sends. A value devalue
// refuses (a json column that is not JSON) is written as superjson for that answer, as the app's
// writer falls back (writeSerializeWithFallback).
func (c *computed) encode(ctx context.Context) error {
	if trpc.DevalueWrite(ctx, c.ttl) {
		_, phase := tracing.StartPhase(ctx, tracing.PhaseEncodeDevalue)
		b, err := devalue.PayloadBuffer(c.value)
		if err == nil {
			c.payload, c.dbuf, c.devalue = b.Bytes(), b, true
			phase.SetInt(tracing.AttrResponseBytes, len(c.payload))
			phase.End()
			return nil
		}
		phase.End()
		c.devalueRefused = err
	}
	_, phase := tracing.StartPhase(ctx, tracing.PhaseEncodeSuperjson)
	defer phase.End()
	buf, err := superjson.SerializeBuffer(c.value)
	if err != nil {
		return err
	}
	c.payload, c.buf = buf.Bytes(), buf
	phase.SetInt(tracing.AttrResponseBytes, len(c.payload))
	return nil
}

const (
	DevalueWriteDevalue   = "devalue"
	DevalueWriteFallback  = "superjson_fallback"
	DevalueWriteSuperjson = "superjson"
)

// noteWriteFormat counts a written answer by format, and logs a devalue fallback: the answer is
// correct (superjson, which every client reads), but a value devalue refuses is a payload shape to
// fix, as the app reports it through devalueFallbackObserver.
func (s *Server) noteWriteFormat(ctx context.Context, endpoint string, c *computed) {
	result := DevalueWriteSuperjson
	switch {
	case c.devalue:
		result = DevalueWriteDevalue
	case c.devalueRefused != nil:
		result = DevalueWriteFallback
		s.Log.Log(ctx, slog.LevelWarn, "devalue refused the answer; wrote superjson", traceAttrs(ctx, []any{"endpoint", endpoint, "err", c.devalueRefused.Error()})...)
	}
	s.Metrics.DevalueWrites.WithLabelValues(endpoint, result).Inc()
}

// apiRequestPolicy is the part of applyApiRequestPolicy (src/server/middleware/api-request-policy.ts)
// that the tRPC route runs before anything else and this service hands to the app rather than answer:
//
//   - a region on REGION_BLOCK_CONFIG (getRegion: cf-ipcountry, cf-region-code for US states, x-isuk
//     true|1 as GB) is errRegionBlocked: the app's 451, which answerRegionBlocked writes here with
//     AnswerRegionBlocked on, and which is otherwise the `region-blocked` fallback (the app answers it).
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
	if regionMatches(s.RegionBlockRules, r) {
		return errRegionBlocked
	}
	if apipolicy.IsCrawlerUserAgent(r.Header.Get("User-Agent")) {
		return fallback.New("crawler-user-agent")
	}
	return nil
}

// regionMatches is IsRegionRestricted over rules for r's region (countryOf, cf-region-code), at the
// clock answers are computed at (clock.Now: FEED_GO_EVAL_NOW in eval mode, else the wall clock). Every
// region rule a route reads goes through it, so a dated rule is read at one instant everywhere.
func regionMatches(rules []browsing.RegionRule, r *http.Request) bool {
	return browsing.IsRegionRestricted(rules, countryOf(r), r.Header.Get("cf-region-code"), clock.Now())
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
			return true
		}
	}
}

func (s *Server) releaseServe() {
	s.inFlight.Add(-1)
}

// InFlight is the number of public requests computing now.
func (s *Server) InFlight() int64 { return s.inFlight.Load() }

// computeServe is computeWithin for a public request, inside a serve slot. A full pod is the
// `bulkhead` fallback without computing anything. The slot is held for the computation only, never
// for the proxied fallback that may follow, and is released however the computation ends (answer,
// fallback, error, panic, deadline, client gone) by the deferred release. The slot shows on
// feed_go_serve_in_flight under endpoint, the route holding it.
func (s *Server) computeServe(r *http.Request, endpoint string, fn func(context.Context, *http.Request) (*computed, error)) (*computed, error) {
	if !s.acquireServe() {
		return nil, errBulkhead
	}
	g := s.Metrics.ServeInFlight[endpoint]
	g.Inc()
	defer func() {
		g.Dec()
		s.releaseServe()
	}()
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
	// One write-back budget for the whole computation: its cache writes, however many caches it
	// fills in sequence, wait at most one hydrate write bound in total (hydrate.WithWriteBudget).
	ctx, cancel := context.WithTimeout(hydrate.WithWriteBudget(parent), budget)
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
		return fallback.Safef("deadline", "budget %v", budget)
	}
	return err
}

// ServeHTTP is the public route of the gallery procedure (Procedure).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fn := s.compute
	if s.computeFn != nil {
		fn = s.computeFn
	}
	s.serve(w, r, EndpointAsPosts, Procedure, nil, fn)
}

// errModelGetAllOff is the `model-getall-off` fallback: the public model.getAll route with
// ServeModelGetAll off.
var errModelGetAllOff = fallback.New("model-getall-off")

// ServeModelGetAllHTTP is the public route of `model.getAll`. With ServeModelGetAll off (the default)
// every request is the `model-getall-off` fallback: nothing is computed and no serve slot is taken,
// the request is proxied to the Node app as it came.
func (s *Server) ServeModelGetAllHTTP(w http.ResponseWriter, r *http.Request) {
	var off error
	if !s.ServeModelGetAll {
		off = errModelGetAllOff
	}
	fn := s.computeModelGetAll
	if s.computeModelsFn != nil {
		fn = s.computeModelsFn
	}
	s.serve(w, r, EndpointModelGetAll, ProcedureModelGetAll, off, fn)
}

// errInfiniteOff is the `infinite-off` fallback: the public image.getInfinite route with
// ServeInfinite off.
var errInfiniteOff = fallback.New("infinite-off")

// ServeInfiniteHTTP is the public route of `image.getInfinite`. With ServeInfinite off (the default)
// every request is the `infinite-off` fallback: nothing is computed and no serve slot is taken, the
// request is proxied to the Node app as it came.
func (s *Server) ServeInfiniteHTTP(w http.ResponseWriter, r *http.Request) {
	var off error
	if !s.ServeInfinite {
		off = errInfiniteOff
	}
	fn := s.computeInfinite
	if s.computeInfiniteFn != nil {
		fn = s.computeInfiniteFn
	}
	s.serve(w, r, EndpointInfinite, ProcedureInfinite, off, fn)
}

// bearerOrigin is fn for a request whose Origin the app would refuse unless its API key resolves to a
// session: the key is resolved first (inside the serve slot and the budget), the answer kept on the
// context for fn's own Resolve, and anything but an API-key viewer is the `origin` fallback.
func (s *Server) bearerOrigin(fn func(context.Context, *http.Request) (*computed, error)) func(context.Context, *http.Request) (*computed, error) {
	return func(ctx context.Context, r *http.Request) (*computed, error) {
		user, err := s.Resolver.Resolve(ctx, r)
		if err != nil {
			return nil, err
		}
		if user == nil || !user.APIKey {
			return nil, fallback.New("origin")
		}
		return fn(auth.WithResolved(ctx, user, nil), r)
	}
}

// ServedByHeader is on every answer a public tRPC route writes or proxies, naming who produced it:
// ServedByGo when this service computed (or refused) it, ServedByNode when it was handed to the Node
// app. A client comparing this route with the Node route reads it, so a fallback answer (Node's own
// bytes) is never counted as Go matching Node.
const (
	ServedByHeader = "X-Feed-Go-Served"
	ServedByGo     = "go"
	ServedByNode   = "node"
)

// serve is a public route: off (non-nil) is the fallback answered before anything else; then the API
// request policy, the origin check, and fn inside a serve slot. An answer is written here; any
// fallback is proxied to the Node app. The serve slots (MaxInFlight) are shared by every public route.
func (s *Server) serve(w http.ResponseWriter, r *http.Request, endpoint, procedure string, off error, fn func(context.Context, *http.Request) (*computed, error)) {
	withProfileLabels(r.Context(), endpoint, "serve", func(ctx context.Context) {
		s.serveLabelled(w, r.WithContext(ctx), endpoint, procedure, off, fn)
	})
}

// serveLabelled is serve under the request's profile labels (withProfileLabels).
func (s *Server) serveLabelled(w http.ResponseWriter, r *http.Request, endpoint, procedure string, off error, fn func(context.Context, *http.Request) (*computed, error)) {
	start := time.Now()
	// The request's span (tracing on only): the compute, its store spans and the proxy hop are its
	// children, and the duration exemplar is its trace id.
	ctx, span := s.startSpan(r.Context(), r.Header, "serve", endpoint)
	defer span.End()
	if s.Tracer != nil {
		r = r.WithContext(ctx)
	}
	if s.WriteDevalue && trpc.CanDecodeDevalueResponse(r.Header) {
		// runWithResponseWriteFormat: the answer may be devalue (encode decides, after the cache policy).
		r = r.WithContext(trpc.WithDevalueWrite(r.Context()))
	}
	// The eval capture reads the viewer the compute resolves (nil with the capture off: r unchanged).
	var viewer *viewerObs
	if s.EvalCapture.on() {
		var vctx context.Context
		vctx, viewer = s.observeViewer(r.Context())
		r = r.WithContext(vctx)
	}
	var (
		c   *computed
		err error
	)
	if off != nil {
		err = off
	} else {
		switch err = s.apiRequestPolicy(r); {
		case err != nil:
		case AcceptableOrigin(r, s.AllowedOrigins):
			c, err = s.computeServe(r, endpoint, fn)
		case s.Resolver != nil && s.Resolver.APIKeys != nil && auth.CarriesBearer(r):
			// createContext accepts any origin for a request whose API key resolved to a session
			// (isBearerAuth); a key that resolves to none is held to the origin like a cookie caller.
			c, err = s.computeServe(r, endpoint, s.bearerOrigin(fn))
		default:
			// The app's answer differs by environment and credential (non-production and bearer callers
			// are accepted, a cookie caller in production is refused): never decided here.
			err = fallback.New("origin")
		}
	}
	if err == nil {
		// An answer that loaded no row is `served_empty`, as in the shadow path, so the per-served-call
		// figures cover only answers that did the work.
		served := "served"
		if c.trivial {
			served = "served_empty"
		}
		w.Header().Set(ServedByHeader, ServedByGo)
		trpc.WriteResult(w, c.payload, c.ttl)
		s.noteWriteFormat(ctx, endpoint, c)
		// The serve-side parity sample (off by default) copies what it compares before the release;
		// its replay starts only after the answer is written and never touches w.
		replay := s.sampleParity(r, endpoint, c, viewer)
		c.release() // WriteResult has sent payload and keeps no reference
		setOutcome(span, served)
		s.Metrics.Requests.WithLabelValues(endpoint, "serve", served).Inc()
		tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", served), time.Since(start).Seconds())
		s.startParity(replay)                          //nolint:contextcheck // the replay runs after the answer, on the server's background context (Close cancels it): it must outlive the request
		s.sampleServeCapture(r, endpoint, viewer, nil) //nolint:contextcheck // the capture finishes after the answer, on the server's background context
		return
	}
	if s.answerRegionBlocked(ctx, span, start, w, endpoint, err) {
		return
	}
	// r, not ctx, carries the devalue mark (set above, after the span).
	if s.answerFeedUnavailable(ctx, span, start, w, endpoint, procedure, trpc.DevalueWrite(r.Context(), nil), err) {
		return
	}
	if !s.serveFallback(ctx, span, start, endpoint, err) {
		return
	}
	if s.Fallback == nil && !s.EvalMode {
		w.Header().Set(ServedByHeader, ServedByGo)
		trpc.WriteError(w, procedure, &trpc.Error{Code: "INTERNAL_SERVER_ERROR", HTTPStatus: 503, Message: "unavailable"})
		return
	}
	// The original request (and its context): the budget bounded only this service's own compute.
	s.handBack(s.Fallback, w, r, endpoint, err)
	s.sampleServeCapture(r, endpoint, viewer, err) //nolint:contextcheck // the capture finishes after the answer, on the server's background context
}

// HandbackStatus and HandbackReasonHeader are eval mode's hand-back stub (EvalMode): a request a
// public route would proxy to the Node app is answered with HandbackStatus, an empty body, and the
// fallback reason in HandbackReasonHeader (fallback.Reason; HandbackReasonError for a compute error,
// which has none). 599 is outside every status the app or this service answers, so a replay can never
// mistake the stub for an answer.
const (
	HandbackStatus       = 599
	HandbackReasonHeader = "X-Feed-Go-Handback-Reason"
	HandbackReasonError  = "error"
)

// handBack hands a public request this service did not answer (err: the fallback, or the compute
// error) to upstream, the route's Node app. Every public route's hand-back goes through it, so eval
// mode's stub covers them all: with EvalMode the stub is written and upstream is never called (it may
// be nil). Otherwise ServedByHeader says the Node app answered (set before the proxy copies the app's
// headers in, so it is on the proxy's own 502 too) and the request is proxied.
func (s *Server) handBack(upstream http.Handler, w http.ResponseWriter, r *http.Request, endpoint string, err error) {
	w.Header().Set(ServedByHeader, ServedByNode)
	if s.EvalMode {
		reason := fallback.Reason(err)
		if reason == "" {
			reason = HandbackReasonError
		}
		w.Header().Set(HandbackReasonHeader, reason)
		w.WriteHeader(HandbackStatus)
		return
	}
	s.proxyVia(upstream, w, r, endpoint)
}

// serveFallback records a public request that was not answered here (err, a fallback or an error)
// and reports whether it is to be proxied: not when the client has gone (`canceled`), as nobody would
// read the answer and proxying would only make the Node app compute one. Every public route's
// fallback goes through it.
func (s *Server) serveFallback(ctx context.Context, span trace.Span, start time.Time, endpoint string, err error) bool {
	outcome := "fallback"
	reason := fallback.Reason(err)
	if reason == "" {
		outcome, reason = "error", "error"
		s.noteError(ctx, slog.LevelError, "feed compute failed; falling back", "serve", endpoint, err)
	} else {
		s.noteFallback(ctx, "serve", endpoint, err)
	}
	setOutcome(span, outcome)
	s.Metrics.Requests.WithLabelValues(endpoint, "serve", outcome).Inc()
	s.Metrics.Fallbacks.WithLabelValues(endpoint, "serve", reason).Inc()
	tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", outcome), time.Since(start).Seconds())
	return reason != "canceled"
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
	// ResponseHeaderSet names the list ResponseHeaders was picked from: ResponseHeaderSetREST for a REST
	// sample (shadow.RESTComparedHeaders), "" for shadow.ComparedHeaders (a tRPC sample, or a REST one
	// from a sampler that predates the REST list).
	ResponseHeaderSet string `json:"responseHeaderSet,omitempty"`
	// Upstream is a site-search sample's search-backend response, as Node received it (its 200 body):
	// the shadow reshapes it rather than asking the backend again (DESIGN.md §18.4).
	Upstream json.RawMessage `json:"upstream,omitempty"`
	// SampleRate is the effective rate the Node sampler took this sample at: its configured rate times
	// the share of selected requests its per-second bucket and in-flight cap admitted for the endpoint
	// over a recent window (0: not sent, an older sampler). Read only for the eval capture's weight;
	// a value outside (0, 1] is ignored (sampleRateOr).
	SampleRate float64 `json:"sampleRate,omitempty"`
	// CorpusOnly marks a corpus-only sample (FEED_GO_SHADOW_CORPUS_ONLY_RATE, DESIGN.md §19.6 T4): a
	// credentialed request Node took the credential out of, sent for the eval capture only. It is never
	// computed or compared, carries no Node answer, and is refused if it still carries a credential
	// (captureCorpusOnly).
	CorpusOnly bool `json:"corpusOnly,omitempty"`
	// Credential is a corpus-only sample's credential class: evalcorpus.CredentialHeader or
	// evalcorpus.CredentialQuery, exactly (anything else is refused).
	Credential string `json:"credential,omitempty"`
}

// ResponseHeaderSetREST marks a sample whose ResponseHeaders are shadow.RESTComparedHeaders.
const ResponseHeaderSetREST = "rest"

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
	withProfileLabels(r.Context(), endpoint, "shadow", func(ctx context.Context) {
		s.shadowHandlerLabelled(w, r.WithContext(ctx), endpoint) //nolint:contextcheck // the background work runs on the server's background context after the 202 is written: it must outlive the request
	})
}

// shadowHandlerLabelled is shadowHandler under the sample's profile labels (withProfileLabels); its
// background goroutine runs the comparison under them too.
func (s *Server) shadowHandlerLabelled(w http.ResponseWriter, r *http.Request, endpoint string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// The sample's span: an independent root (the Node samplers send no traceparent; an inbound one is honoured). It ends
	// with the comparison (in the goroutine below), or here when the sample is not taken.
	spanCtx, span := s.startSpan(r.Context(), r.Header, "shadow", endpoint)
	spanHandedOff := false
	defer func() {
		if !spanHandedOff {
			span.End()
		}
	}()
	// Register with the shutdown wait first: once Close has begun, a sample is dropped, and every
	// sample Close does not see starting here cannot start at all.
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		setOutcome(span, "dropped")
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
		setOutcome(span, "dropped")
		s.Metrics.ShadowDropped.WithLabelValues(endpoint).Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.shadowStarts.Add(1)
	decode := s.startPhase()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxShadowBody))
	if err != nil {
		s.endPhase(spanCtx, decode, endpoint, "decode", "bad_request")
		<-s.ShadowQueue
		setOutcome(span, "bad_request")
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var req ShadowRequest
	err = json.Unmarshal(body, &req)
	if err == nil && req.CorpusOnly {
		// Capture-only: never computed or compared, so no shadow result is counted. Done here rather
		// than on a goroutine: the viewer is not resolved (a corpus-only request carries no cookie
		// and no credential, so it is signed out) and Record only strips, signs and queues, so it
		// costs no I/O. It holds the queue slot (released by defer) and the shutdown registration
		// (s.shadows, released by this handler's defer) until it returns; a panic is recovered and
		// counted as the sample goroutine's is, and answered 500.
		s.endPhase(spanCtx, decode, endpoint, "decode", "ok")
		code := http.StatusInternalServerError
		func() {
			defer func() { <-s.ShadowQueue }()
			defer func() {
				if p := recover(); p != nil {
					s.panicked("eval-capture", p, debug.Stack())
				}
			}()
			code = s.captureCorpusOnly(spanCtx, endpoint, req)
		}()
		setOutcome(span, "corpus_only")
		w.WriteHeader(code)
		return
	}
	if err != nil || len(req.Node) == 0 {
		s.endPhase(spanCtx, decode, endpoint, "decode", "bad_request")
		<-s.ShadowQueue
		setOutcome(span, "bad_request")
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "bad_request").Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.endPhase(spanCtx, decode, endpoint, "decode", "ok")
	w.WriteHeader(http.StatusAccepted)
	started = true
	spanHandedOff = true
	go func() { //nolint:contextcheck // runs after the 202 on the server's background context (Close cancels it): it must outlive the request
		// Deferred in this order so they run in reverse: recover first (a panic in compare or
		// classify is counted, never fatal), then the queue slot is released, then shutdown is told,
		// and the span ends before all of them.
		defer s.shadows.Done()
		defer func() { <-s.ShadowQueue }()
		defer func() {
			if p := recover(); p != nil {
				s.panicked("shadow", p, debug.Stack())
			}
		}()
		defer span.End()
		// Marked as shadow: its feed-service calls carry the shadow headers (feedsvc.WithShadow).
		ctx, cancel := context.WithTimeout(feedsvc.WithShadow(s.background()), shadowSampleTimeout)
		defer cancel()
		if s.Tracer != nil {
			ctx = trace.ContextWithSpan(ctx, span)
		}
		withProfileLabels(ctx, endpoint, "shadow", func(ctx context.Context) { s.compare(ctx, endpoint, req) })
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

// The synthetic requests carry the sampler's credential placeholder, never a key: their context is
// marked so an API credential stays the `bearer-token` fallback (auth.WithRedactedCredentials). It is
// also marked as a sample (withSampled): its verified-crawler header is the app's own decision.
func syntheticTRPCRequest(ctx context.Context, req ShadowRequest, procedure string) (*http.Request, error) {
	u := &url.URL{Path: "/api/trpc/" + procedure, RawQuery: url.Values{"input": {req.Input}}.Encode()}
	r, err := http.NewRequestWithContext(withSampled(auth.WithRedactedCredentials(ctx)), http.MethodGet, u.String(), nil)
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
// string as Node received them, and the forwarded headers. It is marked as a sample (withSampled): its
// verified-crawler header is the app's own decision, which the response headers read
// (v1ImagesCompute), as on the model routes.
func SyntheticV1Request(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	r, err := http.NewRequestWithContext(withSampled(auth.WithRedactedCredentials(ctx)), http.MethodGet, V1ImagesPath, nil)
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
		// The public route's compute, with the headers it writes (v1ImagesCompute; computeV1Fn in tests).
		build, computeFn = SyntheticV1Request, s.v1ImagesCompute(false)
		// `modelVersionIds` compared as a multiset (shadow.CompareV1Images).
		compareFn, classify = shadow.CompareV1Images, shadow.ClassifyJSON
	case EndpointInfinite:
		// The superjson envelope, as for the gallery; classified by image id (a flat page).
		build, computeFn = SyntheticInfiniteRequest, s.computeInfinite
		classify = trpcClassify(endpoint)
		if s.computeInfiniteFn != nil {
			computeFn = s.computeInfiniteFn
		}
	case EndpointModelGetAll:
		// The superjson envelope, as for the gallery; classified by model id (a flat page).
		build, computeFn = SyntheticModelGetAllRequest, s.computeModelGetAll
		classify = trpcClassify(endpoint)
		if s.computeModelsFn != nil {
			computeFn = s.computeModelsFn
		}
	}
	if b, c, cl, ok := s.v1ModelsRoute(endpoint); ok {
		build, computeFn, compareFn, classify = b, c, shadow.CompareJSON, cl
	}
	if b, c, cl, ok := s.associatedRoute(endpoint); ok {
		build, computeFn, classify = b, c, cl
	}
	if b, c, cl, ok := s.searchRoute(endpoint); ok {
		build, computeFn, compareFn, classify = b, c, shadow.CompareJSON, cl
	}
	span := trace.SpanFromContext(ctx)
	// The sample's credential is the sampler's placeholder, never a key: the compute's Resolve reads
	// the marker off this context (auth.WithRedactedCredentials).
	ctx = auth.WithRedactedCredentials(ctx)
	// The eval capture reads the viewer the compute resolves (nil observer with the capture off).
	ctx, viewer := s.observeViewer(ctx)
	r, err := build(ctx, req)
	if err != nil {
		setOutcome(span, "bad_request")
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "bad_request").Inc()
		return
	}
	start := time.Now()
	phase := s.startPhase()
	c, err := s.computeWithin(ctx, r, "shadow", computeFn)
	if err != nil {
		if reason := fallback.Reason(err); reason != "" {
			s.endPhase(ctx, phase, endpoint, "compute", "fallback")
			s.Metrics.Requests.WithLabelValues(endpoint, "shadow", "fallback").Inc()
			s.Metrics.Fallbacks.WithLabelValues(endpoint, "shadow", reason).Inc()
			// A compute cut by the budget is its own result, not `unsupported`: the match-rate
			// denominator leaves both out, and this keeps the budget's share visible (DESIGN.md §10).
			result := "unsupported"
			if reason == "deadline" {
				result = "deadline"
			}
			s.noteFallback(ctx, "shadow", endpoint, err)
			setOutcome(span, "fallback")
			if span.IsRecording() {
				span.SetAttributes(attrShadowResult.String(result))
			}
			s.Metrics.ShadowResults.WithLabelValues(endpoint, result).Inc()
			tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "shadow", "fallback"), time.Since(start).Seconds())
			s.captureShadow(ctx, endpoint, req, r, viewer, compareOutcome{result: result, reason: reason})
			return
		}
		s.endPhase(ctx, phase, endpoint, "compute", "error")
		setOutcome(span, "error")
		s.Metrics.Requests.WithLabelValues(endpoint, "shadow", "error").Inc()
		s.Metrics.ShadowResults.WithLabelValues(endpoint, "go_error").Inc()
		s.noteError(ctx, slog.LevelWarn, "shadow compute failed", "shadow", endpoint, err)
		s.captureShadow(ctx, endpoint, req, r, viewer, compareOutcome{result: "go_error"})
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
	s.endPhase(ctx, phase, endpoint, "compute", served)
	setOutcome(span, served)
	s.Metrics.Requests.WithLabelValues(endpoint, "shadow", served).Inc()
	tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "shadow", served), time.Since(start).Seconds())
	phase = s.startPhase()
	sink := compareSink{source: SourceShadow, results: s.Metrics.ShadowResults, diffs: s.Metrics.ShadowDiffs, response: s.Metrics.ShadowResponse}
	// The phase ends once compared, before the result is counted (a reader of the result then sees
	// the phase).
	out := s.compareAnswer(ctx, endpoint, sink, c, req.Node, req.ResponseHeaders, req.ResponseHeaderSet, compareFn, classify,
		func(ok bool) {
			outcome := "ok"
			if !ok {
				outcome = "bad_request"
			}
			s.endPhase(ctx, phase, endpoint, "compare", outcome)
		})
	s.captureShadow(ctx, endpoint, req, r, viewer, out)
}

// compareOutcome is what one comparison found, for the eval capture: the body's result (a
// feed_go_shadow_compare_total result), the headers' (match | mismatch | uncompared), and the
// categories of every differing path (body and headers; no values). reason is a fallback's reason when
// there was no comparison.
type compareOutcome struct {
	result, header, reason string
	categories             []string
}

// compareSink is where one comparison is counted: the comparison families curried with its source
// (shadow: a Node sample; serve-parity: a replay of a served answer, serveparity.go).
type compareSink struct {
	source                   string
	results, diffs, response *prometheus.CounterVec
}

// trpcClassify is the classifier of a tRPC endpoint's superjson envelope: the gallery's posts
// (shadow.Classify), or a flat page classified by item id (image.getInfinite, model.getAll).
func trpcClassify(endpoint string) func(*shadow.Report, []byte, []byte) string {
	switch endpoint {
	case EndpointInfinite, EndpointModelGetAll:
		return shadow.ClassifyFlat
	}
	return shadow.Classify
}

// compareAnswer compares Go's answer c with Node's (node; nodeHeaders, nil = not sent) and counts the
// result, the differing categories and the header comparison into sink, and returns them. It is the
// one comparison both the shadow sample and the serve-side parity replay run. The two bodies that
// cannot be compared are result bad_request. compared (nil = none) runs once the comparison is done
// (ok false: bad_request), before the result is counted.
func (s *Server) compareAnswer(ctx context.Context, endpoint string, sink compareSink, c *computed, node []byte, nodeHeaders map[string]string, headerSet string,
	compareFn func([]byte, []byte) (*shadow.Report, error), classify func(*shadow.Report, []byte, []byte) string, compared func(ok bool)) compareOutcome {
	span := trace.SpanFromContext(ctx)
	report, err := compareFn(c.payload, node)
	if err != nil {
		if compared != nil {
			compared(false)
		}
		sink.results.WithLabelValues(endpoint, "bad_request").Inc()
		return compareOutcome{result: "bad_request"}
	}
	result := classify(report, c.payload, node)
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
	respResult := "uncompared"
	switch {
	case nodeHeaders == nil || (isRESTEndpoint(endpoint) && c.headers == nil):
		// A sampler that predates the field sends none; a model list sample with an `etag` query has
		// none computed (v1ModelsHeadersUnknown), nor an images sample whose body has no known
		// JSON.stringify text (v1ImagesCompute): nothing to compare.
		sink.response.WithLabelValues(endpoint, "uncompared").Inc()
	default:
		goHeaders, names := trpc.ResultHeaders(c.ttl), shadow.ComparedHeaders
		if isRESTEndpoint(endpoint) {
			// The REST routes: the headers the public route writes (v1models_serve.go, v1images_serve.go).
			goHeaders = v1models.HeaderMap(c.headers)
			if headerSet == ResponseHeaderSetREST {
				names = shadow.RESTComparedHeaders
				if endpoint == EndpointSearch {
					names = SearchComparedHeaders
				}
			}
		}
		respDiffs = shadow.CompareResponseHeaders(goHeaders, nodeHeaders, names)
		respResult = "match"
		if len(respDiffs) > 0 {
			respResult = "mismatch"
		}
		sink.response.WithLabelValues(endpoint, respResult).Inc()
		if c.viewerClass != "" && sink.source == SourceShadow && isFeedViewerEndpoint(endpoint) {
			// Who may cache the answer differs by viewer (signed out: the edge), so the headers'
			// result is read per class too.
			s.Metrics.ShadowResponseViewer.WithLabelValues(endpoint, c.viewerClass, respResult).Inc()
		}
	}
	if compared != nil {
		compared(true)
	}
	if span.IsRecording() {
		span.SetAttributes(attrShadowResult.String(result))
	}
	sink.results.WithLabelValues(endpoint, result).Inc()
	if c.viewerClass != "" && sink.source == SourceShadow {
		s.Metrics.ShadowViewer.WithLabelValues(endpoint, c.viewerClass, result).Inc()
	}
	diffs := make([]shadow.Diff, 0, len(report.Diffs)+len(respDiffs))
	diffs = append(diffs, report.Diffs...)
	diffs = append(diffs, respDiffs...)
	categories := make([]string, 0, len(diffs))
	for _, d := range diffs {
		sink.diffs.WithLabelValues(endpoint, d.Category, d.Kind).Inc()
		categories = append(categories, d.Category)
	}
	unexpected := 0
	for _, d := range respDiffs {
		if !expectedResponseDiff(d) {
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
		s.Log.Log(ctx, level, "shadow diff", traceAttrs(ctx, []any{"endpoint", endpoint, "source", sink.source, "result", result, "paths", paths,
			"truncated", report.Truncated})...)
	}
	return compareOutcome{result: result, header: respResult, categories: categories}
}

// isRESTEndpoint: the REST ports (v1-images, v1-models, v1-models-id, site-search).
func isRESTEndpoint(endpoint string) bool {
	switch endpoint {
	case EndpointV1Images, EndpointV1Models, EndpointV1ModelsID, EndpointSearch:
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

// expectedResponseDiff reports whether a header difference is one DESIGN.md §7 lists: x-update-required
// only from Node (this service never tells a bundle to reload).
func expectedResponseDiff(d shadow.Diff) bool {
	return d.Category == "header:x-update-required" && d.Kind == "missing-in-go"
}
