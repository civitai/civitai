package modelfeed

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// assocImageQuery is getImagesForModelVersion (src/server/services/image.service.ts) as
// getAssociatedResourcesCardDataHandler calls it: `{ modelVersionIds, excludedTagIds, excludedIds,
// excludedUserIds, user, pending, browsingLevel }` with the resolved model input, so one image per
// version (imagesPerVersion 1), no excluded image or user ids (the schema strips them), not pending,
// and no include (no meta, no tags).
type assocImageQuery struct {
	VersionIDs []int
	// ViewerID is the session user (0 = signed out), IsModerator their moderator flag.
	ViewerID    int
	IsModerator bool
	// CanSeeSongs is Viewer.CanSeeSongs: other users' songs are served (songsHiddenSql).
	CanSeeSongs bool
	// Level is the model input's browsingLevel; ExcludedTagIDs its excludedTagIds after
	// enforceBlockedBrowsingTagsForModels added the addons' (nil = none).
	Level          int
	ExcludedTagIDs []int
}

// assocImageColumns are the query's columns in SELECT order: each image's member order on the wire
// (Prisma builds each row object in column order).
var assocImageColumns = []string{"id", "userId", "name", "url", "nsfwLevel", "width", "height", "hash", "type",
	"metadata", "minor", "poi", "modelVersionId", "availability", "hasMeta", "hasPositivePrompt", "onSite", "remixOfId"}

// build is the statement. Node's clauses, in the order it pushes them (imageWhere), then
// imageNotRestrictedSql; values are bound as Node binds them, the version list as one int[] where
// Node binds ARRAY[$1, …], the constants inlined. The json columns are read as text.
func (q assocImageQuery) build() (string, []any) {
	args := []any{q.VersionIDs}
	bind := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	and := []string{`p."publishedAt" IS NOT NULL`, `i."tosViolation" = FALSE`}
	if len(q.ExcludedTagIDs) > 0 {
		or := []string{`i."nsfwLevel" != 0 AND NOT EXISTS (SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."disabled" = FALSE AND toi."tagId" = ANY(` +
			bind(q.ExcludedTagIDs) + `::int[]) )`}
		if q.ViewerID != 0 {
			or = append(or, `i."userId" = `+bind(q.ViewerID))
		}
		and = append(and, `(`+strings.Join(or, " OR ")+`)`)
	}
	// imageBlockedForConditions({ userId, isModerator }): nothing for a moderator; the owner keeps a
	// blocked image only where ownerMediaAllowed allows it (#10505). No ownerMediaSql here, as in Node.
	and = append(and, hydrate.ImageBlockedForSQL(q.ViewerID, q.IsModerator, bind)...)
	// `if (browsingLevel) browsingLevel = onlySelectableLevels(browsingLevel)`, then the not-pending
	// branch: `browsingLevel || allBrowsingLevelsFlag`.
	level := q.Level & table.Levels.All
	if level == 0 {
		level = table.Levels.All
	}
	and = append(and, `i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`,
		`(i."nsfwLevel" & `+bind(level)+`) != 0`,
		hydrate.ImageReviewedSQL("i"),
		// minorMatureImageVisibleSql({ userId, isModerator }).
		hydrate.MinorMatureImageVisibleSQL("i", q.ViewerID, q.IsModerator, bind))
	// songsHiddenSql: a viewer who cannot see songs gets none but their own.
	if !q.IsModerator && !q.CanSeeSongs {
		if q.ViewerID != 0 {
			and = append(and, `(i."type" != 'audio' OR i."userId" = `+bind(q.ViewerID)+`)`)
		} else {
			and = append(and, `i."type" != 'audio'`)
		}
	}
	// imageNotRestrictedSql({ viewerId: userId }): the uploader carve-out for a positive id only.
	notRestricted := `((i."nsfwLevel" & ` + strconv.Itoa(table.Levels.NSFW) + `) = 0 OR NOT i."modelRestricted"`
	if q.ViewerID > 0 {
		notRestricted += ` OR i."userId" = ` + bind(q.ViewerID)
	}
	notRestricted += `)`
	sql := `WITH targets AS (
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
      AND ` + strings.Join(and, "\n      AND ") + `
      AND ` + notRestricted + `
    ORDER BY i."postId", i.index, i.id
    LIMIT 1
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
  ` + hydrate.ImageOnSiteSQL + ` AS "onSite",
  (i."meta"->'extra'->'remixOfId')::text AS "remixOfId"
FROM targets t
JOIN "Image" i ON i.id = t.id
JOIN "Post" p ON p.id = i."postId"
ORDER BY i."postId", i."index", i.id`
	return sql, args
}

// assocImages runs the query: each version's images (at most one), as maps the hold and the viewer
// filter read (`nsfwLevel`, `userId`, `poi`, `minor`) holding every column's value as the Node row
// does: integers as int64, the json columns as their JSON text, SQL NULL as nil.
func assocImages(ctx context.Context, db Querier, q assocImageQuery) (map[int][]map[string]any, error) {
	out := map[int][]map[string]any{}
	if len(q.VersionIDs) == 0 {
		return out, nil
	}
	sql, args := q.build()
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, userID, nsfwLevel, versionID         int
			width, height                            *int
			name, hash, metadata, remixOf            *string
			url, typ, availability                   string
			minor, poi, hasMeta, hasPositive, onSite bool
		)
		if err := rows.Scan(&id, &userID, &name, &url, &nsfwLevel, &width, &height, &hash, &typ, &metadata,
			&minor, &poi, &versionID, &availability, &hasMeta, &hasPositive, &onSite, &remixOf); err != nil {
			return nil, err
		}
		img := map[string]any{
			"id": int64(id), "userId": int64(userID), "name": strPtr(name), "url": url, "nsfwLevel": int64(nsfwLevel),
			"width": int64Ptr(width), "height": int64Ptr(height), "hash": strPtr(hash), "type": typ,
			"metadata": jsonText(metadata), "minor": minor, "poi": poi, "modelVersionId": int64(versionID),
			"availability": availability, "hasMeta": hasMeta, "hasPositivePrompt": hasPositive,
			"onSite": onSite, "remixOfId": jsonText(remixOf),
		}
		out[versionID] = append(out[versionID], img)
	}
	return out, rows.Err()
}

// assocImageWire is one image on the wire: every column, in SELECT order. Node sends the rows
// untrimmed (no GETALL_DROPPED_IMAGE_FIELDS here) and without `tags` (no include).
func assocImageWire(img map[string]any) superjson.Object {
	obj := make(superjson.Object, 0, len(assocImageColumns))
	for _, c := range assocImageColumns {
		obj = append(obj, superjson.Field{Key: c, Val: img[c]})
	}
	return obj
}

func strPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func int64Ptr(p *int) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}

// jsonText is a json column read as text: the value itself, emitted as is (the comparison decodes
// it); SQL NULL is null.
func jsonText(p *string) any {
	if p == nil {
		return nil
	}
	return json.RawMessage(*p)
}
