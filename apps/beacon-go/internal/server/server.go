// Package server is the HTTP surface: the public beacon routes (serve mode), the internal shadow
// compare endpoints, /metrics and /healthz.
package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/safe"
	"github.com/civitai/civitai/apps/beacon-go/internal/shadow"
)

// The modes (BEACON_GO_MODE).
const (
	// ModeShadow computes every answer and write and performs none: only the shadow compare endpoints
	// run, and there is no public listener.
	ModeShadow = "shadow"
	// ModeServe answers the beacons and sends their rows to the tracker; everything it will not answer
	// is proxied to the Node app.
	ModeServe = "serve"
)

// Writer queues tracker rows (tracker.Client).
type Writer interface {
	Enqueue(w beacon.Write) bool
}

// Server holds what the handlers share.
type Server struct {
	Engine  *beacon.Engine
	Mode    string
	Writer  Writer       // serve mode: where rows go (nil in shadow mode: nothing is ever written)
	Proxy   http.Handler // serve mode: the Node app, for every fallback
	Metrics *Metrics
	Log     *slog.Logger
	// ShadowQueue bounds concurrent shadow comparisons; a full queue drops the sample (never blocks
	// the Node sampler).
	ShadowQueue chan struct{}
	// ComputeBudget bounds one computation (the session read is its only I/O).
	ComputeBudget time.Duration
	// TrackBatchServe is BEACON_GO_TRACK_BATCH_SERVE (default off). Off, every /api/track/batch
	// request the public listener receives is proxied to the Node app unchanged (fallback reason
	// `disabled`), whatever share of that route the ingress sends here. Its shadow compare endpoint
	// runs either way, and never writes.
	TrackBatchServe bool

	shadowMu sync.Mutex
	closing  bool
	shadows  sync.WaitGroup
}

// DefaultComputeBudget is the deadline of one computation.
const DefaultComputeBudget = 2 * time.Second

func (s *Server) budget() time.Duration {
	if s.ComputeBudget > 0 {
		return s.ComputeBudget
	}
	return DefaultComputeBudget
}

func (s *Server) panicked(where string, err error) {
	s.Metrics.Panics.WithLabelValues(where).Inc()
	var pe *safe.PanicError
	if errors.As(err, &pe) {
		s.Log.Error("panic", "where", where, "value", pe.Value, "stack", string(pe.Stack))
	}
}

// Routes are the public path of each endpoint.
var Routes = map[string]string{
	beacon.EndpointPing:       "/api/internal/ping",
	beacon.EndpointPulse:      "/api/internal/pulse",
	beacon.EndpointTrackBatch: "/api/track/batch",
}

// PublicMux routes the beacons; every other path is proxied (it should never arrive: the ingress
// routes only these here).
func PublicMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	for _, endpoint := range Endpoints {
		mux.HandleFunc(Routes[endpoint], func(w http.ResponseWriter, r *http.Request) { s.serve(w, r, endpoint) })
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if s.Proxy == nil {
			http.NotFound(w, r)
			return
		}
		s.Proxy.ServeHTTP(w, r)
	})
	return mux
}

// InternalMux routes /metrics, /healthz and the shadow compare endpoints.
func InternalMux(s *Server, metrics http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	for _, endpoint := range Endpoints {
		mux.HandleFunc(ShadowPath(endpoint), func(w http.ResponseWriter, r *http.Request) {
			s.shadowHandler(w, r, endpoint) //nolint:contextcheck // compared after the 202 on a background context: it must outlive the request
		})
	}
	return mux
}

// ShadowPath is the internal compare path for an endpoint, `/internal/shadow` + its public route
// (the sampler appends it to BEACON_GO_SHADOW_URL: beaconGoShadowUrl in
// src/server/beacon/beacon-go-shadow.ts).
func ShadowPath(endpoint string) string { return "/internal/shadow" + Routes[endpoint] }

// serve answers one beacon, or proxies it to the Node app on a fallback.
func (s *Server) serve(w http.ResponseWriter, r *http.Request, endpoint string) {
	if endpoint == beacon.EndpointTrackBatch && !s.TrackBatchServe {
		// The switch is off: the request goes to the Node app as it came, body unread.
		s.Metrics.Fallbacks.WithLabelValues(endpoint, "serve", ReasonDisabled).Inc()
		s.Metrics.Requests.WithLabelValues(endpoint, "fallback").Inc()
		s.proxy(w, r)
		return
	}
	// Read at most one byte past Next's limit; a longer body is Next's 413 to give.
	body, err := io.ReadAll(io.LimitReader(r.Body, beacon.MaxBody+1))
	if err != nil {
		// The client went away mid-body: there is nobody to answer.
		s.Metrics.Requests.WithLabelValues(endpoint, "error").Inc()
		return
	}
	req := beacon.FromHTTP(r, body)
	ctx, cancel := context.WithTimeout(r.Context(), s.budget())
	defer cancel()
	out, err := safe.Call(func() (beacon.Outcome, error) { return s.Engine.Compute(ctx, endpoint, req) })
	if err != nil {
		reason := fallback.Reason(err)
		if reason == "" {
			reason = "error"
			if errors.As(err, new(*safe.PanicError)) {
				s.panicked("serve", err)
				reason = "panic"
			}
		}
		s.Metrics.Fallbacks.WithLabelValues(endpoint, "serve", reason).Inc()
		s.Metrics.Requests.WithLabelValues(endpoint, "fallback").Inc()
		// The proxy reads the body from the start: what was read, then whatever is left.
		r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
		s.proxy(w, r)
		return
	}
	if s.Writer != nil {
		for _, wr := range out.Writes {
			s.Writer.Enqueue(wr)
		}
	}
	s.Metrics.Requests.WithLabelValues(endpoint, "served").Inc()
	WriteResponse(w, out.Response)
}

// ReasonDisabled is the fallback reason of a /api/track/batch request while TrackBatchServe is off.
const ReasonDisabled = "disabled"

// proxy hands a request to the Node app; without one (never in serve mode) it is a 503.
func (s *Server) proxy(w http.ResponseWriter, r *http.Request) {
	if s.Proxy == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	s.Proxy.ServeHTTP(w, r)
}

// WriteResponse writes a computed response. No Content-Type is sniffed: Node's res.send of a string
// sets none, and net/http would otherwise add one.
func WriteResponse(w http.ResponseWriter, resp beacon.Response) {
	h := w.Header()
	h["Content-Type"] = nil
	for _, hd := range resp.Headers {
		h.Set(hd.Name, hd.Value)
	}
	w.WriteHeader(resp.Status)
	if resp.Body != "" {
		_, _ = io.WriteString(w, resp.Body)
	}
}

// maxShadowBody bounds a shadow sample: a beacon body is at most 1 MiB, plus headers and rows.
const maxShadowBody = 4 << 20

// shadowSampleTimeout bounds one comparison after the 202.
const shadowSampleTimeout = 10 * time.Second

func (s *Server) shadowHandler(w http.ResponseWriter, r *http.Request, endpoint string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	s.shadowMu.Lock()
	if s.closing {
		s.shadowMu.Unlock()
		s.Metrics.ShadowCompare.WithLabelValues(endpoint, shadow.ResultDropped).Inc()
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
	// A queue slot before the body is read: a full queue drops the sample without buffering it.
	select {
	case s.ShadowQueue <- struct{}{}:
	default:
		s.Metrics.ShadowCompare.WithLabelValues(endpoint, shadow.ResultDropped).Inc()
		w.WriteHeader(http.StatusAccepted)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxShadowBody))
	sample, derr := shadow.Decode(body)
	if err != nil || derr != nil {
		<-s.ShadowQueue
		s.Metrics.ShadowCompare.WithLabelValues(endpoint, shadow.ResultInvalid).Inc()
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	started = true
	go func() {
		defer s.shadows.Done()
		defer func() { <-s.ShadowQueue }()
		ctx, cancel := context.WithTimeout(context.Background(), shadowSampleTimeout)
		defer cancel()
		s.compare(ctx, endpoint, sample)
	}()
}

// compare computes one sample and counts the verdict. It never writes: the computed rows are only
// compared.
func (s *Server) compare(ctx context.Context, endpoint string, sample *shadow.Sample) {
	req, err := sample.Request(ctx)
	if err != nil {
		s.Metrics.ShadowCompare.WithLabelValues(endpoint, shadow.ResultInvalid).Inc()
		return
	}
	cctx, cancel := context.WithTimeout(ctx, s.budget())
	defer cancel()
	out, err := safe.Call(func() (beacon.Outcome, error) { return s.Engine.Compute(cctx, endpoint, req) })
	if errors.As(err, new(*safe.PanicError)) {
		s.panicked("shadow", err)
	}
	v := shadow.Compare(out, err, sample.Node)
	s.Metrics.ShadowCompare.WithLabelValues(endpoint, v.Result).Inc()
	switch v.Result {
	case shadow.ResultFallback:
		s.Metrics.Fallbacks.WithLabelValues(endpoint, "shadow", v.Reason).Inc()
	case shadow.ResultMatch:
	default:
		for _, d := range v.Diffs {
			s.Metrics.ShadowDiffs.WithLabelValues(endpoint, DiffField(d)).Inc()
		}
		// Field names only: rows carry an ip and a user agent.
		s.Log.Warn("shadow mismatch", "endpoint", endpoint, "result", v.Result, "diffs", v.Diffs)
	}
}

// Close stops accepting shadow samples and waits (until ctx ends) for the running ones.
func (s *Server) Close(ctx context.Context) error {
	s.shadowMu.Lock()
	s.closing = true
	s.shadowMu.Unlock()
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

// Listener limits (feed-go's, with the public read timeout sized for a 1 MiB beacon body).
const (
	MaxHeaderBytes       = 64 << 10
	ReadHeaderTimeout    = 5 * time.Second
	IdleTimeout          = 120 * time.Second
	PublicReadTimeout    = 15 * time.Second
	PublicWriteTimeout   = 60 * time.Second // covers a fallback the proxy relays
	InternalReadTimeout  = 30 * time.Second
	InternalWriteTimeout = 30 * time.Second
)

// PublicHTTPServer is the public listener (serve mode only).
func PublicHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr: addr, Handler: h,
		ReadHeaderTimeout: ReadHeaderTimeout, ReadTimeout: PublicReadTimeout,
		WriteTimeout: PublicWriteTimeout, IdleTimeout: IdleTimeout, MaxHeaderBytes: MaxHeaderBytes,
	}
}

// InternalHTTPServer is the internal listener: metrics, health and the shadow endpoints.
func InternalHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr: addr, Handler: h,
		ReadHeaderTimeout: ReadHeaderTimeout, ReadTimeout: InternalReadTimeout,
		WriteTimeout: InternalWriteTimeout, IdleTimeout: IdleTimeout, MaxHeaderBytes: MaxHeaderBytes,
	}
}

// ReadErrorReporter is the revocation check's OnReadError: every failed read counted, at most one warning
// per Every logged (with the number suppressed since).
type ReadErrorReporter struct {
	Log     *slog.Logger
	Counter interface{ Inc() }
	Every   time.Duration // 0 = 10 s
	Now     func() time.Time

	mu         sync.Mutex
	last       time.Time
	suppressed int
}

// Report records one failed read.
func (f *ReadErrorReporter) Report(err error) {
	if f.Counter != nil {
		f.Counter.Inc()
	}
	now := time.Now()
	if f.Now != nil {
		now = f.Now()
	}
	every := f.Every
	if every <= 0 {
		every = 10 * time.Second
	}
	f.mu.Lock()
	if !f.last.IsZero() && now.Sub(f.last) < every {
		f.suppressed++
		f.mu.Unlock()
		return
	}
	suppressed := f.suppressed
	f.suppressed, f.last = 0, now
	f.mu.Unlock()
	f.Log.Warn("revocation read failed; requests fall back", "err", err, "suppressed", suppressed)
}
