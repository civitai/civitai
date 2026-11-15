package main

import (
	"net"
	"net/http/httputil"
	"net/url"
	"strings"
)

// forwardingHeaders are passed through to the Node app as they arrived. The Rewrite form of
// ReverseProxy strips them from the outbound request before calling Rewrite; the Director form this
// proxy was first written in left them untouched, so whatever downstream reads them sees what it saw
// before.
var forwardingHeaders = []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto"}

// fallbackProxy forwards a request this service does not answer to the Node app at target, keeping
// the original Host: the Node app derives the domain color and cookies from it. Forwarding headers
// are as the Director form wrote them: the inbound ones passed through, and the client address
// appended to the inbound X-Forwarded-For chain (not SetXForwarded, which would also overwrite
// X-Forwarded-Host/-Proto with this hop's own values).
func fallbackProxy(target *url.URL) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Host = pr.In.Host
		for _, h := range forwardingHeaders {
			if v, ok := pr.In.Header[h]; ok {
				pr.Out.Header[h] = v
			}
		}
		prior := pr.In.Header["X-Forwarded-For"]
		ip, _, err := net.SplitHostPort(pr.In.RemoteAddr)
		switch {
		case err == nil && len(prior) > 0:
			pr.Out.Header.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+ip)
		case err == nil:
			pr.Out.Header.Set("X-Forwarded-For", ip)
		case len(prior) > 0:
			pr.Out.Header["X-Forwarded-For"] = prior
		}
		// Without an inbound User-Agent, send none rather than Go's default.
		if _, ok := pr.In.Header["User-Agent"]; !ok {
			pr.Out.Header.Set("User-Agent", "")
		}
	}}
}
