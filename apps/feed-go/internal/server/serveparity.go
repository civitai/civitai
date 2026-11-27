package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"net/http"
	"net/url"
	"runtime/debug"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// The serve-side parity sampler (DESIGN.md §7.2). Once a tRPC route serves every request from Go, the
// Node shadow sampler sees none of them, so its comparison goes dark. For a sampled fraction of the
// requests this service SERVED, after the answer is written, the same request is replayed to the
// Node app (the fallback upstream), and Node's body is compared with what was served, by the same
// comparator and into the same metric families as a shadow sample, under source="serve-parity".

// SourceLabel splits the comparison families (feed_go_shadow_compare_total,
// feed_go_shadow_field_diffs_total, feed_go_shadow_response_total) by where the Node answer came
// from: SourceShadow, a sample Node posted after it served; SourceServeParity, a replay of a request
// this service served.
const (
	SourceLabel       = "source"
	SourceShadow      = "shadow"
	SourceServeParity = "serve-parity"
)

// ParityReplayHeader marks a replay. The Node app neither shadow-samples a request carrying it (the
// replay would otherwise be posted back here as a sample) nor writes it as devalue (the comparison
// reads superjson). A client that sends it itself only opts out of both, which changes nothing it reads.
const ParityReplayHeader = "X-Feed-Go-Parity-Replay"

// ParityEndpoints are the routes the sampler replays: the public tRPC routes whose answers the shadow
// comparison describes.
var ParityEndpoints = []string{EndpointAsPosts, EndpointInfinite, EndpointModelGetAll}

// Outcomes of feed_go_serve_parity_total. Every sampled served request ends in exactly one.
const (
	ParityCompared          = "compared"           // Node answered 200 with a tRPC result; compared (the result is in feed_go_shadow_compare_total)
	ParityDroppedQueue      = "dropped_queue"      // every replay slot was busy
	ParitySkippedBulkhead   = "skipped_bulkhead"   // the pod's serve slots were near full
	ParitySkippedCredential = "skipped_credential" // the request carried an API credential
	ParitySkippedClosing    = "skipped_closing"    // shutting down
	ParityUpstreamError     = "upstream_error"     // the Node app could not be reached, or broke the connection
	ParityUpstreamStatus    = "upstream_status"    // the Node app answered a status other than 200
	ParityTimeout           = "timeout"            // the replay ran past its deadline
	ParityBadBody           = "bad_body"           // Node's body was not a tRPC result (or over maxParityBody), or a devalue answer would not re-encode as superjson
)

// ServeParityOutcomes is every outcome, seeded at 0 per ParityEndpoints.
var ServeParityOutcomes = []string{ParityCompared, ParityDroppedQueue, ParitySkippedBulkhead, ParitySkippedCredential,
	ParitySkippedClosing, ParityUpstreamError, ParityUpstreamStatus, ParityTimeout, ParityBadBody}

// parityResults are the comparison results a replay can count (a served answer is never a fallback,
// so never unsupported, deadline or go_error); the seeded series.
var parityResults = []string{"match", "match_empty", "fields", "order", "membership", "bad_request"}

// DefaultServeParityTimeout bounds one replay, the Node app's answer and the comparison included.
const DefaultServeParityTimeout = 10 * time.Second

// DefaultServeParityWorkers is the replay slots per pod (Queue's capacity in production).
const DefaultServeParityWorkers = 4

// maxParityBody bounds Node's body held for one replay, as maxShadowBody bounds a sample.
const maxParityBody = maxShadowBody

// ServeParity configures the sampler. A nil *ServeParity, a Rate of 0 or a nil Upstream is off.
type ServeParity struct {
	// Rate is FEED_GO_SERVE_PARITY_SAMPLE_RATE: the fraction of served requests replayed (0 = off).
	Rate float64
	// Upstream answers the replay: the fallback proxy to the Node app (FEED_GO_FALLBACK_URL), with
	// its own error accounting (a replay's failure is not a fallback's).
	Upstream http.Handler
	// Queue holds one slot per replay in flight (DefaultServeParityWorkers); a full queue drops the
	// replay (dropped_queue). Never waited on.
	Queue chan struct{}
	// Timeout bounds one replay (0 = DefaultServeParityTimeout).
	Timeout time.Duration
	// Random picks the sample (nil = math/rand/v2's Float64).
	Random func() float64
}

func (p *ServeParity) on() bool { return p != nil && p.Rate > 0 && p.Upstream != nil }

func (p *ServeParity) timeout() time.Duration {
	if p.Timeout > 0 {
		return p.Timeout
	}
	return DefaultServeParityTimeout
}

// parityQueueLen is the replays in flight (0 with the sampler off).
func (s *Server) parityQueueLen() int {
	if s.Parity == nil {
		return 0
	}
	return len(s.Parity.Queue)
}

// seedServeParity: every outcome, and every comparison result a replay can count, per replayed
// endpoint, reads 0 rather than an absent series.
func (m *Metrics) seedServeParity() {
	for _, e := range ParityEndpoints {
		for _, o := range ServeParityOutcomes {
			m.ServeParity.WithLabelValues(e, o)
		}
		for _, r := range parityResults {
			if r == "match_empty" && !emptyReachable(e, "serve") {
				continue
			}
			m.ParityResults.WithLabelValues(e, r)
		}
		for _, r := range []string{"match", "mismatch", "uncompared"} {
			m.ParityResponse.WithLabelValues(e, r)
		}
	}
}

// parityReplay is what a replay needs, taken from the served request before the handler returns: the
// request is rebuilt from it, never read after.
type parityReplay struct {
	endpoint string
	method   string
	url      url.URL
	host     string
	remote   string
	header   http.Header
	// goBody is the served answer's superjson envelope; nil when it was written as devalue, and then
	// value is encoded as superjson in the background (the comparison reads superjson, as the shadow
	// compute writes it).
	goBody  []byte
	value   any
	ttl     *trpc.CacheTTL
	trivial bool
	// viewer is the served request's viewer, for the eval capture (viewerKnown false: none observed,
	// or the capture is off; viewerErr then the resolve's error, if one was observed).
	viewer      evalcorpus.Viewer
	viewerKnown bool
	viewerErr   error
}

// sampleParity decides, for an answer serve has just written, whether it is replayed, and takes the
// replay's copy of the request and the answer (and of the viewer the compute resolved, observed by
// viewer: nil with the eval capture off). Call it before c is released. Returns nil when not sampled
// (every skip after the sample decision is counted).
func (s *Server) sampleParity(r *http.Request, endpoint string, c *computed, viewer *viewerObs) *parityReplay {
	p := s.Parity
	if !p.on() || !isParityEndpoint(endpoint) {
		return nil
	}
	random := p.Random
	if random == nil {
		random = rand.Float64
	}
	if random() >= p.Rate {
		return nil
	}
	// A credential Node treats as its own viewer (an API key, a `?token=`) is never replayed: the
	// replay would present it again, and its answer can depend on the key's scopes.
	if auth.HasAPICredential(r) {
		s.Metrics.ServeParity.WithLabelValues(endpoint, ParitySkippedCredential).Inc()
		return nil
	}
	// A pod whose serve slots are near full has no room for the extra comparison work.
	if limit := s.maxInFlight(); s.inFlight.Load()*4 >= limit*3 {
		s.Metrics.ServeParity.WithLabelValues(endpoint, ParitySkippedBulkhead).Inc()
		return nil
	}
	rep := &parityReplay{
		endpoint: endpoint,
		method:   r.Method,
		url:      *r.URL,
		host:     r.Host,
		remote:   r.RemoteAddr,
		header:   r.Header.Clone(),
		ttl:      c.ttl,
		trivial:  c.trivial,
	}
	if r.URL.User != nil {
		u := *r.URL.User
		rep.url.User = &u
	}
	if u, seen, err := viewer.get(); seen {
		rep.viewer, rep.viewerKnown, rep.viewerErr = evalViewer(u, false), err == nil, err
	}
	if c.devalue {
		rep.value = c.value
	} else {
		rep.goBody = bytes.Clone(c.payload)
	}
	return rep
}

func isParityEndpoint(endpoint string) bool {
	for _, e := range ParityEndpoints {
		if e == endpoint {
			return true
		}
	}
	return false
}

// startParity runs rep in the background, bounded by the replay queue (full: dropped_queue) and
// registered with the shutdown wait (Close cancels it and waits). Never blocks, never touches the
// served response.
func (s *Server) startParity(rep *parityReplay) {
	if rep == nil {
		return
	}
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		s.Metrics.ServeParity.WithLabelValues(rep.endpoint, ParitySkippedClosing).Inc()
		return
	}
	select {
	case s.Parity.Queue <- struct{}{}:
	default:
		s.shadowMu.Unlock()
		s.Metrics.ServeParity.WithLabelValues(rep.endpoint, ParityDroppedQueue).Inc()
		return
	}
	s.shadows.Add(1)
	s.shadowMu.Unlock()
	// A replay in flight overlaps any shadow phase (endPhase attributes no CPU across it).
	s.shadowStarts.Add(1)
	go func() { //nolint:contextcheck // runs after the served answer, on the server's background context (Close cancels it)
		defer s.shadows.Done()
		defer func() { <-s.Parity.Queue }()
		defer func() {
			if v := recover(); v != nil {
				s.panicked("serve-parity", v, debug.Stack())
			}
		}()
		ctx, cancel := context.WithTimeout(s.background(), s.Parity.timeout())
		defer cancel()
		s.Metrics.ServeParity.WithLabelValues(rep.endpoint, s.replay(ctx, rep)).Inc()
	}()
}

// replay sends rep to the Node app and compares its answer; it returns the outcome.
func (s *Server) replay(ctx context.Context, rep *parityReplay) string {
	// The served request's own target, sent only to the fixed upstream (the fallback proxy rewrites
	// scheme and host to FEED_GO_FALLBACK_URL), never to a host the request names.
	req, err := http.NewRequestWithContext(ctx, rep.method, rep.url.String(), nil) //nolint:gosec // G704: see above; the upstream is fixed
	if err != nil {
		return ParityBadBody
	}
	u := rep.url
	req.URL = &u
	req.Host = rep.host
	req.RemoteAddr = rep.remote
	req.Header = rep.header
	// The transport negotiates (and decodes) its own compression: the comparison reads a plain body.
	req.Header.Del("Accept-Encoding")
	// The client's trace context is not the replay's: kept, Node's span of a background replay would
	// join the user's trace (the proxy injects nothing over it from this span-less context).
	for _, h := range replayStrippedTraceHeaders {
		req.Header.Del(h)
	}
	req.Header.Set(ParityReplayHeader, "1")
	rec := &replayRecorder{header: http.Header{}}
	status := s.serveReplay(rec, req)
	switch {
	case s.isClosing():
		// Shutdown cancelled it (Close cancels the background context): a rollout, not a slow Node.
		return ParitySkippedClosing
	case ctx.Err() != nil:
		return ParityTimeout
	case status != "":
		return status
	case rec.status != http.StatusOK:
		if rec.status == http.StatusBadGateway && rec.body.Len() == 0 {
			// The proxy's own answer to a Node app it could not reach (fallbackProxy's ErrorHandler).
			return ParityUpstreamError
		}
		return ParityUpstreamStatus
	case rec.over:
		return ParityBadBody
	}
	var env struct {
		Result *struct {
			Data json.RawMessage `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.body.Bytes(), &env); err != nil || env.Result == nil || len(env.Result.Data) == 0 {
		return ParityBadBody
	}
	goBody := rep.goBody
	if goBody == nil {
		buf, err := superjson.SerializeBuffer(rep.value)
		if err != nil {
			return ParityBadBody
		}
		defer buf.Release()
		goBody = buf.Bytes()
	}
	c := &computed{payload: goBody, ttl: rep.ttl, trivial: rep.trivial}
	sink := compareSink{source: SourceServeParity, results: s.Metrics.ParityResults, diffs: s.Metrics.ParityDiffs, response: s.Metrics.ParityResponse}
	nodeHeaders := pickResponseHeaders(rec.header)
	out := s.compareAnswer(ctx, CompareSelection(rep.endpoint), sink, c, env.Result.Data, nodeHeaders, "", nil)
	s.captureParity(rep, env.Result.Data, nodeHeaders, out)
	return ParityCompared
}

// replayStrippedTraceHeaders are the W3C trace-context and baggage headers a replay never forwards.
var replayStrippedTraceHeaders = []string{"Traceparent", "Tracestate", "Baggage"}

// isClosing: Close has begun.
func (s *Server) isClosing() bool {
	s.shadowMu.Lock()
	defer s.shadowMu.Unlock()
	return s.closing
}

// serveReplay runs the upstream for req, turning ReverseProxy's mid-body abort (a panic with
// http.ErrAbortHandler) into an outcome. "" = it returned normally.
func (s *Server) serveReplay(rec *replayRecorder, req *http.Request) (outcome string) {
	defer func() {
		if v := recover(); v != nil {
			if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				outcome = ParityUpstreamError
				return
			}
			panic(v)
		}
	}()
	s.Parity.Upstream.ServeHTTP(rec, req)
	return ""
}

// pickResponseHeaders is what the Node sampler sends as a sample's responseHeaders
// (pickShadowResponseHeaders): shadow.ComparedHeaders only, lowercased, each value cut at 1024
// characters, Set-Cookie as the literal `present`.
func pickResponseHeaders(h http.Header) map[string]string {
	return PickResponseHeaders(h, shadow.ComparedHeaders)
}

// maxComparedHeaderValue is the Node sampler's cut on a mirrored header value.
const maxComparedHeaderValue = 1024

// replayRecorder is the ResponseWriter a replay's upstream writes into: the status, the headers, and
// at most maxParityBody bytes of body (past it, the rest is discarded and over set, never an error the
// proxy would log).
type replayRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
	over   bool
}

func (r *replayRecorder) Header() http.Header { return r.header }

// Flush is a no-op: the proxy flushes a streamed answer as it copies it, and nothing reads this one
// before it ends.
func (r *replayRecorder) Flush() {}

func (r *replayRecorder) WriteHeader(code int) {
	if r.status == 0 && code >= 200 {
		r.status = code
	}
}

func (r *replayRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if r.over || r.body.Len()+len(b) > maxParityBody {
		r.over = true
		return len(b), nil
	}
	return r.body.Write(b)
}
