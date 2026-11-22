package hydrate

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// versionImagesPerVersion is the lookupFn's imagesPerVersion (20).
const versionImagesPerVersion = 20

// ImageOnSiteSQL is imageOnSiteSql('i.meta') (src/server/utils/image-onsite.ts).
const ImageOnSiteSQL = `(i.meta->>'civitaiResources' IS NOT NULL
 AND NOT (i.meta ? 'Version')
 AND (NOT (i.meta ? 'Model') OR (i.meta->>'Model') LIKE 'urn:air:%'))`

// sqlVersionImages is imagesForModelVersionsCache's lookupFn query: getImagesForModelVersion
// (src/server/services/image.service.ts) with `{modelVersionIds, imagesPerVersion: 20, db}` and no
// other option, so no user (imageBlockedForConditions drops every blocked image, and
// minorMatureImageVisibleSql every image the minor content rule restricts), no browsing level (the
// reviewed, non-pending, rated branch), no include (no meta column, no tags). Its enum and json
// columns are selected as text (Prisma hands the Node code the enum's name and JSON.parse of the
// json). The target ids are one int[] parameter where Node binds ARRAY[$1, …]; LIMIT is the bound 20.
var sqlVersionImages = `WITH targets AS (
  SELECT i.id, full_mv.id::int AS "modelVersionId"
  FROM unnest($1::int[]) AS full_mv(id)
  CROSS JOIN LATERAL (
    SELECT i.id
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE (p."userId" = m."userId" OR m."userId" = -1)
      AND p."modelVersionId" = full_mv.id
      AND p."publishedAt" IS NOT NULL
      AND i."tosViolation" = FALSE
      AND (i."blockedFor" IS NULL)
      AND i."needsReview" IS NULL AND i."acceptableMinor" = FALSE
      AND (i."nsfwLevel" & ` + strconv.Itoa(browsing.AllLevels) + `) != 0
      AND ` + ImageReviewedSQL("i") + `
      AND ` + MinorMatureImageHiddenSQL("i") + `
      AND (
        (i."nsfwLevel" & ` + strconv.Itoa(browsing.NSFWLevels) + `) = 0
        OR NOT i."modelRestricted"
      )
    ORDER BY i."postId", i.index, i.id
    LIMIT ` + strconv.Itoa(versionImagesPerVersion) + `
  ) i
)
SELECT
  i.id,
  i."userId",
  i.name,
  i.url,
  i."nsfwLevel",
  i.width,
  i.height,
  i.hash,
  i.type::text AS type,
  i.metadata::text AS metadata,
  i.minor,
  i.poi,
  t."modelVersionId",
  p."availability"::text AS availability,
  (
    CASE
      WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
      ELSE TRUE
    END
  ) AS "hasMeta",
  (
    CASE
      WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
        AND i.meta->>'prompt' IS NOT NULL
      THEN TRUE
      ELSE FALSE
    END
  ) AS "hasPositivePrompt",
  ` + ImageOnSiteSQL + ` AS "onSite",
  (i."meta"->'extra'->'remixOfId')::text AS "remixOfId"
FROM targets t
JOIN "Image" i ON i.id = t.id
JOIN "Post" p ON p.id = i."postId"
ORDER BY i."postId", i."index", i.id`

// versionImageColumns are the query's columns in its SELECT order: the member order of each cached
// image (Prisma builds each row object in column order). The json ones are decoded (jsonColumn).
var versionImageColumns = []string{"id", "userId", "name", "url", "nsfwLevel", "width", "height", "hash", "type",
	"metadata", "minor", "poi", "modelVersionId", "availability", "hasMeta", "hasPositivePrompt", "onSite", "remixOfId"}

var versionImageJSONColumns = map[string]bool{"metadata": true, "remixOfId": true}

// lagKey is db-lag-helpers' lagKey(type, id), `${REDIS_KEYS.LAG_HELPER}:${type}:${id}`, namespace
// prefixed as every leaf of the key table is.
func (s *Sources) lagKey(typ string, id int) string {
	return s.Packed.Prefix + "lag-helper:" + typ + ":" + strconv.Itoa(id)
}

// versionImagesDB is the database the version-images lookup reads: Node's lookupFn reads
// getDbWithoutLagBatch('modelVersion', ids) (lagAwareDB).
func (s *Sources) versionImagesDB(ctx context.Context, ids []int) (Querier, error) {
	return s.lagAwareDB(ctx, MissVersionImages, "modelVersion", ids)
}

// lagAwareDB is getDbWithoutLagBatch(typ, ids) (src/server/db/db-lag-helpers.ts): the primary when any
// of the ids carries the lag flag a recent write set (markFresh, a non-empty value for
// REPLICATION_LAG_DELAY seconds; a flag read that fails reads as unflagged, the guard failing open),
// else the replica. With cache written back this service writes what it reads, so it decides the
// same way over the same flags (with REPLICATION_LAG_DELAY 0 Node never writes a flag, so none is
// found either). Otherwise nothing it reads is cached and it reads the replica, as entityDB does: an
// id flagged moments ago then gets the replica's answer for this one request. A Go-first probe
// (WithPresence) reads the replica too: it writes nothing, and never reads the primary.
func (s *Sources) lagAwareDB(ctx context.Context, cache, typ string, ids []int) (Querier, error) {
	if !s.Compute.writes(cache) || presenceOf(ctx) != nil {
		return s.Replica, nil
	}
	if s.Compute.Primary == nil {
		return nil, errors.New("write-back needs the primary database")
	}
	if s.Packed.Redis == nil || len(ids) == 0 {
		return s.Replica, nil
	}
	cmds := make([]*redis.StringCmd, len(ids))
	_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range ids {
			cmds[i] = p.Get(ctx, s.lagKey(typ, id))
		}
		return nil
	})
	for _, cmd := range cmds {
		if v, err := cmd.Result(); err == nil && v != "" {
			return s.Compute.Primary, nil
		}
	}
	return s.Replica, nil
}

// lookupVersionImages is imagesForModelVersionsCache's lookupFn: per version with at least one
// showcase image, `{modelVersionId, images}`, the images in the query's order (post, index, id) with
// their members in column order; a version with none is absent (its marker is written). The appendFn
// (each image's `tags` from tagIdsForImagesCache) runs on every read, not here: VersionImages applies
// it.
func (s *Sources) lookupVersionImages(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.versionImagesDB(ctx, ids)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sqlVersionImages, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	order := []int{}
	perVersion := map[int][]any{}
	for _, m := range maps {
		vid, ok := Int(m["modelVersionId"])
		if !ok {
			return nil, fmt.Errorf("version images: row %v has no modelVersionId", m["id"])
		}
		img := make(jspack.Obj, 0, len(versionImageColumns))
		for _, col := range versionImageColumns {
			v, err := versionImageValue(col, m[col])
			if err != nil {
				return nil, fmt.Errorf("version images: %s: %w", col, err)
			}
			img = append(img, jspack.KV{K: col, V: v})
		}
		if _, seen := perVersion[vid]; !seen {
			order = append(order, vid)
		}
		perVersion[vid] = append(perVersion[vid], img)
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, vid := range order {
		out[vid] = jspack.O("modelVersionId", vid, "images", perVersion[vid])
	}
	return out, nil
}

// versionImageValue is one column's value as the Node row holds it: a json column decoded, an
// integer as a number, text and booleans as they are, SQL NULL as null.
func versionImageValue(col string, v any) (any, error) {
	if versionImageJSONColumns[col] {
		return jsonColumn(v)
	}
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
	}
	return nil, fmt.Errorf("unexpected %T", v)
}
