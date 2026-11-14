package server

import (
	"net/http"
	"net/http/pprof"
)

// PublicMux is the public listener's routes: the one procedure, nothing else. It never carries a
// debug route, whatever the pprof toggle says.
func PublicMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/api/trpc/"+Procedure, s)
	return mux
}

// InternalMux is the internal listener's routes: metrics, health, the shadow endpoint, and — only when
// withPprof (FEED_GO_PPROF) — the net/http/pprof handlers under /debug/pprof/, so a CPU profile can be
// pulled through a port-forward (`/debug/pprof/profile?seconds=30`).
func InternalMux(s *Server, metrics http.Handler, withPprof bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/internal/shadow/"+Procedure, s.ShadowHandler)
	if withPprof {
		// Registered explicitly: importing net/http/pprof also registers these on http.DefaultServeMux,
		// which this service never serves.
		mux.HandleFunc("/debug/pprof/", pprof.Index) // also serves the named profiles (heap, goroutine, …)
		mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	}
	return mux
}
