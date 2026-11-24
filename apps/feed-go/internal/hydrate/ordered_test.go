package hydrate

import (
	"bytes"
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// packMap writes a msgpack map with its keys in the given order (msgpackr writes Object.keys order).
func packMap(t *testing.T, kv ...any) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	if err := enc.EncodeMapLen(len(kv) / 2); err != nil {
		t.Fatal(err)
	}
	for i := 0; i+1 < len(kv); i += 2 {
		if err := enc.Encode(kv[i]); err != nil {
			t.Fatal(err)
		}
		switch v := kv[i+1].(type) {
		case []byte: // a pre-encoded value
			buf.Write(v)
		default:
			if err := enc.Encode(v); err != nil {
				t.Fatal(err)
			}
		}
	}
	return buf.Bytes()
}

// undefinedValue is msgpackr's `undefined`: fixext1 type 0.
var undefinedValue = []byte{0xd4, 0x00, 0x00}

func TestUnpackOrderedKeepsJSKeyOrder(t *testing.T) {
	at := time.Date(2026, 6, 15, 11, 55, 0, 0, time.UTC)
	inner := packMap(t, "z", int8(1), "a", "x")
	b := packMap(t,
		"zeta", int64(1),
		"10", "ten",
		"alpha", inner,
		"2", "two",
		"gone", undefinedValue,
		"list", []any{int16(5), nil},
		"at", at,
		"007", true,
	)
	v, err := UnpackOrdered(b)
	if err != nil {
		t.Fatal(err)
	}
	want := superjson.Object{
		{Key: "2", Val: "two"},
		{Key: "10", Val: "ten"},
		{Key: "zeta", Val: int64(1)},
		{Key: "alpha", Val: superjson.Object{{Key: "z", Val: int64(1)}, {Key: "a", Val: "x"}}},
		{Key: "list", Val: []any{int64(5), nil}},
		{Key: "at", Val: at},
		{Key: "007", Val: true},
	}
	if !reflect.DeepEqual(v, want) {
		t.Fatalf("decoded:\n got  %#v\n want %#v", v, want)
	}
	// An undefined array element is nil; a repeated key keeps its first position, its last value.
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	_ = enc.EncodeArrayLen(1)
	buf.Write(undefinedValue)
	if v, err := UnpackOrdered(buf.Bytes()); err != nil || !reflect.DeepEqual(v, []any{nil}) {
		t.Fatalf("undefined element: %#v %v", v, err)
	}
	if v, _ := UnpackOrdered(packMap(t, "a", int64(1), "b", int64(2), "a", int64(3))); !reflect.DeepEqual(v, superjson.Object{{Key: "a", Val: int64(3)}, {Key: "b", Val: int64(2)}}) {
		t.Fatalf("repeated key: %#v", v)
	}
	for _, bad := range [][]byte{{}, {0x92, 0x01}, {0xdf, 0xff, 0xff, 0xff, 0xff}} {
		if _, err := UnpackOrdered(bad); err == nil {
			t.Errorf("% x: want an error", bad)
		}
	}
	// Past the nesting bound.
	deep := []byte{}
	for i := 0; i <= maxOrderedDepth+1; i++ {
		deep = append(deep, 0x91)
	}
	deep = append(deep, 0x01)
	if _, err := UnpackOrdered(deep); err == nil {
		t.Error("over-deep value: want an error")
	}
}

func TestOrderedReadEntries(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	r := testkit.NewRedis()
	r.SetString("k:1", packMap(t, "id", int64(1), "cachedAt", now.Add(-time.Minute)))
	r.SetString("k:2", packMap(t, "id", int64(2), "cachedAt", now.Add(-48*time.Hour)))
	r.SetString("k:3", packMap(t, "id", int64(3), "notFound", true, "cachedAt", now.Add(-48*time.Hour)))
	r.SetString("k:4", packMap(t, "id", int64(4), "debounce", true))
	r.SetString("k:5", []byte{0xc1})
	r.SetString("k:6", []byte{0x01})
	p := &PackedReader{Redis: r, Now: func() time.Time { return now }}
	b := NewBatch()
	read := p.QueueOrdered(b, "k", []int{1, 2, 3, 4, 5, 6, 7}, 24*time.Hour)
	b.Exec(context.Background())
	got := read.Entries()
	if len(got) != 3 {
		t.Fatalf("entries %v, want ids 1-3", got)
	}
	if e := got[1]; e.Stale || e.NotFound || !reflect.DeepEqual(e.Value, superjson.Object{{Key: "id", Val: int64(1)}}) {
		t.Errorf("fresh: %+v", e)
	}
	if !got[2].Stale || got[3].Stale || !got[3].NotFound {
		t.Errorf("stale / notFound: %+v %+v", got[2], got[3])
	}
	// No ids, or no client: nothing queued, every id a miss.
	if e := p.QueueOrdered(NewBatch(), "k", nil, 0).Entries(); len(e) != 0 {
		t.Error("no ids")
	}
	if e := (&PackedReader{}).QueueOrdered(NewBatch(), "k", []int{1}, 0).Entries(); len(e) != 0 {
		t.Error("no client")
	}
	if _, ok := (&PackedReader{}).GetOrdered(context.Background(), "k:1"); ok {
		t.Error("GetOrdered without a client")
	}
	if o, ok := p.GetOrdered(context.Background(), "k:1"); !ok || len(o) != 2 {
		t.Errorf("GetOrdered: %v %v", o, ok)
	}
	if _, ok := p.GetOrdered(context.Background(), "k:5"); ok {
		t.Error("GetOrdered on an undecodable value")
	}
}

func TestSourcesUsers(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyBasicUsers+":1", packMap(t, "id", int64(1), "username", "a", "image", nil, "deletedAt", nil))
	r.SetString(KeyProfilePictures+":1", packMap(t, "id", int64(9), "url", "u", "nsfwLevel", int64(1)))
	s := &Sources{Packed: &PackedReader{Redis: r}, Cache: r, Replica: &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "User" WHERE id`, Rows: func([]any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"id", "username", "deletedAt", "image"}, []any{int64(2), "b", nil, nil}), nil
		}},
		{Match: `JOIN "Image" i`, Rows: func([]any) (*testkit.Rows, error) { return testkit.NewRows([]string{"id"}), nil }},
	}}}
	users, pics, err := s.Users(context.Background(), []int{1, 2, 1})
	if err != nil {
		t.Fatal(err)
	}
	if users[1].Username != "a" || users[2].Username != "b" || pics[1] == nil || pics[2] != nil {
		t.Fatalf("users %+v pictures %+v", users, pics)
	}
	s.Replica = &testkit.DB{}
	if _, _, err := s.Users(context.Background(), []int{3}); err == nil {
		t.Error("a replica failure on the miss path is an error")
	}
}
