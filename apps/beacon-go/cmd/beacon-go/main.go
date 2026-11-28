// Command beacon-go answers the browser beacons POST /api/internal/ping, POST /api/internal/pulse and
// (with BEACON_GO_TRACK_BATCH_SERVE=true) POST /api/track/batch exactly as the Node app does, and
// either shadow-compares them against Node (BEACON_GO_MODE=shadow, the default: nothing is written)
// or serves them and writes their tracker rows (serve). See apps/beacon-go/DESIGN.md.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/config"
	"github.com/civitai/civitai/apps/beacon-go/internal/flipt"
	"github.com/civitai/civitai/apps/beacon-go/internal/hydrate"
	"github.com/civitai/civitai/apps/beacon-go/internal/server"
	"github.com/civitai/civitai/apps/beacon-go/internal/sysredis"
	"github.com/civitai/civitai/apps/beacon-go/internal/tracker"
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

// trackerWriter builds and starts the serve-mode tracker client, wired to the metrics: each row's
// result (beacon_go_tracker_writes_total), each sent row's duration (beacon_go_tracker_send_seconds),
// and the queue-depth gauge, registered on reg.
func trackerWriter(cfg *config.Config, metrics *server.Metrics, reg prometheus.Registerer) *tracker.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = cfg.TrackerWorkers
	w := &tracker.Client{
		BaseURL: cfg.TrackerURL,
		HTTP:    &http.Client{Transport: tr},
		Record:  func(table, result string) { metrics.TrackerWrites.WithLabelValues(table, result).Inc() },
		Observe: func(table string, d time.Duration) {
			metrics.TrackerSendSeconds.WithLabelValues(table).Observe(d.Seconds())
		},
	}
	w.Start(cfg.TrackerWorkers, cfg.TrackerQueue)
	reg.MustRegister(server.TrackerQueueDepth(w.Depth))
	return w
}

// insertWriter builds and starts the serve-mode direct ClickHouse writer (the impression inserts),
// counted under the same series as the tracker rows (table `impressions`, one count per insert).
func insertWriter(cfg *config.Config, metrics *server.Metrics) *tracker.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = cfg.ClickHouseWorkers
	w := tracker.NewClickHouse(cfg.ClickHouseHost, cfg.ClickHouseUsername, cfg.ClickHousePassword, &http.Client{Transport: tr})
	w.Record = func(table, result string) { metrics.TrackerWrites.WithLabelValues(table, result).Inc() }
	w.Observe = func(table string, d time.Duration) {
		metrics.TrackerSendSeconds.WithLabelValues(table).Observe(d.Seconds())
	}
	w.Start(cfg.ClickHouseWorkers, cfg.ClickHouseQueue)
	return w
}

// feedSampleRate starts the background read of the feed events sample rate, or returns nil when
// FLIPT_URL is unset (every batch with a feed event then falls back).
func feedSampleRate(ctx context.Context, cfg *config.Config, log *slog.Logger) (func() (float64, bool), error) {
	if cfg.FliptURL == "" {
		return nil, nil
	}
	c, err := flipt.New(flipt.Config{URL: cfg.FliptURL, ClientToken: cfg.FliptToken, Environment: cfg.FliptEnvironment})
	if err != nil {
		return nil, err
	}
	rate := flipt.NewRate(func(ctx context.Context) (bool, string, error) {
		return c.Variant(ctx, beacon.FeedEventsSampleRateFlag)
	}, beacon.ParseSampleRate)
	rate.OnError = func(err error) { log.Warn("feed events sample rate read failed", "err", err) }
	rate.Start(ctx)
	return rate.Value, nil
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cache, err := redisClient(cfg.RedisURL, cfg.RedisCluster)
	if err != nil {
		return err
	}
	defer func() { _ = cache.Close() }()
	sys, err := sysredis.New(sysredis.Settings{
		URL:              cfg.RedisSysURL,
		Sentinels:        cfg.RedisSysSentinels,
		SentinelName:     cfg.RedisSysSentinelName,
		SentinelPassword: cfg.RedisSysSentinelPassword,
	})
	if err != nil {
		return err
	}
	defer func() { _ = sys.Close() }()

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := server.NewMetrics(reg)

	readErrors := &server.ReadErrorReporter{Log: log, Counter: metrics.RevocationReadErrors}
	verifier := &auth.Verifier{
		Issuer: cfg.AuthIssuer, JWKSURL: cfg.AuthJWKSURI, RequireIat0: cfg.AuthRequireIat0,
		RefreshInterval: cfg.JWKSRefresh,
		MaxStaleness:    cfg.JWKSMaxStaleness,
		OnStale: func(age time.Duration) {
			metrics.JWKSStale.Inc()
			log.Error("jwks key set dropped: no successful fetch within the maximum staleness; sessions verify as signed out",
				"age", age.String(), "max", cfg.JWKSMaxStaleness.String())
		},
		OnRefresh: func(err error) {
			if err != nil {
				metrics.JWKSRefresh.WithLabelValues("error").Inc()
				log.Warn("jwks refresh failed; keeping the last good key set", "err", err)
				return
			}
			metrics.JWKSRefresh.WithLabelValues("ok").Inc()
		},
	}
	go verifier.Run(ctx)
	resolver := &auth.Resolver{
		Verifier:            verifier,
		Revocation:          &auth.Revocation{Redis: sys, Timeout: cfg.SysReadTimeout, OnReadError: readErrors.Report},
		Sessions:            &hydrate.PackedReader{Redis: cache, Prefix: cfg.CacheKeyPrefix},
		CookieNames:         cfg.CookieNames,
		OnSlot:              func(slot string) { metrics.SessionCookieSlot.WithLabelValues(slot).Inc() },
		ModerationAccountID: cfg.ModerationAccountID,
	}
	engine := &beacon.Engine{
		Sessions: resolver,
		// In shadow mode the sampler only runs where the Node Tracker is configured, so the computed
		// rows are always produced (and compared); nothing is sent.
		TrackerEnabled: cfg.OutwardTraffic && (cfg.Mode == server.ModeShadow || cfg.TrackerURL != ""),
		HubOrigin:      cfg.AuthIssuer,
		UpdateAgeMs:    cfg.UpdateAgeMs,
		ModeFor:        cfg.ModeFor,
	}
	if cfg.Mode == server.ModeServe {
		engine.TrackBatchSinks.Impressions, engine.TrackBatchSinks.Feed = cfg.ServeSinks()
	}
	if engine.FeedSampleRate, err = feedSampleRate(ctx, cfg, log); err != nil {
		return err
	}
	srv := &server.Server{
		Engine:        engine,
		Mode:          cfg.Mode,
		Metrics:       metrics,
		Log:           log,
		ShadowQueue:   make(chan struct{}, cfg.ShadowWorkers),
		ComputeBudget: cfg.ComputeBudget,
		// Read only by the public listener, which runs in serve mode only.
		TrackBatchServe: cfg.TrackBatchServe,
	}
	var writer rowWriter
	internal := server.InternalHTTPServer(cfg.InternalAddr, server.InternalMux(srv, promhttp.HandlerFor(reg, promhttp.HandlerOpts{})))
	var public []*http.Server
	if cfg.Mode == server.ModeServe {
		target, err := url.Parse(cfg.FallbackURL)
		if err != nil {
			return err
		}
		srv.Proxy = fallbackProxy(target)
		w := trackerWriter(cfg, metrics, reg)
		srv.Writer = w
		writer = w
		if engine.TrackBatchSinks.Impressions {
			ins := insertWriter(cfg, metrics)
			srv.Inserts = ins
			writer = writers{w, ins}
		}
		public = append(public, server.PublicHTTPServer(cfg.Addr, server.PublicMux(srv)))
	}
	log.Info("starting", "mode", cfg.Mode, "track_batch_serve", cfg.TrackBatchServe,
		"track_batch_impressions", engine.TrackBatchSinks.Impressions, "track_batch_feed", engine.TrackBatchSinks.Feed,
		"feed_sample_rate", engine.FeedSampleRate != nil)

	servers := append([]*http.Server{internal}, public...)
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
	shutdown(log, gracePeriod, public, internal, srv, writer)
	return nil
}

// gracePeriod bounds the drain; internalGrace is the extra time the internal listener gets after it
// to finish a scrape already in progress.
const (
	gracePeriod   = 20 * time.Second
	internalGrace = 2 * time.Second
)

// drainer is the shadow-sample side of the drain (server.Server).
type drainer interface {
	Close(ctx context.Context) error
}

// rowWriter is the tracker side of the drain (tracker.Client); nil in shadow mode.
type rowWriter interface {
	Close(ctx context.Context) (tracker.Abandoned, error)
}

// writers drains several row writers in turn within one grace period, merging what they give up on.
type writers []rowWriter

func (ws writers) Close(ctx context.Context) (tracker.Abandoned, error) {
	all := tracker.Abandoned{Dropped: map[string]int{}}
	var first error
	for _, w := range ws {
		a, err := w.Close(ctx)
		for t, n := range a.Dropped {
			all.Dropped[t] += n
		}
		all.InFlight += a.InFlight
		if err != nil && first == nil {
			first = err
		}
	}
	return all, first
}

// shutdown is the one grace period, in order: the public listener drains (no new beacon can queue a
// row after it), the running shadow samples end, the queued tracker rows are sent. The internal
// listener (/metrics, /healthz, the shadow endpoints, whose late samples are counted as dropped once
// the samples are closing) shuts down LAST: every result the drain counts, including the rows it
// gives up on, is still scrapeable until then. The redis clients close after this returns.
func shutdown(log *slog.Logger, grace time.Duration, public []*http.Server, internal *http.Server, samples drainer, writer rowWriter) {
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	for _, s := range public {
		_ = s.Shutdown(ctx)
	}
	if err := samples.Close(ctx); err != nil {
		log.Warn("shadow samples still running at the end of the grace period", "err", err)
	}
	if writer != nil {
		// A scrape can miss the last counts (the process exits right after), so the rows given up on
		// are also logged, per table.
		if a, err := writer.Close(ctx); err != nil {
			log.Warn("tracker rows still queued or in flight at the end of the grace period; counted as dropped",
				"err", err, "dropped", a.Dropped, "dropped_total", a.Total(), "in_flight", a.InFlight)
		}
	}
	last, cancelLast := context.WithTimeout(context.Background(), internalGrace)
	defer cancelLast()
	_ = internal.Shutdown(last)
}
