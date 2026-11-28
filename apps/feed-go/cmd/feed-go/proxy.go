package main

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel/propagation"
)

// fallbackIdleTimeout is how long the fallback proxy keeps an idle connection to the Node app. It must
// stay below the Node app's keep-alive timeout, which is whatever its server sets: Node's http.Server
// default of 5 s unless it is configured longer (Next's standalone server reads KEEP_ALIVE_TIMEOUT).
// 3 s stays below any of those. Past it, Node closes the idle connection, and a request the proxy
// writes onto a connection Node has just closed fails: Go replays an idempotent request (a GET) on a
// new connection, but cannot replay a POST, which the proxy answers 502. The browser client never
// POSTs to this procedure (a query too large for a GET does not take the Go transport), so the main
// gains here are the larger idle pool and feed_go_fallback_proxy_errors_total. The cost is a new
// connection after 3 s without a fallback.
const fallbackIdleTimeout = 3 * time.Second

// fallbackMaxIdlePerHost is the idle pool kept for the one upstream (DefaultTransport keeps 2 per
// host, so a burst of concurrent fallbacks would open and drop new connections).
const fallbackMaxIdlePerHost = 32

// Reasons passed to fallbackProxy's onError.
const (
	proxyErrorCanceled = "canceled" // the client went away before the Node app answered
	proxyErrorUpstream = "upstream" // the Node app could not be reached or broke the connection
)

// forwardingHeaders are passed through to the Node app as they arrived. Rewrite strips these from the
// outbound request; restore them so the Node app sees the inbound values.
var forwardingHeaders = []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto"}

// fallbackProxy forwards a request this service does not answer to the Node app at target, keeping
// the original Host: the Node app derives the domain color and cookies from it. In addition:
//   - the query is forwarded byte for byte (Rewrite mode re-encodes a query holding a `;` or a bad
//     escape before calling Rewrite);
//   - the inbound forwarding headers are passed through, except one the inbound Connection header
//     names (it is hop-by-hop);
//   - the client address is appended to the inbound X-Forwarded-For chain (not SetXForwarded, which
//     would also overwrite X-Forwarded-Host/-Proto with this hop's own values).
//
// ReverseProxy itself sends an empty User-Agent when the inbound request has none.
//
// The proxy has its own transport, keeping idle connections for idle (fallbackIdleTimeout in
// production; a test passes a shorter one), not DefaultTransport's 90 s. With prop (tracing on) the
// outbound request carries the trace context of its own context (prop.Inject), replacing an inbound
// traceparent when that context holds a span (server.proxy starts one). A context without one
// injects nothing, so the inbound trace headers would pass through: the serve-side parity replay
// (no span, server/serveparity.go) strips them itself. A request that fails before
// the Node app's response starts is answered 502 and reported to onError (if non-nil) with
// proxyErrorCanceled or proxyErrorUpstream; one that fails mid-body is aborted by ReverseProxy
// (http.ErrAbortHandler) and not reported.
func fallbackProxy(target *url.URL, idle time.Duration, onError func(r *http.Request, reason string, err error), prop propagation.TextMapPropagator) *httputil.ReverseProxy {
	p := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		// The target has no query of its own; a target query would be dropped.
		pr.Out.URL.RawQuery = pr.In.URL.RawQuery
		pr.Out.Host = pr.In.Host
		hop := connectionTokens(pr.In.Header)
		for _, h := range forwardingHeaders {
			if v, ok := pr.In.Header[h]; ok && !hop[h] {
				pr.Out.Header[h] = v
			}
		}
		var prior []string
		if !hop["X-Forwarded-For"] {
			prior = pr.In.Header["X-Forwarded-For"]
		}
		ip, _, err := net.SplitHostPort(pr.In.RemoteAddr)
		switch {
		case err == nil && len(prior) > 0:
			pr.Out.Header.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+ip)
		case err == nil:
			pr.Out.Header.Set("X-Forwarded-For", ip)
		case len(prior) > 0:
			pr.Out.Header["X-Forwarded-For"] = prior
		}
		// Tracing on: the outbound traceparent is this hop's span (server.proxy starts it), replacing
		// the inbound one, so the Node app's span is its child. Off (nil): the inbound headers pass
		// through as they came.
		if prop != nil {
			prop.Inject(pr.Out.Context(), propagation.HeaderCarrier(pr.Out.Header))
		}
	}}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.IdleConnTimeout = idle
	tr.MaxIdleConnsPerHost = fallbackMaxIdlePerHost
	p.Transport = tr
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		if onError != nil {
			reason := proxyErrorUpstream
			if r.Context().Err() != nil {
				reason = proxyErrorCanceled
			}
			onError(r, reason, err)
		}
		w.WriteHeader(http.StatusBadGateway)
	}
	return p
}

// connectionTokens returns the header names the Connection header lists, canonicalized.
func connectionTokens(h http.Header) map[string]bool {
	out := map[string]bool{}
	for _, v := range h["Connection"] {
		for _, f := range strings.Split(v, ",") {
			if f = textproto.TrimString(f); f != "" {
				out[textproto.CanonicalMIMEHeaderKey(f)] = true
			}
		}
	}
	return out
}
