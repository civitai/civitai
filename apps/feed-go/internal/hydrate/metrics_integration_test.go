//go:build integration

package hydrate

// The image-metrics miss path against the real ClickHouse (testdata/integration/clickhouse.sql: a
// table shaped as the backing table of the per-day totals, entityMetricDailyAgg_v2 under the name the
// query reads) and the real Redis Cluster (the populate lock, hReplaceStampedEx, the release). Ids
// live in 1_160_000..1_160_999.

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// The populate's own query, with the point-lookup settings (accepted on a GET, so under the
// read-only mode ClickHouse gives a GET), sums each image's per-day totals of the listed metric types
// (a zero total, another entity type and an unlisted metric type are not counts), and with write-back
// the hashes land on the cluster as Node's populate writes them.
func TestIntegrationMetricsMissFromClickHouse(t *testing.T) {
	ctx := integtest.Ctx(t)
	ch := integtest.ClickHouse(t, 2)
	integtest.ClickHouseExec(t, `INSERT INTO entityMetricDailyAgg_v2 (entityType, entityId, metricType, day, total) VALUES
		('Image', 1160001, 'Like', '2026-11-01', 3),
		('Image', 1160001, 'Like', '2026-11-02', 4),
		('Image', 1160001, 'tippedAmount', '2026-11-01', 250),
		('Image', 1160001, 'Heart', '2026-11-01', 0),
		('Image', 1160002, 'Cry', '2026-11-03', 1),
		('Model', 1160003, 'Like', '2026-11-01', 5),
		('Image', 1160003, 'Dislike', '2026-11-01', 9)`)
	cluster := integtest.Cluster(t)
	ids := []int{1160001, 1160002, 1160003, 1160004}
	keys := make([]string, 0, 4*len(ids))
	for _, id := range ids {
		keys = append(keys, metricHashKey(id), metricLockKey(id), metricRecentKey(id), metricTimedOutKey(id))
	}
	integtest.Del(t, cluster, keys...)
	if err := cluster.Set(ctx, metricRecentKey(1160002), "1", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	s := &Sources{Cache: cluster, Packed: &PackedReader{Redis: cluster}, Compute: &MissCompute{
		WriteBack: true, ClickHouse: ch, MetricsTimeout: 20 * time.Second, Now: func() time.Time { return now },
	}}
	got, err := s.ImageMetrics(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]Metrics{1160001: {"Like": 7, "tippedAmount": 250}, 1160002: {"Cry": 1}, 1160003: {}, 1160004: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	stamp := strconv.FormatInt(now.Unix(), 10)
	aged := strconv.FormatInt(now.Unix()-3600+900, 10)
	for id, w := range map[int]struct {
		hash map[string]string
		ttl  time.Duration
	}{
		1160001: {map[string]string{"_populatedAt": stamp, "Like": "7", "tippedAmount": "250"}, 12 * time.Hour},
		1160002: {map[string]string{"_populatedAt": aged, "Cry": "1"}, 12 * time.Hour},
		1160003: {map[string]string{"_populatedAt": stamp, "notFound": "1"}, 5 * time.Minute},
		1160004: {map[string]string{"_populatedAt": stamp, "notFound": "1"}, 5 * time.Minute},
	} {
		h, err := cluster.HGetAll(ctx, metricHashKey(id)).Result()
		if err != nil || !reflect.DeepEqual(h, w.hash) {
			t.Errorf("image %d hash %v (%v), want %v", id, h, err, w.hash)
		}
		ttl, err := cluster.TTL(ctx, metricHashKey(id)).Result()
		if err != nil || ttl > w.ttl || ttl < w.ttl-time.Minute {
			t.Errorf("image %d ttl %v (%v), want about %v", id, ttl, err, w.ttl)
		}
		if n, _ := cluster.Exists(ctx, metricLockKey(id)).Result(); n != 0 {
			t.Errorf("image %d: populate lock not released", id)
		}
	}
}

// The client is read-only whatever the account may do: ClickHouse refuses a write sent as a GET
// (READONLY, code 164).
func TestIntegrationClickHouseClientIsReadOnly(t *testing.T) {
	ch := integtest.ClickHouse(t, 1)
	_, err := ch.Query(integtest.Ctx(t), `INSERT INTO entityMetricDailyAgg_v2 (entityType, entityId, metricType, day, total) VALUES ('Image', 1160099, 'Like', '2026-11-01', 1)`, nil)
	var se *chread.ServerError
	if !errors.As(err, &se) || se.Code != 164 {
		t.Fatalf("INSERT over the read client: %v, want ClickHouse code 164 (READONLY)", err)
	}
	rows, err := ch.Query(integtest.Ctx(t), `SELECT count() AS n FROM entityMetricDailyAgg_v2 WHERE entityId = 1160099`, nil)
	if err != nil || len(rows) != 1 || rows[0]["n"] == nil {
		t.Fatalf("count: %v, %v", rows, err)
	}
	if n, _ := Int(rows[0]["n"]); n != 0 {
		t.Fatalf("the refused INSERT wrote %d rows", n)
	}
}

// A query the server stops at max_execution_time is a server timeout (code 159), whether ClickHouse
// reports it as the status or inside a response it had started.
func TestIntegrationClickHouseServerTimeout(t *testing.T) {
	ch := integtest.ClickHouse(t, 1)
	_, err := ch.Query(integtest.Ctx(t), `SELECT sleepEachRow(0.5) AS s FROM numbers(10)`, []chread.Setting{
		{Name: "max_block_size", Value: "1"}, {Name: "max_execution_time", Value: "1"}, {Name: "timeout_overflow_mode", Value: "throw"},
	})
	if !chread.IsServerTimeout(err) {
		t.Fatalf("err %v, want a server timeout (code 159)", err)
	}
}

// Every read asks ClickHouse to cancel it when the client goes away
// (cancel_http_readonly_queries_on_client_close=1), and the server accepts that setting on a GET
// (read-only mode 2 allows changing settings) and applies it, with the populate's own settings too.
func TestIntegrationClickHouseCancelsOnClientClose(t *testing.T) {
	ch := integtest.ClickHouse(t, 1)
	for _, settings := range [][]chread.Setting{nil, metricPointSettings, metricRetrySettings} {
		rows, err := ch.Query(integtest.Ctx(t), `SELECT toUInt8(getSetting('cancel_http_readonly_queries_on_client_close')) AS v`, settings)
		if err != nil {
			t.Fatalf("settings %v: %v", settings, err)
		}
		if want := []map[string]any{{"v": json.Number("1")}}; !reflect.DeepEqual(rows, want) {
			t.Fatalf("settings %v: rows %v, want %v (the setting on)", settings, rows, want)
		}
	}
}

// A query the server stops at max_execution_time AFTER the response has started (more than the
// server's output buffer already sent, so the status is a 200) is still a server timeout (code
// 159). The raw tail of the same response is logged: the shape this server version writes.
func TestIntegrationClickHouseTimeoutMidResponse(t *testing.T) {
	ch := integtest.ClickHouse(t, 1)
	const sql = `SELECT number, repeat('x', 100000) AS pad, sleepEachRow(0.01) AS s FROM numbers(100000)`
	settings := []chread.Setting{{Name: "max_block_size", Value: "1"}, {Name: "max_execution_time", Value: "2"}, {Name: "timeout_overflow_mode", Value: "throw"}}
	_, err := ch.Query(integtest.Ctx(t), sql, settings)
	var se *chread.ServerError
	if !errors.As(err, &se) || se.Status != http.StatusOK || !chread.IsServerTimeout(err) {
		t.Fatalf("err %v, want a server timeout (code 159) inside a started (200) response", err)
	}
	t.Logf("mid-response exception: %q", se.Message)

	status, header, body, readErr := integtest.ClickHouseRaw(t, sql, settings)
	tail := body[max(0, len(body)-600):]
	t.Logf("raw: status %d, exception-code header %q, tag header %q, %d bytes (read error %v), tail %q",
		status, header.Get("X-ClickHouse-Exception-Code"), header.Get("X-ClickHouse-Exception-Tag"), len(body), readErr, tail)
}
