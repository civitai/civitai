package server

import (
	"net/http"
	"net/http/pprof"
)

// PublicMux is the public listener's routes: the gallery procedure, `model.getAll` — computed only
// with ServeModelGetAll (FEED_GO_SERVE_MODEL_GETALL), else every request there is proxied to the Node
// app (ServeModelGetAllHTTP) — and `image.getInfinite`, the same behind ServeInfinite
// (FEED_GO_SERVE_INFINITE; ServeInfiniteHTTP). With V1Fallback set (FEED_GO_V1_FALLBACK_URL), also
// `GET /api/v1/models` and everything under `/api/v1/models/`, computed only with ServeV1Models
// (FEED_GO_SERVE_V1_MODELS), else proxied to V1Fallback; without it those paths are not routed here.
// With V1ImagesFallback set (FEED_GO_V1_IMAGES_FALLBACK_URL; V1Fallback alone does not mount it),
// `GET /api/v1/images` (that path only), computed only with ServeV1Images (FEED_GO_SERVE_V1_IMAGES),
// else proxied to V1ImagesFallback. With SearchFallback set (FEED_GO_SEARCH_FALLBACK_URL), everything under
// `/api/search/`, computed only with ServeSearch (FEED_GO_SERVE_SEARCH), else proxied to SearchFallback
// (a path the port does not answer, `/api/search/token` among them, falls back: `search-path`). Nothing
// else. It never carries a debug route, whatever the pprof toggle says.
func PublicMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	for _, rt := range publicRoutes(s) {
		mux.Handle(rt.pattern, rt.handler)
	}
	return mux
}

// publicRoute is one pattern PublicMux mounts.
type publicRoute struct {
	pattern string
	handler http.Handler
}

// publicRoutes is every route PublicMux mounts for s, in PublicMux's order. Each one ends a request it
// does not answer at handBack, so eval mode's hand-back stub covers every public route (pinned by
// TestEvalModeStubsEveryPublicRoute, which reads this list).
func publicRoutes(s *Server) []publicRoute {
	routes := []publicRoute{
		{"/api/trpc/" + Procedure, s},
		{"/api/trpc/" + ProcedureModelGetAll, http.HandlerFunc(s.ServeModelGetAllHTTP)},
		{"/api/trpc/" + ProcedureInfinite, http.HandlerFunc(s.ServeInfiniteHTTP)},
	}
	if s.V1Fallback != nil {
		routes = append(routes,
			publicRoute{V1ModelsPath, http.HandlerFunc(s.ServeV1ModelsHTTP)},
			// The subtree: `{id}`, and any deeper path, which the compute falls back on (`v1-models-path`).
			publicRoute{V1ModelsPath + "/", http.HandlerFunc(s.ServeV1ModelsIDHTTP)})
	}
	if s.V1ImagesFallback != nil {
		// The exact path: nothing under /api/v1/images/ is this route (Node's are other pages).
		routes = append(routes, publicRoute{V1ImagesPath, http.HandlerFunc(s.ServeV1ImagesHTTP)})
	}
	if s.SearchFallback != nil {
		routes = append(routes, publicRoute{SearchPath + "/", http.HandlerFunc(s.ServeSearchHTTP)})
	}
	return routes
}

// InternalMux is the internal listener's routes: metrics, liveness (/healthz), readiness (/readyz), the shadow endpoints, the Go-first
// probe endpoint (`/internal/probe/<procedure>`), and — only when
// withPprof (FEED_GO_PPROF) — the net/http/pprof handlers under /debug/pprof/, so a CPU profile can be
// pulled through a port-forward (`/debug/pprof/profile?seconds=30`).
func InternalMux(s *Server, metrics http.Handler, withPprof bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics)
	// Liveness: 200 while the process serves, draining included. Readiness is /readyz, separate so a
	// shutdown can fail it without the liveness probe restarting the pod mid-drain.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("/readyz", &s.Readiness)
	if s.EvalMode {
		// An eval pod is never sampled: neither the shadow comparisons nor the Go-first probes are
		// routed (config.LoadEval refuses the switches that would feed them).
		return withPprofRoutes(mux, withPprof)
	}
	mux.HandleFunc("/internal/shadow/"+Procedure, s.ShadowHandler)
	mux.HandleFunc("/internal/shadow"+V1ImagesPath, s.ShadowV1Handler)
	mux.HandleFunc("/internal/shadow"+V1ModelsPath, s.ShadowV1ModelsHandler)
	mux.HandleFunc("/internal/shadow"+V1ModelsPath+"/id", s.ShadowV1ModelsIDHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureInfinite, s.ShadowInfiniteHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureModelGetAll, s.ShadowModelGetAllHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureAssociated, s.ShadowAssociatedHandler)
	mux.HandleFunc("/internal/shadow"+SearchPath, s.ShadowSearchHandler)
	mux.HandleFunc(ProbePathPrefix, s.ProbeHandler)
	return withPprofRoutes(mux, withPprof)
}

// withPprofRoutes is mux with the net/http/pprof handlers under /debug/pprof/ when withPprof.
func withPprofRoutes(mux *http.ServeMux, withPprof bool) *http.ServeMux {
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
