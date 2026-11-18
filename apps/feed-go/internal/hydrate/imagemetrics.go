package hydrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// MissMetrics is the image metric hashes' `cache` label of feed_go_cache_miss_total: the same string
// as the probe's CacheMetrics.
const MissMetrics = CacheMetrics

// ClickHouse is the read the image-metrics miss path sends (*chread.Client).
type ClickHouse interface {
	Query(ctx context.Context, sql string, settings []chread.Setting) ([]map[string]any, error)
}

// The image-metrics miss path is MetricService.fetch's miss half (event-engine-common/services/
// metrics.ts, the pinned submodule) for the images getImageMetricsObject reads, with its constants:
const (
	metricCacheTTL        = 12 * time.Hour   // CACHE_TTL: a populated hash
	metricMissTTL         = 5 * time.Minute  // MISS_CACHE_TTL: a `notFound` hash
	metricRefreshAfter    = int64(60 * 60)   // REFRESH_AFTER (s)
	metricRecentEventTTL  = int64(15 * 60)   // METRIC_RECENT_EVENT_TTL (s, utils/cache-keys.ts)
	metricLockTTL         = 10 * time.Second // LOCK_DURATION
	metricLockHeartbeat   = 5 * time.Second  // LOCK_HEARTBEAT_MS
	metricFetchBatch      = 1000             // FETCH_BATCH_SIZE
	metricPointLookupMax  = 100              // POINT_LOOKUP_MAX_IDS
	metricTimedOutTTL     = metricCacheTTL   // LOOKUP_TIMED_OUT_TTL
	metricPopulatedAt     = "_populatedAt"   // POPULATED_AT_FIELD
	metricAggTable        = "entityMetricDailyAgg_v2"
	metricEntityTypeImage = "Image"
	// metricPopulateBound bounds a write-back populate that outlives its request (see
	// lookupImageMetrics); Node's own bound is the client's 300 s request_timeout.
	metricPopulateBound = time.Minute
)

// The wait on a populate lock another process holds is feed-go's own, not Node's. Node's fetch
// re-reads the hash every LOCK_RETRY_DELAY (200 ms), up to LOCK_MAX_RETRIES (15) times: ~3 s, all of
// its caller's budget (nodeMetricsBudget). feed-go waits at most metricsLockWait (default
// defaultMetricsLockWait, FEED_GO_METRICS_LOCK_WAIT_MS) and then falls back (`metrics-miss-failed`),
// rather than hold the page for up to the whole lookup bound (metricsTimeout) on another process's
// populate. It re-reads every metricLockPollInterval (100 ms), half Node's delay, so the default
// bound gets five reads (100 … 500 ms) where Node's cadence would get two (200, 400 ms), a hash that
// lands is taken within 100 ms of landing, and one wait makes fewer reads than Node's 15 (or than
// the up to ten feed-go made at 200 ms inside its 2 s lookup bound).
const (
	metricLockPollInterval = 100 * time.Millisecond
	defaultMetricsLockWait = 500 * time.Millisecond
)

// metricsLockWait is the bound of one wait on populate locks another process holds:
// MetricsLockWait (FEED_GO_METRICS_LOCK_WAIT_MS), or defaultMetricsLockWait when that is not positive.
func (c *MissCompute) metricsLockWait() time.Duration {
	if c.MetricsLockWait > 0 {
		return c.MetricsLockWait
	}
	return defaultMetricsLockWait
}

// sleepLockWait waits d before a lock-wait read, or returns ctx's error when it ends first. Tests
// replace the timer (waitSleep).
func (c *MissCompute) sleepLockWait(ctx context.Context, d time.Duration) error {
	if c.waitSleep != nil {
		return c.waitSleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// metricHeartbeatTicks starts the ticker that re-arms held locks every LOCK_HEARTBEAT_MS and
// returns its channel and its stop (tests drive the channel themselves).
var metricHeartbeatTicks = func() (<-chan time.Time, func()) {
	t := time.NewTicker(metricLockHeartbeat)
	return t.C, t.Stop
}

// imageMetricTypes is ENTITY_METRIC_TYPES.Image (event-engine-common/types/metric-types.ts), in order.
var imageMetricTypes = []string{"Cry", "Heart", "Laugh", "Like", "Collection", "commentCount", "tippedAmount", "tippedCount"}

// The per-query settings of a populate (POINT_LOOKUP_SETTINGS / RETRY_LOOKUP_SETTINGS), in the order
// Node's object lists them.
var (
	metricPointSettings = []chread.Setting{{Name: "max_threads", Value: "1"}, {Name: "max_execution_time", Value: "6"}, {Name: "timeout_overflow_mode", Value: "throw"}}
	metricRetrySettings = []chread.Setting{{Name: "max_threads", Value: "1"}}
)

// The metric keys (utils/cache-keys.ts), never namespace-prefixed.
func metricLockKey(id int) string     { return "metrics:lock:Image:" + strconv.Itoa(id) }
func metricTimedOutKey(id int) string { return "metrics:timeout:Image:" + strconv.Itoa(id) }
func metricRecentKey(id int) string   { return "{" + metricHashKey(id) + "}:recent" }

// hReplaceStampedEx is the Lua script of that name (event-engine-common/utils/query-utils.ts), the
// populate's write, byte for byte (a golden test pins it to the script Node evaluates).
const hReplaceStampedEx = `
      redis.call('DEL', KEYS[1])
      local stamp = ARGV[3]
      if redis.call('EXISTS', KEYS[2]) == 1 then stamp = ARGV[4] end
      redis.call('HSET', KEYS[1], ARGV[2], stamp, unpack(ARGV, 5))
      return redis.call('EXPIRE', KEYS[1], ARGV[1])
    `

// sqlImageMetrics is fetchFromClickhouse's query over buildPerDaySource for one batch, with Node's
// whitespace (the text is the same template literal's).
func sqlImageMetrics(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	types := make([]string, len(imageMetricTypes))
	for i, t := range imageMetricTypes {
		types[i] = "'" + t + "'"
	}
	where := "WHERE entityType = '" + metricEntityTypeImage + "'\n" +
		"              AND entityId IN (" + strings.Join(parts, ",") + ")\n" +
		"              AND metricType IN (" + strings.Join(types, ",") + ")"
	perDay := "(\n" +
		"            SELECT entityId, metricType, day, total\n" +
		"            FROM " + metricAggTable + "\n" +
		"            " + where + "\n" +
		"          )"
	return "\n" +
		"          SELECT\n" +
		"            entityId,\n" +
		"            metricType,\n" +
		"            sum(total) AS value\n" +
		"          FROM " + perDay + "\n" +
		"          GROUP BY entityId, metricType\n" +
		"          HAVING value > 0;\n" +
		"        "
}

// metricsComputed is whether a metric-hash miss is computed (else it falls back `metrics-miss`).
func (s *Sources) metricsComputed() bool {
	return s.Compute != nil && s.Compute.ClickHouse != nil && s.Cache != nil
}

// Node bounds MetricService.fetch by CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS and past it answers
// statsUnknown; a lookup here that outlived it would answer counts where Node answers "unknown".
// metricsTimeoutMax stays under that budget, less what Node spends before its populate.
const (
	nodeMetricsBudget = 3000 * time.Millisecond
	metricsTimeoutMax = nodeMetricsBudget - 500*time.Millisecond
)

// metricsTimeout is the bound of one metrics lookup: FEED_GO_CLICKHOUSE_TIMEOUT_MS (default 2 s), at
// most metricsTimeoutMax.
func (c *MissCompute) metricsTimeout() time.Duration {
	d := 2 * time.Second
	if c.MetricsTimeout > 0 {
		d = c.MetricsTimeout
	}
	return min(d, metricsTimeoutMax)
}

// errMetricsWaitExhausted is a lookup whose ids another process holds the populate lock of and did
// not fill within the lock-wait bound (metricsLockWait). Node's fetch answers those ids zeros only
// after 15 × 200 ms of sleeps, which is all of its caller's 3 s budget (nodeMetricsBudget) spent after
// the budget started, so the caller always times out first and Node answers statsUnknown. The page
// falls back (`metrics-miss-failed`) instead of answering zeros.
var errMetricsWaitExhausted = errors.New("metrics wait: the populate lock's holder did not fill the hash within the lock-wait bound")

// fillMetrics answers the image ids whose metric hash is absent, into out, as
// getImageMetricsObject answers them when its MetricService read resolves: every id gets an entry
// (a known image: statsUnknown false), its counts those ClickHouse summed, every other count 0.
// A failed or late read is `metrics-miss-failed`: Node's answer there (the cached hashes, so these
// ids statsUnknown) is left to Node.
func (s *Sources) fillMetrics(ctx context.Context, miss []int, out map[int]Metrics) error {
	if p := presenceOf(ctx); p != nil {
		// As fill: a Go-first probe records the miss and its one lookup and answers "no entry" (here:
		// a known image with no counts), with no query and no write.
		p.recordComputed(MissMetrics, len(miss))
		for _, id := range miss {
			out[id] = Metrics{}
		}
		return nil
	}
	c := s.Compute
	lctx, cancel := context.WithTimeout(ctx, c.metricsTimeout())
	defer cancel()
	records, err := c.lookupShared(lctx, MissMetrics, miss, s.lookupImageMetrics)
	if err != nil {
		c.observe(MissMetrics, "error", len(miss))
		return fallback.Wrap("metrics-miss-failed", err)
	}
	for _, id := range miss {
		m := Metrics{}
		for _, kv := range records[id] {
			if n, ok := kv.V.(int); ok {
				m[kv.K] = n
			}
		}
		out[id] = m
	}
	c.observe(MissMetrics, "computed", len(miss))
	return nil
}

// lookupImageMetrics is MetricService.fetch over ids that all missed: per id, the counts as fetch
// returns them before its zero fill (a record of metricType → count; empty for an image with none).
//
//   - With write-back off this service writes nothing: it only reads the populate lock, so an id
//     another process is populating is waited on, never queried again.
//   - A write-back populate outlives its request: when the request's bound ends first the lookup
//     fails (the request falls back) and the populate still fills the cache, as Node's read does.
func (s *Sources) lookupImageMetrics(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	c := s.Compute
	writeBack := c.WriteBack
	locked, others, err := s.metricLocks(ctx, ids, writeBack)
	if err != nil {
		return nil, err
	}
	out := make(map[int]jspack.Obj, len(ids))
	if len(locked) > 0 {
		var counts map[int]jspack.Obj
		if writeBack {
			counts, err = s.populateDetached(ctx, locked)
		} else {
			counts, err = s.populateMetrics(ctx, locked, false)
		}
		if err != nil {
			return nil, err
		}
		for id, rec := range counts {
			out[id] = rec
		}
	}
	if err := s.awaitMetricHashes(ctx, others, out); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, ok := out[id]; !ok {
			out[id] = jspack.Obj{}
		}
	}
	return out, nil
}

// metricLocks splits ids into those this lookup populates and those another process holds the
// populate lock of: with write-back, the lock taken (SET NX EX 10, what nxWithTtl does to an absent
// key); without, the lock only read. A failed lock command fails the lookup (as Node's fetch throws).
func (s *Sources) metricLocks(ctx context.Context, ids []int, take bool) (mine, others []int, err error) {
	took := make([]*redis.BoolCmd, len(ids))
	held := make([]*redis.IntCmd, len(ids))
	_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			if take {
				took[i] = p.SetNX(ctx, metricLockKey(id), "1", metricLockTTL)
			} else {
				held[i] = p.Exists(ctx, metricLockKey(id))
			}
		}
		return nil
	})
	for i, id := range ids {
		var free bool
		if take {
			ok, err := took[i].Result()
			if err != nil {
				return nil, nil, fmt.Errorf("metrics lock: %w", err)
			}
			free = ok
		} else {
			n, err := held[i].Result()
			if err != nil {
				return nil, nil, fmt.Errorf("metrics lock: %w", err)
			}
			free = n == 0
		}
		if free {
			mine = append(mine, id)
		} else {
			others = append(others, id)
		}
	}
	return mine, others, nil
}

// populateDetached runs a write-back populate under its own bound and returns its answer, or the
// request's error when ctx ends first (the populate carries on and fills the cache).
func (s *Sources) populateDetached(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	type result struct {
		counts map[int]jspack.Obj
		err    error
	}
	done := make(chan result, 1)
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), metricPopulateBound)
	go func() {
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				done <- result{err: fmt.Errorf("metrics populate panicked: %v", r)}
			}
		}()
		counts, err := s.populateMetrics(pctx, ids, true)
		done <- result{counts, err}
	}()
	select {
	case r := <-done:
		return r.counts, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// populateMetrics is MetricService.populate over ids (whose locks it holds when writeBack): the
// ClickHouse read, then, with writeBack, the hash writes and the lock release.
func (s *Sources) populateMetrics(ctx context.Context, ids []int, writeBack bool) (map[int]jspack.Obj, error) {
	var stopHeartbeat func()
	if writeBack {
		stopHeartbeat = s.heartbeatMetricLocks(ctx, ids)
	}
	counts, settings, err := s.fetchImageMetrics(ctx, ids)
	serverTimedOut := err != nil && chread.IsServerTimeout(err)
	if err == nil && writeBack {
		err = s.writeMetricHashes(ctx, ids, counts)
	}
	if writeBack {
		stopHeartbeat()
		if serverTimedOut && isPointSettings(settings) {
			s.markMetricLookupTimedOut(ctx, ids)
		}
		s.releaseMetricLocks(ctx, ids, serverTimedOut)
	}
	if err != nil {
		return nil, err
	}
	return counts, nil
}

func isPointSettings(s []chread.Setting) bool {
	return len(s) == len(metricPointSettings) && slices.Equal(s, metricPointSettings)
}

// metricLookupSettings is lookupSettings: none past 100 ids; else the retry settings when any id is
// marked `metrics:timeout`, the point settings otherwise (and when the markers cannot be read).
func (s *Sources) metricLookupSettings(ctx context.Context, ids []int) []chread.Setting {
	if len(ids) > metricPointLookupMax {
		return nil
	}
	cmds := make([]*redis.StringCmd, len(ids))
	_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			cmds[i] = p.Get(ctx, metricTimedOutKey(id))
		}
		return nil
	})
	for _, cmd := range cmds {
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return metricPointSettings
		}
	}
	for _, cmd := range cmds {
		if cmd.Err() == nil {
			return metricRetrySettings
		}
	}
	return metricPointSettings
}

// fetchImageMetrics is fetchFromClickhouse: the counts per image of ids, one query per batch of
// 1000, the settings decided once for the whole populate (returned, for the timeout marking).
func (s *Sources) fetchImageMetrics(ctx context.Context, ids []int) (map[int]jspack.Obj, []chread.Setting, error) {
	settings := s.metricLookupSettings(ctx, ids)
	out := map[int]jspack.Obj{}
	for start := 0; start < len(ids); start += metricFetchBatch {
		batch := ids[start:min(start+metricFetchBatch, len(ids))]
		rows, err := s.Compute.ClickHouse.Query(ctx, sqlImageMetrics(batch), settings)
		if err != nil {
			return nil, settings, err
		}
		for _, row := range rows {
			id, metric, n, err := metricRow(row)
			if err != nil {
				return nil, settings, err
			}
			rec := out[id]
			setKV(&rec, metric, n)
			out[id] = rec
		}
	}
	return out, settings, nil
}

// setKV sets k on o (replacing a repeated key in place, as the JS assignment does).
func setKV(o *jspack.Obj, k string, v any) {
	for i := range *o {
		if (*o)[i].K == k {
			(*o)[i].V = v
			return
		}
	}
	*o = append(*o, jspack.KV{K: k, V: v})
}

// metricRow reads one `{entityId, metricType, value}` row. A count is a JS number in Node; one this
// service cannot hold as an exact int (fractional, or past 2^53) fails the lookup rather than
// answer differently.
func metricRow(row map[string]any) (int, string, int, error) {
	id, ok := Int(row["entityId"])
	metric, okM := row["metricType"].(string)
	if !ok || !okM {
		return 0, "", 0, fmt.Errorf("metrics row %v", row)
	}
	num, ok := row["value"].(json.Number)
	if !ok {
		return 0, "", 0, fmt.Errorf("metrics row %v: value", row)
	}
	if n, err := num.Int64(); err == nil {
		if n < -(1<<53) || n > 1<<53 {
			return 0, "", 0, fmt.Errorf("metrics row %v: count past 2^53", row)
		}
		return id, metric, int(n), nil
	}
	f, err := num.Float64()
	if err != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
		return 0, "", 0, fmt.Errorf("metrics row %v: not an exact integer count", row)
	}
	return id, metric, int(f), nil
}

// writeMetricHashes is populate's write: per id, hReplaceStampedEx of its counts (a `notFound: '1'`
// hash for an image with none, 5 min; else 12 h), stamped now, or aged to refresh soon when the
// event engine marked a recent event on it. A failed write fails the populate, as Node's does.
func (s *Sources) writeMetricHashes(ctx context.Context, ids []int, counts map[int]jspack.Obj) error {
	now := s.Compute.now().Unix()
	stamp, ifMarker := strconv.FormatInt(now, 10), strconv.FormatInt(now-metricRefreshAfter+metricRecentEventTTL, 10)
	cmds := make([]*redis.Cmd, len(ids))
	_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			rec, found := counts[id]
			ttl, fields := metricMissTTL, []any{"notFound", "1"}
			if found && len(rec) > 0 {
				ttl, fields = metricCacheTTL, make([]any, 0, 2*len(rec))
				for _, kv := range rec {
					fields = append(fields, kv.K, strconv.Itoa(kv.V.(int)))
				}
			}
			args := make([]any, 0, 4+len(fields))
			args = append(args, strconv.Itoa(int(ttl/time.Second)), metricPopulatedAt, stamp, ifMarker)
			args = append(args, fields...)
			cmds[i] = p.Eval(ctx, hReplaceStampedEx, []string{metricHashKey(id), metricRecentKey(id)}, args...)
		}
		return nil
	})
	for _, cmd := range cmds {
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return fmt.Errorf("metrics write: %w", err)
		}
	}
	return nil
}

// markMetricLookupTimedOut is markLookupTimedOut: the next lookup naming these ids runs uncapped.
// Best effort, as Node's.
func (s *Sources) markMetricLookupTimedOut(ctx context.Context, ids []int) {
	_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, id := range ids {
			p.Set(ctx, metricTimedOutKey(id), "1", metricTimedOutTTL)
		}
		return nil
	})
}

// releaseMetricLocks deletes the locks, or after a server timeout re-arms them to expire in 10 s
// (the next lookup then waits instead of querying a saturated server at once). Best effort.
func (s *Sources) releaseMetricLocks(ctx context.Context, ids []int, leave bool) {
	_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, id := range ids {
			if leave {
				p.Expire(ctx, metricLockKey(id), metricLockTTL)
			} else {
				p.Del(ctx, metricLockKey(id))
			}
		}
		return nil
	})
}

// heartbeatMetricLocks re-arms the held locks every 5 s until the returned stop, which waits for an
// in-flight re-arm so the release after it is the last write.
func (s *Sources) heartbeatMetricLocks(ctx context.Context, ids []int) func() {
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticks, stopTicks := metricHeartbeatTicks()
		defer stopTicks()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticks:
				_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
					for _, id := range ids {
						p.Expire(ctx, metricLockKey(id), metricLockTTL)
					}
					return nil
				})
			}
		}
	}()
	return func() {
		close(stop)
		wg.Wait()
	}
}

// awaitMetricHashes is fetch's waiter loop over ids another process is populating, bounded by
// metricsLockWait: a read every metricLockPollInterval, the last one at the bound, each taking the
// hashes that landed. The bound starts here, after this lookup's own populate of the ids it was free
// to query (which keeps the lookup's own bound, metricsTimeout), and the lookup's context still ends
// it sooner. A failed read fails the lookup, as Node's throws; so does an id still unfilled after the
// last read (errMetricsWaitExhausted). Traced
// (MissCompute.traced), the whole wait is one `metrics lock wait` span: how many ids, how many reads
// and the outcome (waitOutcome), failed as the store spans are when it does not end filled.
func (s *Sources) awaitMetricHashes(ctx context.Context, ids []int, out map[int]jspack.Obj) error {
	c := s.Compute
	if len(ids) == 0 || !c.traced(ctx) {
		_, err := s.pollMetricHashes(ctx, ids, out)
		return err
	}
	ctx, span := c.Tracer.Start(ctx, "metrics lock wait", trace.WithAttributes(attrWaitIDs.Int(len(ids))))
	polls, err := s.pollMetricHashes(ctx, ids, out)
	span.SetAttributes(attrWaitPolls.Int(polls), attrWaitOutcome.String(waitOutcome(err)))
	endWithError(span, err)
	return err
}

// pollMetricHashes is awaitMetricHashes' loop; polls is how many Redis reads it made. The delays
// before the reads add up to the bound (the last one cut short to land on it); each read's own
// latency comes on top.
func (s *Sources) pollMetricHashes(ctx context.Context, ids []int, out map[int]jspack.Obj) (int, error) {
	c := s.Compute
	bound := c.metricsLockWait()
	polls := 0
	pending := slices.Clone(ids)
	for waited := time.Duration(0); len(pending) > 0 && waited < bound; {
		d := min(metricLockPollInterval, bound-waited)
		if err := c.sleepLockWait(ctx, d); err != nil {
			return polls, err
		}
		waited += d
		polls++
		cmds := make([]*redis.MapStringStringCmd, len(pending))
		_, _ = s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
			for i, id := range pending {
				cmds[i] = p.HGetAll(ctx, metricHashKey(id))
			}
			return nil
		})
		var still []int
		for i, id := range pending {
			hash, err := cmds[i].Result()
			if err != nil {
				return polls, fmt.Errorf("metrics wait: %w", err)
			}
			if len(hash) == 0 {
				still = append(still, id)
				continue
			}
			rec := jspack.Obj{}
			if m, ok := ParseMetricHash(hash); ok {
				for _, k := range metricNames(m) {
					rec = append(rec, jspack.KV{K: k, V: m[k]})
				}
			}
			out[id] = rec
		}
		pending = still
	}
	if len(pending) > 0 {
		return polls, errMetricsWaitExhausted
	}
	return polls, nil
}

func metricNames(m Metrics) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
