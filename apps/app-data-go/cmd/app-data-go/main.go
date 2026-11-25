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
	"net/url"
	"os"
	"os/signal"
	"sync"
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
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
	"github.com/civitai/civitai/apps/app-data-go/internal/token"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
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
	// overlayMargin is how much longer than one adapter poll an acknowledged write is shown over a
	// stream that has not caught up with it (WRITES-DESIGN.md: "one poll interval plus 30 s").
	overlayMargin = 30 * time.Second
	// levelMaxAge closes a level stream an hour after it opened (a fresh snapshot of the board), and
	// maxSharedOverlays bounds the acknowledged shared writes held in all.
	levelMaxAge       = time.Hour
	maxSharedOverlays = 10_000
	// signedOutProbesPerApp bounds the signed-out reads of a collection major not yet known to
	// resolve that run at once per app (package shared, SIGNED-OUT).
	signedOutProbesPerApp = 2
	// serviceTokenScope is the one scope the level streams' service token asks for: the adapter's
	// service tokens must grant AppsRead (auth.jwt.ts).
	serviceTokenScope = "AppsRead"
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
	for _, w := range cfg.Warnings() {
		log.Warn("configuration", "warning", w)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	// The private streams' manager, and with the shared reads on the level and per-viewer streams'.
	var mgr, levels, viewers *session.Manager
	var overlays *shared.Overlays
	var sharedReader *shared.Reader
	var m *metrics.Metrics
	stats := func() (int, int, int, int) {
		var sum session.Stats
		for _, mm := range []*session.Manager{mgr, levels, viewers} {
			if mm == nil {
				continue
			}
			st := mm.Stats()
			sum.Streams, sum.Live, sum.Records, sum.Bytes = sum.Streams+st.Streams, sum.Live+st.Live, sum.Records+st.Records, sum.Bytes+st.Bytes
		}
		return sum.Streams, sum.Live, sum.Records, sum.Bytes
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
	// One verifier, and one key set, for the block exchange and the writes alike.
	var verifier *exchange.BlockVerifier
	if cfg.BlockJWKSURL != "" {
		verifier = &exchange.BlockVerifier{JWKSURL: cfg.BlockJWKSURL, HTTP: &http.Client{Timeout: exchangeTimeout}}
	}
	swept := make(chan struct{})
	if cfg.RegistryURL != "" {
		ex := &exchange.Exchanger{
			Config: exchange.Config{URL: cfg.Relay.TokenURL, ClientID: cfg.Relay.ClientID,
				ClientSecret: cfg.Relay.ClientSecret, Resource: cfg.Relay.Resource},
			HTTP: &http.Client{Timeout: exchangeTimeout},
		}
		// One router decides which tokens are exchanged, for the handler and the streams alike. Its
		// block cache is nil while APP_DATA_BLOCK_EXCHANGE is off: block tokens then read REST only.
		// The user exchange goes through a Guard: a token the hub refused is not sent again for a while,
		// and an address presenting many tokens not seen exchanged here is throttled before the hub.
		guard := &exchange.Guard{Hub: ex.Exchange, Observe: func(o string) { m.UserExchangeGuard.WithLabelValues(o).Inc() }}
		router := &exchange.Router{User: guard.Exchange}
		if cfg.BlockExchange {
			// Each block token is verified against the site's JWKS before it is sent to the hub.
			router.Blocks = &exchange.BlockCache{Hub: ex.ExchangeBlock, Verify: verifier.Check, Margin: expiryMargin,
				Observe: m.ObserveBlockExchange(log.With("component", "block-exchange"))}
		}
		srv.Exchangeable = router.Accepts
		// One budget over every stream this process opens, private, level and per-viewer
		// (config.DefaultCacheBudgetBytes).
		budget := session.NewBudget(cfg.MaxSubscriptions, cfg.CacheBudgetBytes)
		mgr = session.New(session.ClientSubscriber{Client: &registry.Client{
			BaseURL: cfg.RegistryURL, UserAgent: "app-data-go", HTTP: registry.NewHTTPClient(),
		}}, session.Options{
			MaxStreams: cfg.MaxStreams, MaxPerToken: cfg.MaxStreamsPerToken,
			IdleTTL: cfg.IdleTTL, MaxAge: cfg.MaxAge,
			MaxRecords: cfg.MaxRecords, MaxBytes: cfg.MaxBytes, MaxOverlayBytes: cfg.MaxOverlayBytes,
			Budget: budget, Reserve: cfg.PrivateReserve(),
			Cooldown: streamCooldown, NotPrivateCooldown: notPrivateCooldown,
			Exchange: router.Exchange, ExpiryMargin: expiryMargin, Recheck: tokenRecheck,
			Opened: m.StreamsOpened.Inc,
			Closed: func(reason string) { m.StreamsClosed.WithLabelValues(reason).Inc() },
			// Read-your-writes; zero with the writes off, which turns all of it off (session.Options).
			OverlayTTL:  overlayTTL(cfg),
			ReopenEvery: cfg.AdapterPoll,
			Floor:       func(outcome string) { m.FloorReopens.WithLabelValues(outcome).Inc() },
			Overlaid:    func(kind string) { m.Overlays.WithLabelValues(kind).Inc() },
		})
		srv.Streams = mgr
		if cfg.SharedReads {
			sub := session.ClientSubscriber{Client: &registry.Client{
				BaseURL: cfg.RegistryURL, UserAgent: "app-data-go", HTTP: registry.NewHTTPClient(),
			}}
			// The level streams run under this service's own token (client credentials, the relay
			// client), whatever subject a read names; one the registry refuses is re-minted.
			svc := token.New(token.Config{URL: cfg.Relay.TokenURL, ClientID: cfg.Relay.ClientID,
				ClientSecret: cfg.Relay.ClientSecret, Resource: cfg.Relay.Resource, Scope: serviceTokenScope}, &http.Client{Timeout: exchangeTimeout})
			var reader *shared.Reader
			reader, levels, viewers = shared.NewReader(shared.Build{
				Sub: sub, Budget: budget,
				Level:          shared.Bounds{MaxStreams: cfg.LevelMaxStreams, MaxRecords: cfg.LevelMaxRecords, MaxBytes: cfg.LevelMaxBytes},
				Viewer:         shared.Bounds{MaxStreams: cfg.ViewerMaxStreams, MaxRecords: cfg.ViewerMaxRecords, MaxBytes: cfg.ViewerMaxBytes},
				ServiceToken:   svc.TokenExpiring,
				ServiceRefused: svc.Invalidate,
				ViewerExchange: router.Exchange,
				LevelMaxAge:    levelMaxAge,
				IdleTTL:        cfg.IdleTTL, MaxAge: cfg.MaxAge, Cooldown: streamCooldown, NotPrivateCooldown: notPrivateCooldown,
				ExpiryMargin: expiryMargin, Recheck: tokenRecheck, OverlayTTL: overlayTTL(cfg), ReopenEvery: cfg.AdapterPoll,
				MaxStreamsPerToken: cfg.MaxStreamsPerToken,
				Opened:             m.StreamsOpened.Inc,
				Closed:             func(reason string) { m.StreamsClosed.WithLabelValues(reason).Inc() },
				MaxOverlays:        maxSharedOverlays, MaxOverlayBytes: config.MaxSharedOverlayBytes,
				ProbesPerApp: signedOutProbesPerApp,
			})
			overlays = reader.Overlays
			srv.Shared = reader
			sharedReader = reader
			srv.Anonymous = verifier.CheckAnonymous
		}
		go func() {
			defer close(swept)
			var wg sync.WaitGroup
			for _, mm := range []*session.Manager{mgr, levels, viewers} {
				if mm != nil {
					wg.Go(func() { mm.Run(ctx, sweepInterval(cfg.IdleTTL)) })
				}
			}
			wg.Wait()
		}()
	} else {
		close(swept)
	}

	var draining atomic.Bool
	srv.Ready = func() bool { return !draining.Load() }
	if cfg.Writes {
		site, err := url.Parse(cfg.WritesSiteURL)
		if err != nil {
			return err // config validated it; never reached
		}
		fwd := &writes.Forwarder{
			Site: site, Key: []byte(cfg.WritesSigningKey), Timeout: cfg.WritesTimeout,
			HTTP:   &http.Client{}, // bounded per forward by Timeout; redirects never followed (writes.Forwarder)
			Verify: verifier.Check, Ready: srv.Ready,
			Metrics: m, Log: log.With("component", "writes"),
		}
		if mgr != nil {
			fwd.Acked = mgr.Ack
		}
		if overlays != nil {
			fwd.Acked = shared.AckBoth(mgr, sharedReader)
		}
		srv.Writes = fwd
	}
	// A response may take as long as the slowest request: a read's deadline, or a forward's timeout.
	longest := max(cfg.RequestDeadline, cfg.WritesTimeout)
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      longest + 5*time.Second,
		IdleTimeout:       100 * time.Second,
	}
	log.Info("app-data-go starting", "addr", cfg.Addr, "registry", cfg.RegistryURL != "", "block_exchange", cfg.BlockExchange,
		"writes", cfg.Writes, "max_streams", cfg.MaxStreams, "max_streams_per_token", cfg.MaxStreamsPerToken,
		"max_subscriptions", cfg.MaxSubscriptions, "cache_budget_bytes", cfg.CacheBudgetBytes)

	served := make(chan error, 1)
	go func() { served <- httpSrv.ListenAndServe() }()
	select {
	case <-ctx.Done():
	case err = <-served:
		stop()
	}
	draining.Store(true)
	// In-flight writes are let finish: one cut off here would answer its client nothing, its outcome
	// unknown. New writes are refused 503 not_forwarded once draining is set. The wait is sized by the
	// forward timeout alone (a read cut off is only retried), and that timeout's cap
	// (config.MaxWritesTimeout) keeps it inside the pod's termination grace period.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), max(10*time.Second, cfg.WritesTimeout+config.ShutdownMargin))
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx) //nolint:contextcheck // shutdown outlives the cancelled ctx by design
	<-swept
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// overlayTTL is how long an acknowledged write is shown over its stream: zero with the writes off.
func overlayTTL(cfg *config.Config) time.Duration {
	if !cfg.Writes {
		return 0
	}
	return cfg.AdapterPoll + overlayMargin
}

// sweepInterval checks for idle streams four times per idle TTL, at most every 10 seconds.
func sweepInterval(idle time.Duration) time.Duration {
	return min(idle/4, 10*time.Second)
}
