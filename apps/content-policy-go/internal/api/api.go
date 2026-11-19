// Package api is the service's HTTP surface:
//
//	POST /v1/decide  {context, userId?, country?, region?, isUk?, host?} → a decision (DESIGN.md)
//	GET  /healthz    the process is up
//	GET  /readyz     200 once the database answers, 503 before
//	GET  /metrics    Prometheus
//
// POST, not GET: the input names a user and where they are, and a query string is written to every
// access log on the way; a body is not. Nothing here is cacheable by a proxy anyway: the caller keeps
// the answer (DESIGN.md "Caching").
//
// Fail closed: every answer that is not a decision carries the SFW decision (policy.SFW) in the same
// shape, with `fallback: true` and a status that is not 200: 400 for a malformed request
// (reason=invalid-input), 422 for a request missing an input its context requires
// (reason=missing-input: the site's host, or a country), 503 when the user's settings could not be
// read (reason=error), 500 for anything else (reason=error). A caller that reads only the body
// still gets SFW.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/civitai/civitai/apps/content-policy-go/internal/metrics"
	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// Bounds of a request.
const (
	MaxBodyBytes = 4096
	MaxFieldLen  = 64
	MaxUserID    = 1<<31 - 1 // "User".id is an int4
)

// Users answers a user's settings through the cache (users.Cache).
type Users interface {
	Lookup(ctx context.Context, id int64) (u policy.User, found, hit bool, err error)
}

// Server answers the HTTP API.
type Server struct {
	Engine   *policy.Engine
	Users    Users
	Metrics  *metrics.Metrics
	Gatherer prometheus.Gatherer
	Log      *slog.Logger
	// LookupTimeout bounds one user read (the cache miss); past it the answer is the SFW fallback.
	LookupTimeout time.Duration
	// Ready reports whether the database answers (/readyz).
	Ready func(ctx context.Context) error
	// Now is the decision time; time.Now when nil.
	Now func() time.Time
}

// Request is the body of POST /v1/decide. A string field that is absent or null is a header the
// edge did not send; each is passed on exactly as the edge sent it (DESIGN.md "The contract").
type Request struct {
	Context string  `json:"context"`
	UserID  *int64  `json:"userId"`
	Country *string `json:"country"`
	Region  *string `json:"region"`
	IsUK    *string `json:"isUk"`
	Host    *string `json:"host"`
}

// Response is a decision with the policy version it was made under.
type Response struct {
	policy.Decision
	Context       string `json:"context"`
	PolicyVersion string `json:"policyVersion"`
	// Fallback is true when this is the SFW fallback rather than a decision about this viewer.
	Fallback bool   `json:"fallback"`
	Error    string `json:"error,omitempty"`
}

// Handler is the routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("POST /v1/decide", s.decide)
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.Gatherer, promhttp.HandlerOpts{}))
	return mux
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := s.Ready(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ready": false, "error": "database"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "policyVersion": s.Engine.PolicyVersion()})
}

func (s *Server) decide(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	label := metrics.InvalidContext
	var res Response
	status := http.StatusOK
	defer func() {
		// A panic anywhere below still answers the SFW fallback, never nothing.
		if p := recover(); p != nil {
			s.Log.Error("decide panicked", "panic", p)
			status, res = http.StatusInternalServerError, s.fallback(res.Context, policy.ReasonError, "internal")
		}
		s.Metrics.Decisions.WithLabelValues(label, res.Reason, res.RegionHold).Inc()
		s.Metrics.Duration.WithLabelValues(label).Observe(time.Since(start).Seconds())
		writeJSON(w, status, res)
	}()

	req, err := DecodeRequest(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	label = metrics.ContextLabel(req.Context)
	if err != nil {
		status, res = http.StatusBadRequest, s.fallback(req.Context, policy.ReasonInvalidInput, err.Error())
		return
	}
	in := policy.Input{
		Context:  req.Context,
		Location: policy.Location{Country: req.Country, Region: req.Region, IsUK: req.IsUK},
		At:       s.now(),
	}
	if req.Host != nil {
		in.Host = *req.Host
	}
	// Fail closed on a missing input the context requires: the site would answer it as mature.
	if missing := policy.Missing(req.Context, in.Location, in.Host); missing != "" {
		status, res = http.StatusUnprocessableEntity, s.fallback(req.Context, policy.ReasonMissingInput, missing+" is required for "+req.Context)
		return
	}
	if req.UserID != nil && policy.ReadsUser(req.Context) {
		u, found, lookupErr := s.lookup(r.Context(), *req.UserID)
		if lookupErr != nil {
			status, res = http.StatusServiceUnavailable, s.fallback(req.Context, policy.ReasonError, "user settings unavailable")
			return
		}
		in.Viewer, in.User = policy.Unavailable, policy.User{}
		if found {
			in.Viewer, in.User = policy.SignedIn, u
		}
	}
	d, err := s.Engine.Decide(in)
	if err != nil { // DecodeRequest admits only known contexts; kept so a new error cannot fail open
		status, res = http.StatusInternalServerError, s.fallback(req.Context, policy.ReasonError, "internal")
		return
	}
	res = Response{Decision: d, Context: req.Context, PolicyVersion: s.Engine.PolicyVersion()}
}

// lookup reads a user's settings within LookupTimeout, counting the result.
func (s *Server) lookup(ctx context.Context, id int64) (policy.User, bool, error) {
	if s.LookupTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.LookupTimeout)
		defer cancel()
	}
	u, found, hit, err := s.Users.Lookup(ctx, id)
	result := "found"
	switch {
	case err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded):
		result = "timeout"
	case err != nil:
		result = "error"
	case hit:
		result = "cache_hit"
	case !found:
		result = "not_found"
	}
	s.Metrics.Lookups.WithLabelValues(result).Inc()
	if err != nil {
		s.Metrics.DBErrors.Inc()
		s.Log.Warn("user lookup", "result", result, "err", err)
	}
	return u, found, err
}

func (s *Server) fallback(context, reason, msg string) Response {
	return Response{
		Decision:      policy.SFW(reason),
		Context:       context,
		PolicyVersion: s.Engine.PolicyVersion(),
		Fallback:      true,
		Error:         msg,
	}
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// DecodeRequest reads and validates one request body: one JSON object, no unknown fields, a known
// context, a user id that is an int4 id, and string fields of at most MaxFieldLen bytes. The
// returned Request carries its context even when the body is otherwise invalid, for the metric.
func DecodeRequest(body io.Reader) (Request, error) {
	var req Request
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return req, errors.New("body too large")
		}
		return req, errors.New("body is not a decide request: " + err.Error())
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return req, errors.New("body has data after the request object")
	}
	if _, ok := policy.Contexts[req.Context]; !ok {
		return req, errors.New("context must be one of registry-subscription, site, public-api")
	}
	if req.UserID != nil && (*req.UserID < 1 || *req.UserID > MaxUserID) {
		return req, errors.New("userId must be a positive int4")
	}
	for name, v := range map[string]*string{"country": req.Country, "region": req.Region, "isUk": req.IsUK, "host": req.Host} {
		if v != nil && len(*v) > MaxFieldLen {
			return req, errors.New(name + " is too long")
		}
	}
	return req, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
