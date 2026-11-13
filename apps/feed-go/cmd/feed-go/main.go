// Command feed-go serves `image.getImagesAsPostsInfinite` for the request shapes it has ported and
// proxies everything else to the Node app. See apps/feed-go/DESIGN.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func redisClient(rawURL string, cluster bool) (redis.UniversalClient, error) {
	if cluster {
		opts, err := redis.ParseClusterURL(rawURL)
		if err != nil {
			return nil, err
		}
		return redis.NewClusterClient(opts), nil
	}
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	return redis.NewClient(opts), nil
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	cache, err := redisClient(cfg.RedisURL, cfg.RedisCluster)
	if err != nil {
		return err
	}
	// The system redis is a primary/replica set, never a cluster.
	sys, err := redisClient(cfg.RedisSysURL, false)
	if err != nil {
		return err
	}

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := server.NewMetrics(reg)

	packed := &hydrate.PackedReader{Redis: cache, Prefix: cfg.CacheKeyPrefix}
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: pool}
	resolver := &auth.Resolver{
		Verifier: &auth.Verifier{Issuer: cfg.AuthIssuer, JWKSURL: cfg.AuthJWKSURI, RequireIat0: cfg.AuthRequireIat0},
		Revocation: &auth.Revocation{Redis: sys, Timeout: cfg.SysReadTimeout, OnFailOpen: func(err error) {
			log.Warn("revocation read failed open", "err", err)
		}},
		Sessions:    packed,
		CookieNames: cfg.CookieNames(),
	}
	deps := &feed.Deps{
		DB:       pool,
		Cache:    &feed.QueryCache{Redis: cache, Prefix: cfg.CacheKeyPrefix, Enabled: cfg.ImageQueryCache},
		Hydrator: sources,
		Gallery:  &feed.GalleryStore{Cache: cache, Prefix: cfg.CacheKeyPrefix, DB: pool},
		Addons:   &feed.AddonSource{Sys: sys},
		Config: feed.Config{
			CreatorPromotions:       cfg.CreatorPromotion,
			LazyPostImages:          cfg.LazyPostImages,
			VisibleDecorationEvents: cfg.DecorationEvents,
		},
	}
	srv := &server.Server{
		Resolver:    resolver,
		Deps:        deps,
		Hosts:       cfg.Hosts,
		RegionRules: cfg.RegionRules,
		Metrics:     metrics,
		Log:         log,
		ShadowQueue: make(chan struct{}, max(cfg.ShadowWorkers, 1)),
	}
	if cfg.FallbackURL != "" {
		target, err := url.Parse(cfg.FallbackURL)
		if err != nil {
			return err
		}
		proxy := httputil.NewSingleHostReverseProxy(target)
		// Keep the original Host: the Node app derives the domain color and cookies from it.
		director := proxy.Director
		proxy.Director = func(r *http.Request) {
			host := r.Host
			director(r)
			r.Host = host
		}
		srv.Fallback = proxy
	}

	public := http.NewServeMux()
	public.Handle("/api/trpc/"+server.Procedure, srv)
	internal := http.NewServeMux()
	internal.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	internal.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	internal.HandleFunc("/internal/shadow/"+server.Procedure, srv.ShadowHandler)

	servers := []*http.Server{
		{Addr: cfg.InternalAddr, Handler: internal, ReadHeaderTimeout: 5 * time.Second},
	}
	// Without a fallback the public route could only answer the ported shapes: shadow-only deployments
	// do not listen publicly at all.
	if srv.Fallback != nil {
		servers = append(servers, &http.Server{Addr: cfg.Addr, Handler: public, ReadHeaderTimeout: 5 * time.Second})
	}
	errs := make(chan error, len(servers))
	for _, s := range servers {
		go func(s *http.Server) {
			log.Info("listening", "addr", s.Addr)
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}(s)
	}
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	return nil
}
