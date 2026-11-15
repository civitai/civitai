package hydrate

import (
	"context"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/beacon-go/internal/testkit"
)

func TestSessionReadsTheCachedUser(t *testing.T) {
	r := testkit.NewRedis()
	p := &PackedReader{Redis: r, Prefix: "ns:"}
	put := func(id string, v any) {
		b, err := msgpack.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		r.SetString("ns:session:data2:"+id, b)
	}
	put("1", map[string]any{"id": 1, "tier": "gold", "cachedAt": time.Unix(0, 0)})
	put("2", map[string]any{"debounce": true})
	put("3", map[string]any{"notFound": true})
	put("4", []any{1, 2})
	r.SetString("ns:session:data2:5", []byte{0xc1}) // never-used msgpack code: undecodable

	e, ok := p.Session(context.Background(), 1)
	if !ok || e.NotFound || e.Value["tier"] != "gold" {
		t.Fatalf("user 1: %+v %v", e, ok)
	}
	if _, has := e.Value["cachedAt"]; has {
		t.Fatal("cachedAt must be removed")
	}
	if n, ok := Int(e.Value["id"]); !ok || n != 1 {
		t.Fatalf("id %v", e.Value["id"])
	}
	if _, ok := p.Session(context.Background(), 2); ok {
		t.Fatal("a debounce marker is a miss")
	}
	if e, ok := p.Session(context.Background(), 3); !ok || !e.NotFound {
		t.Fatalf("notFound marker: %+v %v", e, ok)
	}
	for _, id := range []int{4, 5, 6} {
		if _, ok := p.Session(context.Background(), id); ok {
			t.Fatalf("user %d: want a miss", id)
		}
	}
	r.Err = testkit.ErrDown
	if _, ok := p.Session(context.Background(), 1); ok {
		t.Fatal("a redis failure is a miss")
	}
}

func TestInt(t *testing.T) {
	for _, v := range []any{int64(3), uint64(3), float64(3), 3, int32(3), int16(3), int8(3), uint32(3), uint16(3), uint8(3)} {
		if n, ok := Int(v); !ok || n != 3 {
			t.Errorf("Int(%T) = %d, %v", v, n, ok)
		}
	}
	for _, v := range []any{1.5, "3", nil, uint64(1 << 63)} {
		if _, ok := Int(v); ok {
			t.Errorf("Int(%#v) accepted", v)
		}
	}
}
