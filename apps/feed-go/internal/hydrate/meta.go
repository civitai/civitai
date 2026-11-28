package hydrate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// KeyImageMeta is imageMetaCache (src/server/redis/caches.ts): per image `{id, meta}`, its `meta`
// null when the image hides it. The cache is built with `compress: true`: a value is the sentinel byte
// 0x01 then the brotli stream of its msgpack bytes (packages/civitai-redis/src/packed-compression.ts);
// a notFound marker, and any value written before compression was turned on, is plain msgpack.
const KeyImageMeta = "packed:caches:image-meta"

// MissImageMeta is the image-meta cache's `cache` label of feed_go_cache_miss_total.
const MissImageMeta = "image-meta"

// packedBrotliSentinel is PACKED_BROTLI_SENTINEL: the first byte of a compressed value. A msgpack map
// never starts with it, so a value without it is plain msgpack.
const packedBrotliSentinel = 0x01

// maxInflatedMeta bounds one decompressed value (a meta is a few KB): a stream that inflates past it
// is not read, so a corrupt or hostile value cannot make this service allocate without bound.
const maxInflatedMeta = 8 << 20

// sqlImageMeta is imageMetaCache's lookupFn query, its jsonb as text (Prisma hands the Node code
// JSON.parse of that text), on the replica (dbRead), as Node reads it.
const sqlImageMeta = `SELECT i.id, (CASE WHEN i."hideMeta" = TRUE THEN NULL ELSE i.meta END)::text AS "meta" FROM "Image" i WHERE i.id = ANY($1::int[])`

// inflatePacked is decompressPacked: the msgpack bytes of a cached value, inflated when it carries the
// brotli sentinel.
func inflatePacked(b []byte) ([]byte, error) {
	if len(b) == 0 || b[0] != packedBrotliSentinel {
		return b, nil
	}
	out, err := io.ReadAll(io.LimitReader(brotli.NewReader(bytes.NewReader(b[1:])), maxInflatedMeta+1))
	if err != nil {
		return nil, err
	}
	if len(out) > maxInflatedMeta {
		return nil, errors.New("image meta: inflated value too large")
	}
	return out, nil
}

// metaEntry reads image id's cached image-meta value: its `meta` as a wire value (nil for null, a
// notFound marker or a missing member: Node reads all three as `imageMetas[id]?.meta ?? null`). ok
// false is a miss Node looks up: a value that does not inflate or decode (Node's compress-aware read
// evicts it and answers null), a `{debounce: true}` marker, or a value whose own `id` is not id
// (fetch keys what it read by that member). err is a decoded value this service cannot write as Node
// would.
func metaEntry(b []byte, id int) (meta any, ok bool, err error) {
	raw, inflateErr := inflatePacked(b)
	if inflateErr != nil || len(raw) == 0 {
		return nil, false, nil
	}
	v, decodeErr := jspack.Decode(raw)
	o, isObj := v.(jspack.Obj)
	if decodeErr != nil || !isObj {
		return nil, false, nil
	}
	if own, _ := o.Get("id"); !sameID(own, id) {
		return nil, false, nil
	}
	if d, _ := o.Get("debounce"); d == true {
		return nil, false, nil
	}
	if nf, _ := o.Get("notFound"); nf == true {
		return nil, true, nil
	}
	m, _ := o.Get("meta")
	w, err := metaWire(m)
	if err != nil {
		return nil, false, err
	}
	return w, true, nil
}

// sameID is whether a cached value's own `id` member names image id as a JS property key does.
func sameID(v any, id int) bool {
	switch t := v.(type) {
	case float64:
		return t == float64(id)
	case string:
		return t == strconv.Itoa(id)
	}
	return false
}

// metaWire is one image's `meta ?? null` as a wire value: undefined (or absent) is null.
func metaWire(m any) (any, error) {
	if _, undef := m.(jspack.Undefined); undef {
		return nil, nil
	}
	return JSWire(m)
}

// JSWire is a JS value (jspack's: FromJSON, Decode) as JSON.stringify writes it, for superjson.Plain:
// objects keep their member order (undefined members are left out), undefined array elements and
// non-finite numbers are null, Dates are their ISO string. A Buffer (msgpack bin) is not modelled.
func JSWire(v any) (any, error) {
	switch t := v.(type) {
	case nil, string, bool, time.Time:
		return t, nil
	case jspack.Undefined:
		return superjson.Undefined{}, nil
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil, nil
		}
		return t, nil
	case jspack.Obj:
		out := make(superjson.Object, 0, len(t))
		for _, kv := range t {
			w, err := JSWire(kv.V)
			if err != nil {
				return nil, err
			}
			out = append(out, superjson.Field{Key: kv.K, Val: w})
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			w, err := JSWire(e)
			if err != nil {
				return nil, err
			}
			out[i] = w
		}
		return out, nil
	}
	return nil, fmt.Errorf("a %T value is not modelled", v)
}

// metaRead is one queued imageMetaCache.fetch lookup.
type metaRead struct {
	ids  []int
	cmds []*redis.StringCmd
}

// queueMeta adds the image-meta GETs of (unique) ids to b. Its entries are read raw (metaEntry), not
// through decodeEntry: a compressed value is not msgpack until inflated.
func (s *Sources) queueMeta(b *Batch, ids []int) *metaRead {
	r := &metaRead{ids: ids}
	if len(ids) == 0 || s.Packed.Redis == nil {
		return r
	}
	r.cmds = make([]*redis.StringCmd, len(ids))
	b.add(s.Packed.Redis, func(ctx context.Context, p redis.Pipeliner) {
		for i, id := range ids {
			r.cmds[i] = p.Get(ctx, s.Packed.key(KeyImageMeta, id))
		}
	})
	return r
}

// imageMetasFrom is imageMetaCache.fetch(ids) as the public images endpoint reads it, after the batch's
// Exec: per image its `meta` (nil = null; an id with no row is nil too). A hit is served whatever its
// age: Node serves a stale entry too unless its refresh lock is free, and then reads the same row
// again. A miss (no key, an unreadable value, a debounce marker, a failed read) is looked up with the
// Node lookup's query on the replica, as Node's fetch looks it up (concurrent identical lookups
// shared, none kept in process: MissCompute.memoized); without s.Compute it falls back
// (`image-meta-miss`). Nothing is written back: Node writes these values brotli-compressed, which this
// service does not reproduce byte for byte, so a Go-only miss stays a miss.
func (s *Sources) imageMetasFrom(ctx context.Context, r *metaRead) (map[int]any, error) {
	out := make(map[int]any, len(r.ids))
	var miss []int
	for i, id := range r.ids {
		var b []byte
		var err error
		if r.cmds != nil {
			b, err = r.cmds[i].Bytes()
		}
		if r.cmds == nil || err != nil {
			miss = append(miss, id) // no client, no key (redis.Nil), or a failed read
			continue
		}
		meta, ok, err := metaEntry(b, id)
		if err != nil {
			return nil, fallback.Newf("image-meta-shape", "%d: %v", id, err)
		}
		if !ok {
			miss = append(miss, id)
			continue
		}
		out[id] = meta
	}
	if len(miss) == 0 {
		return out, nil
	}
	if s.Compute == nil {
		return nil, fallback.Safef("image-meta-miss", "%d ids", len(miss))
	}
	if p := presenceOf(ctx); p != nil {
		// As fill: a Go-first probe records the miss and its one lookup and answers "no entry" (a null
		// meta), with no query.
		p.recordComputed(MissImageMeta, len(miss))
		for _, id := range miss {
			out[id] = nil
		}
		return out, nil
	}
	c := s.Compute
	records, err := c.lookupShared(ctx, MissImageMeta, miss, s.lookupImageMeta)
	if err != nil {
		c.observe(MissImageMeta, "error", len(miss))
		return nil, fallback.Wrap("image-meta-miss-failed", err)
	}
	c.observe(MissImageMeta, "computed", len(miss))
	for _, id := range miss {
		rec, found := records[id]
		if !found {
			out[id] = nil
			continue
		}
		m, _ := rec.Get("meta")
		w, err := metaWire(m)
		if err != nil {
			return nil, fallback.Newf("image-meta-shape", "%d: %v", id, err)
		}
		out[id] = w
	}
	return out, nil
}

// lookupImageMeta is imageMetaCache's lookupFn: per image found, `{id, meta}` (meta null when hidden);
// an id with no row is absent.
func (s *Sources) lookupImageMeta(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlImageMeta, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := make(map[int]jspack.Obj, len(maps))
	for _, m := range maps {
		id, ok := Int(m["id"])
		if !ok {
			return nil, fmt.Errorf("image meta: id %v", m["id"])
		}
		meta, err := jsonColumn(m["meta"])
		if err != nil {
			return nil, err
		}
		out[id] = jspack.O("id", id, "meta", meta)
	}
	return out, nil
}
