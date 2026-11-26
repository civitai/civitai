package hydrate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/clock"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// KeyOfficialModels is REDIS_KEYS.CACHES.OFFICIAL_MODELS: getOfficialModelIds' one fetchThroughCache
// entry, `{data: [{id, type}], cachedAt: <epoch ms>}` (no per-id suffix).
const KeyOfficialModels = "packed:caches:official-models"

// Mirror getOfficialModelIds' fetchThroughCache: ttl 5m, EX twice the ttl, default 10 s lock.
const (
	officialModelsTTL     = 5 * time.Minute
	officialModelsEX      = 2 * officialModelsTTL
	officialModelsLockTTL = 10 * time.Second
)

// sqlOfficialModels is getOfficialModelIds' fetchFn: `dbRead.model.findMany({ where: { isOfficial:
// true, status: Published }, select: { id, type } })`, no order (Prisma sends none either).
const sqlOfficialModels = `SELECT id, type::text AS type FROM "Model" WHERE "isOfficial" = true AND status = 'Published'::"ModelStatus"`

// officialModelsSpec names the computation for MissReason (fill never runs it: OfficialModels is not a
// per-id cache).
var officialModelsSpec = lookupSpec{cache: MissOfficialModels, reason: "official-models-miss", key: KeyOfficialModels}

// OfficialModel is one getOfficialModelIds record.
type OfficialModel struct {
	ID   int
	Type string
}

// OfficialModels mirrors getOfficialModelIds (src/server/services/resource-select.service.ts):
// fetchThroughCache(OFFICIAL_MODELS, ttl 300, retryCount 0), whose catch answers []. With the cache not
// written back (MissOfficialModels not in WriteBack) or under a probe nothing is written and no lock is taken. A failed replica read is
// official-models-miss-failed, not [], because Node would answer a different page.
func (s *Sources) OfficialModels(ctx context.Context) ([]OfficialModel, error) {
	if s.Packed == nil || s.Packed.Redis == nil {
		return s.officialFetch(ctx)
	}
	key := s.Packed.Prefix + KeyOfficialModels
	raw, err := s.Packed.Redis.Get(ctx, key).Bytes()
	if err != nil && !errors.Is(err, redis.Nil) {
		return s.officialFetch(ctx)
	}
	var cached []OfficialModel
	var cachedAt float64
	hasEntry := false
	if err == nil {
		cached, cachedAt, hasEntry = parseOfficialEntry(raw)
	}
	now := clock.Now()
	if s.Packed.Now != nil {
		now = s.Packed.Now()
	}
	// `Date.now() - ttl * 1000 > cachedAt` is expired.
	if hasEntry && !(float64(now.UnixMilli())-float64(officialModelsTTL/time.Millisecond) > cachedAt) {
		return cached, nil
	}
	lockKey := s.Packed.Prefix + "cache-lock:" + key
	if s.Compute.writes(MissOfficialModels) && presenceOf(ctx) == nil {
		var lock *redis.BoolCmd
		_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
			lock = p.SetNX(ctx, lockKey, "1", officialModelsLockTTL)
			return nil
		})
		got, err := lock.Result()
		switch {
		case err != nil && hasEntry:
			return cached, nil
		case err != nil:
			return s.officialFetch(ctx)
		case !got && hasEntry:
			return cached, nil
		case !got:
			return []OfficialModel{}, nil
		}
		defer s.releaseLocks(ctx, []string{lockKey}) // detached from the request by releaseLocks itself
		list, err := s.officialFetch(ctx)
		if err != nil {
			return nil, err
		}
		data := make([]any, len(list))
		for i, m := range list {
			data[i] = jspack.O("id", m.ID, "type", m.Type)
		}
		val := jspack.Pack(jspack.O("data", data, "cachedAt", float64(s.Compute.now().UnixMilli())))
		s.writePacked(ctx, []packedWrite{{cache: MissOfficialModels, key: key, val: val, ttl: officialModelsEX, overwrite: true}})
		return list, nil
	}
	var exists *redis.IntCmd
	_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		exists = p.Exists(ctx, lockKey)
		return nil
	})
	held, err := exists.Result()
	switch {
	case err != nil && hasEntry:
		return cached, nil
	case err != nil:
		return s.officialFetch(ctx)
	case held > 0 && hasEntry:
		return cached, nil
	case held > 0:
		return []OfficialModel{}, nil
	}
	return s.officialFetch(ctx)
}

// officialFetch is getOfficialModelIds' fetchFn on the replica (dbRead), through the miss computation
// (one flight per process, the answer kept a few seconds when not written back). Without s.Compute it
// falls back.
func (s *Sources) officialFetch(ctx context.Context) ([]OfficialModel, error) {
	if s.Compute == nil {
		return nil, fallback.New("official-models-miss")
	}
	c := s.Compute
	p := presenceOf(ctx)
	var records map[int]jspack.Obj
	var err error
	if p != nil {
		p.recordComputed(MissOfficialModels, 1)
		records, err = s.lookupOfficialModels(ctx, nil)
	} else {
		records, err = c.lookupShared(ctx, MissOfficialModels, []int{0}, s.lookupOfficialModels)
	}
	if err != nil {
		if p == nil {
			c.observe(MissOfficialModels, "error", 1)
		}
		return nil, fallback.Wrap("official-models-miss-failed", err)
	}
	if p == nil {
		c.observe(MissOfficialModels, "computed", 1)
	}
	rec := records[0]
	v, _ := rec.Get("models")
	list, _ := v.([]OfficialModel)
	return list, nil
}

// lookupOfficialModels runs sqlOfficialModels; its answer is held under id 0 (lookupShared's shape).
func (s *Sources) lookupOfficialModels(ctx context.Context, _ []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlOfficialModels)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	list := make([]OfficialModel, 0, len(maps))
	for _, m := range maps {
		id, ok := Int(m["id"])
		typ, ok2 := m["type"].(string)
		if !ok || !ok2 {
			return nil, fmt.Errorf("official models: row %v", m)
		}
		list = append(list, OfficialModel{ID: id, Type: typ})
	}
	return map[int]jspack.Obj{0: {{K: "models", V: list}}}, nil
}

// parseOfficialEntry reads a fetchThroughCache entry: ok false for one fetchThroughCache treats as a
// miss (undecodable, no `data`, or a `cachedAt` that is not a number). `data: null` is an empty list
// (`(await getOfficialModelIds()) ?? []`); a record without a numeric id or a string type is skipped,
// as it can match no model and no type.
func parseOfficialEntry(raw []byte) ([]OfficialModel, float64, bool) {
	v, err := Unpack(raw)
	if err != nil {
		return nil, 0, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, 0, false
	}
	data, has := m["data"]
	if !has {
		return nil, 0, false
	}
	at, ok := toFloat(m["cachedAt"])
	if !ok {
		return nil, 0, false
	}
	list := []OfficialModel{}
	for _, x := range asList(data) {
		r, _ := x.(map[string]any)
		id, ok := Int(r["id"])
		typ, ok2 := r["type"].(string)
		if ok && ok2 {
			list = append(list, OfficialModel{ID: id, Type: typ})
		}
	}
	return list, at, true
}

// Float is toFloat for the other packages reading a fetchThroughCache entry (its `cachedAt`, its
// numbers).
func Float(v any) (float64, bool) { return toFloat(v) }

// toFloat is a msgpack number as a float64 (`typeof cachedAt === 'number'`; NaN is one, and never
// expires, as `x > NaN` is false in Node too).
func toFloat(v any) (float64, bool) {
	var f float64
	switch t := v.(type) {
	case float64:
		f = t
	case float32:
		f = float64(t)
	case int64:
		f = float64(t)
	case uint64:
		f = float64(t)
	case int:
		f = float64(t)
	case int32:
		f = float64(t)
	case int8:
		f = float64(t)
	case int16:
		f = float64(t)
	case uint8:
		f = float64(t)
	case uint16:
		f = float64(t)
	case uint32:
		f = float64(t)
	default:
		return 0, false
	}
	return f, true
}
