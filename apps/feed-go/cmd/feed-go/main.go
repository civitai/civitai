// Command feed-go serves `image.getImagesAsPostsInfinite` for the request shapes it has ported and
// proxies everything else to the Node app, and shadow-compares that procedure and the REST
// `GET /api/v1/images`, `GET /api/v1/models` and `GET /api/v1/models/[id]`. See apps/feed-go/DESIGN.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/propagation"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/dbpool"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/flipt"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
	"github.com/civitai/civitai/apps/feed-go/internal/sysredis"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

func main() {
	if printVersion(os.Args[1:], os.Stdout) {
		return
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	log.Info("feed-go", "version", version)
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

// redisClient builds the cache client. The system client is built by sysredis.New.
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

// missCompute is how hydration answers the misses of the caches Node fills on read
// (hydrate.MissCompute): nil with FEED_GO_COMPUTE_MISSES off (those misses fall back). primary is the
// primary database, used (and opened) only when FEED_GO_CACHE_WRITEBACK lists a cache whose lookup
// reads it (hydrate.PrimaryCaches). The tag-ids lookup's browsing gate reads blocked and addons, the
// blocked-tag list and addons the procedures read.
func missCompute(cfg *config.Config, primary hydrate.Querier, observe func(cache, result string, n int),
	blocked *feed.BlockedTags, addons func(context.Context) []browsing.Addon) *hydrate.MissCompute {
	if !cfg.ComputeMisses {
		return nil
	}
	c := &hydrate.MissCompute{WriteBack: cfg.CacheWriteBack, FrameNegative: cfg.FrameCacheNegative, Observe: observe,
		TagGate: feed.ImageTagGate(blocked, addons)}
	if cfg.CacheWriteBack.NeedsPrimary() {
		c.Primary = primary
	}
	return c
}

// attachWriteObservers hands c (the miss computation, nil when off) the cache-write counter and log
// (FEED_GO_CACHE_WRITE_LOG_PER_MIN), and seeds the counter for the written-back caches, so a cache
// that has written nothing reads 0 rather than an absent series.
func attachWriteObservers(cfg *config.Config, c *hydrate.MissCompute, metrics *server.Metrics, log *slog.Logger) {
	if c == nil {
		return
	}
	c.ObserveWrite = metrics.ObserveCacheWrite
	c.WriteLog = &hydrate.WriteLog{Log: log, PerMinute: cfg.CacheWriteLogPerMinute}
	metrics.SeedCacheWrites(cfg.CacheWriteBack.Names())
}

// metricsReader is the ClickHouse reader the metric-hash misses are computed with: nil when it is not
// configured (cfg.ClickHouseURL empty) or its URL is invalid, so feed-go starts and those misses fall
// back (`metrics-miss`). The error is for the startup log; it never names the URL or credentials.
// tracer spans its reads (nil when tracing is off).
func metricsReader(cfg *config.Config, tracer chread.Tracer) (hydrate.ClickHouse, error) {
	if cfg.ClickHouseURL == "" {
		return nil, nil
	}
	c, err := chread.New(chread.Config{URL: cfg.ClickHouseURL, Username: cfg.ClickHouseUsername, Password: cfg.ClickHousePassword,
		MaxInFlight: cfg.ClickHouseMaxInFlight, Tracer: tracer})
	if err != nil {
		return nil, err
	}
	return c, nil
}

// attachMetricsReader hands c (the miss computation, nil when off) the metrics reader and its bounds
// (the lookup's, FEED_GO_CLICKHOUSE_TIMEOUT_MS; the populate-lock wait's, FEED_GO_METRICS_LOCK_WAIT_MS),
// when one is configured (FEED_GO_CLICKHOUSE_*; metricsReader). With tracing on (tp set) the reader's
// reads are spanned (tracing.ClickHouseTracer) and so are c's waits (MissCompute.Tracer); tp nil
// leaves both untraced. The error is metricsReader's.
func attachMetricsReader(cfg *config.Config, c *hydrate.MissCompute, tp *tracing.Provider) error {
	var chTracer chread.Tracer
	if tp != nil {
		chTracer = tracing.ClickHouseTracer{Tracer: tp.Tracer}
		if c != nil {
			c.Tracer = tp.Tracer
		}
	}
	reader, err := metricsReader(cfg, chTracer)
	if c != nil && reader != nil {
		c.ClickHouse = reader
		c.MetricsTimeout = cfg.ClickHouseTimeout
		c.MetricsLockWait = cfg.MetricsLockWait
	}
	if err != nil {
		return err
	}
	dedicated, err := dedicatedMetricsReader(cfg, chTracer)
	if c != nil && c.ClickHouse != nil && dedicated != nil {
		c.MetricsClickHouse = dedicated
	}
	return err
}

// dedicatedMetricsReader is the dedicated ClickHouse for entity metrics (CLICKHOUSE_METRICS_*): nil
// when it is not configured. Built from its own variables only (URL, login and password alike, so
// none of the shared reader's credentials can reach it), with the shared reader's read cap and every
// request bounded by CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS. The error never names the URL or
// credentials.
func dedicatedMetricsReader(cfg *config.Config, tracer chread.Tracer) (hydrate.ClickHouse, error) {
	if cfg.MetricsClickHouseURL == "" {
		return nil, nil
	}
	c, err := chread.New(chread.Config{URL: cfg.MetricsClickHouseURL, Username: cfg.MetricsClickHouseUsername,
		Password: cfg.MetricsClickHousePassword, MaxInFlight: cfg.ClickHouseMaxInFlight, Tracer: tracer,
		HTTP: &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone(), Timeout: cfg.MetricsClickHouseRequestTimeout}})
	if err != nil {
		return nil, fmt.Errorf("dedicated metrics %w", err)
	}
	return c, nil
}

// metricsClickHouseFlag is the Flipt flag that moves the image metric-hash populate onto the dedicated
// ClickHouse: the Node app's FLIPT_FEATURE_FLAGS.IMAGE_METRICS_DEDICATED_CLICKHOUSE, so one switch
// moves both runtimes.
const metricsClickHouseFlag = "image-metrics-dedicated-clickhouse"

// attachMetricsSwitch reads metricsClickHouseFlag in the background (every flipt.RefreshInterval,
// until ctx ends) and hands its answer to c, when c has a dedicated reader (attachMetricsReader).
// Without one, or without FLIPT_URL, nothing is read and the populate keeps the shared reader. A
// failed read reads as off; failures are logged at most once a minute.
func attachMetricsSwitch(ctx context.Context, cfg *config.Config, c *hydrate.MissCompute, log *slog.Logger) (*flipt.Switch, error) {
	if c == nil || c.MetricsClickHouse == nil || cfg.FliptURL == "" {
		return nil, nil
	}
	fc, err := flipt.New(flipt.Config{URL: cfg.FliptURL, ClientToken: cfg.FliptClientToken, Environment: cfg.FliptEnvironment})
	if err != nil {
		return nil, err
	}
	sw := flipt.NewSwitch(func(ctx context.Context) (bool, error) { return fc.Boolean(ctx, metricsClickHouseFlag) })
	var lastLog time.Time
	sw.OnError = func(err error) {
		if now := time.Now(); now.Sub(lastLog) >= time.Minute {
			lastLog = now
			log.Warn("flag read failed; reads as off", "flag", metricsClickHouseFlag, "err", err)
		}
	}
	c.MetricsClickHouseOn = sw.On
	sw.Start(ctx)
	return sw, nil
}

// opensPrimary is whether run() opens the primary pool (DATABASE_URL): only with the miss computation
// on and a written-back cache whose lookup reads the primary (hydrate.PrimaryCaches). A replica-only
// allowlist (e.g. metrics,tag-ids) never opens it.
func opensPrimary(cfg *config.Config) bool {
	return cfg.ComputeMisses && cfg.CacheWriteBack.NeedsPrimary()
}

// primaryMaxConns bounds the primary pool, used only by the written-back miss lookups that read it
// (hydrate.PrimaryCaches; DESIGN.md §3.1).
const primaryMaxConns = 4

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Tracing (DESIGN.md §10.3): nil = off, and then nothing below starts a span or touches a header.
	tp, err := tracing.Setup(ctx, cfg.Tracing)
	if err != nil {
		return err
	}
	log.Info("tracing", "FEED_GO_OTEL_ENABLED", cfg.Tracing.Enabled, "OTEL_SERVICE_NAME", cfg.Tracing.ServiceName,
		"OTEL_TRACES_SAMPLE_RATIO", cfg.Tracing.Ratio, "FEED_GO_FALLBACK_LOG_PER_MIN", cfg.FallbackLogPerMinute,
		"FEED_GO_ERROR_LOG_PER_MIN", cfg.ErrorLogPerMinute)

	poolCfg, err := dbpool.Config(cfg.DatabaseURL, dbpool.Settings{MaxConns: cfg.DBMaxConns})
	if err != nil {
		return err
	}
	if tp != nil {
		poolCfg.ConnConfig.Tracer = tracing.PgxTracer{Tracer: tp.Tracer}
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return err
	}
	// Deferred closes run after the shutdown sequence below (servers drained, shadow samples ended).
	defer pool.Close()
	cache, err := redisClient(cfg.RedisURL, cfg.RedisCluster)
	if err != nil {
		return err
	}
	defer func() { _ = cache.Close() }()
	if tp != nil {
		cache.AddHook(tracing.RedisHook{Tracer: tp.Tracer, Client: "cache"})
	}
	// The system redis is a primary/replica set, never a cluster: through its Sentinels when
	// REDIS_SYS_SENTINELS is set, else the single REDIS_SYS_URL connection (internal/sysredis).
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
	if tp != nil {
		sys.AddHook(tracing.RedisHook{Tracer: tp.Tracer, Client: "sys"})
	}

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := server.NewMetrics(reg)

	packed := &hydrate.PackedReader{Redis: cache, Prefix: cfg.CacheKeyPrefix}
	sources := &hydrate.Sources{Packed: packed, Cache: cache, Replica: pool}
	var primary hydrate.Querier
	if opensPrimary(cfg) {
		primaryCfg, err := dbpool.Config(cfg.PrimaryDatabaseURL, dbpool.Settings{MaxConns: primaryMaxConns})
		if err != nil {
			return err
		}
		if tp != nil {
			primaryCfg.ConnConfig.Tracer = tracing.PgxTracer{Tracer: tp.Tracer}
		}
		primaryPool, err := pgxpool.NewWithConfig(ctx, primaryCfg)
		if err != nil {
			return err
		}
		defer primaryPool.Close()
		primary = primaryPool
	}
	// One blocked-tag list (one memo, as in Node) and one addon source for every reader.
	blocked := &feed.BlockedTags{Cache: cache, Prefix: cfg.CacheKeyPrefix}
	addons := &feed.AddonSource{Sys: sys}
	sources.Compute = missCompute(cfg, primary, metrics.ObserveCacheMiss, blocked, addons.Addons)
	attachWriteObservers(cfg, sources.Compute, metrics, log)
	if err := attachMetricsReader(cfg, sources.Compute, tp); err != nil {
		log.Error("clickhouse reader not configured; metric-hash misses fall back", "err", err)
	}
	metricsSwitch, err := attachMetricsSwitch(ctx, cfg, sources.Compute, log)
	if err != nil {
		log.Error("flag not read; metric-hash populates keep the shared clickhouse", "flag", metricsClickHouseFlag, "err", err)
	}
	log.Info("dedicated metrics clickhouse", "configured", sources.Compute != nil && sources.Compute.MetricsClickHouse != nil,
		"flag_read", metricsSwitch != nil, "CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS", cfg.MetricsClickHouseRequestTimeout.Milliseconds())
	// Under the env names, so a value that disagrees with the Node side's flag (frame-cache-negative)
	// or with the rollout step (DESIGN.md §3.1) is visible in the startup log.
	log.Info("cache misses", "FEED_GO_COMPUTE_MISSES", cfg.ComputeMisses, "FEED_GO_CACHE_WRITEBACK", cfg.CacheWriteBack.Names(),
		"primary_db", primary != nil, "FEED_GO_CACHE_WRITE_LOG_PER_MIN", cfg.CacheWriteLogPerMinute,
		"FEED_GO_FRAME_CACHE_NEGATIVE", cfg.FrameCacheNegative, "clickhouse_metrics", sources.Compute != nil && sources.Compute.ClickHouse != nil,
		"FEED_GO_CLICKHOUSE_TIMEOUT_MS", cfg.ClickHouseTimeout.Milliseconds(), "FEED_GO_METRICS_LOCK_WAIT_MS", cfg.MetricsLockWait.Milliseconds(),
		"FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT", cfg.ClickHouseMaxInFlight)
	degraded := &server.RevocationDegradedReporter{Log: log, Counter: metrics.RevocationDegraded}
	// SESSION_REVOCATION_CACHE=off|0|false turns the marker record off (the plain fail-open), as in the app.
	var markers *auth.MarkerCache
	if cfg.RevocationMarkerCache {
		markers = auth.NewMarkerCache(auth.MarkerCacheMaxEntries)
	}
	verifier := &auth.Verifier{
		Issuer: cfg.AuthIssuer, JWKSURL: cfg.AuthJWKSURI, RequireIat0: cfg.AuthRequireIat0,
		RefreshInterval: cfg.JWKSRefresh,
		MaxStaleness:    cfg.JWKSMaxStaleness,
		// Called once per stale episode: every session verifies as signed out until a fetch succeeds.
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
	// Periodic refresh, so a signing key the hub removed stops verifying; ends with ctx (SIGTERM).
	go verifier.Run(ctx)
	resolver := &auth.Resolver{
		Verifier:            verifier,
		Revocation:          &auth.Revocation{Redis: sys, Timeout: cfg.SysReadTimeout, Markers: markers, OnDegraded: degraded.Report},
		Sessions:            packed,
		CookieNames:         cfg.CookieNames,
		OnSlot:              func(slot string) { metrics.SessionCookieSlot.WithLabelValues(slot).Inc() },
		ModerationAccountID: cfg.ModerationAccountID,
	}
	deps := &feed.Deps{
		DB:       pool,
		Cache:    &feed.QueryCache{Redis: cache, Prefix: cfg.CacheKeyPrefix, Enabled: cfg.ImageQueryCache},
		Hydrator: sources,
		Gallery:  &feed.GalleryStore{Cache: cache, Prefix: cfg.CacheKeyPrefix, DB: pool},
		Addons:   addons,
		Blocked:  blocked,
		Config: feed.Config{
			CreatorPromotions:       feed.ParsePromotionAudience(cfg.CreatorPromotion),
			LazyPostImages:          cfg.LazyPostImages,
			ImageIndexFeed:          cfg.ImageIndexFeed,
			PrioritizedVersionCache: cfg.PrioritizedVersionCache,
			VisibleDecorationEvents: cfg.DecorationEvents,
			CompletionConcurrency:   cfg.CompletionConcurrency,
		},
	}
	// Without FEED_SERVICE_URL the Node app answers from Postgres (feedPrimaryAvailable() false: local
	// development only); with the index flag mirrored on, those requests fall back here instead.
	if cfg.FeedServiceURL != "" {
		// Fetch bounds each call (feedsvc.Timeout); the transport keeps enough idle connections for
		// the shadow workers' bounded completion fan-out, so a burst does not open new ones per call.
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.MaxIdleConnsPerHost = 16
		deps.Feed = &feedsvc.Client{BaseURL: cfg.FeedServiceURL, HTTP: &http.Client{Transport: tr}}
	}
	// The REST /api/v1/images shadow shares the feed client, the replica, the caches and the addons.
	v1 := &feed.V1Deps{
		Feed:    deps.Feed,
		Sources: sources,
		Gallery: deps.Gallery,
		Rows: func(ctx context.Context, q feed.ImagesQuery) ([]feed.RawImage, error) {
			return feed.FetchRows(ctx, pool, deps.Cache, q.Build())
		},
		Addons:        deps.Addons.Addons,
		ImageLocation: cfg.ImageLocation,
		// The Node app this service shadows is the production build (isProd): nextPage on https://<host>.
		NodeProduction: true,
	}
	// The image.getInfinite shadow shares all of the gallery's dependencies, plus the post→version /
	// version→model caches and the username lookup the REST port reads, and the blocked tag list.
	infinite := &feed.InfiniteDeps{
		Deps:    deps,
		Sources: sources,
		Blocked: blocked,
	}
	// The model.getAll shadow shares the replica, the cache readers, the gallery settings and the
	// addons; its own flags are mirrored by FEED_GO_* variables (DESIGN.md §15.3).
	models := &modelfeed.Deps{
		DB:      pool,
		Sources: sources,
		Gallery: deps.Gallery,
		Addons:  deps.Addons.Addons,
		Blocked: blocked,
		Config: modelfeed.Config{
			BaseModelMetrics:        cfg.BaseModelFeedMetrics,
			ImagesSlim:              cfg.ModelImagesSlim,
			CoverageNext:            cfg.CoverageNext,
			LoadingOpenToAll:        cfg.LoadingOpenToAll,
			VisibleDecorationEvents: cfg.DecorationEvents,
		},
	}
	// The REST /api/v1/models shadows read the replica and the caches (read-only) the same way.
	mc := config.LoadV1Models()
	v1Models := &server.V1ModelsDeps{
		Deps: &v1models.Deps{
			DB:      pool,
			Packed:  packed,
			Sources: sources,
			Gallery: deps.Gallery,
			Addons:  deps.Addons.Addons,
			Config: v1models.Config{
				ImageLocation:        cfg.ImageLocation,
				BaseURL:              mc.BaseURL,
				CoverageNext:         cfg.CoverageNext,
				BaseModelFeedMetrics: cfg.BaseModelFeedMetrics,
				ComputeMisses:        cfg.ComputeMisses,
				ResponseCacheTTL:     mc.ResponseCacheTTL,
				Production:           true,
			},
		},
		Users: sources,
	}
	srv := &server.Server{
		Resolver:         resolver,
		Deps:             deps,
		Models:           models,
		ServeModelGetAll: cfg.ServeModelGetAll,
		ServeInfinite:    cfg.ServeInfinite,
		Hosts:            cfg.Hosts,
		RegionRules:      cfg.RegionRules,
		// REGION_BLOCK_CONFIG, else the app's default list (apipolicy.json).
		RegionBlockRules: cfg.RegionBlockRules,
		Metrics:          metrics,
		Log:              log,
		ShadowQueue:      make(chan struct{}, max(cfg.ShadowWorkers, 1)),
		// The Go-first probes get as many slots as the comparisons, in their own queue.
		ProbeQueue:     make(chan struct{}, max(cfg.ShadowWorkers, 1)),
		AllowedOrigins: cfg.AllowedOriginHosts,
		V1:             v1,
		Infinite:       infinite,
		V1Models:       v1Models,
		RequestBudget:  cfg.RequestBudget,
		// The pool's resolved ceiling (FEED_GO_DB_MAX_CONNS, the URL's pool_max_conns, or the default).
		MaxInFlight: server.ResolveMaxInFlight(log, cfg.MaxInFlight, int(poolCfg.MaxConns)),
		Events:      &server.EventLog{Log: log, FallbackPerMinute: cfg.FallbackLogPerMinute, ErrorPerMinute: cfg.ErrorLogPerMinute},
	}
	var prop propagation.TextMapPropagator
	if tp != nil {
		srv.Tracer, srv.Propagator, prop = tp.Tracer, tp.Propagator, tp.Propagator
	}
	if cfg.FallbackURL != "" {
		target, err := url.Parse(cfg.FallbackURL)
		if err != nil {
			return err
		}
		srv.Fallback = fallbackProxy(target, fallbackIdleTimeout, func(r *http.Request, reason string, err error) {
			metrics.FallbackProxyErrors.WithLabelValues(reason).Inc()
			srv.NoteProxyError(r, reason, err)
		}, prop)
	}

	public := server.PublicMux(srv)
	log.Info("public model.getAll", "FEED_GO_SERVE_MODEL_GETALL", cfg.ServeModelGetAll)
	log.Info("public image.getInfinite", "FEED_GO_SERVE_INFINITE", cfg.ServeInfinite)
	// pprof only on the internal listener, and only with FEED_GO_PPROF set (default off).
	// OpenMetrics on request only with tracing on: the exemplars ride in that format alone.
	internal := server.InternalMux(srv, server.MetricsHandler(reg, tp != nil), cfg.Pprof)
	if cfg.Pprof {
		log.Info("pprof enabled on the internal listener", "addr", cfg.InternalAddr, "path", "/debug/pprof/")
	}

	// Timeouts and header limits per listener: server.PublicHTTPServer / InternalHTTPServer (a pprof
	// capture extends its own write deadline, so it is not cut by the internal write timeout).
	servers := []*http.Server{server.InternalHTTPServer(cfg.InternalAddr, internal)}
	// Without a fallback the public route could only answer the ported shapes: shadow-only deployments
	// do not listen publicly at all.
	if srv.Fallback != nil {
		servers = append(servers, server.PublicHTTPServer(cfg.Addr, public, cfg.RequestBudget))
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
	// One grace period for the whole sequence: first cancel the shadow samples and wait for them to
	// return (they hold replica connections), then drain the listeners' in-flight requests; the
	// deferred closes of the pool and both redis clients run after both.
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Close(shutdown); err != nil {
		log.Warn("shadow samples still running at the end of the grace period", "err", err)
	}
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	// The spans of the drained requests are exported before exit.
	if err := tp.Shutdown(shutdown); err != nil {
		log.Warn("trace exporter shutdown", "err", err)
	}
	return nil
}
