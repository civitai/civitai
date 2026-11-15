package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// fallbackProxy forwards a request this service does not answer to the Node app at target, keeping
// the original Host: the Node app derives the domain color and cookies from it.
func fallbackProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		host := r.Host
		director(r)
		r.Host = host
	}
	return proxy
}
