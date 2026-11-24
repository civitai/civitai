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

// The sample headers a credentialed model sample carries in place of its key (the Node sampler's
// FEED_GO_SHADOW_V1_MODELS_CREDENTIALS, src/server/trpc/feed-go-shadow-credential.ts): the
// credential's description (auth.SampleCredential*) and, on the list, the viewer Node searched as.
// Read off a sample only (SyntheticV1ModelsRequest moves them onto its context), never off a public
// request's headers.
const (
	SampleCredentialHeader = "x-feed-go-credential" //nolint:gosec // G101: a header name, not a credential
	SampleViewerHeader     = "x-feed-go-viewer"
)

// NodeViewerUser is the list sample's SampleViewerHeader when Node searched as the key's user (the
// signed-in list), not as signed out.
const NodeViewerUser = "user"

type nodeViewerKey struct{}

func nodeViewer(ctx context.Context) string {
	v, _ := ctx.Value(nodeViewerKey{}).(string)
	return v
}

// SyntheticV1ModelsRequest rebuilds the REST request a v1-models sample describes: its path and raw
// query string as Node received them, and the forwarded headers. It is marked as a sample
// (withSampled): its verified-crawler header is the app's own decision, and `[id]` reads the origin
// cache as a sample does (v1models.NodeBuiltWindow). A credential description and Node's viewer
// (SampleCredentialHeader, SampleViewerHeader) go on its context, not its headers.
func SyntheticV1ModelsRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	ctx = withSampled(auth.WithRedactedCredentials(ctx))
	if v, ok := req.Headers[SampleCredentialHeader]; ok {
		ctx = auth.WithSampleCredential(ctx, v)
	}
	if v, ok := req.Headers[SampleViewerHeader]; ok {
		ctx = context.WithValue(ctx, nodeViewerKey{}, v)
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
		if k == SampleCredentialHeader || k == SampleViewerHeader {
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
	return &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial, cached: ans.Cached, notFound: ans.NotFound}, nil
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
// signed-out caller; a session falls back, and so does an API credential unless v1Credential already
// decided the search runs as signed out (V1BearerAuth).
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
	// With V1BearerAuth the credential was decided before this (v1ListViewer: signed out, or a key
	// whose search runs as signed out). Without it, an API credential falls back (DESIGN.md §4.2).
	if !credentialDecided(ctx) {
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
	}
	host, err := v1ModelsHost(r)
	if err != nil {
		return nil, err
	}
	sqlHash, rules := s.trainingDataVouch(r)
	ans, err := v1models.ServeList(ctx, s.V1Models.Deps, s.V1Models.Users, v1models.ListRequest{
		Query: r.URL.RawQuery, Path: r.URL.Path, Host: host, RegionRestricted: s.regionRestricted(r),
		TrainingDataSQL: sqlHash, Rules: rules,
	})
	if err != nil {
		return nil, err
	}
	return v1ModelsAnswer(ans)
}

// computeV1ModelsID answers a REST `/api/v1/models/[id]` request (the PublicEndpoint handler: no
// session is read, so a cookie changes nothing). An Authorization header falls back (the block-scope
// middleware reads it) unless v1Credential already decided it (V1BearerAuth).
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

// V1ViewerAPIKey is the viewer class (feed_go_shadow_compare_viewer_total) of a model sample that
// carried an API credential and was computed (V1BearerAuth).
const V1ViewerAPIKey = "api-key"

type credentialDecidedKey struct{}

// credentialDecided reports whether v1Credential already decided the request's credential: the port
// then answers it as signed out without reading the session again.
func credentialDecided(ctx context.Context) bool {
	v, _ := ctx.Value(credentialDecidedKey{}).(bool)
	return v
}

// v1Credential decides a model request's credential as the Node route does (V1BearerAuth): nil when
// Node answers it with the body it gives a signed-out caller, else the fallback. The returned context
// marks the decision for the port; apiKey reports whether the request carried an API credential (an
// Authorization header of any value, or a `?token=`), for the viewer class.
func (s *Server) v1Credential(ctx context.Context, r *http.Request, detail bool) (context.Context, bool, error) {
	apiKey := len(r.Header.Values("Authorization")) > 0 || auth.AnyQueryToken(r.URL.RawQuery)
	if s.Resolver == nil {
		if apiKey {
			return ctx, apiKey, fallback.New("bearer-token")
		}
		return ctx, apiKey, fallback.New("v1-models-unconfigured")
	}
	var err error
	if detail {
		err = s.Resolver.DetailCredential(ctx, r)
	} else {
		err = s.v1ListViewer(ctx, r)
	}
	if err != nil {
		return ctx, apiKey, err
	}
	return context.WithValue(ctx, credentialDecidedKey{}, true), apiKey, nil
}

// v1ListViewer is the list's viewer decision (MixedAuthEndpoint's getApiAuthSession with
// MODEL_VIEW_SCOPE, then the handler's searchViewer, src/pages/api/v1/models/index.ts): nil when the
// search runs as signed out, so the body is the signed-out body; every case where it runs as a user,
// or where Node's answer or its logged scope decision depends on a setting this service does not read,
// falls back. The query is parsed first, as the port parses it before the session (its fallbacks name
// the query, and an own-list key — favorites, hidden, followed — or availability falls back there).
//
//   - a `?token=` (any value, auth.AnyQueryToken): `bearer-query-token`. Node reads it unless it is the
//     webhook token (not known here), and the body's nextPage echoes it;
//   - a session cookie decided the session: `v1-models-session` (the signed-in list is not ported);
//   - an API key decided it: no session (a provider or service token, a client-credentials key, a
//     banned user, the moderation account) is signed out; a full-scope personal key searches as its
//     user (isSessionOrFullUserKey): `v1-models-bearer-session`; a key without ModelsRead or
//     AIServicesRead is refused by REST_SCOPE_ENFORCE=enforce (signed out, the refusal logged) and kept
//     otherwise: `v1-models-bearer-scope`; a moderator on any other key keeps their rights only as the
//     system account and has the withholding logged otherwise: `v1-models-bearer-moderator`; any other
//     key searches as signed out (searchViewer: not an own list);
//   - on a shadow sample, Node's own viewer (SampleViewerHeader) is the user while this decided signed
//     out: `v1-models-bearer-viewer-mismatch`, which must never be counted.
func (s *Server) v1ListViewer(ctx context.Context, r *http.Request) error {
	if _, err := v1models.ParseList(r.URL.RawQuery); err != nil {
		return err
	}
	if auth.AnyQueryToken(r.URL.RawQuery) {
		return fallback.New("bearer-query-token")
	}
	sess, err := s.Resolver.ResolveREST(ctx, r)
	if err != nil {
		return err
	}
	if sess.Bearer == nil && sess.User != nil {
		return fallback.New("v1-models-session")
	}
	if b := sess.Bearer; b != nil && b.User != nil {
		switch {
		case b.FullUserKey():
			return fallback.New("v1-models-bearer-session")
		case b.Scope&(auth.ScopeModelsRead|auth.ScopeAIServicesRead) == 0:
			return fallback.New("v1-models-bearer-scope")
		case b.User.IsModerator:
			return fallback.New("v1-models-bearer-moderator")
		}
	}
	if nodeViewer(r.Context()) == NodeViewerUser {
		return fallback.New("v1-models-bearer-viewer-mismatch")
	}
	return nil
}
