package main

import (
	"net"
	"net/http"
	"net/http/httputil"
	"net/textproto"
	"net/url"
	"strings"
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
func fallbackProxy(target *url.URL) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
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
	}}
}

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
