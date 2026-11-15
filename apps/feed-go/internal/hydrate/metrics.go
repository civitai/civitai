package hydrate

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// MetricRow is one row of MetricService.fetchFromClickhouse's query: an entity's total of one metric
// type, only when above zero.
type MetricRow struct {
	EntityID   int
	MetricType string
	Value      float64
}

// MetricsSource is the store MetricService populates a metric-hash miss from.
type MetricsSource interface {
	// ImageMetrics is fetchFromClickhouse('Image', ids): the rows of every id with a count above zero.
	ImageMetrics(ctx context.Context, ids []int) ([]MetricRow, error)
}

// The MetricService constants (event-engine-common/services/metrics.ts, utils/cache-keys.ts).
const (
	metricCacheTTL       = 12 * time.Hour  // CACHE_TTL
	metricMissCacheTTL   = 5 * time.Minute // MISS_CACHE_TTL
	metricLockDuration   = 10 * time.Second
	metricRefreshAfter   = 60 * 60 // REFRESH_AFTER, seconds
	metricRecentEventTTL = 15 * 60 // METRIC_RECENT_EVENT_TTL, seconds
	metricPopulatedAt    = "_populatedAt"
)

func metricLockKey(id int) string     { return "metrics:lock:Image:" + strconv.Itoa(id) }
func metricRecentKey(id int) string   { return "{" + metricHashKey(id) + "}:recent" }
func metricsFailed(err error) error   { return fallback.Newf("metrics-miss-failed", "%v", err) }
func formatJSNumber(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// hReplaceStampedEx is the helper script of the same name (event-engine-common/utils/query-utils.ts),
// verbatim: replace the hash whole, stamp ARGV[2] with ARGV[3] (ARGV[4] while the recent-event
// marker KEYS[2] exists), set the expiry. KEYS[2] is hash-tagged to KEYS[1]'s slot.
const hReplaceStampedEx = `
      redis.call('DEL', KEYS[1])
      local stamp = ARGV[3]
      if redis.call('EXISTS', KEYS[2]) == 1 then stamp = ARGV[4] end
      redis.call('HSET', KEYS[1], ARGV[2], stamp, unpack(ARGV, 5))
      return redis.call('EXPIRE', KEYS[1], ARGV[1])
    `

// HReplaceStampedExSource is the script's text, for a test fake that emulates it.
func HReplaceStampedExSource() string { return hReplaceStampedEx }

// computeMetrics is MetricService.fetch's cold-miss arm for miss (ids with no hash): the ClickHouse
// totals, every requested id answered (fetch's `{...baseMetrics, ...results[id]}`: an id with no row
// has every count 0). With WriteBack it is also the populate: under the same per-id lock Node takes
// (`metrics:lock:Image:<id>`, SET NX, 10 s), each locked id's hash is replaced with the snapshot
// (12 h) or a `notFound` marker (5 min), stamped as populate stamps it, and the lock released. An id
// another process holds the lock for is answered from the same query and not written (Node would
// wait for that holder's write).
func (c *MissCompute) computeMetrics(ctx context.Context, cache redis.UniversalClient, miss []int) (map[int]Metrics, error) {
	var locked []int
	if c.WriteBack && cache != nil {
		locked = metricLocks(ctx, cache, miss)
	}
	rows, err := c.Metrics.ImageMetrics(ctx, miss)
	if err != nil {
		c.observe(MissImageMetrics, "error", len(miss))
		// As populate's finally: a server timeout leaves the locks to expire (the server is saturated),
		// any other failure releases them.
		if len(locked) > 0 && !IsServerTimeout(err) {
			releaseMetricLocks(ctx, cache, locked)
		}
		return nil, metricsFailed(err)
	}
	wanted := make(map[int]bool, len(miss))
	out := make(map[int]Metrics, len(miss))
	for _, id := range miss {
		wanted[id] = true
		out[id] = Metrics{}
	}
	fields := map[int][]string{} // per id, the snapshot's field/value pairs in row order
	for _, r := range rows {
		if !wanted[r.EntityID] {
			continue
		}
		if _, seen := fields[r.EntityID]; !seen {
			fields[r.EntityID] = nil
		}
		out[r.EntityID][r.MetricType] = int(r.Value)
		fields[r.EntityID] = append(fields[r.EntityID], r.MetricType, formatJSNumber(r.Value))
	}
	c.observe(MissImageMetrics, "computed", len(miss))
	if len(locked) > 0 {
		c.populateMetrics(ctx, cache, locked, fields)
		releaseMetricLocks(ctx, cache, locked)
	}
	return out, nil
}

// metricLocks takes the populate lock of each id (nxWithTtl: SET NX, then a 10 s expiry), returning
// the ids it got. A failed pipeline takes none.
func metricLocks(ctx context.Context, cache redis.UniversalClient, ids []int) []int {
	cmds := make([]*redis.BoolCmd, len(ids))
	_, _ = cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			cmds[i] = p.SetNX(ctx, metricLockKey(id), "1", metricLockDuration)
		}
		return nil
	})
	var locked []int
	for i, cmd := range cmds {
		if ok, err := cmd.Result(); err == nil && ok {
			locked = append(locked, ids[i])
		}
	}
	return locked
}

func releaseMetricLocks(ctx context.Context, cache redis.UniversalClient, ids []int) {
	_, _ = cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, id := range ids {
			p.Del(ctx, metricLockKey(id))
		}
		return nil
	})
}

// populateMetrics is MetricService.populate's cache writes for ids: hReplaceStampedEx of each hash,
// best effort (a failed write leaves the miss for the next reader).
func (c *MissCompute) populateMetrics(ctx context.Context, cache redis.UniversalClient, ids []int, fields map[int][]string) {
	nowSeconds := c.now().Unix()
	stamp := strconv.FormatInt(nowSeconds, 10)
	ifMarker := strconv.FormatInt(nowSeconds-metricRefreshAfter+metricRecentEventTTL, 10)
	_, _ = cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, id := range ids {
			pairs, found := fields[id]
			ttl := metricCacheTTL
			if !found {
				pairs, ttl = []string{"notFound", "1"}, metricMissCacheTTL
			}
			args := []any{strconv.FormatInt(int64(ttl/time.Second), 10), metricPopulatedAt, stamp, ifMarker}
			for _, f := range pairs {
				args = append(args, f)
			}
			p.Eval(ctx, hReplaceStampedEx, []string{metricHashKey(id), metricRecentKey(id)}, args...)
		}
		return nil
	})
}

// --- ClickHouse -----------------------------------------------------------------------------------

// ClickHouse reads metric totals over ClickHouse's HTTP interface, as the Node app's client does
// (CLICKHOUSE_HOST / CLICKHOUSE_USERNAME / CLICKHOUSE_PASSWORD; JSONEachRow; 64-bit integers
// unquoted). At most cap(sem) queries run at once process-wide; each is bounded by Timeout.
type ClickHouse struct {
	URL      string
	User     string
	Password string
	HTTP     *http.Client
	// Timeout is CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: Node's budget for this read.
	Timeout time.Duration
	sem     chan struct{}
}

// NewClickHouse returns a client running at most maxConcurrent queries at once.
func NewClickHouse(rawURL, user, password string, timeout time.Duration, maxConcurrent int) *ClickHouse {
	return &ClickHouse{URL: rawURL, User: user, Password: password, HTTP: &http.Client{}, Timeout: timeout,
		sem: make(chan struct{}, max(maxConcurrent, 1))}
}

// imageMetricTypes is ENTITY_METRIC_TYPES.Image (event-engine-common/types/metric-types.ts).
var imageMetricTypes = []string{"Cry", "Heart", "Laugh", "Like", "Collection", "commentCount", "tippedAmount", "tippedCount"}

// metricsFetchBatch is FETCH_BATCH_SIZE; pointLookupMaxIDs POINT_LOOKUP_MAX_IDS.
const (
	metricsFetchBatch = 1000
	pointLookupMaxIDs = 100
)

// ImageMetricsQuery is fetchFromClickhouse's query for one batch of ids (buildPerDaySource over
// entityMetricDailyAgg_v2), as the Node code writes it.
func ImageMetricsQuery(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	types := make([]string, len(imageMetricTypes))
	for i, t := range imageMetricTypes {
		types[i] = "'" + t + "'"
	}
	where := `WHERE entityType = 'Image'
              AND entityId IN (` + strings.Join(parts, ",") + `)
              AND metricType IN (` + strings.Join(types, ",") + `)`
	source := `(
            SELECT entityId, metricType, day, total
            FROM entityMetricDailyAgg_v2
            ` + where + `
          )`
	return `
          SELECT
            entityId,
            metricType,
            sum(total) AS value
          FROM ` + source + `
          GROUP BY entityId, metricType
          HAVING value > 0;
        `
}

// ImageMetricsSettings is the per-query settings of a populate of n ids: POINT_LOOKUP_SETTINGS at
// most 100 ids, else the server defaults, plus the client's own output_format_json_quote_64bit_integers
// = 0. (Node runs a lookup uncapped after one was stopped at the cap, via a timeout marker; this
// service always caps, so a stopped lookup falls back.)
func ImageMetricsSettings(n int) url.Values {
	v := url.Values{"output_format_json_quote_64bit_integers": {"0"}}
	if n <= pointLookupMaxIDs {
		v.Set("max_threads", "1")
		v.Set("max_execution_time", "6")
		v.Set("timeout_overflow_mode", "throw")
	}
	return v
}

// FormatQuery is the client's formatQuery (@clickhouse/client, common/client.js): the query trimmed,
// its trailing semicolons removed, then ` \nFORMAT <format>`.
func FormatQuery(query, format string) string {
	return strings.TrimRight(strings.TrimSpace(query), ";") + " \nFORMAT " + format
}

// ClickHouseError is a query the server refused or failed.
type ClickHouseError struct {
	Status int
	Code   int // X-ClickHouse-Exception-Code, 0 when absent
	Body   string
}

func (e *ClickHouseError) Error() string {
	return fmt.Sprintf("clickhouse: status %d, code %d: %s", e.Status, e.Code, e.Body)
}

// IsServerTimeout is isServerTimeout: ClickHouse's TIMEOUT_EXCEEDED (code 159), the server stopping
// the query at max_execution_time.
func IsServerTimeout(err error) bool {
	var ce *ClickHouseError
	return errors.As(err, &ce) && ce.Code == 159
}

// ImageMetrics implements MetricsSource.
func (c *ClickHouse) ImageMetrics(ctx context.Context, ids []int) ([]MetricRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if c.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	settings := ImageMetricsSettings(len(ids)) // decided for the whole populate, as Node does
	var out []MetricRow
	for start := 0; start < len(ids); start += metricsFetchBatch {
		batch := ids[start:min(start+metricsFetchBatch, len(ids))]
		rows, err := c.query(ctx, ImageMetricsQuery(batch), settings)
		if err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	return out, nil
}

func (c *ClickHouse) query(ctx context.Context, query string, settings url.Values) ([]MetricRow, error) {
	u, err := url.Parse(c.URL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	for k, vs := range settings {
		q[k] = vs
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(FormatQuery(query, "JSONEachRow")))
	if err != nil {
		return nil, err
	}
	if c.User != "" || c.Password != "" {
		req.SetBasicAuth(c.User, c.Password)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		code, _ := strconv.Atoi(res.Header.Get("X-ClickHouse-Exception-Code"))
		return nil, &ClickHouseError{Status: res.StatusCode, Code: code, Body: strings.TrimSpace(string(body))}
	}
	var out []MetricRow
	sc := bufio.NewScanner(io.LimitReader(res.Body, 64<<20))
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var row struct {
			EntityID   json.Number `json:"entityId"`
			MetricType string      `json:"metricType"`
			Value      json.Number `json:"value"`
		}
		dec := json.NewDecoder(strings.NewReader(string(line)))
		dec.UseNumber()
		if err := dec.Decode(&row); err != nil {
			return nil, fmt.Errorf("clickhouse: row %q: %w", line, err)
		}
		id, err := strconv.Atoi(row.EntityID.String())
		if err != nil {
			return nil, fmt.Errorf("clickhouse: entityId %q: %w", row.EntityID, err)
		}
		v, err := strconv.ParseFloat(row.Value.String(), 64)
		if err != nil {
			return nil, fmt.Errorf("clickhouse: value %q: %w", row.Value, err)
		}
		out = append(out, MetricRow{EntityID: id, MetricType: row.MetricType, Value: v})
	}
	return out, sc.Err()
}
