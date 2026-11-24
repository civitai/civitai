package server

import (
	"context"
	"net/http"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The public serve path of `GET /api/v1/images` (DESIGN.md §13.8), behind ServeV1Images
// (FEED_GO_SERVE_V1_IMAGES, default off): the `/api/v1/models` routes' shape (serveV1Models) for the
// images route. The switch first, then the API request policy (a blocked region or a crawler's user
// agent is handed to the Node app), a serve slot from the one shared pool (MaxInFlight), the request
// budget, and the compute the shadow runs (v1ImagesCompute). An answer is the shadow-compared body
// and the headers PublicEndpoint and the handler set, plus X-Feed-Go-Served: go, or, to a conditional
// request the answer's ETag satisfies, Next's 304 (writeV1Models); every fallback is proxied to
// v1ImagesUpstream: V1ImagesFallback (FEED_GO_V1_IMAGES_FALLBACK_URL) when set, else V1Fallback, the
// Node app that serves `/api/v1`. No origin check: PublicEndpoint answers any origin
// (CORS `*`, no credentials), and the route has no block-scope middleware.
//
// Signed-out callers only: a request presenting any credential (an Authorization header, a `?token=`,
// a session cookie) is handed back to Node before anything is computed, as the model list does.

// errV1ImagesOff is the `v1-images-off` fallback: the public images route with ServeV1Images off.
var errV1ImagesOff = fallback.New("v1-images-off")

// ServeV1ImagesHTTP is the public `GET /api/v1/images` route. With ServeV1Images off every request is
// the `v1-images-off` fallback: nothing is computed and no serve slot is taken.
func (s *Server) ServeV1ImagesHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	endpoint := EndpointV1Images
	ctx, span := s.startSpan(r.Context(), r.Header, "serve", endpoint)
	defer span.End()
	if s.Tracer != nil {
		r = r.WithContext(ctx)
	}
	var (
		c   *computed
		err error
	)
	if !s.ServeV1Images {
		err = errV1ImagesOff
	} else if err = s.apiRequestPolicy(r); err == nil {
		c, err = s.computeServe(r, endpoint, s.v1ImagesCompute(true))
	}
	if err == nil {
		served := "served"
		if c.trivial {
			served = "served_empty"
		}
		writeV1Models(w, c, notModified(r, c))
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
	s.proxyVia(s.v1ImagesUpstream(), w, r, endpoint)
}

// v1ImagesUpstream is the Node app every images-route fallback is proxied to: V1ImagesFallback when
// set, else V1Fallback; nil when neither is (the route is then not mounted).
func (s *Server) v1ImagesUpstream() http.Handler {
	if s.V1ImagesFallback != nil {
		return s.V1ImagesFallback
	}
	return s.V1Fallback
}

// v1ImagesCompute is the compute of the images route, the shadow's and the public route's alike
// (serving tells them apart): the request checks of v1ModelsPreflight (not a GET, any API credential),
// then, serving only, those of v1ImagesServeOnly; the port (computeV1, which serving also refuses a
// resolved session: computeV1For); then the body as JSON.stringify writes it (v1models.NodeBody) and
// the headers Node sends with it (v1models.ResponseHeaders with the handler's own no-store above SFW).
// Serving, a body with no known JSON.stringify text falls back (`v1-images-invalid-utf8`); in the
// shadow that body is compared as computed and its headers are not (uncompared).
func (s *Server) v1ImagesCompute(serving bool) func(context.Context, *http.Request) (*computed, error) {
	inner := func(ctx context.Context, r *http.Request) (*computed, error) { return s.computeV1For(ctx, r, serving) }
	if s.computeV1Fn != nil {
		inner = s.computeV1Fn
	}
	return func(ctx context.Context, r *http.Request) (*computed, error) {
		if err := v1ModelsPreflight(r); err != nil {
			return nil, err
		}
		if serving {
			if err := v1ImagesServeOnly(r); err != nil {
				return nil, err
			}
		}
		c, err := inner(ctx, r)
		if err != nil {
			return nil, err
		}
		body, ok := v1models.NodeBody(c.payload)
		if !ok {
			if serving {
				c.release()
				return nil, fallback.New("v1-images-invalid-utf8")
			}
			return c, nil
		}
		// The query already parsed in the port (so this cannot fail after an answer, but a serve never
		// writes headers it could not compute); its maturity inputs decide the handler's Cache-Control.
		in, err := feed.ParseV1(r.URL.RawQuery)
		if err != nil {
			if serving {
				c.release()
				return nil, err
			}
			return c, nil
		}
		// body is c.payload, or a copy when an escape was rewritten; c.buf still owns the pooled bytes.
		c.payload = body
		c.headers = v1models.ResponseHeaders(v1models.HeaderInput{
			Credentialed:    v1models.CarriesCallerCredentials(r.Header, r.URL.RawQuery),
			VerifiedCrawler: verifiedCrawler(r),
			NoStore:         !in.WithinSFW(),
		}, body)
		return c, nil
	}
}

// v1ImagesServeOnly falls back, on the public route only, on a request whose answer or headers depend
// on something this service does not serve, before anything is computed:
//
//   - a conditional request whose headers fresh reads are not each one ASCII line
//     (`v1-images-conditional`, v1models.ConditionalUnsupported); every other conditional request is
//     computed and answered 304 or 200 as Next's fresh decides (notModified);
//   - a cookie under a session cookie name, valid or not (`v1-images-session-cookie`): the route
//     serves signed-out callers only, and the cookie also switches PublicEndpoint's headers to the
//     credentialed arm (`private`, `Vary: Authorization, Cookie`).
//
// In the shadow these do not drop a sample: the sampler forwards no conditional header, and a sample
// with a session cookie is computed for the viewer and compared, its headers too.
func v1ImagesServeOnly(r *http.Request) error {
	if v1models.ConditionalUnsupported(r.Header) {
		return fallback.New("v1-images-conditional")
	}
	if v1models.HasSessionCookie(r.Header) {
		return fallback.New("v1-images-session-cookie")
	}
	return nil
}
