// Package hydrate reads the main app's per-id Redis caches READ-ONLY. In this service it reads one:
// the session user (`session:data2:<userId>`), which the Tracker stamps onto every beacon row.
// (Copied from apps/feed-go/internal/hydrate, cut down to the single-key read.)
//
// The caches are `createCachedObject` instances (packages/civitai-redis/src/cached-array.ts): one key per
// id, `${key}:${id}`, holding a msgpackr-packed map (module-level `pack`, i.e. `useRecords: false`: plain
// msgpack maps with string keys, Dates as the timestamp extension -1). Two marker shapes are not data:
// `{notFound: true}` ("no row") and `{debounce: true}` (a bust marker, treat as a miss).
//
// This service NEVER writes these keys.
package hydrate

import (
	"bytes"
	"context"
	"math"
	"strconv"

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
}

// SessionKey is the session-user cache (`session:data2:<userId>`, session-client.ts).
const SessionKey = "session:data2"

// Getter is the one command PackedReader sends (a redis.UniversalClient, cluster or not).
type Getter interface {
	Get(ctx context.Context, key string) *redis.StringCmd
}

// PackedReader reads `${key}:${id}` msgpack entries. Prefix is CACHE_KEY_NAMESPACE + ":" outside
// production and empty in production (packages/civitai-redis/src/cache-key-prefix.ts).
type PackedReader struct {
	Redis  Getter
	Prefix string
}

// Session returns the decoded session-user entry for one user id; ok false is a miss (no key, a
// debounce marker, an undecodable value, or a redis failure).
func (p *PackedReader) Session(ctx context.Context, id int) (Entry, bool) {
	return decodeEntry(p.Redis.Get(ctx, p.Prefix+SessionKey+":"+strconv.Itoa(id)))
}

// decodeEntry is one GET's answer as an Entry; ok false is a miss: the command failed (redis.Nil for
// an absent key, or a transport failure), the value is empty, undecodable or not a map, or it is a
// `{debounce: true}` marker. A `{notFound: true}` marker is an entry with NotFound set; any other value
// is data. `cachedAt` is removed from the value either way.
func decodeEntry(cmd *redis.StringCmd) (Entry, bool) {
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
	e := Entry{Value: m, NotFound: truthy(m["notFound"])}
	delete(m, "cachedAt")
	return e, true
}

func truthy(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// Int reads a msgpack/JSON number as an int.
func Int(v any) (int, bool) {
	switch t := v.(type) {
	case int64:
		return int(t), true
	case uint64:
		if t > math.MaxInt {
			return 0, false
		}
		return int(t), true
	case float64:
		if t == float64(int(t)) {
			return int(t), true
		}
	case int:
		return t, true
	case int32:
		return int(t), true
	case int16:
		return int(t), true
	case int8:
		return int(t), true
	case uint32:
		return int(t), true
	case uint16:
		return int(t), true
	case uint8:
		return int(t), true
	}
	return 0, false
}
