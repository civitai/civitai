package hydrate

import (
	"context"
	"fmt"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The model-data and model-tags misses (model.getAll's getModelsRaw): dataForModelsCache and
// modelTagCache (src/server/redis/caches.ts), computed with their lookupFns' own queries.

var (
	// dataForModelsCache: ttl a day, staleWhileRevalidate off (EX = the ttl), cacheNotFound off: a model
	// the lookup finds no version for is left out and nothing is written for it (fill's writeNotFound
	// false). Looked up under a Go-first probe: a model with no data is dropped from the page.
	modelDataSpec = lookupSpec{cache: MissModelData, reason: "model-data-miss", key: KeyDataForModel, idKey: "modelId",
		ttl: ttlDay, notFoundTTL: ttlDay, probeLooksUp: true}
	// modelTagCache: ttl a day, staleWhileRevalidate off, cacheNotFound (default) on, no notFoundTtl, so
	// its markers get the day too. Looked up under a probe: the tags decide the excluded-tag drop.
	modelTagsSpec = lookupSpec{cache: MissModelTags, reason: "model-tags-miss", key: KeyModelTags, idKey: "modelId",
		ttl: ttlDay, notFoundTTL: ttlDay, probeLooksUp: true}
)

// sqlModelDataVersions is dataForModelsCache's lookupFn's first query, its enum columns selected as
// text (Prisma hands the Node code the enum's name). The ids are one int[] parameter where Node binds
// IN (…).
const sqlModelDataVersions = `SELECT
  mv."id",
  mv.index,
  mv."modelId",
  mv."name",
  mv."earlyAccessTimeFrame",
  mv."baseModel",
  mv."baseModelType",
  mv."createdAt",
  mv."trainingStatus"::text AS "trainingStatus",
  mv."publishedAt",
  mv."status"::text AS "status",
  mv."flags",
  mv.availability::text AS availability,
  mv."nsfwLevel",
  mv."description",
  mv."trainedWords",
  (SELECT rr."resourceId" FROM "RecommendedResource" rr
   WHERE rr."sourceId" = mv.id
     AND rr.settings->>'isLinkedComponent' = 'true'
     AND rr.settings->>'componentType' = 'VAE'
     AND EXISTS (SELECT 1 FROM "ModelFile" mf WHERE mf.id = (rr.settings->>'fileId')::int)
   LIMIT 1) AS "vaeId",
  COALESCE(gc.covered, false) AS covered,
  COALESCE(gc."coveredNext", false) AS "coveredNext"
FROM "ModelVersion" mv
LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
WHERE mv."modelId" = ANY($1::int[])
ORDER BY mv."modelId", mv.index`

// sqlModelDataHashes is the lookupFn's second query, on the same database as the first.
const sqlModelDataHashes = `SELECT "modelId", hash
FROM "ModelHash"
WHERE
  "modelId" = ANY($1::int[])
  AND "hashType" = 'SHA256'
  AND "fileType" IN ('Model', 'Pruned Model')`

// sqlModelTags is modelTagCache's lookupFn: `findMany({ where: { modelId: { in: ids } }, select:
// { modelId, tagId } })`, no order (Prisma sends none either).
const sqlModelTags = `SELECT "modelId", "tagId" FROM "TagsOnModels" WHERE "modelId" = ANY($1::int[])`

// modelDataVersionColumns are each cached version's members, in the query's column order without
// `modelId` (the lookup destructures it out: `{ modelId, ...version }`).
var modelDataVersionColumns = []string{"id", "index", "name", "earlyAccessTimeFrame", "baseModel", "baseModelType",
	"createdAt", "trainingStatus", "publishedAt", "status", "flags", "availability", "nsfwLevel", "description",
	"trainedWords", "vaeId", "covered", "coveredNext"}

// fillModelData is dataForModelsCache.fetch's miss path; no marker is written (cacheNotFound is off).
func (s *Sources) fillModelData(ctx context.Context, models []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, modelDataSpec, models, got, writable, false, nil, s.lookupModelData)
}

// ComputeModelData is fillModelData for a reader that keeps the records' key order (the REST model
// routes): each of ids (none of which an entry answered) looked up with dataForModelsCache's lookup,
// its computed record (Ordered) or NotFound for a model the lookup finds no version for. writable
// (OrderedRead.Writable) is the misses Node would write back: with model-data written back
// (FEED_GO_CACHE_WRITEBACK) each of those is written as model.getAll writes it (same key, bytes and
// expiry, SET NX), and the lookup reads the primary for a model a recent write flagged (lagAwareDB);
// nil writes nothing. ok is false when misses are not computed (no Compute): the caller then falls
// back. A failed lookup is the `model-data-miss-failed` fallback.
func (s *Sources) ComputeModelData(ctx context.Context, ids []int, writable map[int]bool) (entries map[int]OrderedEntry, ok bool, err error) {
	if s == nil || s.Compute == nil {
		return nil, false, nil
	}
	got := make(map[int]Entry, len(ids))
	if err := s.fillModelData(ctx, ids, got, writable); err != nil {
		return nil, true, err
	}
	return orderedEntries(got), true, nil
}

// ComputeModelTags is fillModelTags for the REST model routes: each of ids (none of which an entry
// answered) looked up with modelTagCache's lookup on the replica (Node's fetch reads dbRead), its
// `{modelId, tagIds}` record or NotFound for a model with no tag (the marker modelTagCache writes).
// writable is the misses Node would write back: with model-tags written back
// (FEED_GO_CACHE_WRITEBACK) each is written as model.getAll writes it; nil writes nothing. ok is
// false without Compute. A failed lookup is the `model-tags-miss-failed` fallback.
func (s *Sources) ComputeModelTags(ctx context.Context, ids []int, writable map[int]bool) (entries map[int]OrderedEntry, ok bool, err error) {
	if s == nil || s.Compute == nil {
		return nil, false, nil
	}
	got := make(map[int]Entry, len(ids))
	if err := s.fillModelTags(ctx, ids, got, writable); err != nil {
		return nil, true, err
	}
	return orderedEntries(got), true, nil
}

// orderedEntries is got as OrderedEntry values (Entry.Ordered: an ordered cache's own key order, any
// other's keys sorted).
func orderedEntries(got map[int]Entry) map[int]OrderedEntry {
	out := make(map[int]OrderedEntry, len(got))
	for id, e := range got {
		out[id] = OrderedEntry{Value: e.Ordered(), NotFound: e.NotFound}
	}
	return out
}

// WritesBack reports whether this service writes the named cache's computed entries back
// (FEED_GO_CACHE_WRITEBACK lists it and misses are computed).
func (s *Sources) WritesBack(cache string) bool {
	return s != nil && s.Compute != nil && s.Compute.writes(cache)
}

// ModelLagFlagged reports whether a recent write flagged any of the models (their
// `lag-helper:model:<id>` keys, lagFlagged): Node's lag-aware model-data lookup then reads the
// primary. err is a flag read that failed (a flag found set wins over it).
func (s *Sources) ModelLagFlagged(ctx context.Context, ids []int) (bool, error) {
	return s.lagFlagged(ctx, "model", ids)
}

// fillModelTags is modelTagCache.fetch's miss path, asked only for the models the data cache answered.
func (s *Sources) fillModelTags(ctx context.Context, models []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, modelTagsSpec, models, got, writable, true, nil, s.lookupModelTags)
}

// lookupModelData is dataForModelsCache's lookupFn. Keep the versions in (modelId, index) order and the
// hashes in row order: the cache value's order is what Node serves.
func (s *Sources) lookupModelData(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.lagAwareDB(ctx, MissModelData, "model", ids)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sqlModelDataVersions, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	order := []int{}
	versions := map[int][]any{}
	for _, m := range maps {
		mid, ok := Int(m["modelId"])
		if !ok {
			return nil, fmt.Errorf("model data: row %v has no modelId", m["id"])
		}
		v := make(jspack.Obj, 0, len(modelDataVersionColumns))
		for _, col := range modelDataVersionColumns {
			val, err := modelDataValue(m[col])
			if err != nil {
				return nil, fmt.Errorf("model data: %s: %w", col, err)
			}
			v = append(v, jspack.KV{K: col, V: val})
		}
		if _, seen := versions[mid]; !seen {
			order = append(order, mid)
		}
		versions[mid] = append(versions[mid], v)
	}
	hashRows, err := db.Query(ctx, sqlModelDataHashes, ids)
	if err != nil {
		return nil, err
	}
	hashMaps, err := rowsToMaps(hashRows)
	if err != nil {
		return nil, err
	}
	hashes := map[int][]any{}
	for _, m := range hashMaps {
		mid, _ := Int(m["modelId"])
		if _, ok := versions[mid]; !ok {
			continue // `results[modelId]?.hashes.push(hash)`: a model with no version has no record
		}
		h, err := modelDataValue(m["hash"])
		if err != nil {
			return nil, fmt.Errorf("model data: hash: %w", err)
		}
		hashes[mid] = append(hashes[mid], h)
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, mid := range order {
		hs := hashes[mid]
		if hs == nil {
			hs = []any{}
		}
		out[mid] = jspack.O("modelId", mid, "hashes", hs, "tags", []any{}, "versions", versions[mid])
	}
	return out, nil
}

// lookupModelTags is modelTagCache's lookupFn on the replica (a plain fetch's dbRead): per model with
// at least one tag, `{modelId, tagIds}` in row order; a model with none is absent (its marker is
// written). The appendFn (the tag records) runs on every read, not here.
func (s *Sources) lookupModelTags(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlModelTags, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	order := []int{}
	tags := map[int][]any{}
	for _, m := range maps {
		mid, ok := Int(m["modelId"])
		tid, ok2 := Int(m["tagId"])
		if !ok || !ok2 {
			return nil, fmt.Errorf("model tags: row %v", m)
		}
		if _, seen := tags[mid]; !seen {
			order = append(order, mid)
		}
		tags[mid] = append(tags[mid], int64(tid))
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, mid := range order {
		out[mid] = jspack.O("modelId", mid, "tagIds", tags[mid])
	}
	return out, nil
}

// modelDataValue is one column's value as the Node row holds it: an integer as a number, a timestamp
// as a Date, a text[] as an array of strings, text and booleans as they are, SQL NULL as null.
func modelDataValue(v any) (any, error) {
	switch t := v.(type) {
	case nil, bool, string:
		return t, nil
	case int16:
		return int64(t), nil
	case int32:
		return int64(t), nil
	case int64:
		return t, nil
	case int:
		return int64(t), nil
	case time.Time:
		return t, nil
	case []string:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = x
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			switch e := x.(type) {
			case nil, string:
				out[i] = e
			default:
				return nil, fmt.Errorf("unexpected array element %T", x)
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("unexpected %T", v)
}
