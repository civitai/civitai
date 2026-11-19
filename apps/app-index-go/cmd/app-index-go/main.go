// Command app-index-go keeps a search index of the apps a registry streams and answers searches
// over it. It subscribes to the app entity schema, holds every app in its own Postgres database,
// and serves GET /search. The index is a cache: it can always be rebuilt from the registry. See
// apps/app-index-go/README.md.
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

	"github.com/civitai/civitai/apps/app-index-go/internal/api"
	"github.com/civitai/civitai/apps/app-index-go/internal/config"
	"github.com/civitai/civitai/apps/app-index-go/internal/index"
	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/registry"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("APP_INDEX_DATABASE_URL is not a valid database URL")
	}
	poolCfg.MaxConns = cfg.DBMaxConns
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	st, err := store.NewPostgres(ctx, pool)
	if err != nil {
		return err
	}

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	m := metrics.New(reg)

	// No response-header or idle timeout: a stream may be quiet for any length of time. Dead
	// connections are found by TCP keepalive and HTTP/2 pings (registry.NewHTTPClient).
	client := &registry.Client{
		BaseURL:   cfg.RegistryURL,
		Token:     cfg.RegistryToken,
		UserAgent: "app-index-go",
		HTTP:      registry.NewHTTPClient(),
	}
	consumer := &index.Consumer{
		Store:   st,
		Sub:     index.ClientSubscriber{Client: client},
		Schema:  cfg.Schema,
		Layout:  index.LayoutVersion,
		Log:     log.With("component", "consumer"),
		Metrics: m,
		Backoff: index.Backoff{Base: cfg.BackoffBase, Max: cfg.BackoffMax},
	}
	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: (&api.Server{Store: st, Metrics: m, Gatherer: reg, Log: log.With("component", "api"),
			SearchTimeout: cfg.SearchTimeout}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       100 * time.Second,
	}
	log.Info("app-index-go starting", "addr", cfg.Addr, "schema", cfg.Schema, "authenticated", cfg.RegistryToken != "")

	consumed := make(chan struct{})
	go func() {
		defer close(consumed)
		_ = consumer.Run(ctx)
	}()
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
	case err = <-served:
		stop()
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	<-consumed
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
