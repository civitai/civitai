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

// The public REST model endpoints: shadowed, and served behind ServeV1Models (v1models_serve.go):
// DESIGN.md §16.
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
	// Rules vouches for this build's Training Data rules on a public request (the Node builds'
	// published rule sets); nil vouches for nothing, so a Training Data candidate there falls back.
	Rules *v1models.TrainingDataRules
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
// (with the response headers the public route writes, v1ModelsCompute) and the classification (both
// bodies are plain JSON, compared with shadow.CompareJSON).
func (s *Server) v1ModelsRoute(endpoint string) (
	build func(context.Context, ShadowRequest) (*http.Request, error),
	compute func(context.Context, *http.Request) (*computed, error),
	classify func(*shadow.Report, []byte, []byte) string,
	ok bool,
) {
	switch endpoint {
	case EndpointV1Models:
		return SyntheticV1ModelsRequest, s.v1ModelsCompute(endpoint, false), shadow.ClassifyJSON, true
	case EndpointV1ModelsID:
		return SyntheticV1ModelsRequest, s.v1ModelsCompute(endpoint, false), ClassifyV1ModelID, true
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

// SampleCredentialHeader is the header a credentialed `[id]` sample carries in place of its key (the
// Node sampler's FEED_GO_SHADOW_V1_MODELS_CREDENTIALS, src/server/trpc/feed-go-shadow-credential.ts):
// the credential's description (auth.SampleCredential*). Read off a sample only
// (SyntheticV1ModelsRequest moves it onto the rebuilt request's context and off its headers), never
// off a public request's headers.
const SampleCredentialHeader = "x-feed-go-credential" //nolint:gosec // G101: a header name, not a credential

// SyntheticV1ModelsRequest rebuilds the REST request a v1-models sample describes: its path and raw
// query string as Node received them, and the forwarded headers. It is marked as a sample
// (withSampled): its verified-crawler header is the app's own decision, and `[id]` reads the origin
// cache as a sample does (v1models.NodeBuiltWindow). A credential description (SampleCredentialHeader)
// goes on its context, not its headers.
func SyntheticV1ModelsRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	ctx = withSampled(auth.WithRedactedCredentials(ctx))
	if v, ok := req.Headers[SampleCredentialHeader]; ok {
		ctx = auth.WithSampleCredential(ctx, v)
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, V1ModelsPath, nil)
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
		if k == SampleCredentialHeader {
			continue
		}
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
	return &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial, cached: ans.Cached, notFound: ans.NotFound, absent: ans.NotFound && ans.Absent}, nil
}

// sampledRequest reports whether r was rebuilt from a Node sample (withSampled): `[id]` then reads the
// origin cache as a sample does.
func sampledRequest(r *http.Request) bool {
	return isSampled(r.Context())
}

// trainingDataVouch picks what vouches for the Training Data rules: a sample's header, or on a
// public request (where that header would be the client's and is never read) the rule sets the
// Node builds now answering published (DESIGN.md §16.8).
func (s *Server) trainingDataVouch(r *http.Request) (string, *v1models.TrainingDataRules) {
	if sampledRequest(r) {
		return r.Header.Get(v1models.TrainingDataSQLHeader), nil
	}
	if s.V1Models == nil {
		return "", nil
	}
	return "", s.V1Models.Rules
}

func (s *Server) regionRestricted(r *http.Request) bool {
	return browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
}

// computeV1Models answers a REST `/api/v1/models` request (the MixedAuthEndpoint handler) for a
// signed-out caller; a session or an API credential falls back, whatever V1BearerAuth says.
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
	sqlHash, rules := s.trainingDataVouch(r)
	ans, err := v1models.ServeList(ctx, s.V1Models.Deps, s.V1Models.Users, v1models.ListRequest{
		Query: r.URL.RawQuery, Path: r.URL.Path, Host: host, RegionRestricted: s.regionRestricted(r),
		TrainingDataSQL: sqlHash, Rules: rules, Serving: !sampledRequest(r),
	})
	if err != nil {
		return nil, err
	}
	return v1ModelsAnswer(ans)
}

// computeV1ModelsID answers a REST `/api/v1/models/[id]` request (the PublicEndpoint handler: no
// session is read, so a cookie changes nothing). An Authorization header falls back (the block-scope
// middleware reads it) unless v1DetailCredential already decided it (V1BearerAuth).
func (s *Server) computeV1ModelsID(ctx context.Context, r *http.Request) (*computed, error) {
	if s.V1Models == nil || s.V1Models.Deps == nil {
		return nil, fallback.New("v1-models-unconfigured")
	}
	if r.Method != http.MethodGet {
		return nil, fallback.New("method")
	}
	// With V1BearerAuth the credential was decided before this (auth.Resolver.DetailCredential).
	if !credentialDecided(ctx) && r.Header.Get("authorization") != "" {
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
	sqlHash, rules := s.trainingDataVouch(r)
	ans, err := v1models.ServeDetail(ctx, s.V1Models.Deps, v1models.DetailRequest{
		ID: id, RegionRestricted: s.regionRestricted(r), Serving: !sampledRequest(r), Host: host,
		TrainingDataSQL: sqlHash, Rules: rules,
	})
	if err != nil {
		return nil, err
	}
	return v1ModelsAnswer(ans)
}

// V1ViewerAPIKey is the viewer class (feed_go_shadow_compare_viewer_total) of an `[id]` sample that
// carried an API credential and was computed (V1BearerAuth).
const V1ViewerAPIKey = "api-key"

type credentialDecidedKey struct{}

// credentialDecided reports whether v1DetailCredential already decided the `[id]` request's
// credential: the port then answers it as for any caller.
func credentialDecided(ctx context.Context) bool {
	v, _ := ctx.Value(credentialDecidedKey{}).(bool)
	return v
}

// v1DetailCredential decides an `[id]` request's credential as the Node route does (V1BearerAuth;
// auth.Resolver.DetailCredential): nil when Node answers it with the body it gives any caller, else
// the fallback. The returned context marks the decision for the port; apiKey reports whether the
// request carried an API credential (an Authorization header of any value, or a `?token=`), for the
// viewer class. The list never comes here: its API credentials stay the `bearer-token` fallback.
func (s *Server) v1DetailCredential(ctx context.Context, r *http.Request) (context.Context, bool, error) {
	apiKey := len(r.Header.Values("Authorization")) > 0 || auth.AnyQueryToken(r.URL.RawQuery)
	if s.Resolver == nil {
		if apiKey {
			return ctx, apiKey, fallback.New("bearer-token")
		}
		return ctx, apiKey, fallback.New("v1-models-unconfigured")
	}
	if err := s.Resolver.DetailCredential(ctx, r); err != nil {
		return ctx, apiKey, err
	}
	return context.WithValue(ctx, credentialDecidedKey{}, true), apiKey, nil
}
