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
// Nothing else. It never carries a debug route, whatever the pprof toggle says.
func PublicMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/api/trpc/"+Procedure, s)
	mux.HandleFunc("/api/trpc/"+ProcedureModelGetAll, s.ServeModelGetAllHTTP)
	mux.HandleFunc("/api/trpc/"+ProcedureInfinite, s.ServeInfiniteHTTP)
	if s.V1Fallback != nil {
		mux.HandleFunc(V1ModelsPath, s.ServeV1ModelsHTTP)
		// The subtree: `{id}`, and any deeper path, which the compute falls back on (`v1-models-path`).
		mux.HandleFunc(V1ModelsPath+"/", s.ServeV1ModelsIDHTTP)
	}
	return mux
}

// InternalMux is the internal listener's routes: metrics, health, the shadow endpoints, the Go-first
// probe endpoint (`/internal/probe/<procedure>`), and — only when
// withPprof (FEED_GO_PPROF) — the net/http/pprof handlers under /debug/pprof/, so a CPU profile can be
// pulled through a port-forward (`/debug/pprof/profile?seconds=30`).
func InternalMux(s *Server, metrics http.Handler, withPprof bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/internal/shadow/"+Procedure, s.ShadowHandler)
	mux.HandleFunc("/internal/shadow"+V1ImagesPath, s.ShadowV1Handler)
	mux.HandleFunc("/internal/shadow"+V1ModelsPath, s.ShadowV1ModelsHandler)
	mux.HandleFunc("/internal/shadow"+V1ModelsPath+"/id", s.ShadowV1ModelsIDHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureInfinite, s.ShadowInfiniteHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureModelGetAll, s.ShadowModelGetAllHandler)
	mux.HandleFunc("/internal/shadow/"+ProcedureAssociated, s.ShadowAssociatedHandler)
	mux.HandleFunc(ProbePathPrefix, s.ProbeHandler)
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
