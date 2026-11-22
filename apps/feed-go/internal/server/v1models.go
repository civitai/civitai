package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The public REST model endpoints, shadowed (never served): DESIGN.md §16.
const (
	EndpointV1Models   = "v1-models"    // REST GET /api/v1/models
	EndpointV1ModelsID = "v1-models-id" // REST GET /api/v1/models/[id]

	V1ModelsPath = "/api/v1/models"
)

// V1ModelsDeps serves the two model shadows.
type V1ModelsDeps struct {
	Deps *v1models.Deps
	// Users resolves the list's `username` filter (hydrate.Sources).
	Users v1models.UsernameResolver
}

// ShadowV1ModelsHandler is the internal compare endpoint for REST `GET /api/v1/models`.
func (s *Server) ShadowV1ModelsHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointV1Models) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// ShadowV1ModelsIDHandler is the internal compare endpoint for REST `GET /api/v1/models/[id]`.
func (s *Server) ShadowV1ModelsIDHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointV1ModelsID) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// v1ModelsRoute is compare's dispatch for the two model endpoints: the request rebuild, the compute
// and the classification (both bodies are plain JSON, compared with shadow.CompareJSON).
func (s *Server) v1ModelsRoute(endpoint string) (
	build func(context.Context, ShadowRequest) (*http.Request, error),
	compute func(context.Context, *http.Request) (*computed, error),
	classify func(*shadow.Report, []byte, []byte) string,
	ok bool,
) {
	switch endpoint {
	case EndpointV1Models:
		compute = s.computeV1Models
		if s.computeV1ModelsFn != nil {
			compute = s.computeV1ModelsFn
		}
		return SyntheticV1ModelsRequest, compute, shadow.ClassifyJSON, true
	case EndpointV1ModelsID:
		compute = s.computeV1ModelsID
		if s.computeV1ModelsFn != nil {
			compute = s.computeV1ModelsFn
		}
		return SyntheticV1ModelsRequest, compute, ClassifyV1ModelID, true
	}
	return nil, nil, nil, false
}

// ClassifyV1ModelID classifies a `[id]` comparison: one model, so no order or membership within it —
// except a not-found answer against Node's 200, which is `membership` (the model itself differs).
func ClassifyV1ModelID(r *shadow.Report, goBody, _ []byte) string {
	if r.Match {
		return "match"
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(goBody, &probe) == nil {
		if _, notFound := probe["error"]; notFound {
			return "membership"
		}
	}
	return "fields"
}

// SyntheticV1ModelsRequest rebuilds the REST request a v1-models sample describes: its path and raw
// query string as Node received them, and the forwarded headers.
func SyntheticV1ModelsRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	r, err := http.NewRequestWithContext(auth.WithRedactedCredentials(ctx), http.MethodGet, V1ModelsPath, nil)
	if err != nil {
		return nil, err
	}
	path := req.Path
	if path == "" {
		path = V1ModelsPath
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

// v1ModelsHost is the request's Host header as Node reads it (`req.headers.host`: nextPage's origin,
// isRedCapableHost). net/http keeps it in r.Host, except on an absolute-form request line, where
// r.Host is the URL's host and the header is gone: such a request falls back rather than read a host
// Node would not. (A shadow sample is rebuilt in origin form with r.Host the forwarded header.)
func v1ModelsHost(r *http.Request) (string, error) {
	if r.URL != nil && r.URL.Host != "" {
		return "", fallback.New("v1-models-host")
	}
	return r.Host, nil
}

// v1ModelsAnswer encodes an answer as `res.json` writes it.
func v1ModelsAnswer(ans *v1models.Answer) (*computed, error) {
	buf, err := superjson.PlainBuffer(ans.Body)
	if err != nil {
		return nil, err
	}
	return &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial, cached: ans.Cached}, nil
}

func (s *Server) regionRestricted(r *http.Request) bool {
	return browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
}

// computeV1Models answers a REST `/api/v1/models` request (the MixedAuthEndpoint handler) for a
// signed-out caller; a session or an API credential falls back.
func (s *Server) computeV1Models(ctx context.Context, r *http.Request) (*computed, error) {
	if s.V1Models == nil || s.V1Models.Deps == nil {
		return nil, fallback.New("v1-models-unconfigured")
	}
	if r.Method != http.MethodGet {
		return nil, fallback.New("method")
	}
	// Parsed before the session: Node answers a 400/401/429 without it.
	if _, err := v1models.ParseList(r.URL.RawQuery); err != nil {
		return nil, err
	}
	// An API credential falls back (the route's block-scope middleware decides it; DESIGN.md §4.2).
	if auth.HasAPICredential(r) {
		return nil, fallback.New("bearer-token")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return nil, err
	}
	if user != nil {
		// The viewer reaches the query (own-content carve-outs), the file preference and the metric
		// privacy: not ported.
		return nil, fallback.New("v1-models-session")
	}
	host, err := v1ModelsHost(r)
	if err != nil {
		return nil, err
	}
	ans, err := v1models.ServeList(ctx, s.V1Models.Deps, s.V1Models.Users, v1models.ListRequest{
		Query: r.URL.RawQuery, Path: r.URL.Path, Host: host, RegionRestricted: s.regionRestricted(r),
		TrainingDataSQL: r.Header.Get(v1models.TrainingDataSQLHeader),
	})
	if err != nil {
		return nil, err
	}
	return v1ModelsAnswer(ans)
}

// computeV1ModelsID answers a REST `/api/v1/models/[id]` request (the PublicEndpoint handler: no
// session is read, so a cookie changes nothing). An API credential falls back: the block-scope
// middleware decides it.
func (s *Server) computeV1ModelsID(ctx context.Context, r *http.Request) (*computed, error) {
	if s.V1Models == nil || s.V1Models.Deps == nil {
		return nil, fallback.New("v1-models-unconfigured")
	}
	if r.Method != http.MethodGet {
		return nil, fallback.New("method")
	}
	if r.Header.Get("authorization") != "" {
		return nil, fallback.New("bearer-token")
	}
	id, ok := strings.CutPrefix(r.URL.Path, V1ModelsPath+"/")
	if !ok || strings.Contains(id, "/") {
		return nil, fallback.New("v1-models-path")
	}
	host, err := v1ModelsHost(r)
	if err != nil {
		return nil, err
	}
	ans, err := v1models.ServeDetail(ctx, s.V1Models.Deps, v1models.DetailRequest{
		ID: id, RegionRestricted: s.regionRestricted(r), Host: host,
		TrainingDataSQL: r.Header.Get(v1models.TrainingDataSQLHeader),
	})
	if err != nil {
		return nil, err
	}
	return v1ModelsAnswer(ans)
}
