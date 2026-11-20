// Command app-data-go serves app clients their users' private app data. A read is answered from a
// per-user stream on the registry adapter, opened with a token this service exchanged from the user's
// own token as the adapter's relay, so the origin stays the only judge of what the user may read; when no stream can answer in time, from the site's document-store REST
// read, made with the same token. Browsers never subscribe to the registry themselves. See
// apps/app-data-go/README.md and DESIGN.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/civitai/civitai/apps/app-data-go/internal/api"
	"github.com/civitai/civitai/apps/app-data-go/internal/config"
	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/rest"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// Stream timings that are not configuration: how long a stream that failed is not reopened; how
// long a collection the private feed does not serve is left to REST; how long before its exchanged
// token expires a stream is closed; how often a live stream re-checks its user's token; how long one
// exchange may take.
const (
	streamCooldown     = 30 * time.Second
	notPrivateCooldown = 15 * time.Minute
	expiryMargin       = 30 * time.Second
	tokenRecheck       = 2 * time.Minute
	exchangeTimeout    = 5 * time.Second
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

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	var mgr *session.Manager
	var m *metrics.Metrics
	stats := func() (int, int, int, int) {
		if mgr == nil {
			return 0, 0, 0, 0
		}
		st := mgr.Stats()
		return st.Streams, st.Live, st.Records, st.Bytes
	}
	m = metrics.New(reg, stats)

	srv := &api.Server{
		REST: &rest.Client{BaseURL: cfg.RESTURL, MaxRecords: cfg.MaxRecords,
			HTTP: &http.Client{Timeout: cfg.RequestDeadline}},
		Metrics:   m,
		Gatherer:  reg,
		Log:       log.With("component", "api"),
		Deadline:  cfg.RequestDeadline,
		LiveWait:  cfg.LiveWait,
		RESTSlots: make(chan struct{}, cfg.RESTMaxInFlight),
	}
	swept := make(chan struct{})
	if cfg.RegistryURL != "" {
		ex := &exchange.Exchanger{
			Config: exchange.Config{URL: cfg.Relay.TokenURL, ClientID: cfg.Relay.ClientID,
				ClientSecret: cfg.Relay.ClientSecret, Resource: cfg.Relay.Resource},
			HTTP: &http.Client{Timeout: exchangeTimeout},
		}
		mgr = session.New(session.ClientSubscriber{Client: &registry.Client{
			BaseURL: cfg.RegistryURL, UserAgent: "app-data-go", HTTP: registry.NewHTTPClient(),
		}}, session.Options{
			MaxStreams: cfg.MaxStreams, MaxPerToken: cfg.MaxStreamsPerToken,
			IdleTTL: cfg.IdleTTL, MaxAge: cfg.MaxAge,
			MaxRecords: cfg.MaxRecords, MaxBytes: cfg.MaxBytes,
			Cooldown: streamCooldown, NotPrivateCooldown: notPrivateCooldown,
			Exchange: ex.Exchange, ExpiryMargin: expiryMargin, Recheck: tokenRecheck,
			Opened: m.StreamsOpened.Inc,
			Closed: func(reason string) { m.StreamsClosed.WithLabelValues(reason).Inc() },
		})
		srv.Streams = mgr
		go func() {
			defer close(swept)
			mgr.Run(ctx, sweepInterval(cfg.IdleTTL))
		}()
	} else {
		close(swept)
	}

	var draining atomic.Bool
	srv.Ready = func() bool { return !draining.Load() }
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.RequestDeadline + 5*time.Second,
		IdleTimeout:       100 * time.Second,
	}
	log.Info("app-data-go starting", "addr", cfg.Addr, "registry", cfg.RegistryURL != "",
		"max_streams", cfg.MaxStreams, "max_streams_per_token", cfg.MaxStreamsPerToken)

	served := make(chan error, 1)
	go func() { served <- httpSrv.ListenAndServe() }()
	select {
	case <-ctx.Done():
	case err = <-served:
		stop()
	}
	draining.Store(true)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx) //nolint:contextcheck // shutdown outlives the cancelled ctx by design
	<-swept
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// sweepInterval checks for idle streams four times per idle TTL, at most every 10 seconds.
func sweepInterval(idle time.Duration) time.Duration {
	return min(idle/4, 10*time.Second)
}
