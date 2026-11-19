package hydrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The fake runs hReplaceStampedEx as the script does: replace the hash whole, stamp it (the aged
// stamp when the recent-event marker exists), set its expiry.
func init() {
	testkit.Scripts[hReplaceStampedEx] = func(r *testkit.Redis, keys []string, args []any) (any, error) {
		str := func(v any) string { return v.(string) }
		r.DelKey(keys[0])
		stamp := str(args[2])
		if r.Has(keys[1]) {
			stamp = str(args[3])
		}
		fields := map[string]string{str(args[1]): stamp}
		for i := 4; i+1 < len(args); i += 2 {
			fields[str(args[i])] = str(args[i+1])
		}
		ttl, err := strconv.Atoi(str(args[0]))
		if err != nil {
			return nil, err
		}
		r.SetHashTTL(keys[0], fields, time.Duration(ttl)*time.Second)
		return int64(1), nil
	}
}

// chQuery is one query the fake ClickHouse received.
type chQuery struct {
	sql      string
	settings []chread.Setting
}

// fakeCH answers every query with rows (or err), after delay or the context's end; onQuery runs first.
type fakeCH struct {
	mu      sync.Mutex
	queries []chQuery
	rows    []map[string]any
	err     error
	delay   time.Duration
	onQuery func()
}

func (f *fakeCH) Query(ctx context.Context, sql string, settings []chread.Setting) ([]map[string]any, error) {
	f.mu.Lock()
	f.queries = append(f.queries, chQuery{sql, settings})
	on := f.onQuery
	f.mu.Unlock()
	if on != nil {
		on()
	}
	if f.delay > 0 {
		t := time.NewTimer(f.delay)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return f.rows, f.err
}

func (f *fakeCH) seen() []chQuery {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]chQuery(nil), f.queries...)
}

// --- the golden: what Node's MetricService does on these misses (testdata/golden/gen-metrics.mjs) ---

type goldenStore struct {
	Strings map[string]struct {
		Value string `json:"value"`
		TTL   int    `json:"ttl"`
	} `json:"strings"`
	Hashes map[string]struct {
		Fields map[string]string `json:"fields"`
		TTL    int               `json:"ttl"`
	} `json:"hashes"`
}

type goldenMetricsCase struct {
	Name    string            `json:"name"`
	IDs     []int             `json:"ids"`
	Rows    []json.RawMessage `json:"rows"`
	ChError *struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	} `json:"chError"`
	FillLater *struct {
		Key    string            `json:"key"`
		Fields map[string]string `json:"fields"`
	} `json:"fillLater"`
	Queries []struct {
		Query    string         `json:"query"`
		Wire     string         `json:"wire"`
		Format   string         `json:"format"`
		Settings map[string]any `json:"settings"`
	} `json:"queries"`
	Result map[string]map[string]int `json:"result"`
	Error  *struct {
		Code *string `json:"code"`
	} `json:"error"`
	Before goldenStore `json:"before"`
	After  goldenStore `json:"after"`
}

type goldenMetrics struct {
	NowMs   int64             `json:"nowMs"`
	Scripts map[string]string `json:"scripts"`
	Cases   []goldenMetricsCase
}

func loadGoldenMetrics(t *testing.T) *goldenMetrics {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "metrics", "populate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenMetrics
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	// Positive control: every case the generator writes is here (a renamed or dropped case fails).
	if len(g.Cases) != 7 {
		t.Fatalf("%d golden cases, want 7", len(g.Cases))
	}
	return &g
}

// storeOf is the fake's state as the golden records it (expiries in seconds).
func storeOf(r *testkit.Redis) goldenStore {
	var out goldenStore
	out.Strings = map[string]struct {
		Value string `json:"value"`
		TTL   int    `json:"ttl"`
	}{}
	out.Hashes = map[string]struct {
		Fields map[string]string `json:"fields"`
		TTL    int               `json:"ttl"`
	}{}
	for _, k := range r.AllKeys() {
		ttl := int(r.Expiry(k) / time.Second)
		if h := r.Hash(k); h != nil {
			out.Hashes[k] = struct {
				Fields map[string]string `json:"fields"`
				TTL    int               `json:"ttl"`
			}{h, ttl}
			continue
		}
		v, _ := r.String(k)
		out.Strings[k] = struct {
			Value string `json:"value"`
			TTL   int    `json:"ttl"`
		}{string(v), ttl}
	}
	return out
}

func seedStore(s goldenStore) *testkit.Redis {
	r := testkit.NewRedis()
	for k, v := range s.Strings {
		r.SetStringTTL(k, []byte(v.Value), time.Duration(v.TTL)*time.Second)
	}
	for k, v := range s.Hashes {
		r.SetHashTTL(k, v.Fields, time.Duration(v.TTL)*time.Second)
	}
	return r
}

// goldenSettings is the golden's settings object as the ordered list Node's object literal lists.
func goldenSettings(m map[string]any) []chread.Setting {
	if m == nil {
		return nil
	}
	out := make([]chread.Setting, 0, len(m))
	for _, k := range []string{"max_threads", "max_execution_time", "timeout_overflow_mode"} {
		if v, ok := m[k]; ok {
			out = append(out, chread.Setting{Name: k, Value: fmt.Sprint(v)})
		}
	}
	if len(out) != len(m) {
		panic(fmt.Sprintf("golden settings %v carry an unexpected key", m))
	}
	return out
}

func (c *goldenMetricsCase) ch(t *testing.T, r *testkit.Redis) *fakeCH {
	t.Helper()
	f := &fakeCH{}
	for _, raw := range c.Rows {
		var row map[string]any
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&row); err != nil {
			t.Fatal(err)
		}
		f.rows = append(f.rows, row)
	}
	if c.ChError != nil {
		code, _ := strconv.Atoi(c.ChError.Code)
		f.err = &chread.ServerError{Code: code, Status: 500, Message: c.ChError.Message}
	}
	if c.FillLater != nil {
		fill := c.FillLater
		f.onQuery = func() { r.SetHash(fill.Key, fill.Fields) }
	}
	return f
}

// The metric-hash misses are computed exactly as Node's MetricService.fetch computes them, case by
// case against what the real Node code did (testdata/golden/metrics/populate.json): the same SQL text
// (and wire text) with the same per-query settings, the same counts per image (every requested image
// answered; a failed read is the fallback, where Node throws), and with write-back on the same cache
// afterwards (the hashes, their stamps and expiries, the timeout markers, the locks released or left).
// The write is the same Lua script, byte for byte. With write-back off the cache is untouched.
//
// One case is recorded from fetch alone but never reaches a reader in Node: in locked-never-filled
// fetch sleeps 15 × 200 ms on the held lock before it answers zeros, which is all of
// getImageMetricsObject's 3 s budget (CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS) before its cache reads
// and lock command, so the caller's timeout always wins and Node answers from the cache
// (statsUnknown). There this service falls back.
func TestMetricsMissGolden(t *testing.T) {
	g := loadGoldenMetrics(t)
	for name := range nodeBudgetExpires {
		if !slices.ContainsFunc(g.Cases, func(c goldenMetricsCase) bool { return c.Name == name }) {
			t.Fatalf("golden case %q is gone", name)
		}
	}
	if g.Scripts["hReplaceStampedEx"] != hReplaceStampedEx {
		t.Fatalf("hReplaceStampedEx differs from the script Node evaluates:\n got %q\nwant %q", hReplaceStampedEx, g.Scripts["hReplaceStampedEx"])
	}
	now := time.UnixMilli(g.NowMs)
	for _, c := range g.Cases {
		for _, writeBack := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/writeback=%v", c.Name, writeBack), func(t *testing.T) {
				r := seedStore(c.Before)
				f := c.ch(t, r)
				s := &Sources{Packed: &PackedReader{Redis: r}, Cache: r, Compute: &MissCompute{
					WriteBack: writeSet(writeBack), ClickHouse: f, MetricsTimeout: 10 * time.Second, Now: func() time.Time { return now },
				}}
				got, err := s.ImageMetrics(context.Background(), c.IDs)

				q := f.seen()
				if len(q) != len(c.Queries) {
					t.Fatalf("%d queries, want %d", len(q), len(c.Queries))
				}
				for i, want := range c.Queries {
					if q[i].sql != want.Query {
						t.Errorf("query %d:\n got %q\nwant %q", i, q[i].sql, want.Query)
					}
					if w := chread.WireQuery(q[i].sql); w != want.Wire || want.Format != "JSONEachRow" {
						t.Errorf("wire %d:\n got %q\nwant %q (%s)", i, w, want.Wire, want.Format)
					}
					if ws := goldenSettings(want.Settings); !reflect.DeepEqual(q[i].settings, ws) {
						t.Errorf("settings %d: %v, want %v", i, q[i].settings, ws)
					}
				}

				if c.Error != nil || nodeBudgetExpires[c.Name] {
					if fallback.Reason(err) != "metrics-miss-failed" {
						t.Fatalf("Node threw or its caller timed out; got %v, %v (reason %q), want the metrics-miss-failed fallback", got, err, fallback.Reason(err))
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if len(got) != len(c.Result) {
						t.Fatalf("%d images answered, want %d", len(got), len(c.Result))
					}
					for idStr, want := range c.Result {
						id, _ := strconv.Atoi(idStr)
						m, ok := got[id]
						if !ok {
							t.Fatalf("image %d unanswered", id)
						}
						for k, v := range want {
							if m[k] != v {
								t.Errorf("image %d %s = %d, want %d", id, k, m[k], v)
							}
						}
						for k, v := range m {
							if _, ok := want[k]; !ok || (v != 0 && want[k] != v) {
								t.Errorf("image %d has %s = %d, not in Node's answer %v", id, k, v, want)
							}
						}
					}
				}

				wantAfter := c.After
				if !writeBack {
					// Nothing written: the store is as before, plus what the other holder filled.
					wantAfter = c.Before
					if c.FillLater != nil {
						wantAfter = seedAndFill(c.Before, c.FillLater.Key, c.FillLater.Fields)
					}
				}
				if after := storeOf(r); !reflect.DeepEqual(normStore(after), normStore(wantAfter)) {
					t.Fatalf("cache after:\n got %+v\nwant %+v", after, wantAfter)
				}
			})
		}
	}
}

// nodeBudgetExpires names the golden cases Node's caller times out on (TestMetricsMissGolden).
var nodeBudgetExpires = map[string]bool{"locked-never-filled": true}

func seedAndFill(s goldenStore, key string, fields map[string]string) goldenStore {
	r := seedStore(s)
	r.SetHash(key, fields)
	return storeOf(r)
}

// normStore makes empty and nil maps equal.
func normStore(s goldenStore) string {
	b, _ := json.Marshal(struct {
		S any `json:"s"`
		H any `json:"h"`
	}{orEmpty(len(s.Strings), s.Strings), orEmpty(len(s.Hashes), s.Hashes)})
	return string(b)
}

func orEmpty(n int, v any) any {
	if n == 0 {
		return map[string]any{}
	}
	return v
}

// The settings and the batching: past 100 ids no per-query settings, and 1000 ids per query.
func TestMetricsMissBatches(t *testing.T) {
	r := testkit.NewRedis()
	f := &fakeCH{}
	s := &Sources{Cache: r, Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ClickHouse: f}}
	ids := make([]int, 1001)
	for i := range ids {
		ids[i] = 20001 + i
	}
	got, err := s.ImageMetrics(context.Background(), ids)
	if err != nil || len(got) != 1001 {
		t.Fatalf("%d answered, %v; want 1001", len(got), err)
	}
	q := f.seen()
	if len(q) != 2 || q[0].sql != sqlImageMetrics(ids[:1000]) || q[1].sql != sqlImageMetrics(ids[1000:]) {
		t.Fatalf("%d queries, want 2 (1000 ids, then 1)", len(q))
	}
	for _, x := range q {
		if x.settings != nil {
			t.Fatalf("settings %v past 100 ids, want none", x.settings)
		}
	}
}

// coldSources is a store with image 31's hash present (Like 3) and 32, 33 cold, and a ClickHouse that
// answers 32 with Like 4.
func coldSources(writeBack bool) (*Sources, *testkit.Redis, *fakeCH) {
	r := testkit.NewRedis()
	r.SetHash(metricHashKey(31), map[string]string{"Like": "3"})
	f := &fakeCH{rows: []map[string]any{{"entityId": json.Number("32"), "metricType": "Like", "value": json.Number("4")}}}
	return &Sources{Cache: r, Packed: &PackedReader{Redis: r}, Compute: &MissCompute{WriteBack: writeSet(writeBack), ClickHouse: f}}, r, f
}

// Only the absent hashes are looked up; the present one is served from the cache. Without a reader
// (or without the computation) a miss falls back `metrics-miss`, with no query.
func TestMetricsMissOnlyTheMisses(t *testing.T) {
	s, _, f := coldSources(false)
	got, err := s.ImageMetrics(context.Background(), []int{31, 32, 33})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]Metrics{31: {"Like": 3}, 32: {"Like": 4}, 33: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if q := f.seen(); len(q) != 1 || q[0].sql != sqlImageMetrics([]int{32, 33}) {
		t.Fatalf("queries %v, want one over 32 and 33", q)
	}
	for _, s := range []*Sources{
		{Cache: s.Cache, Packed: s.Packed, Compute: &MissCompute{}},
		{Cache: s.Cache, Packed: s.Packed},
	} {
		if _, err := s.ImageMetrics(context.Background(), []int{31, 32}); fallback.Reason(err) != "metrics-miss" {
			t.Fatalf("no reader: %v (reason %q), want metrics-miss", err, fallback.Reason(err))
		}
	}
}

// A ClickHouse that cannot be reached, refuses (busy), errors or outlasts MetricsTimeout makes the
// page fall back `metrics-miss-failed`, counted as an error; nothing is written.
func TestMetricsMissReadFailureFallsBack(t *testing.T) {
	unreachable, err := chread.New(chread.Config{URL: "http://127.0.0.1:1", MaxInFlight: 1})
	if err != nil {
		t.Fatal(err)
	}
	for name, ch := range map[string]ClickHouse{
		"unreachable": unreachable,
		"error":       &fakeCH{err: &chread.ServerError{Code: 202, Message: "Too many simultaneous queries"}},
		"busy":        &fakeCH{err: chread.ErrBusy},
		"slow":        &fakeCH{delay: time.Minute},
	} {
		t.Run(name, func(t *testing.T) {
			s, r, _ := coldSources(false)
			before := r.AllKeys()
			var errs int
			s.Compute.ClickHouse = ch
			s.Compute.MetricsTimeout = 50 * time.Millisecond
			s.Compute.Observe = func(cache, result string, n int) {
				if cache == MissMetrics && result == "error" {
					errs += n
				}
			}
			start := time.Now()
			_, err := s.ImageMetrics(context.Background(), []int{31, 32, 33})
			if fallback.Reason(err) != "metrics-miss-failed" {
				t.Fatalf("err %v (reason %q), want metrics-miss-failed", err, fallback.Reason(err))
			}
			if el := time.Since(start); el > 5*time.Second {
				t.Fatalf("took %v: the timeout did not bound the read", el)
			}
			if errs != 2 {
				t.Fatalf("errors counted %d, want 2 (the two missed ids)", errs)
			}
			if after := r.AllKeys(); !reflect.DeepEqual(after, before) {
				t.Fatalf("keys %v, want %v (nothing written)", after, before)
			}
		})
	}
}

// With write-back off an answer is kept 10 s: the same miss again sends no query, and a later one
// past the memo does. With write-back on nothing is kept (the written hash answers repeats).
func TestMetricsMissMemo(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s, _, f := coldSources(false)
	s.Compute.Now = func() time.Time { return now }
	for range 2 {
		if _, err := s.ImageMetrics(context.Background(), []int{32}); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(f.seen()); n != 1 {
		t.Fatalf("%d queries for a repeated miss within the memo, want 1", n)
	}
	now = now.Add(recentTTL)
	if _, err := s.ImageMetrics(context.Background(), []int{32}); err != nil {
		t.Fatal(err)
	}
	if n := len(f.seen()); n != 2 {
		t.Fatalf("%d queries past the memo, want 2", n)
	}
}

// Under a Go-first probe (WithPresence) a metric miss is recorded, with its one read, and answered as
// a known image with no counts; nothing is queried or written.
func TestMetricsMissUnderPresence(t *testing.T) {
	s, r, f := coldSources(true)
	before := r.AllKeys()
	p := &PresenceProbe{}
	got, err := s.ImageMetrics(WithPresence(context.Background(), p), []int{31, 32, 33})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[int]Metrics{31: {"Like": 3}, 32: {}, 33: {}}) {
		t.Fatalf("got %v", got)
	}
	if len(f.seen()) != 0 || !reflect.DeepEqual(r.AllKeys(), before) {
		t.Fatal("the probe queried or wrote")
	}
	if p.Misses()[MissMetrics] != 2 || p.DBReads()[MissMetrics] != 1 {
		t.Fatalf("recorded %v / %v, want 2 misses, 1 read", p.Misses(), p.DBReads())
	}
}

// A write-back populate outlives a request whose bound ends first: the request falls back, and the
// populate still writes the hash and releases its lock, as Node's un-aborted read does.
func TestMetricsMissWriteBackOutlivesTheRequest(t *testing.T) {
	s, r, f := coldSources(true)
	f.delay = 150 * time.Millisecond
	s.Compute.MetricsTimeout = 20 * time.Millisecond
	if _, err := s.ImageMetrics(context.Background(), []int{32}); fallback.Reason(err) != "metrics-miss-failed" {
		t.Fatalf("err %v, want metrics-miss-failed", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && (r.Hash(metricHashKey(32)) == nil || r.Has(metricLockKey(32))) {
		time.Sleep(10 * time.Millisecond)
	}
	if h := r.Hash(metricHashKey(32)); h["Like"] != "4" || r.Has(metricLockKey(32)) {
		t.Fatalf("hash %v, lock held %v: want Like 4 written and the lock released", h, r.Has(metricLockKey(32)))
	}
	if r.Expiry(metricHashKey(32)) != 12*time.Hour {
		t.Fatalf("expiry %v, want 12h", r.Expiry(metricHashKey(32)))
	}
}

// lockLog records, in order, the commands sent on one key through pipelines (SET NX, EXPIRE, DEL).
type lockLog struct {
	*testkit.Redis
	key string
	mu  sync.Mutex
	log []string
	// holdSecondExpire delays the second re-arm before it is recorded, so a release that does
	// not wait for an in-flight re-arm logs its DEL first.
	holdSecondExpire time.Duration
	expires          int
}

func (l *lockLog) Pipelined(ctx context.Context, fn func(redis.Pipeliner) error) ([]redis.Cmder, error) {
	return l.Redis.Pipelined(ctx, func(p redis.Pipeliner) error { return fn(&lockLogPipe{p, l}) })
}

func (l *lockLog) add(key, cmd string) {
	if key == l.key {
		l.mu.Lock()
		l.log = append(l.log, cmd)
		l.mu.Unlock()
	}
}

func (l *lockLog) commands() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.log...)
}

type lockLogPipe struct {
	redis.Pipeliner
	l *lockLog
}

func (p *lockLogPipe) SetNX(ctx context.Context, key string, val any, ttl time.Duration) *redis.BoolCmd {
	p.l.add(key, "SET NX")
	return p.Pipeliner.SetNX(ctx, key, val, ttl)
}

func (p *lockLogPipe) Expire(ctx context.Context, key string, d time.Duration) *redis.BoolCmd {
	if key == p.l.key {
		p.l.mu.Lock()
		p.l.expires++
		hold := p.l.expires == 2 && p.l.holdSecondExpire > 0
		p.l.mu.Unlock()
		if hold {
			time.Sleep(p.l.holdSecondExpire)
		}
	}
	p.l.add(key, "EXPIRE")
	return p.Pipeliner.Expire(ctx, key, d)
}

func (p *lockLogPipe) Del(ctx context.Context, keys ...string) *redis.IntCmd {
	for _, key := range keys {
		p.l.add(key, "DEL")
	}
	return p.Pipeliner.Del(ctx, keys...)
}

// The heartbeat must re-arm before the lock it keeps alive can expire.
func TestMetricLockHeartbeatUnderTTL(t *testing.T) {
	if metricLockHeartbeat >= metricLockTTL {
		t.Fatalf("heartbeat %s is not under the lock TTL %s", metricLockHeartbeat, metricLockTTL)
	}
}

// The held lock is re-armed on every heartbeat tick while a populate runs, and the release waits for
// an in-flight re-arm, so the DEL is the last write. The ticks are sent while the query is in flight:
// the second send is taken only after the first re-arm finished, so exactly two re-arms precede the
// DEL. The second re-arm is held 100 ms before it is recorded: the release waits it out, so the DEL
// still comes last, while a release that did not wait would log its DEL first.
func TestMetricsMissLockHeartbeat(t *testing.T) {
	ticks := make(chan time.Time)
	old := metricHeartbeatTicks
	metricHeartbeatTicks = func() (<-chan time.Time, func()) { return ticks, func() {} }
	t.Cleanup(func() { metricHeartbeatTicks = old })
	s, r, f := coldSources(true)
	l := &lockLog{Redis: r, key: metricLockKey(32), holdSecondExpire: 100 * time.Millisecond}
	s.Cache = l
	f.onQuery = func() {
		for i := 0; i < 2; i++ {
			select {
			case ticks <- time.Time{}:
			// under the request's 2.5 s cap, so a heartbeat that never ticks fails before the test ends
			case <-time.After(time.Second):
				t.Errorf("heartbeat tick %d was never taken", i+1)
				return
			}
		}
	}
	if _, err := s.ImageMetrics(context.Background(), []int{32}); err != nil {
		t.Fatal(err)
	}
	if got, want := l.commands(), []string{"SET NX", "EXPIRE", "EXPIRE", "DEL"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lock commands %q, want %q (the SET NX, a re-arm per tick, then the DEL)", got, want)
	}
	if r.Has(metricLockKey(32)) {
		t.Fatal("lock not released")
	}
}

// A count ClickHouse answers that Node holds as a number this service cannot hold exactly fails
// the lookup; a whole float is the integer.
func TestMetricRow(t *testing.T) {
	row := func(v any) map[string]any {
		return map[string]any{"entityId": json.Number("7"), "metricType": "Like", "value": v}
	}
	if _, _, n, err := metricRow(row(json.Number("12.0"))); err != nil || n != 12 {
		t.Fatalf("12.0 = %d, %v; want 12", n, err)
	}
	for _, bad := range []any{json.Number("12.5"), json.Number("9007199254740993"), "12", nil} {
		if _, _, _, err := metricRow(row(bad)); err == nil {
			t.Errorf("value %v accepted", bad)
		}
	}
	if _, _, _, err := metricRow(map[string]any{"metricType": "Like", "value": json.Number("1")}); err == nil {
		t.Error("a row without entityId accepted")
	}
}

// Another process's lock is waited on, with write-back off too (read, never taken): its hash is
// taken when it lands, and the id is never queried.
func TestMetricsMissWaitsOnAHeldLock(t *testing.T) {
	s, r, f := coldSources(false)
	r.SetString(metricLockKey(33), []byte("1"))
	go func() {
		time.Sleep(50 * time.Millisecond)
		r.SetHash(metricHashKey(33), map[string]string{"Heart": "8", "_populatedAt": "1"})
	}()
	got, err := s.ImageMetrics(context.Background(), []int{32, 33})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[int]Metrics{32: {"Like": 4}, 33: {"Heart": 8}}) {
		t.Fatalf("got %v", got)
	}
	if q := f.seen(); len(q) != 1 || q[0].sql != sqlImageMetrics([]int{32}) {
		t.Fatalf("queries %v, want one over 32 only", q)
	}
	if v, _ := r.String(metricLockKey(33)); string(v) != "1" {
		t.Fatal("the other holder's lock was touched")
	}
}

// A failed lock read fails the lookup (Node's fetch throws).
func TestMetricsMissLockReadFails(t *testing.T) {
	s, r, f := coldSources(false)
	r.KeyErr = func(key string) error {
		if key == metricLockKey(32) {
			return testkit.ErrDown
		}
		return nil
	}
	if _, err := s.ImageMetrics(context.Background(), []int{32}); fallback.Reason(err) != "metrics-miss-failed" {
		t.Fatalf("err %v, want metrics-miss-failed", err)
	}
	if len(f.seen()) != 0 {
		t.Fatal("queried past a failed lock read")
	}
}

// The lookup's bound stays under Node's own: getImageMetricsObject gives the whole read 3 s
// (CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS) and answers statsUnknown past it, so a lookup this service
// let run longer could answer counts (or zeros) where Node answers "unknown". Whatever
// FEED_GO_CLICKHOUSE_TIMEOUT_MS says, the bound is at most 2.5 s.
func TestMetricsTimeoutBound(t *testing.T) {
	for set, want := range map[time.Duration]time.Duration{
		0:                       2000 * time.Millisecond,
		900 * time.Millisecond:  900 * time.Millisecond,
		2500 * time.Millisecond: 2500 * time.Millisecond,
		2501 * time.Millisecond: 2500 * time.Millisecond,
		3000 * time.Millisecond: 2500 * time.Millisecond,
		10 * time.Second:        2500 * time.Millisecond,
	} {
		if got := (&MissCompute{MetricsTimeout: set}).metricsTimeout(); got != want {
			t.Errorf("MetricsTimeout %v: bound %v, want %v", set, got, want)
		}
	}
}

// A ClickHouse read slower than Node's budget falls back even with a longer FEED_GO_CLICKHOUSE_TIMEOUT_MS:
// Node would have answered statsUnknown at 3 s.
func TestMetricsMissSlowerThanNodesBudgetFallsBack(t *testing.T) {
	s, _, f := coldSources(false)
	f.delay = 2800 * time.Millisecond
	s.Compute.MetricsTimeout = 10 * time.Second
	start := time.Now()
	got, err := s.ImageMetrics(context.Background(), []int{32})
	if fallback.Reason(err) != "metrics-miss-failed" {
		t.Fatalf("got %v, %v (reason %q); want metrics-miss-failed", got, err, fallback.Reason(err))
	}
	if el := time.Since(start); el >= 2800*time.Millisecond {
		t.Fatalf("took %v: the read was waited out", el)
	}
}

// An id whose populate lock another process holds and never fills is not answered as zeros: Node's
// fetch only answers zeros after 15 × 200 ms of waiting, past its caller's 3 s budget, so Node answers
// statsUnknown. Under the lookup bound (whatever FEED_GO_CLICKHOUSE_TIMEOUT_MS says) and without one,
// the page falls back once the lock-wait bound runs out.
func TestMetricsMissLockNeverFilledFallsBack(t *testing.T) {
	t.Run("bounded", func(t *testing.T) {
		s, r, f := coldSources(false)
		r.SetString(metricLockKey(33), []byte("1"))
		s.Compute.MetricsTimeout = 10 * time.Second
		got, err := s.ImageMetrics(context.Background(), []int{33})
		if fallback.Reason(err) != "metrics-miss-failed" {
			t.Fatalf("got %v, %v (reason %q); want metrics-miss-failed", got, err, fallback.Reason(err))
		}
		if len(f.seen()) != 0 {
			t.Fatal("queried an id another process holds the lock of")
		}
	})
	t.Run("wait exhausted", func(t *testing.T) {
		s, r, _ := coldSources(false)
		r.SetString(metricLockKey(33), []byte("1"))
		got, err := s.lookupImageMetrics(context.Background(), []int{33})
		if !errors.Is(err, errMetricsWaitExhausted) {
			t.Fatalf("got %v, %v after the wait ran out, want errMetricsWaitExhausted (the fallback)", got, err)
		}
	})
}

// fakeLockWait replaces s's lock-wait timer with a fake clock: each delay advances it at once and is
// recorded; at fills (fake time since the wait began) image 33's hash lands, as another process's
// populate would fill it. It returns the recorded delays.
func fakeLockWait(s *Sources, r *testkit.Redis, fillAt time.Duration) *[]time.Duration {
	var delays []time.Duration
	var now time.Duration
	s.Compute.waitSleep = func(ctx context.Context, d time.Duration) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		delays = append(delays, d)
		now += d
		if fillAt > 0 && now >= fillAt {
			r.SetHash(metricHashKey(33), map[string]string{"Heart": "8", "_populatedAt": "1"})
		}
		return nil
	}
	return &delays
}

// sumDurations is the total of ds.
func sumDurations(ds []time.Duration) time.Duration {
	var t time.Duration
	for _, d := range ds {
		t += d
	}
	return t
}

// The wait on a populate lock another process holds never fills is bounded by MetricsLockWait
// (default 500 ms), read every 100 ms with the last delay cut to land on the bound, and ends
// exhausted (errMetricsWaitExhausted) with one Redis read per delay. Fake clock: the delays are
// asserted exactly. MetricsTimeout (the lookup's own bound) is set far past every case and does not
// move them.
//
// Fails on: the bound reverted to Node's 15 × 200 ms (15 delays of 200 ms); the poll interval left
// at 200 ms ([200 200 100] for the default); the last delay not cut (250 ms → [100 100 100]); the
// default changed (unset → not 500 ms); a non-positive MetricsLockWait taken as is (-1 → no read at
// all); the bound taken from MetricsTimeout; reads miscounted against delays.
func TestMetricsLockWaitBounded(t *testing.T) {
	ms := time.Millisecond
	for _, c := range []struct {
		set  time.Duration
		want []time.Duration
	}{
		{0, []time.Duration{100 * ms, 100 * ms, 100 * ms, 100 * ms, 100 * ms}},
		{-1, []time.Duration{100 * ms, 100 * ms, 100 * ms, 100 * ms, 100 * ms}},
		{250 * ms, []time.Duration{100 * ms, 100 * ms, 50 * ms}},
		{70 * ms, []time.Duration{70 * ms}},
		{1000 * ms, slices.Repeat([]time.Duration{100 * ms}, 10)},
	} {
		s, r, f := coldSources(false)
		s.Compute.MetricsTimeout = 2 * time.Second
		s.Compute.MetricsLockWait = c.set
		r.SetString(metricLockKey(33), []byte("1"))
		delays := fakeLockWait(s, r, 0)
		out := map[int]jspack.Obj{}
		polls, err := s.pollMetricHashes(context.Background(), []int{33}, out)
		if !errors.Is(err, errMetricsWaitExhausted) {
			t.Fatalf("MetricsLockWait %v: err %v, want errMetricsWaitExhausted", c.set, err)
		}
		if !slices.Equal(*delays, c.want) {
			t.Fatalf("MetricsLockWait %v: delays %v (total %v), want %v", c.set, *delays, sumDurations(*delays), c.want)
		}
		if polls != len(c.want) {
			t.Fatalf("MetricsLockWait %v: %d reads, want %d (one per delay)", c.set, polls, len(c.want))
		}
		if len(out) != 0 || len(f.seen()) != 0 {
			t.Fatalf("MetricsLockWait %v: answered %v, queried %v; want neither", c.set, out, f.seen())
		}
	}
}

// A hash the holder fills inside the bound is taken at the first read after it lands, including a
// fill landing exactly on the bound (the last read is AT the bound); one landing after it is not
// waited for.
//
// Fails on: the last read dropped or moved before the bound (the 500 ms case exhausts); the wait
// running past the bound (the 510 ms case fills); a filled hash not taken or the wait not stopping
// at it (300 ms: 3 reads, Heart 8).
func TestMetricsLockReleasedInsideBound(t *testing.T) {
	for _, c := range []struct {
		fillAt time.Duration
		polls  int
		filled bool
	}{
		{300 * time.Millisecond, 3, true},
		{500 * time.Millisecond, 5, true},
		{510 * time.Millisecond, 5, false},
	} {
		s, r, _ := coldSources(false)
		r.SetString(metricLockKey(33), []byte("1"))
		fakeLockWait(s, r, c.fillAt)
		out := map[int]jspack.Obj{}
		polls, err := s.pollMetricHashes(context.Background(), []int{33}, out)
		if polls != c.polls {
			t.Fatalf("fill at %v: %d reads, want %d", c.fillAt, polls, c.polls)
		}
		if !c.filled {
			if !errors.Is(err, errMetricsWaitExhausted) {
				t.Fatalf("fill at %v (past the bound): err %v, want errMetricsWaitExhausted", c.fillAt, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("fill at %v: %v", c.fillAt, err)
		}
		if !reflect.DeepEqual(out, map[int]jspack.Obj{33: {{K: "Heart", V: 8}}}) {
			t.Fatalf("fill at %v: answered %v, want 33 Heart 8", c.fillAt, out)
		}
	}
}

// End to end on the real clock: a page whose only miss is held by another process past the bound
// falls back `metrics-miss-failed` with the wait exhausted after about the bound (500 ms), not when
// the lookup's own 2 s bound (or Node's 3 s) ends. The upper limit, 1.5 s, leaves CI scheduling
// room and is still under the 2 s the lookup bound ends it at.
//
// Fails on: the change reverted (the wait runs until MetricsTimeout, 2 s: too slow, and the class is
// "deadline", not the exhausted wait); the bound applied to nothing.
func TestMetricsMissLockHeldPastBoundFallsBack(t *testing.T) {
	s, r, f := coldSources(false)
	r.SetString(metricLockKey(33), []byte("1"))
	s.Compute.MetricsTimeout = 2 * time.Second
	start := time.Now()
	got, err := s.ImageMetrics(context.Background(), []int{33})
	el := time.Since(start)
	var fe *fallback.Error
	if !errors.As(err, &fe) || fe.Reason != "metrics-miss-failed" || fe.Detail != errMetricsWaitExhausted.Error() {
		t.Fatalf("got %v, %v; want the metrics-miss-failed fallback of the exhausted wait", got, err)
	}
	if el < 500*time.Millisecond || el >= 1500*time.Millisecond {
		t.Fatalf("fell back after %v, want about the 500 ms bound (≥ 500 ms, < 1.5 s)", el)
	}
	if len(f.seen()) != 0 {
		t.Fatal("queried an id another process holds the lock of")
	}
}

// The lock-wait bound is not the lookup's: this service's own ClickHouse read of the ids it is free
// to query keeps MetricsTimeout (2 s) and is answered as before when it takes longer than the
// lock-wait bound, alone and beside an id another process holds and fills during that read (taken at
// the wait's first read, never queried).
//
// Fails on: the lock-wait bound applied to the whole lookup or to the own read (the 800 ms read is
// cut at 500 ms and the page falls back); the held id queried.
func TestMetricsLockWaitSparesOwnQuery(t *testing.T) {
	t.Run("own read only", func(t *testing.T) {
		s, _, f := coldSources(false)
		f.delay = 800 * time.Millisecond
		s.Compute.MetricsTimeout = 2 * time.Second
		got, err := s.ImageMetrics(context.Background(), []int{32})
		if err != nil {
			t.Fatalf("an 800 ms own read under a 2 s lookup bound: %v", err)
		}
		if !reflect.DeepEqual(got, map[int]Metrics{32: {"Like": 4}}) {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("beside a held id", func(t *testing.T) {
		s, r, f := coldSources(false)
		f.delay = 800 * time.Millisecond
		s.Compute.MetricsTimeout = 2 * time.Second
		r.SetString(metricLockKey(33), []byte("1"))
		f.onQuery = func() { r.SetHash(metricHashKey(33), map[string]string{"Heart": "8", "_populatedAt": "1"}) }
		got, err := s.ImageMetrics(context.Background(), []int{32, 33})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, map[int]Metrics{32: {"Like": 4}, 33: {"Heart": 8}}) {
			t.Fatalf("got %v", got)
		}
		if q := f.seen(); len(q) != 1 || q[0].sql != sqlImageMetrics([]int{32}) {
			t.Fatalf("queries %v, want one over 32 only", q)
		}
	})
}

// metricsLockWait is MetricsLockWait when positive, else 500 ms.
//
// Fails on: the default changed; a non-positive value taken as is; the value capped or replaced.
func TestMetricsLockWaitDefault(t *testing.T) {
	for set, want := range map[time.Duration]time.Duration{
		0:                      500 * time.Millisecond,
		-time.Second:           500 * time.Millisecond,
		750 * time.Millisecond: 750 * time.Millisecond,
		5 * time.Second:        5 * time.Second,
	} {
		if got := (&MissCompute{MetricsLockWait: set}).metricsLockWait(); got != want {
			t.Errorf("MetricsLockWait %v: %v, want %v", set, got, want)
		}
	}
}
