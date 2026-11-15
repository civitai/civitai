// Package hydrate reads the main app's per-id Redis caches READ-ONLY and falls through to Postgres on a
// miss, producing the same values the Node hydration step attaches to each image.
//
// The caches are `createCachedObject` instances (packages/civitai-redis/src/cached-array.ts): one key per
// id, `${key}:${id}`, holding a msgpackr-packed map (module-level `pack`, i.e. `useRecords: false`: plain
// msgpack maps with string keys, Dates as the timestamp extension -1). Two marker shapes are not data:
// `{notFound: true}` ("no row", skip the lookup) and `{debounce: true}` (a bust marker, treat as a miss).
//
// This service NEVER writes these keys. A miss is answered from Postgres and not written back, so a Go
// bug can never poison a cache the Node app reads. The cost is that Go-only misses stay misses; see
// DESIGN.md "Caches".
package hydrate

import (
	"bytes"
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// jsUndefined absorbs msgpackr's encoding of `undefined` (fixext1, type 0).
type jsUndefined struct{}

func (*jsUndefined) UnmarshalMsgpack([]byte) error  { return nil }
func (jsUndefined) MarshalMsgpack() ([]byte, error) { return nil, nil }

func init() {
	msgpack.RegisterExt(0, (*jsUndefined)(nil))
}

// Unpack decodes one msgpackr value into Go maps/slices. Maps decode to map[string]any.
//
// The bytes are checked by checkSizes first: the decoder sizes an array or map from its declared
// length before reading any element, so 5 bytes declaring a 2^32-element array made it allocate
// 64 GiB and the process died of an unrecoverable out-of-memory error (found by FuzzUnpack).
func Unpack(b []byte) (any, error) {
	if err := checkSizes(b); err != nil {
		return nil, err
	}
	dec := msgpack.NewDecoder(bytes.NewReader(b))
	dec.UseLooseInterfaceDecoding(true)
	v, err := dec.DecodeInterface()
	if err != nil {
		return nil, err
	}
	return normalize(v), nil
}

// normalize turns map[any]any (non-string keys) into map[string]any and drops jsUndefined values.
func normalize(v any) any {
	switch t := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if isUndef(val) {
				continue
			}
			out[toKey(k)] = normalize(val)
		}
		return out
	case map[string]any:
		for k, val := range t {
			if isUndef(val) {
				delete(t, k)
				continue
			}
			t[k] = normalize(val)
		}
		return t
	case []any:
		for i := range t {
			if isUndef(t[i]) {
				t[i] = nil
				continue
			}
			t[i] = normalize(t[i])
		}
		return t
	case *jsUndefined, jsUndefined:
		return nil
	}
	return v
}

func isUndef(v any) bool {
	switch v.(type) {
	case *jsUndefined, jsUndefined:
		return true
	}
	return false
}

func toKey(k any) string {
	switch t := k.(type) {
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case uint64:
		return strconv.FormatUint(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}

// Entry is one decoded cache value.
type Entry struct {
	Value    map[string]any
	NotFound bool
	Stale    bool
}

// PackedReader reads `${key}:${id}` msgpack entries. Prefix is CACHE_KEY_NAMESPACE + ":" outside
// production and empty in production (packages/civitai-redis/src/cache-key-prefix.ts).
type PackedReader struct {
	Redis  redis.UniversalClient
	Prefix string
	Now    func() time.Time
}

// Get returns decoded entries by id. Ids absent from the result are misses (no key, a debounce marker,
// an undecodable value, or a redis failure — redis errors fail open to the database like the Node path).
// ttl > 0 marks entries whose `cachedAt` is older than ttl as Stale; they are still returned (served
// stale, as the Node path does when another process holds the refresh lock).
//
// Get is one pipeline of its own; a page's hydration queues all of its lookups on one Batch instead
// (Queue), with the same per-entry semantics (decodeEntry).
func (p *PackedReader) Get(ctx context.Context, key string, ids []int, ttl time.Duration) map[int]Entry {
	b := NewBatch()
	r := p.Queue(b, key, ids, ttl)
	b.Exec(ctx)
	return r.Entries()
}

// key is the Redis key of one id's entry.
func (p *PackedReader) key(key string, id int) string {
	return p.Prefix + key + ":" + strconv.Itoa(id)
}

// decodeEntry is one GET's answer as an Entry; ok false is a miss: the command failed (redis.Nil for
// an absent key, or a transport failure), the value is empty, undecodable or not a map, or it is a
// `{debounce: true}` marker. A `{notFound: true}` marker is an entry with NotFound set; any other value
// is data, Stale when ttl > 0 and its `cachedAt` is older than ttl before now. `cachedAt` is removed
// from the value either way.
func decodeEntry(cmd *redis.StringCmd, ttl time.Duration, now time.Time) (Entry, bool) {
	b, err := cmd.Bytes()
	if err != nil || len(b) == 0 {
		return Entry{}, false
	}
	v, err := Unpack(b)
	if err != nil {
		return Entry{}, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		return Entry{}, false
	}
	if truthy(m["debounce"]) {
		return Entry{}, false
	}
	e := Entry{Value: m}
	if truthy(m["notFound"]) {
		e.NotFound = true
	} else if ttl > 0 {
		if at, ok := m["cachedAt"].(time.Time); ok && at.Before(now.Add(-ttl)) {
			e.Stale = true
		}
	}
	delete(m, "cachedAt")
	return e, true
}

func truthy(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// Missing returns the ids that Get did not answer.
func Missing(ids []int, got map[int]Entry) []int {
	var miss []int
	for _, id := range ids {
		if _, ok := got[id]; !ok {
			miss = append(miss, id)
		}
	}
	return miss
}
