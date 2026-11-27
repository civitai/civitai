package hydrate

import (
	"context"
	"fmt"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The version-files misses of the REST model routes: filesForModelVersionCache
// (src/server/services/model-file.service.ts), computed with its lookupFn's own query.

// KeyVersionFiles is REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION: one `{ modelVersionId, files,
// cachedAt }` record per version with at least one file, a notFound marker for one without.
const KeyVersionFiles = "packed:caches:files-for-model-version-2"

// MissVersionFiles is filesForModelVersionCache (the v1 models routes' file read).
const MissVersionFiles = "version-files"

// VersionFilesTTL is filesForModelVersionCache's ttl (CacheTTL.day): staleWhileRevalidate is on (the
// default), so an entry whose cachedAt is older is revalidated by Node's fetch: the reader that wins
// the revalidate lock looks it up again and overwrites it, a reader that loses it serves it.
const VersionFilesTTL = ttlDay

// versionFilesSpec: EX resolveCacheExpiry(day, true, undefined) = two days; cacheNotFound (default)
// on and no notFoundTtl, so a marker gets the same two days.
var versionFilesSpec = lookupSpec{cache: MissVersionFiles, reason: "v1-models-files-miss", key: KeyVersionFiles,
	idKey: "modelVersionId", ttl: 2 * VersionFilesTTL, notFoundTTL: 2 * VersionFilesTTL}

// sqlVersionFiles is fetchModelFilesForCache's `modelFile.findMany({ where: { modelVersionId: { in:
// ids }, replacedAt: null }, select: modelFileSelect })` (src/server/selectors/modelFile.selector.ts),
// its columns in the select's order, the enums as their names (as Prisma hands them over) and the
// jsonb `metadata` as text (JSON.parse order, jsonColumn). No ORDER BY: Prisma sends none, so the
// files are in the replica's row order, here as in Node's own lookup.
const sqlVersionFiles = `SELECT id, url, "sizeKB", name, "overrideName", type, visibility::text AS visibility,
  "pickleScanResult"::text AS "pickleScanResult", "pickleScanMessage", "virusScanResult"::text AS "virusScanResult",
  "virusScanMessage", "scannedAt", "modelVersionId", metadata::text AS metadata
FROM "ModelFile"
WHERE "modelVersionId" = ANY($1::int[]) AND "replacedAt" IS NULL`

// sqlVersionFileHashes is the select's `hashes: { select: { type, hash } }` relation read (Prisma's
// second query, by file id; no ORDER BY, as Prisma sends none).
const sqlVersionFileHashes = `SELECT "fileId", type::text AS type, hash::text AS hash FROM "ModelFileHash" WHERE "fileId" = ANY($1::int[])`

// versionFileColumns are a cached file's members in the record's order: the select's, `metadata` moved
// last by the lookup's `({ metadata, ...file }) => ({ ...file, metadata })`, `hashes` (the relation)
// after `modelVersionId`.
var versionFileColumns = []string{"id", "url", "sizeKB", "name", "overrideName", "type", "visibility",
	"pickleScanResult", "pickleScanMessage", "virusScanResult", "virusScanMessage", "scannedAt", "modelVersionId"}

// lookupVersionFiles is filesForModelVersionCache's lookupFn, on the replica (dbRead, as Node's reads
// it whatever the lag flags say): per version with at least one file, `{modelVersionId, files}`, the
// files in row order; a version with none is absent (its marker is written).
func (s *Sources) lookupVersionFiles(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlVersionFiles, ids)
	if err != nil {
		return nil, err
	}
	files, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := map[int]jspack.Obj{}
	if len(files) == 0 {
		return out, nil
	}
	fileIDs := make([]int, 0, len(files))
	for _, f := range files {
		id, ok := Int(f["id"])
		if !ok {
			return nil, fmt.Errorf("version files: row %v has no id", f)
		}
		fileIDs = append(fileIDs, id)
	}
	hashRows, err := s.Replica.Query(ctx, sqlVersionFileHashes, fileIDs)
	if err != nil {
		return nil, err
	}
	hashMaps, err := rowsToMaps(hashRows)
	if err != nil {
		return nil, err
	}
	hashes := map[int][]any{}
	for _, h := range hashMaps {
		fid, _ := Int(h["fileId"])
		hashes[fid] = append(hashes[fid], jspack.O("type", h["type"], "hash", h["hash"]))
	}
	order := []int{}
	perVersion := map[int][]any{}
	for i, f := range files {
		vid, ok := Int(f["modelVersionId"])
		if !ok {
			return nil, fmt.Errorf("version files: file %d has no modelVersionId", fileIDs[i])
		}
		rec := make(jspack.Obj, 0, len(versionFileColumns)+2)
		for _, col := range versionFileColumns {
			v, err := versionFileValue(f[col])
			if err != nil {
				return nil, fmt.Errorf("version files: %s: %w", col, err)
			}
			rec = append(rec, jspack.KV{K: col, V: v})
		}
		hs := hashes[fileIDs[i]]
		if hs == nil {
			hs = []any{}
		}
		meta, err := jsonColumn(f["metadata"])
		if err != nil {
			return nil, fmt.Errorf("version files: metadata: %w", err)
		}
		rec = append(rec, jspack.KV{K: "hashes", V: hs}, jspack.KV{K: "metadata", V: meta})
		if _, seen := perVersion[vid]; !seen {
			order = append(order, vid)
		}
		perVersion[vid] = append(perVersion[vid], rec)
	}
	for _, vid := range order {
		out[vid] = jspack.O("modelVersionId", vid, "files", perVersion[vid])
	}
	return out, nil
}

// versionFileValue is one file column as the Node row holds it: an integer or a float (sizeKB) as a
// number, a timestamp as a Date, text as it is, SQL NULL as null.
func versionFileValue(v any) (any, error) {
	switch t := v.(type) {
	case nil, string, time.Time:
		return t, nil
	case int16:
		return int64(t), nil
	case int32:
		return int64(t), nil
	case int64:
		return t, nil
	case int:
		return int64(t), nil
	case float32:
		return float64(t), nil
	case float64:
		return t, nil
	}
	return nil, fmt.Errorf("unexpected %T", v)
}

// ComputeVersionFiles answers, for the REST model routes, the version-files entries a read left
// unanswered: missing (no key, a bust's debounce marker, an undecodable value, a failed GET the
// caller chose to compute) looked up with filesForModelVersionCache's lookup, and stale (past
// VersionFilesTTL) revalidated as Node's fetch revalidates them. Each answer is the record
// (Ordered) or NotFound for a version with no file. A stale id absent from the answer keeps its
// cached entry: another reader holds its revalidate lock, so it is served stale, as Node serves it.
//
// write (a public request) writes as Node's fetch does where FEED_GO_CACHE_WRITEBACK lists
// version-files: each miss Node would write back (writable: no key, an undecodable value) SET NX
// with the cache's two-day EX, markers included; each stale id under the revalidate lock Node's fetch
// takes (cache-lock, SET NX EX 10), its value overwritten, the lock released after. Without
// write-back, or without write (a shadow sample), nothing is written or locked and every stale id is
// looked up. ok is false without Compute: the caller falls back. A failed lookup is the
// `v1-models-files-miss-failed` fallback.
func (s *Sources) ComputeVersionFiles(ctx context.Context, missing, stale []int, writable map[int]bool, write bool) (map[int]OrderedEntry, bool, error) {
	if s == nil || s.Compute == nil {
		return nil, false, nil
	}
	ids := make([]int, 0, len(missing)+len(stale))
	ids = append(append(ids, missing...), stale...)
	got := make(map[int]Entry, len(ids))
	var err error
	if write && s.Compute.writes(MissVersionFiles) {
		// A placeholder per stale id for revalidateStale: it takes each one's lock, and drops those it
		// got from got (looked up and overwritten); one whose lock is held stays as it is.
		for _, id := range stale {
			got[id] = Entry{Stale: true}
		}
		err = s.fillSWR(ctx, versionFilesSpec, ids, got, writable, s.lookupVersionFiles)
	} else {
		err = s.fill(ctx, versionFilesSpec, ids, got, nil, true, nil, s.lookupVersionFiles)
	}
	if err != nil {
		return nil, true, err
	}
	out := make(map[int]OrderedEntry, len(got))
	for id, e := range got {
		if e.Stale {
			continue // its lock is another reader's: the caller serves the cached entry
		}
		out[id] = OrderedEntry{Value: e.Ordered(), NotFound: e.NotFound}
	}
	return out, true, nil
}
