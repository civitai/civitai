// Command content-policy-go answers, for one viewer, which content ratings they may be sent, at
// which browsing level, and whether their region holds them to SFW or refuses them: the SFW/NSFW and
// region rules the site and the registry adapter apply today, in one place. See
// apps/content-policy-go/DESIGN.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/civitai/civitai/apps/content-policy-go/internal/api"
	"github.com/civitai/civitai/apps/content-policy-go/internal/config"
	"github.com/civitai/civitai/apps/content-policy-go/internal/dbpool"
	"github.com/civitai/civitai/apps/content-policy-go/internal/metrics"
	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
	"github.com/civitai/civitai/apps/content-policy-go/internal/users"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	poolCfg, err := dbpool.Config(cfg.DatabaseURL, dbpool.Settings{MaxConns: cfg.DBMaxConns})
	if err != nil {
		return errors.New("the database URL is not valid") // never echo it: it holds the password
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	engine := policy.NewEngine(cfg.Restricted, cfg.Blocked)
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	m := metrics.New(reg)
	m.Info.WithLabelValues(engine.PolicyVersion()).Set(1)

	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: (&api.Server{
			Engine:        engine,
			Users:         &users.Cache{Source: users.Postgres{DB: pool}, TTL: cfg.CacheTTL, MaxEntries: cfg.CacheMax},
			Metrics:       m,
			Gatherer:      reg,
			Log:           log.With("component", "api"),
			LookupTimeout: cfg.LookupTimeout,
			Ready:         pool.Ping,
		}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       100 * time.Second,
	}
	log.Info("content-policy-go starting", "addr", cfg.Addr, "policy_version", engine.PolicyVersion(),
		"restricted_regions", len(cfg.Restricted), "blocked_regions", len(cfg.Blocked),
		"cache_ttl", cfg.CacheTTL.String(), "lookup_timeout", cfg.LookupTimeout.String())

	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()
	select {
	case <-ctx.Done():
	case err = <-served:
		stop()
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx) //nolint:contextcheck // shutdown must outlive the cancelled run context
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
