package server

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The public serve path of `GET /api/v1/models` and `GET /api/v1/models/{id}` (DESIGN.md §16.8),
// behind ServeV1Models (FEED_GO_SERVE_V1_MODELS, default off). It is the model.getAll route's shape
// (ServeModelGetAllHTTP) for a REST answer: the switch first, then the API request policy (a blocked
// region or a crawler's user agent is handed to the Node app, which answers its 451 or decides the
// crawler), a serve slot from the one shared pool (MaxInFlight), the request budget, and the compute
// the shadow runs (v1ModelsCompute). An answer is the shadow-compared body and headers plus
// X-Feed-Go-Served: go; every fallback is proxied to V1Fallback, the Node app that serves `/api/v1`.
// No origin allow-list (unlike model.getAll): the list answers any origin (CORS `*`); an `[id]`
// request with an Origin falls back (v1-models-origin).

// errV1ModelsOff is the `v1-models-off` fallback: a public model route with ServeV1Models off.
var errV1ModelsOff = fallback.New("v1-models-off")

// ServeV1ModelsHTTP is the public `GET /api/v1/models` route.
func (s *Server) ServeV1ModelsHTTP(w http.ResponseWriter, r *http.Request) {
	s.serveV1Models(w, r, EndpointV1Models)
}

// ServeV1ModelsIDHTTP is the public `GET /api/v1/models/{id}` route.
func (s *Server) ServeV1ModelsIDHTTP(w http.ResponseWriter, r *http.Request) {
	s.serveV1Models(w, r, EndpointV1ModelsID)
}

// serveV1Models is serve (server.go) for a REST model route. With ServeV1Models off every request is
// the `v1-models-off` fallback: nothing is computed and no serve slot is taken.
func (s *Server) serveV1Models(w http.ResponseWriter, r *http.Request, endpoint string) {
	start := time.Now()
	ctx, span := s.startSpan(r.Context(), r.Header, "serve", endpoint)
	defer span.End()
	if s.Tracer != nil {
		r = r.WithContext(ctx)
	}
	var (
		c   *computed
		err error
	)
	if !s.ServeV1Models {
		err = errV1ModelsOff
	} else if err = s.apiRequestPolicy(r); err == nil {
		c, err = s.computeServe(r, endpoint, s.v1ModelsCompute(endpoint, true))
	}
	if err == nil {
		served := "served"
		switch {
		case c.trivial:
			served = "served_empty"
		case c.cached:
			served = "served_cached"
		}
		writeV1Models(w, c)
		c.release()
		setOutcome(span, served)
		s.Metrics.Requests.WithLabelValues(endpoint, "serve", served).Inc()
		tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", served), time.Since(start).Seconds())
		return
	}
	if !s.serveFallback(ctx, span, start, endpoint, err) {
		return
	}
	w.Header().Set(ServedByHeader, ServedByNode)
	s.proxyVia(s.V1Fallback, w, r, endpoint)
}

// writeV1Models writes a computed answer as Node's res.json does: c.headers (v1models.ResponseHeaders),
// Next's JSON Content-Type, and the body bytes.
func writeV1Models(w http.ResponseWriter, c *computed) {
	h := w.Header()
	for _, x := range c.headers {
		h.Set(x.Name, x.Value)
	}
	h.Set("Content-Type", v1models.JSONContentType)
	h.Set("Content-Length", strconv.Itoa(len(c.payload)))
	h.Set(ServedByHeader, ServedByGo)
	w.WriteHeader(http.StatusOK)
	// The JSON answer this service computed, with a JSON Content-Type, as the Node app writes it.
	_, _ = w.Write(c.payload) //nolint:gosec // G705: a computed JSON body under application/json, not reflected input
}

// v1ModelsCompute is the compute of a model route, the shadow's and the public route's alike (serving
// tells them apart): the request checks of v1ModelsPreflight, then, serving only, those of
// v1ModelsServeOnly; the port (computeV1Models / computeV1ModelsID); then the body as JSON.stringify
// writes it (v1models.NodeBody) and the headers Node sends with it (v1models.ResponseHeaders).
// Serving, a not-found `[id]` falls back (`v1-models-not-found`): Node's answer is a 404, and a served
// answer here is a 200. In the shadow a list sample with a session cookie or an `etag` query is still
// computed and its body compared; an `etag` query's headers are not computed (v1ModelsHeadersUnknown),
// so its response compare is `uncompared`.
func (s *Server) v1ModelsCompute(endpoint string, serving bool) func(context.Context, *http.Request) (*computed, error) {
	detail := endpoint == EndpointV1ModelsID
	inner := s.computeV1Models
	if detail {
		inner = s.computeV1ModelsID
	}
	if s.computeV1ModelsFn != nil {
		inner = s.computeV1ModelsFn
	}
	return func(ctx context.Context, r *http.Request) (*computed, error) {
		if err := v1ModelsPreflight(r); err != nil {
			return nil, err
		}
		if serving {
			if err := v1ModelsServeOnly(r, detail); err != nil {
				return nil, err
			}
		}
		c, err := inner(ctx, r)
		if err != nil {
			return nil, err
		}
		if serving && c.notFound {
			c.release()
			return nil, fallback.New("v1-models-not-found")
		}
		in := v1models.HeaderInput{
			Detail:          detail,
			Credentialed:    v1models.CarriesCallerCredentials(r.Header, r.URL.RawQuery),
			VerifiedCrawler: verifiedCrawler(r),
		}
		if !detail {
			// Parsed again (the port parsed it already, so it parses): the `nsfw` the handler reads.
			list, err := v1models.ParseList(r.URL.RawQuery)
			if err != nil {
				c.release()
				return nil, err
			}
			in.Nsfw = list.Nsfw
		}
		body, ok := v1models.NodeBody(c.payload)
		if !ok {
			c.release()
			return nil, fallback.New("v1-models-invalid-utf8")
		}
		// body is c.payload, or a copy when an escape was rewritten; c.buf still owns the pooled bytes.
		c.payload = body
		if !v1ModelsHeadersUnknown(r, detail) {
			c.headers = v1models.ResponseHeaders(in, body)
		}
		return c, nil
	}
}

// v1ModelsPreflight falls back, in the shadow and serving alike, on a request that is not a GET
// (`method`) or carries any API credential, a `?token=` or an Authorization header of any value
// (`bearer-token`: the block-scope middleware and the scoped-key views are not ported).
func v1ModelsPreflight(r *http.Request) error {
	if r.Method != http.MethodGet {
		return fallback.New("method")
	}
	if auth.HasAPICredential(r) || len(r.Header.Values("Authorization")) > 0 {
		return fallback.New("bearer-token")
	}
	return nil
}

// v1ModelsServeOnly falls back, on the public route only, on a request whose answer or headers depend
// on something this service does not read, before anything is computed:
//
//   - a conditional request, If-None-Match or If-Modified-Since (`v1-models-conditional`): Next's
//     sendData may answer it 304 (fresh), which is not reproduced;
//   - the list: a cookie under a session cookie name (`v1-models-session-cookie`): the list serves
//     signed-out callers only, and the cookie, valid or not, also switches Node's cache headers to the
//     credentialed arm; an `etag` query value (`v1-models-etag`): MixedAuthEndpoint checks it against
//     the database and may add X-Expires;
//   - `[id]`: an Origin header (`v1-models-origin`): withBlockScope adds its CORS headers for an
//     origin on the block-app allow-list, which is read from the database.
//
// In the shadow these do not drop a sample: of them the sampler forwards only the session cookie and
// the query, and such a list sample is computed and compared (v1ModelsHeadersUnknown for its headers).
func v1ModelsServeOnly(r *http.Request, detail bool) error {
	if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
		return fallback.New("v1-models-conditional")
	}
	if detail {
		if len(r.Header.Values("Origin")) > 0 {
			return fallback.New("v1-models-origin")
		}
		return nil
	}
	if v1models.HasSessionCookie(r.Header) {
		return fallback.New("v1-models-session-cookie")
	}
	if etagChecked(r) {
		return fallback.New("v1-models-etag")
	}
	return nil
}

// v1ModelsHeadersUnknown: on the list, an `etag` query lets Node add X-Expires read from its
// database, so the headers are not computed here and the shadow's response compare is `uncompared`.
func v1ModelsHeadersUnknown(r *http.Request, detail bool) bool {
	return !detail && etagChecked(r)
}

// etagChecked is MixedAuthEndpoint's `!!req.query.etag && req.query.etag !== ""`: one empty value is
// no check; a non-empty value, or the key repeated (an array, truthy), is.
func etagChecked(r *http.Request) bool {
	params, err := feed.ParseSearch(r.URL.RawQuery)
	if err != nil {
		return false
	}
	for _, p := range params {
		if p.Key == "etag" && (len(p.Values) > 1 || (len(p.Values) == 1 && p.Values[0] != "")) {
			return true
		}
	}
	return false
}
