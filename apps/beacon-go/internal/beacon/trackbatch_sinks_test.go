package beacon

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// closedWindow is a clock outside every event-points window (2026-05-28, before birthday2026's
// preview), openWindow one inside it.
var (
	closedWindow = time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	openWindow   = time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
)

func rate(r float64) func() (float64, bool) { return func() (float64, bool) { return r, true } }

// sinkEngine answers every sink at a closed-window clock, the feed rate 0.25.
func sinkEngine(calls *atomic.Int32, user *auth.SessionUser) *Engine {
	return &Engine{
		Sessions:        countingUser{u: user, calls: calls},
		TrackerEnabled:  true,
		TrackBatchSinks: AllSinks,
		FeedSampleRate:  rate(0.25),
		Now:             func() time.Time { return closedWindow },
	}
}

// Tracker.impressions' rows, written by hand from tracker.ts (trackMany with skipActorMeta: the user
// id, then entityType, entityId, sessionKey, surface), not from the generator.
func TestTrackBatchImpressionRowsLiteral(t *testing.T) {
	cases := []struct {
		name  string
		user  *auth.SessionUser
		body  string
		want  []Write
		sinks Sinks
	}{
		{
			name: "one row per entity, in order, duplicates kept",
			body: `[{"kind":"impression","data":{"surface":"home","sessionKey":"abc","entities":[{"entityType":"Post","entityId":3},{"entityId":1,"entityType":"Image"},{"entityType":"Post","entityId":3}]}}]`,
			want: []Write{
				{Table: "impressions", Sink: SinkClickHouse, Body: []byte(`{"userId":0,"entityType":"Post","entityId":3,"sessionKey":"abc","surface":"home"}`)},
				{Table: "impressions", Sink: SinkClickHouse, Body: []byte(`{"userId":0,"entityType":"Image","entityId":1,"sessionKey":"abc","surface":"home"}`)},
				{Table: "impressions", Sink: SinkClickHouse, Body: []byte(`{"userId":0,"entityType":"Post","entityId":3,"sessionKey":"abc","surface":"home"}`)},
			},
			sinks: Sinks{Impressions: true},
		},
		{
			name: "signed in: the user id only, no ip or user agent; unknown keys stripped; surface caught",
			user: &auth.SessionUser{ID: 77},
			body: `[{"kind":"impression","data":{"x":1,"surface":"nope","sessionKey":"s","entities":[{"entityType":"Model","entityId":9,"score":1}]}}]`,
			want: []Write{
				{Table: "impressions", Sink: SinkClickHouse, Body: []byte(`{"userId":77,"entityType":"Model","entityId":9,"sessionKey":"s","surface":"other"}`)},
			},
			sinks: Sinks{Impressions: true},
		},
		{
			name: "no surface is 'other'; a null surface too",
			body: `[{"kind":"impression","data":{"sessionKey":"s","entities":[{"entityType":"User","entityId":2}]}},{"kind":"impression","data":{"sessionKey":"s","surface":null,"entities":[{"entityType":"User","entityId":3}]}}]`,
			want: []Write{
				{Table: "impressions", Sink: SinkClickHouse, Body: []byte(`{"userId":0,"entityType":"User","entityId":2,"sessionKey":"s","surface":"other"}`)},
				{Table: "impressions", Sink: SinkClickHouse, Insert: 1, Body: []byte(`{"userId":0,"entityType":"User","entityId":3,"sessionKey":"s","surface":"other"}`)},
			},
			sinks: Sinks{Impressions: true},
		},
		{
			name: "tracker rows first, then each impression event as its own insert",
			body: `[{"kind":"impression","data":{"sessionKey":"s","surface":"tag","entities":[{"entityType":"Bounty","entityId":1}]}},{"kind":"search","data":{"query":"q","index":"i"}},{"kind":"impression","data":{"sessionKey":"t","surface":"tag","entities":[{"entityType":"Bounty","entityId":2}]}}]`,
			want: []Write{
				{Table: "search", Body: []byte(`{"userId":0,"ip":"192.0.2.1","userAgent":"ua","query":"q","index":"i","filters":""}`)},
				{Table: "impressions", Sink: SinkClickHouse, Insert: 0, Body: []byte(`{"userId":0,"entityType":"Bounty","entityId":1,"sessionKey":"s","surface":"tag"}`)},
				{Table: "impressions", Sink: SinkClickHouse, Insert: 1, Body: []byte(`{"userId":0,"entityType":"Bounty","entityId":2,"sessionKey":"t","surface":"tag"}`)},
			},
			sinks: Sinks{Impressions: true},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			calls := &atomic.Int32{}
			e := sinkEngine(calls, c.user)
			out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(c.body, nil))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(out.Writes, c.want) {
				t.Fatalf("writes\n got  %s\n want %s", writesString(out.Writes), writesString(c.want))
			}
			if out.Sinks != c.sinks || calls.Load() != 1 {
				t.Fatalf("sinks %+v, %d session reads", out.Sinks, calls.Load())
			}
		})
	}
}

func writesString(ws []Write) string {
	var b strings.Builder
	for _, w := range ws {
		b.WriteString(w.Table + "/" + strconv.Itoa(int(w.Sink)) + "/" + strconv.Itoa(w.Insert) + " " + string(w.Body) + "\n")
	}
	return b.String()
}

// Impressions do not go through the tracker: without one, the search row is gone and the impression
// rows stay (the session is still read for their user id, and no client ip is needed).
func TestTrackBatchImpressionsWithoutTracker(t *testing.T) {
	calls := &atomic.Int32{}
	e := sinkEngine(calls, &auth.SessionUser{ID: 5})
	e.TrackerEnabled = false
	body := `[{"kind":"search","data":{"query":"q","index":"i"}},{"kind":"impression","data":{"sessionKey":"s","surface":"home","entities":[{"entityType":"Post","entityId":1}]}}]`
	// No ip header: a tracker row would fall back on it; an impression row does not carry one.
	out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, map[string]string{"cf-connecting-ip": drop}))
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"userId":5,"entityType":"Post","entityId":1,"sessionKey":"s","surface":"home"}`
	if len(out.Writes) != 1 || string(out.Writes[0].Body) != want || calls.Load() != 1 {
		t.Fatalf("writes %s, %d session reads", writesString(out.Writes), calls.Load())
	}
}

// A feed event of an unsampled session writes nothing and reads no session; a batch of only those is
// a bare 200. The sample rate is read only when a feed event is present.
func TestTrackBatchFeedUnsampled(t *testing.T) {
	const feed = `{"kind":"feed","data":{"event":"seen","sessionKey":"k1","feed":"images","page":"/images","seenIds":[1]}}`
	calls := &atomic.Int32{}
	reads := 0
	e := sinkEngine(calls, &auth.SessionUser{ID: 3})
	e.FeedSampleRate = func() (float64, bool) { reads++; return 0.25, true }
	out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq("["+feed+","+feed+"]", nil))
	if err != nil || out.Response.Status != 200 || len(out.Writes) != 0 || calls.Load() != 0 {
		t.Fatalf("err %v status %d writes %d session reads %d", err, out.Response.Status, len(out.Writes), calls.Load())
	}
	if out.Sinks != (Sinks{Feed: true}) || reads != 1 {
		t.Fatalf("sinks %+v, %d rate reads", out.Sinks, reads)
	}
	out, err = e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"search","data":{"query":"q","index":"i"}},`+feed+`]`, nil))
	if err != nil || len(out.Writes) != 1 || out.Writes[0].Table != "search" || calls.Load() != 1 {
		t.Fatalf("with a search: err %v writes %s", err, writesString(out.Writes))
	}
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"search","data":{"query":"q","index":"i"}}]`, nil)); err != nil || reads != 2 {
		t.Fatalf("a batch without a feed event read the rate: %d reads (%v)", reads, err)
	}
}

// keeps(sessionKey): hashToUnit(key) < rate, so `k1` (0.5947) is kept from a rate just above it and
// `tab-0` (0.1103) at 0.25; rate 0 keeps nothing and 1 everything; no reading falls back.
func TestTrackBatchFeedSampling(t *testing.T) {
	feed := func(key string) string {
		return `[{"kind":"feed","data":{"event":"load","sessionKey":"` + key + `","feed":"models","page":"/models"}}]`
	}
	cases := []struct {
		key    string
		rate   float64
		ok     bool
		reason string
	}{
		{"k1", 0.25, true, ""},
		{"k1", 0.5946884604, true, ""},
		{"k1", 0.5946884605, true, ReasonTrackFeedSampled},
		{"tab-0", 0.25, true, ReasonTrackFeedSampled},
		{"tab-0", 0, true, ""},
		{"k1", 1, true, ReasonTrackFeedSampled},
		{"k1", 0, false, ReasonTrackFeedSampleRate},
	}
	for _, c := range cases {
		calls := &atomic.Int32{}
		e := sinkEngine(calls, nil)
		e.FeedSampleRate = func() (float64, bool) { return c.rate, c.ok }
		_, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(feed(c.key), nil))
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s at %v (%v): %q, want %q", c.key, c.rate, c.ok, got, c.reason)
		}
	}
	// No rate source at all is no reading.
	e := sinkEngine(&atomic.Int32{}, nil)
	e.FeedSampleRate = nil
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(feed("k1"), nil)); fallback.Reason(err) != ReasonTrackFeedSampleRate {
		t.Fatalf("nil rate: %v", err)
	}
}

// The event-points gate: an impression of an Image, Model or Article inside a scored window (widened
// by EventPointsMargin) falls back; other entity types, and any clock outside, are answered.
func TestTrackBatchEventPointsWindow(t *testing.T) {
	imp := func(types ...string) string {
		ents := make([]string, len(types))
		for i, ty := range types {
			ents[i] = `{"entityType":"` + ty + `","entityId":1}`
		}
		return `[{"kind":"impression","data":{"sessionKey":"s","surface":"home","entities":[` + strings.Join(ents, ",") + `]}}]`
	}
	from := time.UnixMilli(1791504000000) // 2026-10-09T00:00Z
	to := time.UnixMilli(1796169600000)   // 2026-12-02T00:00Z
	cases := []struct {
		name   string
		now    time.Time
		body   string
		reason string
	}{
		{"open, Image", openWindow, imp("Image"), ReasonTrackImpressionEventPoints},
		{"open, Model", openWindow, imp("Post", "Model"), ReasonTrackImpressionEventPoints},
		{"open, Article", openWindow, imp("Article"), ReasonTrackImpressionEventPoints},
		{"open, no point type", openWindow, imp("Post", "User", "Collection", "Bounty", "BountyEntry", "Announcement"), ""},
		{"closed, Image", closedWindow, imp("Image"), ""},
		{"margin before the preview", from.Add(-time.Hour), imp("Image"), ReasonTrackImpressionEventPoints},
		{"past the margin before", from.Add(-time.Hour - time.Millisecond), imp("Image"), ""},
		{"margin after the window", to.Add(time.Hour), imp("Image"), ReasonTrackImpressionEventPoints},
		{"past the margin after", to.Add(time.Hour + time.Millisecond), imp("Image"), ""},
	}
	for _, c := range cases {
		e := sinkEngine(&atomic.Int32{}, nil)
		e.Now = func() time.Time { return c.now }
		_, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(c.body, nil))
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
}

// With several reasons the first of the ranking wins: impression sink off, feed sink off, event
// points, no rate reading, a sampled session, an unported action, an invalid event.
func TestTrackBatchSinkReasonRanking(t *testing.T) {
	const (
		imgImp    = `{"kind":"impression","data":{"sessionKey":"s","entities":[{"entityType":"Image","entityId":1}]}}`
		sampled   = `{"kind":"feed","data":{"event":"load","sessionKey":"tab-0","feed":"images","page":"/"}}`
		unported  = `{"kind":"action","data":{"type":"Experiment_Exposure"}}`
		invalid   = `{"kind":"action","data":{"type":"Tip_Click","details":"x"}}`
		badImp    = `{"kind":"impression","data":{"sessionKey":"","entities":[{"entityType":"Image","entityId":1}]}}`
		badFeed   = `{"kind":"feed","data":{"event":"load","sessionKey":"k","feed":"nope","page":"/"}}`
		unsampled = `{"kind":"feed","data":{"event":"load","sessionKey":"k1","feed":"images","page":"/"}}`
	)
	cases := []struct {
		name   string
		sinks  Sinks
		rateOK bool
		now    time.Time
		events []string
		reason string
	}{
		{"impression sink off beats feed sink off", Sinks{}, true, closedWindow, []string{sampled, imgImp}, ReasonTrackImpression},
		{"feed sink off beats event points", Sinks{Impressions: true}, true, openWindow, []string{imgImp, sampled}, ReasonTrackFeed},
		{"event points beat no rate", AllSinks, false, openWindow, []string{sampled, imgImp}, ReasonTrackImpressionEventPoints},
		{"no rate beats unported", AllSinks, false, closedWindow, []string{unported, unsampled}, ReasonTrackFeedSampleRate},
		{"sampled beats invalid", AllSinks, true, closedWindow, []string{invalid, sampled}, ReasonTrackFeedSampled},
		{"unported beats invalid", AllSinks, true, closedWindow, []string{invalid, unported, unsampled}, ReasonTrackActionUnported},
		{"an invalid impression", AllSinks, true, closedWindow, []string{badImp}, ReasonTrackEventInvalid},
		{"an invalid feed event", AllSinks, true, closedWindow, []string{badFeed}, ReasonTrackEventInvalid},
		{"an invalid impression is not the sink being off", Sinks{Feed: true}, true, closedWindow, []string{badImp}, ReasonTrackImpression},
	}
	for _, c := range cases {
		calls := &atomic.Int32{}
		e := sinkEngine(calls, nil)
		e.TrackBatchSinks = c.sinks
		e.FeedSampleRate = func() (float64, bool) { return 0.25, c.rateOK }
		e.Now = func() time.Time { return c.now }
		out, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq("["+strings.Join(c.events, ",")+"]", nil))
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q, want %q", c.name, got, c.reason)
		}
		if len(out.Writes) != 0 || calls.Load() != 0 {
			t.Errorf("%s: a fallback wrote %d rows / read the session %d times", c.name, len(out.Writes), calls.Load())
		}
	}
}

// ComputeShadow answers with every sink whatever Compute is set to, and only for track-batch.
func TestComputeShadowUsesAllSinks(t *testing.T) {
	e := sinkEngine(&atomic.Int32{}, nil)
	e.TrackBatchSinks = Sinks{}
	body := `[{"kind":"impression","data":{"sessionKey":"s","entities":[{"entityType":"Post","entityId":1}]}},{"kind":"feed","data":{"event":"load","sessionKey":"k1","feed":"images","page":"/"}}]`
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(body, nil)); fallback.Reason(err) != ReasonTrackImpression {
		t.Fatalf("serve sinks off: %v", err)
	}
	out, err := e.ComputeShadow(context.Background(), EndpointTrackBatch, batchReq(body, nil))
	if err != nil || out.Sinks != AllSinks || SinksLabel(out.Sinks) != "impressions-feed" || len(out.Writes) != 1 {
		t.Fatalf("shadow: %v %+v", err, out)
	}
}

func TestSinksLabel(t *testing.T) {
	got := []string{SinksLabel(Sinks{}), SinksLabel(Sinks{Impressions: true}), SinksLabel(Sinks{Feed: true}), SinksLabel(AllSinks)}
	if !reflect.DeepEqual(got, SinkLabels) || !reflect.DeepEqual(got, []string{"core", "impressions", "feed", "impressions-feed"}) {
		t.Fatalf("%v / %v", got, SinkLabels)
	}
}

// Each feed schema bound, accepted and refused at its edge (a refusal falls the batch back).
func TestFeedEventFields(t *testing.T) {
	base := `"event":"click","sessionKey":"k1","feed":"images","page":"/images"`
	cases := []struct {
		name string
		data string
		ok   bool
	}{
		{"minimal", base, true},
		{"every field", base + `,"sort":"Newest","pageIndex":10000,"filters":{"period":"Week","x":"y"},"entityType":"Image","entityId":2147483647,"position":0,"seenIds":[1,2147483647],"extra":1`, true},
		{"page at 200", `"event":"load","sessionKey":"k1","feed":"images","page":"` + strings.Repeat("p", 200) + `"`, true},
		{"page at 201", `"event":"load","sessionKey":"k1","feed":"images","page":"` + strings.Repeat("p", 201) + `"`, false},
		{"page missing", `"event":"load","sessionKey":"k1","feed":"images"`, false},
		{"sort at 64", base + `,"sort":"` + strings.Repeat("s", 64) + `"`, true},
		{"sort at 65", base + `,"sort":"` + strings.Repeat("s", 65) + `"`, false},
		{"sort null", base + `,"sort":null`, false},
		{"pageIndex -1", base + `,"pageIndex":-1`, false},
		{"pageIndex 1.5", base + `,"pageIndex":1.5`, false},
		{"position 10001", base + `,"position":10001`, false},
		{"filter key at 64", base + `,"filters":{"` + strings.Repeat("k", 64) + `":"v"}`, true},
		{"filter key at 65", base + `,"filters":{"` + strings.Repeat("k", 65) + `":"v"}`, false},
		{"filter value not a string", base + `,"filters":{"period":7}`, false},
		{"__proto__ filter skipped whatever its value", base + `,"filters":{"__proto__":7}`, true},
		{"filters an array", base + `,"filters":[]`, false},
		{"entityType unknown", base + `,"entityType":"Comic"`, false},
		{"entityId 0", base + `,"entityId":0`, false},
		{"entityId 2^31", base + `,"entityId":2147483648`, false},
		{"seenIds 250", base + `,"seenIds":[` + strings.TrimSuffix(strings.Repeat("1,", 250), ",") + `]`, true},
		{"seenIds 251", base + `,"seenIds":[` + strings.TrimSuffix(strings.Repeat("1,", 251), ",") + `]`, false},
		{"seenIds not an array", base + `,"seenIds":1`, false},
		{"seenIds with a zero", base + `,"seenIds":[0]`, false},
		{"event unknown", `"event":"scroll","sessionKey":"k1","feed":"images","page":"/"`, false},
		{"feed unknown", `"event":"load","sessionKey":"k1","feed":"videos","page":"/"`, false},
		{"sessionKey 33", `"event":"load","sessionKey":"` + strings.Repeat("k", 33) + `","feed":"images","page":"/"`, false},
		{"17 emoji are 34 UTF-16 units", `"event":"load","sessionKey":"` + strings.Repeat("😀", 17) + `","feed":"images","page":"/"`, false},
	}
	for _, c := range cases {
		e := sinkEngine(&atomic.Int32{}, nil)
		e.FeedSampleRate = rate(0)
		_, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"feed","data":{`+c.data+`}}]`, nil))
		if (err == nil) != c.ok || (err != nil && fallback.Reason(err) != ReasonTrackEventInvalid) {
			t.Errorf("%s: err %v, want ok %v", c.name, err, c.ok)
		}
	}
	// Data that is not an object.
	e := sinkEngine(&atomic.Int32{}, nil)
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"feed","data":[]}]`, nil)); fallback.Reason(err) != ReasonTrackEventInvalid {
		t.Fatalf("array data: %v", err)
	}
}

// Each impression schema bound at its edge.
func TestImpressionEventFields(t *testing.T) {
	ents := func(n int) string {
		return "[" + strings.TrimSuffix(strings.Repeat(`{"entityType":"Post","entityId":1},`, n), ",") + "]"
	}
	cases := []struct {
		name string
		data string
		ok   bool
	}{
		{"250 entities", `"sessionKey":"s","entities":` + ents(250), true},
		{"251 entities", `"sessionKey":"s","entities":` + ents(251), false},
		{"no entities", `"sessionKey":"s","entities":[]`, false},
		{"entities missing", `"sessionKey":"s"`, false},
		{"entities not an array", `"sessionKey":"s","entities":{}`, false},
		{"an entity not an object", `"sessionKey":"s","entities":[1]`, false},
		{"entityId missing", `"sessionKey":"s","entities":[{"entityType":"Post"}]`, false},
		{"entityId 1.5", `"sessionKey":"s","entities":[{"entityType":"Post","entityId":1.5}]`, false},
		{"entityId MAX_SAFE_INTEGER", `"sessionKey":"s","entities":[{"entityType":"Post","entityId":9007199254740991}]`, true},
		{"entityId past MAX_SAFE_INTEGER", `"sessionKey":"s","entities":[{"entityType":"Post","entityId":9007199254740992}]`, false},
		{"entityId a string", `"sessionKey":"s","entities":[{"entityType":"Post","entityId":"1"}]`, false},
		{"sessionKey at 32", `"sessionKey":"` + strings.Repeat("k", 32) + `","entities":` + ents(1), true},
		{"sessionKey missing", `"entities":` + ents(1), false},
		{"sessionKey a number", `"sessionKey":1,"entities":` + ents(1), false},
		{"surface a number is caught", `"sessionKey":"s","surface":5,"entities":` + ents(1), true},
	}
	for _, c := range cases {
		e := sinkEngine(&atomic.Int32{}, nil)
		_, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"impression","data":{`+c.data+`}}]`, nil))
		if (err == nil) != c.ok || (err != nil && fallback.Reason(err) != ReasonTrackEventInvalid) {
			t.Errorf("%s: err %v, want ok %v", c.name, err, c.ok)
		}
	}
	e := sinkEngine(&atomic.Int32{}, nil)
	if _, err := e.Compute(context.Background(), EndpointTrackBatch, batchReq(`[{"kind":"impression","data":"x"}]`, nil)); fallback.Reason(err) != ReasonTrackEventInvalid {
		t.Fatalf("string data: %v", err)
	}
}

// ---- The copies against the Node recording ---------------------------------------------------------

// readVectors parses vectors.json with the JS-semantics parser (key order kept, a lone surrogate
// survives).
func readVectors(t *testing.T) *jsvalue.Object {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := jsvalue.Parse(string(b))
	if err != nil || !v.IsPlainObject() {
		t.Fatalf("vectors.json: %v", err)
	}
	s, ok := v.O.Get("trackBatchSinks")
	if !ok || !s.IsPlainObject() {
		t.Fatal("vectors.json has no trackBatchSinks")
	}
	return s.O
}

func get(t *testing.T, o *jsvalue.Object, path ...string) jsvalue.Value {
	t.Helper()
	v := jsvalue.ObjectValue(o)
	for _, k := range path {
		if !v.IsPlainObject() {
			t.Fatalf("%v: not an object at %s", path, k)
		}
		var ok bool
		if v, ok = v.O.Get(k); !ok {
			t.Fatalf("%v: no %s", path, k)
		}
	}
	return v
}

func strs(t *testing.T, v jsvalue.Value) []string {
	t.Helper()
	if v.Kind != jsvalue.Array {
		t.Fatalf("not an array: %s", jsvalue.Stringify(v))
	}
	out := make([]string, len(v.A))
	for i, e := range v.A {
		if e.Kind != jsvalue.String {
			t.Fatalf("not a string: %s", jsvalue.Stringify(e))
		}
		out[i] = e.S
	}
	return out
}

// The copies in trackbatch_sinks.go equal what gen.ts recorded from the Node code.
func TestTrackBatchSinkConstants(t *testing.T) {
	v := readVectors(t)
	lists := map[string][]string{
		"impressionEntityTypes": impressionEntityTypes,
		"impressionSurfaces":    impressionSurfaces,
		"feedEventTypes":        feedEventTypes,
		"feedEventFeeds":        feedEventFeeds,
		"pointEntityTypes":      pointEntityTypes,
	}
	for name, here := range lists {
		if node := strs(t, get(t, v, name)); !reflect.DeepEqual(here, node) {
			t.Errorf("%s\n here %v\n Node %v", name, here, node)
		}
	}
	for name, here := range map[string]float64{"impressionEntitiesMax": impressionEntitiesMax, "feedEventIndexMax": feedEventIndexMax} {
		if node := get(t, v, name); node.N != here {
			t.Errorf("%s here %v, Node %v", name, here, node.N)
		}
	}
	if f := get(t, v, "feedEventsSampleRateFlag"); f.S != FeedEventsSampleRateFlag {
		t.Errorf("flag here %q, Node %q", FeedEventsSampleRateFlag, f.S)
	}
	events := get(t, v, "scoredEvents")
	if len(events.A) != len(scoredEvents) {
		t.Fatalf("%d scored events here, Node %d", len(scoredEvents), len(events.A))
	}
	for i, ev := range events.A {
		got := scoredEvent{name: get(t, ev.O, "name").S, from: int64(get(t, ev.O, "from").N), to: int64(get(t, ev.O, "to").N)}
		if got != scoredEvents[i] {
			t.Errorf("scored event %d here %+v, Node %+v", i, scoredEvents[i], got)
		}
	}
	// Literal anchors: the recording is the shape read above (a positive control).
	if len(impressionSurfaces) != 20 || impressionSurfaces[19] != "other" || scoredEvents[0].to-scoredEvents[0].from != 54*24*3600*1000 {
		t.Fatalf("anchors: %d surfaces, window %d ms", len(impressionSurfaces), scoredEvents[0].to-scoredEvents[0].from)
	}
}

// HashToUnit and ParseSampleRate give the Node values for every recorded input, a lone surrogate and
// JS Number() spellings included.
func TestSamplingVectors(t *testing.T) {
	v := readVectors(t)
	hashes := get(t, v, "hashToUnit")
	if len(hashes.A) < 8 {
		t.Fatalf("%d hash vectors", len(hashes.A))
	}
	for _, h := range hashes.A {
		in, out := get(t, h.O, "in").S, get(t, h.O, "out").N
		if got := HashToUnit(in); got != out {
			t.Errorf("hashToUnit(%q) = %v, Node %v", in, got, out)
		}
	}
	// Literal: FNV-1a's offset basis over no units.
	if got := HashToUnit(""); got != float64(0x811c9dc5)/0x1_0000_0000 {
		t.Fatalf("hashToUnit('') = %v", got)
	}
	rates := get(t, v, "parseSampleRate")
	for _, r := range rates.A {
		in, out := get(t, r.O, "in").S, get(t, r.O, "out").N
		if got := ParseSampleRate(in); got != out {
			t.Errorf("parseSampleRate(%q) = %v, Node %v", in, got, out)
		}
	}
	if ParseSampleRate("NaN") != 0 || ParseSampleRate("0.3") != 0.3 || ParseSampleRate("7") != 1 {
		t.Fatal("parseSampleRate literals")
	}
}

// ---- The schemas, structurally ----------------------------------------------------------------------

// propSpec is one property of a JSON Schema, folded onto what this service's parsers check.
type propSpec struct {
	Types    []string // sorted, "null" included when nullable
	Enum     []string // sorted
	Const    string
	Min, Max *float64
	ExclMin  *float64
	MinLen   *float64
	MaxLen   *float64
	Pattern  string
	Items    string // an array's item type
	Object   *objSpec
}

// objSpec is an object schema: its property order, the required ones, and whether unknown keys pass.
type objSpec struct {
	Keys        []string
	Required    []string // sorted
	Passthrough bool
	Props       map[string]propSpec
}

func num64(f float64) *float64 { return &f }

// nodeObj folds a zod JSON Schema object (`io: 'input'`). Integer bounds at ±MAX_SAFE_INTEGER are
// zod 4's `.int()` itself, not a bound of the field.
func nodeObj(t *testing.T, v jsvalue.Value) *objSpec {
	t.Helper()
	o := &objSpec{Props: map[string]propSpec{}}
	if p, ok := v.O.Get("properties"); ok {
		for _, k := range p.O.Keys() {
			pv, _ := p.O.Get(k)
			o.Keys = append(o.Keys, k)
			o.Props[k] = nodeProp(t, pv)
		}
	}
	if r, ok := v.O.Get("required"); ok {
		o.Required = strs(t, r)
		sort.Strings(o.Required)
	}
	if a, ok := v.O.Get("additionalProperties"); ok && a.IsPlainObject() && a.O.Len() == 0 {
		o.Passthrough = true
	}
	return o
}

func nodeProp(t *testing.T, v jsvalue.Value) propSpec {
	t.Helper()
	var p propSpec
	if any, ok := v.O.Get("anyOf"); ok {
		// `.nullable()` over a schema with keywords: anyOf [schema, {type: null}].
		for _, alt := range any.A {
			ap := nodeProp(t, alt)
			if reflect.DeepEqual(ap.Types, []string{"null"}) {
				p.Types = append(p.Types, "null")
				continue
			}
			ap.Types = append(ap.Types, p.Types...)
			p = ap
		}
		sort.Strings(p.Types)
		return p
	}
	if ty, ok := v.O.Get("type"); ok {
		if ty.Kind == jsvalue.String {
			p.Types = []string{ty.S}
		} else {
			p.Types = strs(t, ty)
		}
		sort.Strings(p.Types)
	}
	if e, ok := v.O.Get("enum"); ok {
		p.Enum = strs(t, e)
		sort.Strings(p.Enum)
	}
	if c, ok := v.O.Get("const"); ok {
		p.Const = c.S
	}
	bound := func(k string) *float64 {
		b, ok := v.O.Get(k)
		if !ok || math.Abs(b.N) == maxSafeInteger {
			return nil
		}
		return num64(b.N)
	}
	p.Min, p.Max, p.ExclMin, p.MinLen, p.MaxLen = bound("minimum"), bound("maximum"), bound("exclusiveMinimum"), bound("minLength"), bound("maxLength")
	if pat, ok := v.O.Get("pattern"); ok {
		p.Pattern = pat.S
	}
	if it, ok := v.O.Get("items"); ok {
		p.Items = nodeProp(t, it).Types[0]
	}
	if reflect.DeepEqual(p.Types, []string{"object"}) {
		p.Object = nodeObj(t, v)
	}
	return p
}

// goField folds one of this service's fields the same way.
func goField(f field) propSpec {
	var p propSpec
	switch f.kind {
	case kindNumber:
		p.Types = []string{"number"}
	case kindInt:
		p.Types = []string{"integer"}
		if f.positive {
			p.ExclMin = num64(0)
		}
		p.Min, p.Max = f.min, f.max
	case kindString:
		p.Types = []string{"string"}
		if f.maxLen > 0 {
			p.MaxLen = num64(float64(f.maxLen))
		}
		if f.re != nil {
			p.Pattern = f.re.String()
		}
	case kindBool:
		p.Types = []string{"boolean"}
	case kindEnum:
		p.Types = []string{"string"}
		for v := range f.enum {
			p.Enum = append(p.Enum, v)
		}
		sort.Strings(p.Enum)
	case kindStringArray:
		p.Types, p.Items = []string{"array"}, "string"
	}
	if f.nullable {
		p.Types = append(p.Types, "null")
		sort.Strings(p.Types)
	}
	return p
}

func goObj(spec *objSpec2) *objSpec {
	o := &objSpec{Passthrough: spec.passthrough, Props: map[string]propSpec{}}
	for _, f := range spec.fields {
		o.Keys = append(o.Keys, f.name)
		o.Props[f.name] = goField(f)
		if !f.optional {
			o.Required = append(o.Required, f.name)
		}
	}
	sort.Strings(o.Required)
	return o
}

// objSpec2 is this package's objectSpec under a name the test's own objSpec does not shadow.
type objSpec2 = objectSpec

// goArm folds an action arm into the shape zod's JSON Schema has: `type` (a const), the arm's other
// top-level keys, then `details`.
func goArm(name string, arm actionArm) *objSpec {
	o := &objSpec{Props: map[string]propSpec{"type": {Types: []string{"string"}, Const: name}}, Keys: []string{"type"}, Required: []string{"type"}}
	for _, f := range arm.top {
		o.Keys = append(o.Keys, f.name)
		o.Props[f.name] = goField(f)
		if !f.optional {
			o.Required = append(o.Required, f.name)
		}
	}
	if arm.details != nil {
		o.Keys = append(o.Keys, "details")
		o.Props["details"] = propSpec{Types: []string{"object"}, Object: goObj(arm.details)}
		if !arm.detailsOptional {
			o.Required = append(o.Required, "details")
		}
	}
	sort.Strings(o.Required)
	return o
}

// Every action arm here has the shape zod's trackActionSchema has, field by field: the same keys in
// the same order, the same required ones, the same types, enums, bounds and patterns, and the same
// passthrough. A field added, removed or retyped on the Node side fails here, not in production (where
// an added field would be stripped from the row, or a value refused). What JSON Schema cannot show is
// not pinned here: `.trim()` (Feed_TagBar_Click's tag) and Experiment_Exposure's refinement, which
// stays on Node (only its presence is checked).
func TestTrackBatchSchemas(t *testing.T) {
	v := readVectors(t)
	arms := get(t, v, "schemas", "action", "oneOf")
	if len(arms.A) < 25 {
		t.Fatalf("%d action arms recorded", len(arms.A))
	}
	seen := map[string]bool{}
	for _, a := range arms.A {
		node := nodeObj(t, a)
		name := node.Props["type"].Const
		seen[name] = true
		arm, ok := actionArms[name]
		if !ok {
			t.Errorf("Node arm %s is not here", name)
			continue
		}
		if arm.unported {
			continue
		}
		if here := goArm(name, arm); !reflect.DeepEqual(here, node) {
			t.Errorf("arm %s\n here %s\n Node %s", name, dump(here), dump(node))
		}
	}
	for name := range actionArms {
		if !seen[name] {
			t.Errorf("arm %s is not in Node's schema", name)
		}
	}

	// trackSearchSchema: query and index strings, filters an optional passthrough object.
	search := nodeObj(t, get(t, v, "schemas", "search"))
	wantSearch := &objSpec{
		Keys: []string{"query", "index", "filters"}, Required: []string{"index", "query"},
		Props: map[string]propSpec{
			"query": {Types: []string{"string"}}, "index": {Types: []string{"string"}},
			"filters": {Types: []string{"object"}, Object: &objSpec{Passthrough: true, Props: map[string]propSpec{}}},
		},
	}
	if !reflect.DeepEqual(search, wantSearch) {
		t.Errorf("search schema\n here %s\n Node %s", dump(wantSearch), dump(search))
	}

	// trackImpressionSchema against parseImpressionEvent's constants.
	imp := nodeObj(t, get(t, v, "schemas", "impression"))
	sorted := func(s []string) []string { c := append([]string(nil), s...); sort.Strings(c); return c }
	wantImp := &objSpec{
		// `surface` is listed as required in the input schema although `.catch` accepts it absent.
		Keys: []string{"sessionKey", "surface", "entities"}, Required: []string{"entities", "sessionKey", "surface"},
		Props: map[string]propSpec{
			"sessionKey": {Types: []string{"string"}, MinLen: num64(1), MaxLen: num64(trackSessionKeyMax)},
			"surface":    {Types: []string{"string"}, Enum: sorted(impressionSurfaces)},
			"entities":   {Types: []string{"array"}, Items: "object"},
		},
	}
	if !reflect.DeepEqual(imp, wantImp) {
		t.Errorf("impression schema\n here %s\n Node %s", dump(wantImp), dump(imp))
	}
	if d := get(t, v, "schemas", "impression", "properties", "surface", "default"); d.S != impressionSurfaceCatch {
		t.Errorf("surface caught as %q here, Node %q", impressionSurfaceCatch, d.S)
	}
	ents := get(t, v, "schemas", "impression", "properties", "entities")
	if get(t, ents.O, "minItems").N != 1 || get(t, ents.O, "maxItems").N != impressionEntitiesMax {
		t.Errorf("entities bounds %s", jsvalue.Stringify(ents))
	}
	entity := nodeObj(t, get(t, ents.O, "items"))
	wantEntity := &objSpec{
		Keys: []string{"entityType", "entityId"}, Required: []string{"entityId", "entityType"},
		Props: map[string]propSpec{
			"entityType": {Types: []string{"string"}, Enum: sorted(impressionEntityTypes)},
			"entityId":   {Types: []string{"integer"}, ExclMin: num64(0)},
		},
	}
	if !reflect.DeepEqual(entity, wantEntity) {
		t.Errorf("impression entity\n here %s\n Node %s", dump(wantEntity), dump(entity))
	}

	// trackFeedSchema against parseFeedEvent's checks.
	feed := nodeObj(t, get(t, v, "schemas", "feed"))
	idx := propSpec{Types: []string{"integer"}, Min: num64(0), Max: num64(feedEventIndexMax)}
	id := propSpec{Types: []string{"integer"}, ExclMin: num64(0), Max: num64(int32Max)}
	wantFeed := &objSpec{
		Keys:     []string{"event", "sessionKey", "feed", "page", "sort", "pageIndex", "filters", "entityType", "entityId", "position", "seenIds"},
		Required: []string{"event", "feed", "page", "sessionKey"},
		Props: map[string]propSpec{
			"event":      {Types: []string{"string"}, Enum: sorted(feedEventTypes)},
			"sessionKey": {Types: []string{"string"}, MinLen: num64(1), MaxLen: num64(trackSessionKeyMax)},
			"feed":       {Types: []string{"string"}, Enum: sorted(feedEventFeeds)},
			"page":       {Types: []string{"string"}, MaxLen: num64(feedPageMax)},
			"sort":       {Types: []string{"string"}, MaxLen: num64(feedSortMax)},
			"pageIndex":  idx,
			"filters":    {Types: []string{"object"}, Object: &objSpec{Props: map[string]propSpec{}}},
			"entityType": {Types: []string{"string"}, Enum: sorted(impressionEntityTypes)},
			"entityId":   id,
			"position":   idx,
			"seenIds":    {Types: []string{"array"}, Items: "integer"},
		},
	}
	if !reflect.DeepEqual(feed, wantFeed) {
		t.Errorf("feed schema\n here %s\n Node %s", dump(wantFeed), dump(feed))
	}
	filters := get(t, v, "schemas", "feed", "properties", "filters")
	if k := nodeProp(t, get(t, filters.O, "propertyNames")); k.MaxLen == nil || *k.MaxLen != feedFilterKeyMax {
		t.Errorf("filter keys %s", jsvalue.Stringify(filters))
	}
	if a := nodeProp(t, get(t, filters.O, "additionalProperties")); !reflect.DeepEqual(a.Types, []string{"string"}) {
		t.Errorf("filter values %s", jsvalue.Stringify(filters))
	}
	seenIDs := get(t, v, "schemas", "feed", "properties", "seenIds")
	if get(t, seenIDs.O, "maxItems").N != impressionEntitiesMax || !reflect.DeepEqual(nodeProp(t, get(t, seenIDs.O, "items")), id) {
		t.Errorf("seenIds %s", jsvalue.Stringify(seenIDs))
	}
}

func dump(o *objSpec) string {
	var b strings.Builder
	b.WriteString("{keys " + strings.Join(o.Keys, ",") + " required " + strings.Join(o.Required, ","))
	if o.Passthrough {
		b.WriteString(" passthrough")
	}
	keys := make([]string, 0, len(o.Props))
	for k := range o.Props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		p := o.Props[k]
		b.WriteString(" " + k + ":" + strings.Join(p.Types, "|"))
		if p.Const != "" {
			b.WriteString("=" + p.Const)
		}
		if len(p.Enum) > 0 {
			b.WriteString("[" + strings.Join(p.Enum, ",") + "]")
		}
		for name, n := range map[string]*float64{"min": p.Min, "max": p.Max, "exclMin": p.ExclMin, "minLen": p.MinLen, "maxLen": p.MaxLen} {
			if n != nil {
				b.WriteString(" " + name + "=" + jsvalue.FormatNumber(*n))
			}
		}
		if p.Pattern != "" {
			b.WriteString(" /" + p.Pattern + "/")
		}
		if p.Items != "" {
			b.WriteString(" of " + p.Items)
		}
		if p.Object != nil {
			b.WriteString(" " + dump(p.Object))
		}
	}
	return b.String() + "}"
}
