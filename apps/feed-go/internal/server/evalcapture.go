package server

import (
	"context"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"math/rand/v2"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The eval capture taps (DESIGN.md §19.6), behind FEED_GO_EVAL_CAPTURE (default off: EvalCapture nil,
// and then no tap does anything, not even a context value). Each tap hands one evalcapture.Sample to
// EvalCapture.Recorder.Record, which strips, signs, deduplicates and queues it, and counts the outcome
// in feed_go_eval_capture_total{feed_endpoint, source, outcome}:
//
//   - T1, source shadow: every Node shadow sample of a first-wave endpoint, in compare (the fallback,
//     error and compared branches), with Node's answer.
//   - T2, source serve-parity: every serve-parity replay that was compared, in replay, with Node's
//     answer.
//   - T3, source serve: a FEED_GO_EVAL_CAPTURE_SERVE_RATE fraction of the public requests of a
//     first-wave endpoint, after the answer was served or handed back (no Node answer).
//
// The viewer is the one the computation resolved (auth.WithResolveObserver: no extra store read). A
// request whose computation never resolved one (an early hand-back) is resolved in the background
// (T1 on the sample's own goroutine; T3 on an eval-capture worker), with credentials redacted, so an
// API key is never looked up for it: such a request is dropped (an API-key tap is a later change).

// DefaultEvalCaptureWorkers bounds the T3 captures in flight per pod (EvalCapture.Queue's capacity).
const DefaultEvalCaptureWorkers = 2

// evalCaptureResolveTimeout bounds T3's background viewer resolve.
const evalCaptureResolveTimeout = 2 * time.Second

// EvalRecorder is what the taps hand captures to (*evalcapture.Recorder).
type EvalRecorder interface {
	Record(evalcapture.Sample) string
}

// EvalCapture configures the taps. A nil *EvalCapture (or a nil Recorder) is off.
type EvalCapture struct {
	Recorder EvalRecorder
	// ShadowRate is FEED_GO_EVAL_CAPTURE_SHADOW_RATE: the Node shadow sampler's configured rate, read
	// for a T1 sample's weight when the sample does not carry its effective rate
	// (ShadowRequest.SampleRate). 0: the weight is 0 (unknown).
	// TODO(C4): drop once the Node sampler sends sampleRate with every sample.
	ShadowRate float64
	// ServeRate is FEED_GO_EVAL_CAPTURE_SERVE_RATE (default 0: T3 off): the fraction of public
	// first-wave requests captured.
	ServeRate float64
	// Queue holds one slot per T3 capture in flight (DefaultEvalCaptureWorkers); full: dropped.
	Queue chan struct{}
	// Random picks T3's sample (nil: math/rand/v2's Float64).
	Random func() float64
}

func (e *EvalCapture) on() bool { return e != nil && e.Recorder != nil }

// seedEvalCapture: every outcome of every source per endpoint that source can capture reads 0.
func (m *Metrics) seedEvalCapture() {
	for _, source := range evalcapture.Sources {
		for _, e := range evalCaptureEndpoints(source) {
			for _, o := range evalcapture.Outcomes {
				m.EvalCapture.WithLabelValues(e, source, o)
			}
		}
	}
}

// evalCaptureEndpoints are the endpoints a source captures: every first-wave endpoint (all are shadowed
// and have public routes), less the ones serve-parity does not replay.
func evalCaptureEndpoints(source string) []string {
	var out []string
	for _, e := range evalcorpus.Endpoints {
		if source == evalcapture.SourceServeParity && !isParityEndpoint(e) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// viewerObs records the viewer a computation resolved (auth.WithResolveObserver).
type viewerObs struct {
	mu   sync.Mutex
	seen bool
	user *auth.SessionUser
	err  error
}

func (o *viewerObs) observe(u *auth.SessionUser, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.seen, o.user, o.err = true, u, err
}

// get is the observed answer; seen false when nothing resolved.
func (o *viewerObs) get() (u *auth.SessionUser, seen bool, err error) {
	if o == nil {
		return nil, false, nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.user, o.seen, o.err
}

// observeViewer is ctx with a viewer observer when the capture is on (nil observer when off: ctx
// unchanged).
func (s *Server) observeViewer(ctx context.Context) (context.Context, *viewerObs) {
	if !s.EvalCapture.on() {
		return ctx, nil
	}
	o := &viewerObs{}
	return auth.WithResolveObserver(ctx, o.observe), o
}

// evalViewer is the corpus viewer of a resolved session user (nil: signed out). The hidden
// preferences and the viewer's collections are not known here (they would cost a read): HiddenPrefs
// is false and a collectionId input is kept as sent (DESIGN.md §19.6).
func evalViewer(u *auth.SessionUser, crawler bool) evalcorpus.Viewer {
	v := evalcorpus.Viewer{Class: feedViewerClass(u, crawler)}
	if u != nil {
		v.BrowsingLevel, v.ShowNsfw, v.UserID, v.Username = u.BrowsingLevel, u.ShowNsfw, u.ID, u.Username
	}
	return v
}

// evalRequest is the corpus request of a request to endpoint (credentials included; Record strips
// them). Several values of one header are joined with ", ", cookies with "; ".
func evalRequest(endpoint string, u *url.URL, header http.Header, host string) evalcorpus.Request {
	h := make(map[string]string, len(header)+1)
	for k, vs := range header {
		sep := ", "
		if http.CanonicalHeaderKey(k) == "Cookie" {
			sep = "; "
		}
		h[k] = strings.Join(vs, sep)
	}
	if host != "" {
		h["Host"] = host
	}
	req := evalcorpus.Request{Endpoint: endpoint, Headers: h}
	if isRESTEndpoint(endpoint) {
		req.Path, req.Query = u.Path, u.RawQuery
	} else {
		req.Input = u.Query().Get("input")
	}
	return req
}

// recordEval hands one capture to the recorder and counts its outcome.
func (s *Server) recordEval(endpoint string, sample evalcapture.Sample) {
	if o := s.EvalCapture.Recorder.Record(sample); o != "" {
		s.Metrics.EvalCapture.WithLabelValues(endpoint, sample.Source, o).Inc()
	}
}

// rateWeight is 1/rate, 0 when the rate is unknown.
func rateWeight(rate float64) float64 {
	if rate > 0 {
		return 1 / rate
	}
	return 0
}

// captureShadow is T1: a shadow sample of endpoint, rebuilt as r, with the production verdict out. It
// runs on the sample's goroutine; a viewer the computation did not resolve is resolved here (r's
// context is the sample's, credentials redacted).
func (s *Server) captureShadow(ctx context.Context, endpoint string, req ShadowRequest, r *http.Request, obs *viewerObs, out compareOutcome) {
	if !s.EvalCapture.on() || !evalcapture.Supported(endpoint) {
		return
	}
	u, seen, err := obs.get()
	if !seen && s.Resolver != nil {
		u, err = s.Resolver.Resolve(ctx, r)
	}
	rate := req.SampleRate
	if rate <= 0 {
		rate = s.EvalCapture.ShadowRate
	}
	s.recordEval(endpoint, evalcapture.Sample{
		Source:  evalcapture.SourceShadow,
		Request: evalRequest(endpoint, r.URL, r.Header, r.Host),
		Viewer:  evalViewer(u, verifiedCrawler(r)), ViewerKnown: err == nil,
		Weight:     rateWeight(rate),
		ProdResult: out.result, FallbackReason: out.reason, DiffCategories: out.categories, HeaderResult: out.header,
		NodeBody: req.Node, NodeHeaders: req.ResponseHeaders,
	})
}

// captureParity is T2: a compared serve-parity replay, with Node's answer.
func (s *Server) captureParity(rep *parityReplay, node []byte, nodeHeaders map[string]string, out compareOutcome) {
	if !s.EvalCapture.on() || !evalcapture.Supported(rep.endpoint) {
		return
	}
	s.recordEval(rep.endpoint, evalcapture.Sample{
		Source:  evalcapture.SourceServeParity,
		Request: evalRequest(rep.endpoint, &rep.url, rep.header, rep.host),
		Viewer:  rep.viewer, ViewerKnown: rep.viewerKnown,
		Weight:     rateWeight(s.Parity.Rate),
		ProdResult: out.result, DiffCategories: out.categories, HeaderResult: out.header,
		NodeBody: node, NodeHeaders: nodeHeaders,
	})
}

// sampleServeCapture is T3: for a public request of endpoint that was served (err nil) or handed back
// (err its fallback or error), decide at ServeRate whether it is captured and, if so, copy what the
// capture needs and finish it on an eval-capture worker. Never blocks the request: a full worker
// queue or shutdown is outcome dropped. Call it while r is still the handler's.
func (s *Server) sampleServeCapture(r *http.Request, endpoint string, obs *viewerObs, err error) {
	e := s.EvalCapture
	if !e.on() || e.ServeRate <= 0 || !evalcapture.Supported(endpoint) {
		return
	}
	random := e.Random
	if random == nil {
		random = rand.Float64
	}
	if random() >= e.ServeRate {
		return
	}
	sample := evalcapture.Sample{
		Source:     evalcapture.SourceServe,
		Request:    evalRequest(endpoint, r.URL, r.Header, r.Host),
		Weight:     rateWeight(e.ServeRate),
		ProdResult: evalcapture.ResultServed,
	}
	if err != nil {
		sample.ProdResult, sample.FallbackReason = evalcapture.ResultHandback, fallback.Reason(err)
		if sample.FallbackReason == "" {
			sample.ProdResult, sample.FallbackReason = evalcapture.ResultError, "error"
		}
	}
	u, seen, uerr := obs.get()
	if seen {
		sample.Viewer, sample.ViewerKnown = evalViewer(u, false), uerr == nil
	}
	// The request's own values, copied: r is not read once the handler returns.
	var replay *http.Request
	if !seen {
		replay = &http.Request{Method: r.Method, URL: cloneURL(r.URL), Header: r.Header.Clone(), Host: r.Host}
	}
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		s.Metrics.EvalCapture.WithLabelValues(endpoint, evalcapture.SourceServe, evalcapture.OutcomeDropped).Inc()
		return
	}
	select {
	case e.Queue <- struct{}{}:
	default:
		s.shadowMu.Unlock()
		s.Metrics.EvalCapture.WithLabelValues(endpoint, evalcapture.SourceServe, evalcapture.OutcomeDropped).Inc()
		return
	}
	s.shadows.Add(1)
	s.shadowMu.Unlock()
	go func() { //nolint:contextcheck // runs after the answer, on the server's background context (Close cancels it)
		defer s.shadows.Done()
		defer func() { <-e.Queue }()
		defer func() {
			if v := recover(); v != nil {
				s.panicked("eval-capture", v, debug.Stack())
			}
		}()
		if replay != nil {
			// Nothing resolved the viewer: resolve it now, credentials redacted (an API key is never
			// looked up here; the request is then dropped).
			ctx, cancel := context.WithTimeout(auth.WithRedactedCredentials(s.background()), evalCaptureResolveTimeout)
			defer cancel()
			var u *auth.SessionUser
			var uerr error
			if s.Resolver != nil {
				u, uerr = s.Resolver.Resolve(ctx, replay.WithContext(ctx))
			}
			sample.Viewer, sample.ViewerKnown = evalViewer(u, false), uerr == nil
		}
		s.recordEval(endpoint, sample)
	}()
}

func cloneURL(u *url.URL) *url.URL {
	c := *u
	if u.User != nil {
		uu := *u.User
		c.User = &uu
	}
	return &c
}
