package main

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/textproto"
	"net/url"
	"strings"
)

// forwardingHeaders are passed through to the Node app as they arrived. The Rewrite form of
// ReverseProxy strips them from the outbound request before calling Rewrite; the Director form this
// proxy was first written in left them untouched, so whatever downstream reads them sees what it saw
// before.
var forwardingHeaders = []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto"}

// fallbackProxy forwards a request this service does not answer to the Node app at target, keeping
// the original Host: the Node app derives the domain color and cookies from it. Everything else is
// as the Director form wrote it:
//   - the query is forwarded byte for byte (Rewrite mode re-encodes a query holding a `;` or a bad
//     escape before calling Rewrite; the Director form never did, as this service never parses the
//     form);
//   - the inbound forwarding headers are passed through, except one the inbound Connection header
//     names (hop-by-hop: the Director form's hop-by-hop removal dropped it);
//   - the client address is appended to the inbound X-Forwarded-For chain (not SetXForwarded, which
//     would also overwrite X-Forwarded-Host/-Proto with this hop's own values).
//
// ReverseProxy itself sends an empty User-Agent when the inbound request has none, in both forms.
func fallbackProxy(target *url.URL) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		// The target (FEED_GO_FALLBACK_URL) is a base URL with no query of its own, so the inbound
		// query is the whole outbound query. (A target query would be dropped here, where the
		// Director form merged it.)
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
	}}
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
