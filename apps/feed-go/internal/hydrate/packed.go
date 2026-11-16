// Package hydrate reads the main app's per-id Redis caches and, on a miss, computes the entry as the
// Node lookup would, producing the same values the Node hydration step attaches to each image.
//
// The caches are `createCachedObject` instances (packages/civitai-redis/src/cached-array.ts): one key per
// id, `${key}:${id}`, holding a msgpackr-packed map (module-level `pack`, i.e. `useRecords: false`: plain
// msgpack maps with string keys, Dates as the timestamp extension -1). Two marker shapes are not data:
// `{notFound: true}` ("no row", skip the lookup) and `{debounce: true}` (a bust marker, treat as a miss).
//
// A miss is answered from Postgres with the Node lookup's own query (a metric-hash miss, which Node
// populates from ClickHouse, falls back). This service writes those keys back only with
// FEED_GO_CACHE_WRITEBACK on (default off), and then exactly what the Node lookup writes (misses.go);
// with it off a Go bug can never poison a cache the Node app reads, at the cost that a Go-only miss
// stays a miss. See DESIGN.md §3.1.
package hydrate

import (
	"bytes"
	"context"
	"errors"
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
// Checked first (checkSizes): the decoder allocates from a declared length before reading elements,
// and an out-of-memory error cannot be recovered.
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
	// CachedAt is the entry's `cachedAt` stamp (zero when it has none): when the writer filled it.
	// The Go-first probe reads it to tell an entry Node filled after the request began (raced).
	CachedAt time.Time
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
	e, st := entryState(cmd, ttl, now)
	return e, st == stateEntry
}

// readState is what one GET's answer means for a miss computation.
type readState int

const (
	// stateEntry is an entry (data or a notFound marker).
	stateEntry readState = iota
	// stateAbsent is a miss Node's fetch would look up and write back: no key, or a value that does
	// not decode (Node's packed read evicts it and answers null).
	stateAbsent
	// stateHeld is a miss Node looks up but does NOT write back: a `{debounce: true}` marker (a bust's
	// window), or a read that failed (Node's degraded path writes nothing).
	stateHeld
)

// entryState is decodeEntry with the reason for a miss (readState).
func entryState(cmd *redis.StringCmd, ttl time.Duration, now time.Time) (Entry, readState) {
	b, err := cmd.Bytes()
	if errors.Is(err, redis.Nil) {
		return Entry{}, stateAbsent
	}
	if err != nil {
		return Entry{}, stateHeld
	}
	return decodeBytes(b, ttl, now)
}

// decodeBytes is one cached value as an Entry (see decodeEntry).
func decodeBytes(b []byte, ttl time.Duration, now time.Time) (Entry, readState) {
	if len(b) == 0 {
		return Entry{}, stateAbsent
	}
	v, err := Unpack(b)
	if err != nil {
		return Entry{}, stateAbsent
	}
	m, ok := v.(map[string]any)
	if !ok {
		return Entry{}, stateAbsent
	}
	if truthy(m["debounce"]) {
		return Entry{}, stateHeld
	}
	e := Entry{Value: m}
	if at, ok := m["cachedAt"].(time.Time); ok {
		e.CachedAt = at
	}
	if truthy(m["notFound"]) {
		e.NotFound = true
	} else if ttl > 0 {
		if at, ok := m["cachedAt"].(time.Time); ok && at.Before(now.Add(-ttl)) {
			e.Stale = true
		}
	}
	delete(m, "cachedAt")
	return e, stateEntry
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
