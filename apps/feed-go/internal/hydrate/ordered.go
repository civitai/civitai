package hydrate

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
	"github.com/vmihailenco/msgpack/v5/msgpcode"

	"github.com/civitai/civitai/apps/feed-go/internal/jskeys"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// maxOrderedDepth bounds the nesting UnpackOrdered follows. Cache records nest a handful of levels; a
// deeper value is not one this service reads.
const maxOrderedDepth = 64

var errTooDeep = errors.New("hydrate: msgpack value nested too deeply")

// UnpackOrdered decodes one msgpackr value as Unpack does, except that a map becomes a
// superjson.Object holding its keys in the order the JS object has them: the encoded order (msgpackr
// writes Object.keys order), with array-index keys moved first in ascending order, as a JS engine
// orders an object's own keys. `undefined` members are dropped and `undefined` array elements become
// nil, as in Unpack. Integers are int64 / uint64, so the value is ready for superjson.Plain.
//
// The REST answers this service builds spread cache records into their bodies (`{...version}`), so
// their key order is the record's own; Unpack's map loses it.
func UnpackOrdered(b []byte) (any, error) {
	if err := checkSizes(b); err != nil {
		return nil, err
	}
	dec := msgpack.NewDecoder(bytes.NewReader(b))
	dec.UseLooseInterfaceDecoding(true)
	return decodeOrdered(dec, 0)
}

func decodeOrdered(dec *msgpack.Decoder, depth int) (any, error) {
	if depth > maxOrderedDepth {
		return nil, errTooDeep
	}
	c, err := dec.PeekCode()
	if err != nil {
		return nil, err
	}
	switch {
	case msgpcode.IsFixedMap(c) || c == msgpcode.Map16 || c == msgpcode.Map32:
		n, err := dec.DecodeMapLen()
		if err != nil {
			return nil, err
		}
		obj := make(superjson.Object, 0, max(n, 0))
		for i := 0; i < n; i++ {
			key, err := decodeOrderedKey(dec)
			if err != nil {
				return nil, err
			}
			v, err := decodeOrdered(dec, depth+1)
			if err != nil {
				return nil, err
			}
			if isUndef(v) {
				// A repeated key's undefined still deletes it, as the JS assignment would leave it
				// undefined; JSON.stringify then omits it either way.
				obj = dropKey(obj, key)
				continue
			}
			obj.Set(key, v)
		}
		return jsKeyOrder(obj), nil
	case msgpcode.IsFixedArray(c) || c == msgpcode.Array16 || c == msgpcode.Array32:
		n, err := dec.DecodeArrayLen()
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := range arr {
			v, err := decodeOrdered(dec, depth+1)
			if err != nil {
				return nil, err
			}
			if isUndef(v) {
				v = nil
			}
			arr[i] = v
		}
		return arr, nil
	}
	v, err := dec.DecodeInterfaceLoose()
	if err != nil {
		return nil, err
	}
	switch t := v.(type) {
	case int8, int16, int32, int, uint8, uint16, uint32, uint:
		return Wire(t), nil
	case time.Time:
		return t.UTC(), nil
	}
	return v, nil
}

// decodeOrderedKey is one map key as its JS property name (toKey). A string key, the only kind
// msgpackr writes for an object, is read as a string, without the interface value a loose decode
// allocates for it.
func decodeOrderedKey(dec *msgpack.Decoder) (string, error) {
	c, err := dec.PeekCode()
	if err != nil {
		return "", err
	}
	if msgpcode.IsString(c) {
		return dec.DecodeString()
	}
	k, err := dec.DecodeInterfaceLoose()
	if err != nil {
		return "", err
	}
	return toKey(k), nil
}

func dropKey(o superjson.Object, key string) superjson.Object {
	for i, f := range o {
		if f.Key == key {
			return append(o[:i], o[i+1:]...)
		}
	}
	return o
}

// jsKeyOrder is o in the order a JS engine gives an object's keys (jskeys.Order).
func jsKeyOrder(o superjson.Object) superjson.Object {
	return jskeys.Order(o, func(f superjson.Field) string { return f.Key })
}

// OrderedEntry is one decoded cache value with its key order (UnpackOrdered).
type OrderedEntry struct {
	Value    superjson.Object
	NotFound bool
	Stale    bool
}

// OrderedRead is one queued lookup whose entries keep their key order.
type OrderedRead struct {
	p    *PackedReader
	ids  []int
	ttl  time.Duration
	cmds []*redis.StringCmd
}

// QueueOrdered adds the `${key}:${id}` GETs of ids to b, as Queue does, for entries read with
// OrderedRead.Entries.
func (p *PackedReader) QueueOrdered(b *Batch, key string, ids []int, ttl time.Duration) *OrderedRead {
	r := &OrderedRead{p: p, ids: ids, ttl: ttl}
	if len(ids) == 0 || p.Redis == nil {
		return r
	}
	r.cmds = make([]*redis.StringCmd, len(ids))
	b.add(p.Redis, func(ctx context.Context, pl redis.Pipeliner) {
		for i, id := range ids {
			r.cmds[i] = pl.Get(ctx, p.key(key, id))
		}
	})
	return r
}

// Entries decodes the lookup's answer by id after the batch's Exec, with decodeEntry's semantics: an
// id absent from the result is a miss (no key, a debounce marker, an undecodable value or a redis
// failure), `{notFound: true}` is NotFound, and `cachedAt` (removed from the value) older than ttl
// marks the entry Stale.
func (r *OrderedRead) Entries() map[int]OrderedEntry {
	out := make(map[int]OrderedEntry, len(r.ids))
	if len(r.cmds) == 0 {
		return out
	}
	now := time.Now()
	if r.p.Now != nil {
		now = r.p.Now()
	}
	for i, cmd := range r.cmds {
		if e, ok := decodeOrderedEntry(cmd, r.ttl, now); ok {
			out[r.ids[i]] = e
		}
	}
	return out
}

// GetOrdered is one key's raw value decoded with UnpackOrdered (a non-map value is a miss); ok false
// for a miss or a read failure. Used for keys that are not per-id cache records.
func (p *PackedReader) GetOrdered(ctx context.Context, key string) (superjson.Object, bool) {
	if p.Redis == nil {
		return nil, false
	}
	b, err := p.Redis.Get(ctx, p.Prefix+key).Bytes()
	if err != nil || len(b) == 0 {
		return nil, false
	}
	v, err := UnpackOrdered(b)
	if err != nil {
		return nil, false
	}
	obj, ok := v.(superjson.Object)
	return obj, ok
}

func decodeOrderedEntry(cmd *redis.StringCmd, ttl time.Duration, now time.Time) (OrderedEntry, bool) {
	b, err := cmd.Bytes()
	if err != nil || len(b) == 0 {
		return OrderedEntry{}, false
	}
	v, err := UnpackOrdered(b)
	if err != nil {
		return OrderedEntry{}, false
	}
	obj, ok := v.(superjson.Object)
	if !ok {
		return OrderedEntry{}, false
	}
	if d, _ := obj.Get("debounce"); d == true {
		return OrderedEntry{}, false
	}
	e := OrderedEntry{}
	if nf, _ := obj.Get("notFound"); nf == true {
		e.NotFound = true
	} else if ttl > 0 {
		if at, ok := obj.Get("cachedAt"); ok {
			if t, ok := at.(time.Time); ok && t.Before(now.Add(-ttl)) {
				e.Stale = true
			}
		}
	}
	e.Value = dropKey(obj, "cachedAt")
	return e, true
}

// Users is getModelsRaw's creator reads for (unique) user ids, from one pipeline: userBasicCache and
// getProfilePicturesForUsers, each served from its cache with the replica on a miss (the same reads
// the gallery hydration makes).
func (s *Sources) Users(ctx context.Context, ids []int) (map[int]BasicUser, map[int]superjson.Object, error) {
	ids = Unique(ids)
	b := NewBatch()
	basic := s.Packed.Queue(b, KeyBasicUsers, ids, ttlDay)
	pics := s.Packed.Queue(b, KeyProfilePictures, ids, 0)
	b.Exec(ctx)
	users, err := s.basicUsersFrom(ctx, ids, basic.Entries())
	if err != nil {
		return nil, nil, err
	}
	pictures, err := s.profilePicturesFrom(ctx, ids, pics.Entries())
	if err != nil {
		return nil, nil, err
	}
	return users, pictures, nil
}
