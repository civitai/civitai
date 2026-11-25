package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/sitesearch"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// `POST /api/search/[...path]` (DESIGN.md §18): shadowed at /internal/shadow/api/search, and served on
// the public route only with ServeSearch (FEED_GO_SERVE_SEARCH, default off).

const (
	// EndpointSearch is the route's feed_endpoint label.
	EndpointSearch = "site-search"
	// SearchPath is the route's prefix: `multi-search`, `indexes/:uid/search` and
	// `indexes/:uid/facet-search` under it.
	SearchPath = "/api/search"
)

// maxSearchBody is Next's API body-parser limit (`1mb`): a larger body is Node's 413, and falls back.
const maxSearchBody = 1 << 20

// The rate limit (src/server/utils/site-search-rate-limit.ts): a fixed window per user, else per
// client address, on the cache cluster under `site-search:rate-limit:<bucket>`.
const (
	searchRateUserMax = 300
	searchRateIPMax   = 600
	searchRateWindow  = 60 * time.Second
)

// SearchComparedHeaders are the headers compared on a site-search sample: the REST list
// (shadow.RESTComparedHeaders) without the ETag Next's res.json adds to a reshaped answer (the route
// answers `private, no-store`, so no cache revalidates with it, and Node's passthrough answer has
// none: this service writes none) and X-Expires (an `etag` query, whose sample's headers are not
// compared).
var SearchComparedHeaders = slices.DeleteFunc(slices.Clone(shadow.RESTComparedHeaders), func(h string) bool {
	return h == "etag" || h == "x-expires"
})

// RateCounter is the part of the cache client the public route's rate limit uses.
type RateCounter interface {
	Get(ctx context.Context, key string) *redis.StringCmd
	Incr(ctx context.Context, key string) *redis.IntCmd
	TTL(ctx context.Context, key string) *redis.DurationCmd
	Expire(ctx context.Context, key string, expiration time.Duration) *redis.BoolCmd
}

// SearchDeps serves the public route. The shadow needs none of it: it reshapes the backend response
// Node recorded.
type SearchDeps struct {
	// Upstream is the search backend (sitesearch.Client); nil = every public request falls back
	// (`search-unconfigured`).
	Upstream sitesearch.Upstream
	// Rate is the cache cluster the rate-limit windows live on; nil = every public request falls back
	// (`search-rate-limit-unconfigured`).
	Rate RateCounter
	// KeyPrefix is prefixCacheKey's namespace (CACHE_KEY_NAMESPACE + ":", empty in production).
	KeyPrefix string
}

var errSearchOff = fallback.New("search-off")

type searchBodyKey struct{}
type searchRecordedKey struct{}

func withSearchBody(ctx context.Context, body []byte) context.Context {
	return context.WithValue(ctx, searchBodyKey{}, body)
}

// ShadowSearchHandler is the internal compare endpoint for `POST /api/search/*`.
func (s *Server) ShadowSearchHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointSearch) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// searchRoute is compare's dispatch for the route: the request rebuild, the compute (the shadow's:
// the recorded backend response, and the call in the compared body) and the classification.
func (s *Server) searchRoute(endpoint string) (
	build func(context.Context, ShadowRequest) (*http.Request, error),
	compute func(context.Context, *http.Request) (*computed, error),
	classify func(*shadow.Report, []byte, []byte) string,
	ok bool,
) {
	if endpoint != EndpointSearch {
		return nil, nil, nil, false
	}
	return SyntheticSearchRequest, s.searchCompute(false), ClassifySearch, true
}

// SyntheticSearchRequest rebuilds the request a site-search sample describes: a POST to its path with
// its JSON body (`input`, the body Node parsed, as JSON.stringify writes it) and the forwarded headers,
// with the backend response Node recorded (`upstream`) on its context. It is marked as a sample, its
// credentials redacted (the sampler never mirrors a request that carried one).
func SyntheticSearchRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	ctx = withSampled(auth.WithRedactedCredentials(ctx))
	body := []byte(req.Input)
	ctx = withSearchBody(ctx, body)
	if len(req.Upstream) > 0 {
		ctx = context.WithValue(ctx, searchRecordedKey{}, sitesearch.Recorded{Body: req.Upstream})
	}
	path := req.Path
	if path == "" {
		return nil, errors.New("site-search sample without a path")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, SearchPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(path)
	if err != nil {
		return nil, err
	}
	r.URL = u
	r.RequestURI = ""
	for k, v := range req.Headers {
		r.Header.Set(k, v)
	}
	r.Header.Set("Content-Type", "application/json")
	if h := req.Headers["host"]; h != "" {
		r.Host = h
	}
	return r, nil
}

// ClassifySearch classifies a site-search comparison of the two `{upstream, body}` documents (the
// search call and the answer): `match`; `membership` when the search call differs (the query this
// service would send is not Node's, so the hits could differ); `fields` when the call is the same and
// the answer differs (the shaping).
func ClassifySearch(r *shadow.Report, _, _ []byte) string {
	if r.Match {
		return "match"
	}
	for _, d := range r.Diffs {
		if d.Category == "upstream" || strings.HasPrefix(d.Category, "upstream.") {
			return "membership"
		}
	}
	return "fields"
}

// searchShadowDocument is what a site-search sample is compared as: the call and the answer, in the
// shape the Node sampler sends as `node`.
func searchShadowDocument(ans *sitesearch.Answer) []byte {
	out := make([]byte, 0, len(ans.Body)+len(ans.Call.Body)+64)
	out = append(out, `{"upstream":{"path":`...)
	out = strconv.AppendQuote(out, ans.Call.Path)
	out = append(out, `,"body":`...)
	out = append(out, ans.Call.Body...)
	out = append(out, `},"body":`...)
	out = append(out, ans.Body...)
	return append(out, '}')
}

// searchResponseHeaders are the headers Node sends with a site-search 200, in the order it sets them:
// next.config's (configheaders.json), MixedAuthEndpoint's Vary and CORS headers (POST only), and the
// handler's own Cache-Control, which replaces the wrapper's and the API policy's. Content-Type and
// Content-Length are transport; X-Handled-By names the pod. Node's reshaped answer also carries the
// ETag res.json computes, which is not written here (SearchComparedHeaders).
func searchResponseHeaders(credentialed bool) []v1models.Header {
	vary := "Authorization"
	if credentialed {
		vary = "Authorization, Cookie"
	}
	return append(v1models.ConfigHeaders(),
		v1models.Header{Name: "Vary", Value: vary},
		v1models.Header{Name: "Access-Control-Allow-Origin", Value: "*"},
		v1models.Header{Name: "Access-Control-Allow-Headers", Value: "Authorization, Content-Type, *"},
		v1models.Header{Name: "Access-Control-Allow-Methods", Value: "POST"},
		v1models.Header{Name: "Cache-Control", Value: "private, no-store"},
	)
}

// searchJSONBody checks the request carries JSON as Next's body parser reads it (application/json,
// UTF-8): any other type is a string body zod refuses, another charset is decoded by iconv, and neither
// is reproduced (`search-content-type`).
func searchJSONBody(r *http.Request) error {
	values := r.Header.Values("Content-Type")
	if len(values) != 1 {
		return fallback.New("search-content-type")
	}
	mt, params, err := mime.ParseMediaType(values[0])
	if err != nil || (mt != "application/json" && mt != "application/ld+json") {
		return fallback.New("search-content-type")
	}
	if cs, ok := params["charset"]; ok && !strings.EqualFold(cs, "utf-8") {
		return fallback.New("search-content-type")
	}
	return nil
}

// searchCompute is the route's compute, the shadow's and the public route's alike (serving tells them
// apart). In order: the method, the path, any API credential (`bearer-token`), on the public route an
// `etag` query (`search-etag`: MixedAuthEndpoint may add X-Expires from its database), the body, the
// session (a banned one is Node's 403: `search-banned`), the profanity refusal civitai.com applies
// (`search-profanity`: not ported), the viewer, the rate limit (public route only), then the port.
func (s *Server) searchCompute(serving bool) func(context.Context, *http.Request) (*computed, error) {
	return func(ctx context.Context, r *http.Request) (*computed, error) {
		if r.Method != http.MethodPost {
			return nil, fallback.New("method")
		}
		rest, ok := strings.CutPrefix(r.URL.Path, SearchPath+"/")
		if !ok || r.URL.RawPath != "" {
			// An escaped segment is decoded by Next's catch-all in a way not reproduced.
			return nil, fallback.New("search-path")
		}
		route, index, err := sitesearch.ParsePath(rest)
		if err != nil {
			return nil, err
		}
		if len(r.Header.Values("Authorization")) > 0 || auth.AnyQueryToken(r.URL.RawQuery) {
			return nil, fallback.New("bearer-token")
		}
		etag := etagChecked(r)
		if serving && etag {
			return nil, fallback.New("search-etag")
		}
		if err := searchJSONBody(r); err != nil {
			return nil, err
		}
		body, _ := ctx.Value(searchBodyKey{}).([]byte)
		req, err := sitesearch.ParseBody(route, index, body)
		if err != nil {
			return nil, err
		}
		if s.Resolver == nil {
			return nil, fallback.New("search-unconfigured")
		}
		user, err := s.Resolver.Resolve(ctx, r)
		if err != nil {
			return nil, err
		}
		if user != nil && user.Banned {
			return nil, fallback.New("search-banned")
		}
		if user != nil && user.BrowsingPrefsUnread {
			return nil, fallback.New("search-session-shape")
		}
		color := s.Hosts.ColorOf(r.Host)
		// civitai.com refuses a profane search (isProfaneSearch: the managed list, the shipped one, the
		// moderators' benign words). Not ported: serving, any text there is handed back. A shadow sample
		// is computed: Node samples a request only after its own check has passed it.
		if serving && color == "green" {
			for _, q := range req.QueryTexts() {
				if q != "" {
					return nil, fallback.New("search-profanity")
				}
			}
		}
		restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
		sess := sitesearch.Session{}
		if user != nil {
			sess = sitesearch.Session{
				SignedIn: true, ID: user.ID, IsModerator: user.IsModerator,
				BrowsingLevel: user.BrowsingLevel, ShowNsfw: user.ShowNsfw,
			}
		}
		sess.CanViewNsfw = browsing.CanViewNsfw(color, restricted, sess.IsModerator)
		viewer := sitesearch.ViewerOf(sess)

		// A shadow sample's recorded response (sitesearch.Recorded), else the backend when serving.
		up, recorded := ctx.Value(searchRecordedKey{}).(sitesearch.Upstream)
		switch {
		case recorded:
		case serving && s.Search != nil && s.Search.Upstream != nil:
			up = s.Search.Upstream
		case !serving:
			return nil, fallback.New("search-no-upstream")
		default:
			return nil, fallback.New("search-unconfigured")
		}
		rateKey := ""
		if serving {
			key, max, err := s.searchRateKey(r, user)
			if err != nil {
				return nil, err
			}
			if s.searchRateSpent(ctx, key, max) {
				// Node answers its 429 and counts the request.
				return nil, fallback.New("search-rate-limited")
			}
			rateKey = key
		}
		ans, err := sitesearch.Compute(ctx, up, req, viewer)
		if err != nil {
			return nil, err
		}
		c := &computed{payload: ans.Body, searchRateKey: rateKey}
		if !serving {
			c.payload = searchShadowDocument(ans)
		}
		if !etag {
			c.headers = searchResponseHeaders(v1models.CarriesCallerCredentials(r.Header, r.URL.RawQuery))
		}
		return c, nil
	}
}

// searchRateKey is checkSiteSearchRateLimit's key and ceiling: the signed-in user's bucket, else the
// client address's. The address is resolveClientIp's first source, `cf-connecting-ip`, read as
// isIpAddress reads it; a request without one Node keys by another derivation (request-ip), not
// reproduced: `search-rate-limit-ip`.
func (s *Server) searchRateKey(r *http.Request, user *auth.SessionUser) (string, int, error) {
	if s.Search == nil || s.Search.Rate == nil {
		return "", 0, fallback.New("search-rate-limit-unconfigured")
	}
	prefix := s.Search.KeyPrefix + "site-search:rate-limit:"
	if user != nil {
		return prefix + "user:" + strconv.Itoa(user.ID), searchRateUserMax, nil
	}
	ip, ok := edgeClientIP(r.Header)
	if !ok {
		return "", 0, fallback.New("search-rate-limit-ip")
	}
	return prefix + "ip:" + ip, searchRateIPMax, nil
}

// edgeClientIP is resolveClientIp's `cf-connecting-ip` arm: the header's first value, trimmed, when
// isIpAddress accepts it (at most 45 characters, no zone, an IP address). A value with a byte outside
// printable ASCII is refused rather than trimmed as JavaScript trims it.
func edgeClientIP(h http.Header) (string, bool) {
	values := h.Values("Cf-Connecting-Ip")
	if len(values) == 0 {
		return "", false
	}
	v := strings.Trim(values[0], " \t")
	for i := 0; i < len(v); i++ {
		if v[i] < 0x21 || v[i] > 0x7e {
			return "", false
		}
	}
	if v == "" || len(v) > 45 || strings.Contains(v, "%") {
		return "", false
	}
	if _, err := netip.ParseAddr(v); err != nil {
		return "", false
	}
	return v, true
}

// searchRateSpent reports whether the window is already at its ceiling, without counting this request:
// it is counted only once answered here (countSearch), since a request handed to Node is counted
// there. A failed read fails open, as checkFixedWindow does.
func (s *Server) searchRateSpent(ctx context.Context, key string, max int) bool {
	n, err := s.Search.Rate.Get(ctx, key).Int64()
	if err != nil {
		return false
	}
	return n >= int64(max)
}

// countSearch is checkFixedWindowWith's write for an answered request: INCR, and the window's expiry
// set on the first request or re-asserted when it was lost. Errors are ignored (fail open).
func (s *Server) countSearch(ctx context.Context, key string) {
	if key == "" || s.Search == nil || s.Search.Rate == nil {
		return
	}
	count, err := s.Search.Rate.Incr(ctx, key).Result()
	if err != nil {
		return
	}
	if count == 1 {
		s.Search.Rate.Expire(ctx, key, searchRateWindow)
		return
	}
	if ttl, err := s.Search.Rate.TTL(ctx, key).Result(); err == nil && ttl < 0 {
		s.Search.Rate.Expire(ctx, key, searchRateWindow)
	}
}

// ServeSearchHTTP is the public `POST /api/search/*` route. With ServeSearch off every request is the
// `search-off` fallback: nothing is read or computed, no serve slot is taken, the request is proxied as
// it came.
func (s *Server) ServeSearchHTTP(w http.ResponseWriter, r *http.Request) {
	withProfileLabels(r.Context(), EndpointSearch, "serve", func(ctx context.Context) {
		s.serveSearchLabelled(w, r.WithContext(ctx))
	})
}

// bufferSearchBody reads the body (up to maxSearchBody) onto the request's context for the compute and
// leaves r.Body replayable for the fallback proxy. Past the limit it is `search-body-size` (Node's 413);
// a read that fails (the client went away) is `canceled`, which is not proxied.
func bufferSearchBody(r *http.Request) (*http.Request, error) {
	if r.Body == nil || r.Body == http.NoBody {
		return r.WithContext(withSearchBody(r.Context(), nil)), nil
	}
	buf, err := io.ReadAll(io.LimitReader(r.Body, maxSearchBody+1))
	if err != nil {
		return r, fallback.New("canceled")
	}
	orig := r.Body
	r = r.WithContext(withSearchBody(r.Context(), buf))
	r.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(buf), orig), orig}
	if len(buf) > maxSearchBody {
		return r, fallback.New("search-body-size")
	}
	return r, nil
}

func (s *Server) serveSearchLabelled(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	ctx, span := s.startSpan(r.Context(), r.Header, "serve", EndpointSearch)
	defer span.End()
	if s.Tracer != nil {
		r = r.WithContext(ctx)
	}
	var (
		c   *computed
		err error
	)
	if !s.ServeSearch {
		err = errSearchOff
	} else if r, err = bufferSearchBody(r); err == nil {
		// The API request policy's region block only: this path is not bot-aware, so the app removes
		// any verified-crawler header rather than deciding one (the crawler user agent does not matter).
		// A blocked region is always handed back, whatever AnswerRegionBlocked says: the handler applies
		// the policy after MixedAuthEndpoint, so Node's 451 here carries the wrapper's Vary, CORS and
		// Cache-Control headers, and a method other than POST is its 405 first.
		if browsing.IsRegionRestricted(s.RegionBlockRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now()) {
			err = errRegionBlocked
		} else {
			c, err = s.computeServe(r, EndpointSearch, s.searchCompute(true))
		}
	}
	if err == nil {
		// Counted once answered here; a fallback is counted by Node.
		s.countSearch(ctx, c.searchRateKey)
		writeSearch(w, c)
		c.release()
		setOutcome(span, "served")
		s.Metrics.Requests.WithLabelValues(EndpointSearch, "serve", "served").Inc()
		tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(EndpointSearch, "serve", "served"), time.Since(start).Seconds())
		return
	}
	if !s.serveFallback(ctx, span, start, EndpointSearch, err) {
		return
	}
	w.Header().Set(ServedByHeader, ServedByNode)
	s.proxyVia(s.SearchFallback, w, r, EndpointSearch)
}

// writeSearch writes a computed answer as Node writes its JSON: the headers, Next's JSON Content-Type
// and the body.
func writeSearch(w http.ResponseWriter, c *computed) {
	h := w.Header()
	for _, x := range c.headers {
		h.Set(x.Name, x.Value)
	}
	h.Set("Content-Type", v1models.JSONContentType)
	h.Set("Content-Length", strconv.Itoa(len(c.payload)))
	h.Set(ServedByHeader, ServedByGo)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(c.payload) //nolint:gosec // G705: a computed JSON body under application/json, not reflected input
}
