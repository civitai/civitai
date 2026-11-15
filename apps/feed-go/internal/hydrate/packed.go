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
func Unpack(b []byte) (any, error) {
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
func (p *PackedReader) Get(ctx context.Context, key string, ids []int, ttl time.Duration) map[int]Entry {
	out := make(map[int]Entry, len(ids))
	if len(ids) == 0 || p.Redis == nil {
		return out
	}
	cmds := make([]*redis.StringCmd, len(ids))
	_, err := p.Redis.Pipelined(ctx, func(pl redis.Pipeliner) error {
		for i, id := range ids {
			cmds[i] = pl.Get(ctx, p.Prefix+key+":"+strconv.Itoa(id))
		}
		return nil
	})
	// A pipeline error (redis.Nil for any absent key, or a transport failure) is not inspected here:
	// each command's own error is, below, and an errored command is a miss.
	_ = err
	now := time.Now()
	if p.Now != nil {
		now = p.Now()
	}
	for i, cmd := range cmds {
		b, err := cmd.Bytes()
		if err != nil || len(b) == 0 {
			continue
		}
		v, err := Unpack(b)
		if err != nil {
			continue
		}
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		if truthy(m["debounce"]) {
			continue
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
		out[ids[i]] = e
	}
	return out
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
