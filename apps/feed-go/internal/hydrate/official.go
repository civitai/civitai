package hydrate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// KeyOfficialModels is REDIS_KEYS.CACHES.OFFICIAL_MODELS: getOfficialModelIds' one fetchThroughCache
// entry, `{data: [{id, type}], cachedAt: <epoch ms>}` (no per-id suffix).
const KeyOfficialModels = "packed:caches:official-models"

const (
	// officialModelsTTL is getOfficialModelIds' `ttl: 60 * 5`: an entry older is expired.
	officialModelsTTL = 5 * time.Minute
	// officialModelsEX is writeFetchThroughEntry's EX, the ttl twice.
	officialModelsEX = 2 * officialModelsTTL
	// officialModelsLockTTL is fetchThroughCache's default lockTTL (10 s).
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

// OfficialModels is getOfficialModelIds (src/server/services/resource-select.service.ts):
// fetchThroughCache(OFFICIAL_MODELS, fetchFn, { ttl: 300, retryCount: 0 }) with its catch answering [].
// A fresh entry (cachedAt within the ttl) is its data. Otherwise, as fetchThroughCache:
//
//   - the cache read failed: Node fetches from the replica and writes nothing (its fail-open path);
//     so does this, with s.Compute (else `official-models-miss`);
//   - write-back on: the refresh lock (`cache-lock:<key>`, SET NX EX 10) is taken as Node takes it.
//     Held elsewhere, the expired entry is served, and with none the answer is [] (Node's retryCount 0
//     throws, and the catch answers []); a lock write that failed serves the expired entry or fetches
//     without writing. Taken, the replica is read and `{data, cachedAt}` written (SET EX 600, a plain
//     SET as Node's under its lock), and the lock released;
//   - write-back off, or under a Go-first probe: nothing is written and no lock taken. The lock is
//     read (EXISTS): held elsewhere is answered as above; free, the replica is read (as Node, which
//     would take it, reads it), kept in process for a few seconds (lookupShared). A failed lock read
//     is answered as Node answers a failed lock write.
//
// A replica read that fails is `official-models-miss-failed` (Node's catch would answer [], a
// different page: the request is left to Node). Without s.Compute an entry that would be fetched is
// `official-models-miss`. Under a probe a computed read is recorded (MissOfficialModels) and done on
// the replica, as its answer decides the page's rows.
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
	now := time.Now()
	if s.Packed.Now != nil {
		now = s.Packed.Now()
	}
	// `Date.now() - ttl * 1000 > cachedAt` is expired.
	if hasEntry && !(float64(now.UnixMilli())-float64(officialModelsTTL/time.Millisecond) > cachedAt) {
		return cached, nil
	}
	lockKey := s.Packed.Prefix + "cache-lock:" + key
	if s.Compute != nil && s.Compute.WriteBack && presenceOf(ctx) == nil {
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
		defer s.releaseLocks(context.WithoutCancel(ctx), []string{lockKey})
		list, err := s.officialFetch(ctx)
		if err != nil {
			return nil, err
		}
		data := make([]any, len(list))
		for i, m := range list {
			data[i] = jspack.O("id", m.ID, "type", m.Type)
		}
		val := jspack.Pack(jspack.O("data", data, "cachedAt", float64(s.Compute.now().UnixMilli())))
		s.writePacked(ctx, []packedWrite{{key: key, val: val, ttl: officialModelsEX, overwrite: true}})
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
// (one flight per process, the answer kept a few seconds with write-back off). Without s.Compute it
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
		return nil, fallback.Newf("official-models-miss-failed", "%v", err)
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
