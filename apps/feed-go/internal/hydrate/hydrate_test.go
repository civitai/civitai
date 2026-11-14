package hydrate

import (
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestUnpackMsgpackrShapes(t *testing.T) {
	// fixmap(3): "a" -> 1, "u" -> fixext1 type 0 (msgpackr's `undefined`), "f" -> float64 1.5
	b := []byte{0x83,
		0xa1, 'a', 0x01,
		0xa1, 'u', 0xd4, 0x00, 0x00,
		0xa1, 'f', 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0,
	}
	v, err := Unpack(b)
	if err != nil {
		t.Fatal(err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("want a map, got %T", v)
	}
	if _, has := m["u"]; has {
		t.Fatalf("an undefined member must be dropped, got %v", m)
	}
	if n, ok := Int(m["a"]); !ok || n != 1 {
		t.Fatalf("a = %v (%T)", m["a"], m["a"])
	}
	if m["f"] != 1.5 {
		t.Fatalf("f = %v", m["f"])
	}
}

func TestUnpackTimestampExtension(t *testing.T) {
	at := time.Date(2026, 3, 4, 5, 6, 7, 8_000_000, time.UTC)
	b, err := msgpack.Marshal(map[string]any{"cachedAt": at})
	if err != nil {
		t.Fatal(err)
	}
	v, err := Unpack(b)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := v.(map[string]any)["cachedAt"].(time.Time)
	if !ok || !got.Equal(at) {
		t.Fatalf("cachedAt = %v", v)
	}
}

func TestJoinFrameMirrorsAppendFn(t *testing.T) {
	cosmetics := map[int]superjson.Object{
		7: {{Key: "id", Val: int64(7)}, {Key: "data", Val: superjson.Object{{Key: "url", Val: "x"}}}},
	}
	// userData null: the JS leaves `userData: null` on the record (it only deletes a truthy one).
	frame, ok := JoinFrame(map[string]any{"cosmeticId": int64(7), "equippedToId": int64(99), "userData": nil}, cosmetics)
	if !ok {
		t.Fatal("want joined")
	}
	got, _ := superjson.Serialize(frame)
	if want := `{"json":{"equippedToId":99,"userData":null,"id":7,"data":{"url":"x"}}}`; string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	// userData with lights: merged into a copy of data, userData removed.
	frame, _ = JoinFrame(map[string]any{"cosmeticId": int64(7), "equippedToId": int64(99), "userData": map[string]any{"lights": int64(3)}}, cosmetics)
	got, _ = superjson.Serialize(frame)
	if want := `{"json":{"equippedToId":99,"id":7,"data":{"url":"x","lights":3}}}`; string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	// The shared cosmetic record must not have been mutated by the merge.
	d, _ := cosmetics[7].Get("data")
	if len(d.(superjson.Object)) != 1 {
		t.Fatalf("cosmetic data mutated: %v", d)
	}
	if _, ok := JoinFrame(map[string]any{"cosmeticId": int64(8)}, cosmetics); ok {
		t.Fatal("a frame whose cosmetic is missing must not join")
	}
}

func TestParseMetricHashAndStats(t *testing.T) {
	m, ok := ParseMetricHash(map[string]string{"Like": "3", "Heart": "2", "_populatedAt": "1700000000"})
	if !ok || m["Like"] != 3 || m["Heart"] != 2 || len(m) != 2 {
		t.Fatalf("got %v %v", m, ok)
	}
	if _, ok := ParseMetricHash(map[string]string{"notFound": "1"}); ok {
		t.Fatal("a notFound marker is not metrics")
	}
	// A stamped hash with no metric field and no marker is an EMPTY metrics entry (stats known, all 0).
	if m, ok := ParseMetricHash(map[string]string{"_populatedAt": "1"}); !ok || len(m) != 0 {
		t.Fatalf("got %v %v", m, ok)
	}
	got, _ := superjson.Serialize(Stats(Metrics{"Like": 3, "commentCount": 5, "Collection": 1, "tippedAmount": 9}, true))
	want := `{"json":{"likeCountAllTime":3,"laughCountAllTime":0,"heartCountAllTime":0,"cryCountAllTime":0,` +
		`"commentCountAllTime":5,"collectedCountAllTime":1,"tippedAmountCountAllTime":9,"dislikeCountAllTime":0,` +
		`"viewCountAllTime":0,"statsUnknown":false}}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	got, _ = superjson.Serialize(Stats(nil, false))
	if want := `"statsUnknown":true}}`; string(got[len(got)-len(want):]) != want {
		t.Fatalf("unknown stats = %s", got)
	}
}

// getImageMetricsObject gives every image whose hash exists an entry, so toImageV2Stats reports a
// `notFound` marker as zero counts with statsUnknown FALSE (shapeImageMetrics(id, undefined) on the
// direct read; shapeCachedMetricHash on the image-metrics-swr read). Before this, the marker was left
// out of the result and served statsUnknown true.
func TestMetricsFromHashesNotFoundIsKnownZero(t *testing.T) {
	ids := []int{11, 12, 13}
	got, err := MetricsFromHashes(ids, []map[string]string{
		{"notFound": "1", "_populatedAt": "1700000000"},
		{"Like": "7", "_populatedAt": "1700000000"},
		{"notFound": "1", "Heart": "2"}, // the watcher incremented a marker hash: counts win
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want an entry per id, got %v", got)
	}
	cases := []struct {
		id   int
		want string
	}{
		{11, `{"json":{"likeCountAllTime":0,"laughCountAllTime":0,"heartCountAllTime":0,"cryCountAllTime":0,` +
			`"commentCountAllTime":0,"collectedCountAllTime":0,"tippedAmountCountAllTime":0,"dislikeCountAllTime":0,` +
			`"viewCountAllTime":0,"statsUnknown":false}}`},
		{12, `{"json":{"likeCountAllTime":7,"laughCountAllTime":0,"heartCountAllTime":0,"cryCountAllTime":0,` +
			`"commentCountAllTime":0,"collectedCountAllTime":0,"tippedAmountCountAllTime":0,"dislikeCountAllTime":0,` +
			`"viewCountAllTime":0,"statsUnknown":false}}`},
		{13, `{"json":{"likeCountAllTime":0,"laughCountAllTime":0,"heartCountAllTime":2,"cryCountAllTime":0,` +
			`"commentCountAllTime":0,"collectedCountAllTime":0,"tippedAmountCountAllTime":0,"dislikeCountAllTime":0,` +
			`"viewCountAllTime":0,"statsUnknown":false}}`},
	}
	for _, c := range cases {
		m, ok := got[c.id]
		out, _ := superjson.Serialize(Stats(m, ok))
		if string(out) != c.want {
			t.Errorf("id %d:\ngot  %s\nwant %s", c.id, out, c.want)
		}
	}
}

func TestMetricsFromHashesEmptyHashFallsBack(t *testing.T) {
	_, err := MetricsFromHashes([]int{1, 2}, []map[string]string{{"Like": "1"}, {}})
	if r := fallback.Reason(err); r != "metrics-miss" {
		t.Fatalf("reason = %q (%v), want metrics-miss", r, err)
	}
}

func TestWireSortsKeysAndWidensInts(t *testing.T) {
	got, err := superjson.Serialize(Wire(map[string]any{"b": int32(2), "a": []any{int8(1), "x"}}))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"json":{"a":[1,"x"],"b":2}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestUniqueAndMissing(t *testing.T) {
	ids := Unique([]int{3, 0, 3, 1})
	if len(ids) != 2 || ids[0] != 3 || ids[1] != 1 {
		t.Fatalf("Unique = %v", ids)
	}
	miss := Missing([]int{1, 2, 3}, map[int]Entry{2: {}})
	if len(miss) != 2 || miss[0] != 1 || miss[1] != 3 {
		t.Fatalf("Missing = %v", miss)
	}
}
