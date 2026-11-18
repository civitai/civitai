package superjson

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// A Buffer's bytes are its owner's until Release; after Release Bytes is nil (a second Release is a
// no-op), and a later serialization reusing the pooled memory leaves a copy taken before untouched.
func TestSerializeBufferOwnership(t *testing.T) {
	b, err := SerializeBuffer(Object{{"a", "first"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(b.Bytes()); got != `{"json":{"a":"first"}}` {
		t.Fatalf("Bytes = %s", got)
	}
	kept := string(b.Bytes())
	b.Release()
	b.Release()
	if b.Bytes() != nil {
		t.Fatalf("Bytes after Release = %q, want nil", b.Bytes())
	}
	c, err := SerializeBuffer(Object{{"a", "second"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Release()
	if got := string(c.Bytes()); got != `{"json":{"a":"second"}}` {
		t.Fatalf("second Bytes = %s", got)
	}
	if kept != `{"json":{"a":"first"}}` {
		t.Fatalf("a copy taken before Release changed: %s", kept)
	}
	var nilBuf *Buffer
	nilBuf.Release()
	if nilBuf.Bytes() != nil {
		t.Fatal("a nil Buffer has bytes")
	}
}

// Serialize and Plain return copies the caller owns: a later serialization never writes over them.
func TestSerializeAndPlainReturnOwnedCopies(t *testing.T) {
	first, err := Serialize(Object{{"n", 1}})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := Plain(Object{{"p", "x"}})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 20 {
		if _, err := Serialize(Object{{"n", 1000 + i}, {"pad", strings.Repeat("z", 64)}}); err != nil {
			t.Fatal(err)
		}
	}
	if string(first) != `{"json":{"n":1}}` || string(plain) != `{"p":"x"}` {
		t.Fatalf("copies changed: %s, %s", first, plain)
	}
}

// A failed serialization returns no Buffer and puts its writer back clean: the next output carries
// nothing of the failed one.
func TestSerializeBufferErrorReleasesTheWriter(t *testing.T) {
	if b, err := SerializeBuffer(Object{{"bad", struct{}{}}}); err == nil || b != nil {
		t.Fatalf("SerializeBuffer = %v, %v; want nil and an error", b, err)
	}
	if b, err := PlainBuffer(Undefined{}); err == nil || b != nil {
		t.Fatalf("PlainBuffer(undefined) = %v, %v; want nil and an error", b, err)
	}
	b, err := SerializeBuffer(Object{{"ok", true}})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Release()
	if got := string(b.Bytes()); got != `{"json":{"ok":true}}` {
		t.Fatalf("after a failure: %s", got)
	}
}

// The page pool hands out buffers of at least pageBufSize and the owned pool of at least
// ownedBufSize, each writer going back to the pool it came from; neither takes back a buffer above
// maxPooledBufSize, and a writer taken back is reset (no output, path or annotations).
func TestWriterPoolSizes(t *testing.T) {
	for _, c := range []struct {
		pool *sync.Pool
		min  int
	}{{pagePool, pageBufSize}, {ownedPool, ownedBufSize}} {
		w := getWriter(c.pool, false)
		if cap(w.buf) < c.min || w.pool != c.pool {
			t.Fatalf("pooled buffer cap %d (want >= %d), from its own pool %v", cap(w.buf), c.min, w.pool == c.pool)
		}
		putWriter(w)
	}

	local := &sync.Pool{}
	if putWriter(&writer{buf: make([]byte, 0, maxPooledBufSize+1), pool: local}) {
		t.Fatal("a buffer above maxPooledBufSize went back to the pool")
	}
	if putWriter(&writer{buf: make([]byte, 0, 16)}) {
		t.Fatal("a writer with no pool was pooled")
	}
	kept := &writer{
		buf:   append(make([]byte, 0, maxPooledBufSize), "used"...),
		path:  []segment{{key: "a", index: -1}},
		notes: []annotation{{path: "a", typ: "Date"}},
		plain: true,
		pool:  local,
	}
	notes := kept.notes
	if !putWriter(kept) {
		t.Fatal("a buffer of exactly maxPooledBufSize was not pooled")
	}
	if len(kept.buf) != 0 || len(kept.path) != 0 || len(kept.notes) != 0 || kept.plain {
		t.Fatalf("pooled writer not reset: buf %d path %d notes %d plain %v", len(kept.buf), len(kept.path), len(kept.notes), kept.plain)
	}
	if notes[0] != (annotation{}) {
		t.Fatalf("a pooled writer keeps an annotation alive: %+v", notes[0])
	}
}

// Concurrent owners never see each other's bytes (run under -race in CI): each checks its own output
// right before releasing it, while the others reuse the pool.
func TestSerializeBufferConcurrentOwners(t *testing.T) {
	var wg sync.WaitGroup
	errs := make(chan string, 64)
	for g := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 50 {
				n := g*1000 + i
				pad := strings.Repeat("x", (n*37)%2000)
				b, err := SerializeBuffer(Object{{"n", n}, {"pad", pad}})
				if err != nil {
					errs <- err.Error()
					return
				}
				want := `{"json":{"n":` + strconv.Itoa(n) + `,"pad":"` + pad + `"}}`
				if got := string(b.Bytes()); got != want {
					errs <- "owner " + strconv.Itoa(n) + " read " + got
					b.Release()
					return
				}
				b.Release()
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}

// BenchmarkSerializeBuffer is BenchmarkSerialize without the owned copy: the served path's cost.
func BenchmarkSerializeBuffer(b *testing.B) {
	page := feedPage()
	b.ReportAllocs()
	for b.Loop() {
		buf, err := SerializeBuffer(page)
		if err != nil {
			b.Fatal(err)
		}
		buf.Release()
	}
}

// smallBody is an error envelope's body, the smallest output this service writes.
func smallBody() Object {
	return Object{{"message", "unavailable"}, {"code", -32603}, {"data", Object{{"code", "INTERNAL_SERVER_ERROR"}, {"httpStatus", 503}, {"path", "image.getImagesAsPostsInfinite"}}}}
}

// bigPage is feedPage with a ~7.5 KB jsonb member per item: an output of a few hundred KiB, the size
// of a real feed page.
func bigPage() Object {
	page := feedPage()
	items, _ := page[0].Val.([]any)
	meta := json.RawMessage(`{"prompt":"` + strings.Repeat("a long prompt ", 540) + `"}`)
	for i, it := range items {
		obj, _ := it.(Object)
		obj = append(obj, Field{"meta", meta})
		items[i] = obj
	}
	return page
}

// BenchmarkSerializeColdStart is a serialization on a writer fresh from each pool's New (the pools are
// emptied by every GC cycle): the page pool's on a page-sized output, the owned pool's on the smallest
// one. Its B/op is what a cold get costs, growth included.
func BenchmarkSerializeColdStart(b *testing.B) {
	for _, c := range []struct {
		name string
		size int
		v    any
	}{{"page", pageBufSize, bigPage()}, {"owned-small", ownedBufSize, smallBody()}} {
		b.Run(c.name, func(b *testing.B) {
			w := newWriter(c.size, nil)
			if err := w.envelope(c.v); err != nil {
				b.Fatal(err)
			}
			out := len(w.buf)
			b.ReportAllocs()
			for b.Loop() {
				w := newWriter(c.size, nil)
				if err := w.envelope(c.v); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(out), "out-bytes")
		})
	}
}
