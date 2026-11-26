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
// X-Feed-Go-Served: go, or, to a conditional request the answer's ETag satisfies, Next's 304
// (writeV1Models); every fallback is proxied to V1Fallback, the Node app that serves `/api/v1`.
// No origin allow-list (unlike model.getAll): the list answers any origin (CORS `*`); an `[id]`
// request with an Origin falls back (v1-models-origin).

// OutcomeNotFound is the feed_go_requests_total outcome of a public `GET /api/v1/models/{id}` request
// answered here with Node's 404 (FEED_GO_V1_MODELS_ANSWER_NOT_FOUND: the model statement returned no
// row and the model's lag flag read clean; v1models.Answer.Absent). Kept apart from `served` (no model
// was answered) and from the fallbacks (nothing went to the app). Serve mode, `[id]` only.
const OutcomeNotFound = "not_found"

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
	withProfileLabels(r.Context(), endpoint, "serve", func(ctx context.Context) {
		s.serveV1ModelsLabelled(w, r.WithContext(ctx), endpoint)
	})
}

// serveV1ModelsLabelled is serveV1Models under the request's profile labels (withProfileLabels).
func (s *Server) serveV1ModelsLabelled(w http.ResponseWriter, r *http.Request, endpoint string) {
	start := time.Now()
	ctx, span := s.startSpan(r.Context(), r.Header, "serve", endpoint)
	defer span.End()
	if s.Tracer != nil {
		r = r.WithContext(ctx)
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
	if !s.ServeV1Models {
		err = errV1ModelsOff
	} else if err = s.apiRequestPolicy(r); err == nil {
		c, err = s.computeServe(r, endpoint, s.v1ModelsCompute(endpoint, true))
	}
	if err == nil {
		served := "served"
		switch {
		case c.absent:
			served = OutcomeNotFound
		case c.trivial:
			served = "served_empty"
		case c.cached:
			served = "served_cached"
		}
		writeV1Models(w, c, notModified(r, c))
		c.release()
		setOutcome(span, served)
		s.Metrics.Requests.WithLabelValues(endpoint, "serve", served).Inc()
		tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", served), time.Since(start).Seconds())
		s.sampleServeCapture(r, endpoint, viewer, nil) //nolint:contextcheck // the capture finishes after the answer, on the server's background context
		return
	}
	if s.answerRegionBlocked(ctx, span, start, w, endpoint, err) {
		return
	}
	if !s.serveFallback(ctx, span, start, endpoint, err) {
		return
	}
	s.handBack(s.V1Fallback, w, r, endpoint, err)
	s.sampleServeCapture(r, endpoint, viewer, err) //nolint:contextcheck // the capture finishes after the answer, on the server's background context
}

// writeV1Models writes a computed answer as Node's res.json does: c.headers (v1models.ResponseHeaders),
// Next's JSON Content-Type, and the body bytes, with status 200, or 404 for the not-found answer
// (c.absent: `res.status(404).json(...)` in the `[id]` handler, the same headers). With is304 it is
// sendEtagResponse's 304: the same headers, no body. Next decides that 304 over the body's ETag
// whatever the status the handler set, so a 404 whose ETag the request names is a 304 too. Node's
// 304 also carries the Content-Type res.json set before sendData; Go's net/http drops Content-Type,
// Content-Length and Transfer-Encoding from every 304 it writes, so this one has none (the one known
// divergence, DESIGN.md §16.8). It is counted under the outcome of the answer it was computed from
// (served, served_empty, served_cached or not_found), as the same compute.
func writeV1Models(w http.ResponseWriter, c *computed, is304 bool) {
	h := w.Header()
	for _, x := range c.headers {
		h.Set(x.Name, x.Value)
	}
	if is304 {
		h.Set(ServedByHeader, ServedByGo)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", v1models.JSONContentType)
	h.Set("Content-Length", strconv.Itoa(len(c.payload)))
	h.Set(ServedByHeader, ServedByGo)
	status := http.StatusOK
	if c.absent {
		status = http.StatusNotFound
	}
	w.WriteHeader(status)
	_, _ = w.Write(c.payload) //nolint:gosec // G705: a computed JSON body under application/json, not reflected input
}

// v1ModelsCompute is the compute of a model route, the shadow's and the public route's alike (serving
// tells them apart): the request checks of v1ModelsPreflight (on `[id]` with V1BearerAuth, only its
// method check), then, serving only, those of v1ModelsServeOnly; on `[id]` with V1BearerAuth, the
// credential decision (v1DetailCredential, DESIGN.md §16.10); the port (computeV1Models / computeV1ModelsID); then the body as JSON.stringify
// writes it (v1models.NodeBody) and the headers Node sends with it (v1models.ResponseHeaders).
// Serving, a not-found `[id]` is answered with Node's 404 when the port knows Node's statement finds
// no row (c.absent, FEED_GO_V1_MODELS_ANSWER_NOT_FOUND), and falls back (`v1-models-not-found`)
// otherwise; its headers are computed over the not-found body as over any other. In the shadow a list
// sample with a session cookie or an `etag` query is still computed and its body compared; an `etag` query's headers are not computed (v1ModelsHeadersUnknown),
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
		bearer := s.V1BearerAuth && detail
		if !bearer {
			if err := v1ModelsPreflight(r); err != nil {
				return nil, err
			}
		} else if r.Method != http.MethodGet {
			return nil, fallback.New("method")
		}
		if serving {
			if err := v1ModelsServeOnly(r, detail); err != nil {
				return nil, err
			}
		}
		// V1BearerAuth, `[id]` only: the credential decided as the Node route decides it, after the
		// checks above and before the port (which then answers as for any caller).
		apiKey := false
		if bearer {
			var err error
			if ctx, apiKey, err = s.v1DetailCredential(ctx, r); err != nil {
				return nil, err
			}
		}
		c, err := inner(ctx, r)
		if err != nil {
			return nil, err
		}
		if apiKey {
			c.viewerClass = V1ViewerAPIKey
		}
		if serving && c.notFound && !c.absent {
			c.release()
			return nil, fallback.New("v1-models-not-found")
		}
		in := v1models.HeaderInput{
			Detail:          detail,
			Credentialed:    v1models.CarriesCallerCredentials(r.Header, r.URL.RawQuery),
			VerifiedCrawler: verifiedCrawler(r),
		}
		if !detail {
			// nsfw, for the headers; the port already parsed this query.
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

// notModified is Next's `fresh(req.headers, { etag })` for the answer c (v1models.Fresh, over the
// ETag of c.headers). v1ModelsServeOnly has already handed every conditional request Fresh does not
// decide as Next does to the app.
func notModified(r *http.Request, c *computed) bool {
	etag := ""
	for _, x := range c.headers {
		if x.Name == "ETag" {
			etag = x.Value
		}
	}
	return v1models.Fresh(r.Header, etag)
}

// v1ModelsPreflight falls back, in the shadow and serving alike, on a request that is not a GET
// (`method`) or carries any API credential: an Authorization header of any value, or any non-empty
// `token` query value, read as loosely as the endpoint wrappers read it (auth.AnyQueryToken)
// (`bearer-token`). Used on the list always, and on `[id]` with V1BearerAuth off; on, `[id]`'s
// credential is decided as Node decides it (v1DetailCredential).
func v1ModelsPreflight(r *http.Request) error {
	if r.Method != http.MethodGet {
		return fallback.New("method")
	}
	if len(r.Header.Values("Authorization")) > 0 || auth.AnyQueryToken(r.URL.RawQuery) {
		return fallback.New("bearer-token")
	}
	return nil
}

// v1ModelsServeOnly falls back, on the public route only, on a request whose answer or headers depend
// on something this service does not read, before anything is computed:
//
//   - a conditional request (If-None-Match or If-Modified-Since) whose headers fresh reads are not
//     each one ASCII line (`v1-models-conditional`, v1models.ConditionalUnsupported); every other
//     conditional request is computed and answered 304 or 200 as Next's fresh decides (notModified);
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
	if v1models.ConditionalUnsupported(r.Header) {
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
