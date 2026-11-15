package hydrate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// fetchFromClickhouse's query (event-engine-common/services/metrics.ts) for ids 11 and 12, whitespace
// collapsed: buildPerDaySource over entityMetricDailyAgg_v2, every ENTITY_METRIC_TYPES.Image type,
// summed per entity and type, only totals above zero.
const wantMetricsQuery = "SELECT entityId, metricType, sum(total) AS value FROM ( SELECT entityId, metricType, day, total FROM entityMetricDailyAgg_v2 " +
	"WHERE entityType = 'Image' AND entityId IN (11,12) AND metricType IN ('Cry','Heart','Laugh','Like','Collection','commentCount','tippedAmount','tippedCount') ) " +
	"GROUP BY entityId, metricType HAVING value > 0;"

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

func TestFormatQuery(t *testing.T) {
	if got := FormatQuery("\n  SELECT 1;; \n", "JSONEachRow"); got != "SELECT 1 \nFORMAT JSONEachRow" {
		t.Fatalf("FormatQuery = %q", got)
	}
}

func TestImageMetricsQueryIsNodes(t *testing.T) {
	if got := collapse(ImageMetricsQuery([]int{11, 12})); got != wantMetricsQuery {
		t.Fatalf("query\n got %s\nwant %s", got, wantMetricsQuery)
	}
}

// One request per batch of at most 1000 ids, POSTed with the client's settings (point-lookup caps
// for at most 100 ids, the whole populate deciding), basic auth, JSONEachRow; rows parsed as numbers.
func TestClickHouseImageMetrics(t *testing.T) {
	type call struct {
		settings map[string]string
		body     string
		user     string
		pass     string
	}
	var (
		mu    sync.Mutex
		calls []call
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		u, p, _ := r.BasicAuth()
		settings := map[string]string{}
		for k := range r.URL.Query() {
			settings[k] = r.URL.Query().Get(k)
		}
		mu.Lock()
		calls = append(calls, call{settings, string(b), u, p})
		mu.Unlock()
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		_, _ = io.WriteString(w, `{"entityId":11,"metricType":"Like","value":7}`+"\n"+`{"entityId":12,"metricType":"tippedAmount","value":12345678901}`+"\n")
	}))
	defer srv.Close()
	c := NewClickHouse(srv.URL, "reader", "secret", time.Second, 2)

	rows, err := c.ImageMetrics(context.Background(), []int{11, 12})
	if err != nil {
		t.Fatal(err)
	}
	if want := []MetricRow{{11, "Like", 7}, {12, "tippedAmount", 12345678901}}; !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %v, want %v", rows, want)
	}
	if len(calls) != 1 {
		t.Fatalf("%d requests, want 1", len(calls))
	}
	got := calls[0]
	if want := map[string]string{"output_format_json_quote_64bit_integers": "0", "max_threads": "1", "max_execution_time": "6",
		"timeout_overflow_mode": "throw"}; !reflect.DeepEqual(got.settings, want) {
		t.Fatalf("settings %v, want %v", got.settings, want)
	}
	if got.user != "reader" || got.pass != "secret" {
		t.Fatalf("auth %q/%q", got.user, got.pass)
	}
	// The client's formatQuery: the trailing semicolon dropped, then " \nFORMAT JSONEachRow".
	if !strings.HasSuffix(got.body, "HAVING value > 0 \nFORMAT JSONEachRow") || strings.Contains(got.body, ";") ||
		collapse(got.body) != strings.TrimSuffix(wantMetricsQuery, ";")+" FORMAT JSONEachRow" {
		t.Fatalf("body %q", got.body)
	}
	calls = nil
	ids := make([]int, 1001)
	for i := range ids {
		ids[i] = i + 1
	}
	if _, err := c.ImageMetrics(context.Background(), ids); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 {
		t.Fatalf("%d requests for 1001 ids, want 2 (batches of 1000)", len(calls))
	}
	for _, cl := range calls {
		if _, capped := cl.settings["max_execution_time"]; capped || cl.settings["output_format_json_quote_64bit_integers"] != "0" {
			t.Fatalf("a populate of 1001 ids ran with %v, want the server defaults (no point-lookup caps)", cl.settings)
		}
	}
	if !strings.Contains(calls[1].body, "IN (1001)") {
		t.Fatalf("second batch %q, want the 1001st id alone", collapse(calls[1].body))
	}
}

func TestClickHouseErrors(t *testing.T) {
	failing := func(code string) *ClickHouse {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-ClickHouse-Exception-Code", code)
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, "Code: "+code+". DB::Exception")
		}))
		t.Cleanup(srv.Close)
		return NewClickHouse(srv.URL, "u", "", time.Second, 1)
	}
	_, err := failing("159").ImageMetrics(context.Background(), []int{1})
	var ce *ClickHouseError
	if !errors.As(err, &ce) || ce.Status != 500 || ce.Code != 159 || !IsServerTimeout(err) {
		t.Fatalf("err %v, want a server timeout", err)
	}
	if _, err = failing("241").ImageMetrics(context.Background(), []int{1}); err == nil || IsServerTimeout(err) {
		t.Fatalf("err %v, want a failure that is not a server timeout", err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"entityId":"x","metricType":"Like","value":1}`+"\n")
	}))
	defer bad.Close()
	if _, err := NewClickHouse(bad.URL, "u", "", time.Second, 1).ImageMetrics(context.Background(), []int{1}); err == nil {
		t.Fatal("a non-numeric entityId parsed")
	}
}

// At most maxConcurrent queries at once; a query waiting for a slot ends with the timeout.
func TestClickHouseConcurrencyAndTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	c := NewClickHouse(srv.URL, "u", "", 200*time.Millisecond, 1)
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := c.ImageMetrics(context.Background(), []int{1})
			done <- err
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("err %v, want the 200ms timeout", err)
		}
	}
	if len(c.sem) != 0 {
		t.Fatalf("%d slots still held", len(c.sem))
	}
}
