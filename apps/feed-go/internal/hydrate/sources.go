package hydrate

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Querier is the database surface the miss paths use (a *pgxpool.Pool satisfies it).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Sources are the stores hydration reads.
type Sources struct {
	// Packed reads the cache cluster's msgpack per-id keys.
	Packed *PackedReader
	// Cache is the cache cluster client itself, for the metrics hashes.
	Cache redis.UniversalClient
	// Replica is the read replica the Node path reads for these lookups.
	Replica Querier
}

// Cache keys (REDIS_KEYS.CACHES in packages/civitai-redis/src/client.ts), without the per-id suffix.
const (
	KeyBasicUsers      = "packed:caches:basic-users"
	KeyUserCosmetics   = "packed:caches:user-cosmetics"
	KeyCosmetics       = "packed:caches:cosmetics2"
	KeyProfilePictures = "packed:caches:profile-pictures:v2"
	KeyImageFrames     = "packed:caches:cosmetics2:Image"
	KeyImageEvents     = "packed:caches:cosmetics2:event:v2:Image"
	KeyThumbnails      = "packed:caches:thumbnails"
	KeyTagIDs          = "packed:caches:tag-ids-for-images"
)

// TTLs (CacheTTL in src/server/common/constants.ts) for the caches that serve stale entries.
const (
	ttlDay = 24 * time.Hour
)

// Wire converts a decoded msgpack value into a value superjson.Serialize accepts. Map keys are
// emitted in sorted order: the client decodes values, not key order (see DESIGN.md "Wire format").
func Wire(v any) any {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		obj := make(superjson.Object, 0, len(keys))
		for _, k := range keys {
			obj = append(obj, superjson.Field{Key: k, Val: Wire(t[k])})
		}
		return obj
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = Wire(e)
		}
		return out
	case int8:
		return int64(t)
	case int16:
		return int64(t)
	case int32:
		return int64(t)
	case uint8:
		return int64(t)
	case uint16:
		return int64(t)
	case int:
		return int64(t)
	case uint:
		return uint64(t)
	}
	return v
}

// Pick builds an ordered object from m with the given keys, in order; a key absent from m is skipped
// (an absent key and an `undefined` one decode the same).
func Pick(m map[string]any, keys ...string) superjson.Object {
	obj := make(superjson.Object, 0, len(keys))
	for _, k := range keys {
		if v, ok := m[k]; ok {
			obj = append(obj, superjson.Field{Key: k, Val: Wire(v)})
		}
	}
	return obj
}

// Int reads a msgpack/JSON number as an int.
func Int(v any) (int, bool) {
	switch t := v.(type) {
	case int64:
		return int(t), true
	case uint64:
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
	case json.Number:
		n, err := t.Int64()
		return int(n), err == nil
	case string:
		n, err := strconv.Atoi(t)
		return n, err == nil
	}
	return 0, false
}

// rowsToMaps collects every row as a column-name map (jsonb arrives as decoded Go values).
func rowsToMaps(rows pgx.Rows) ([]map[string]any, error) {
	defer rows.Close()
	var out []map[string]any
	fields := rows.FieldDescriptions()
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		m := make(map[string]any, len(vals))
		for i, f := range fields {
			m[f.Name] = vals[i]
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
