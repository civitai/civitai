package feed

import (
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// challengeTagID is dailyChallengeConfig.challengeTagId (src/server/games/daily-challenge/daily-challenge.utils.ts),
// excluded when `hideChallenges` is set (applyHideChallengesExclusion).
const challengeTagID = 676575

// ImagesQuery is one getAllImages call for the supported subset, after the handler and the blocked-
// browsing-tags enforcement have shaped it.
type ImagesQuery struct {
	Limit          int
	Cursor         int
	Sort           string
	Period         string
	PeriodMode     string
	BrowsingLevel  int
	ModelID        int
	ModelVersionID int
	Model3DID      int
	Types          []string
	Generation     []string
	WithMeta       bool
	FromPlatform   bool
	DisablePoi     bool
	DisableMinor   bool
	ExcludedTagIDs []int
	ExcludedUsers  []int
	ViewerID       int
	IsModerator    bool
}

// Built is the SQL for one page plus its caching policy.
type Built struct {
	SQL       string
	Args      []any
	CacheTTL  time.Duration // 0 = not cached
	CacheTags []string
}

type sqlArgs struct{ args []any }

func (a *sqlArgs) add(v any) string {
	a.args = append(a.args, v)
	return "$" + strconv.Itoa(len(a.args))
}

// viewerArg binds the viewer id, or NULL for a signed-out viewer (Prisma binds `undefined` as NULL,
// which makes every `… = <viewer>` carve-out false).
func (q *ImagesQuery) viewerArg(a *sqlArgs) string {
	if q.ViewerID == 0 {
		return a.add(nil) + "::int"
	}
	return a.add(q.ViewerID)
}

// Build ports the SQL getAllImagesUncaptured assembles for this subset, clause by clause and in the
// same order (image.service.ts ~2263-2938). Value lists use `= ANY($n)` where Node inlines `IN (…)`:
// same rows, one bind each.
func (q *ImagesQuery) Build() Built {
	a := &sqlArgs{}
	and := []string{`i."postId" IS NOT NULL`}
	cacheTTL := time.Duration(0)
	var tags []string

	browsingLevel := browsing.OnlySelectable(q.BrowsingLevel)
	if browsingLevel == 0 {
		browsingLevel = browsing.PublicLevels
	}

	if len(q.Types) > 0 {
		and = append(and, `i.type = ANY(`+a.add(q.Types)+`::text[]::"MediaType"[])`)
	}
	if q.WithMeta {
		and = append(and, `NOT (i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" = TRUE)`)
	}
	if q.FromPlatform {
		and = append(and, `(i.meta IS NOT NULL AND i.meta ? 'civitaiResources')`)
	}
	// Not pending: strict published-only (the scheduled carve-out is a fallback shape).
	and = append(and, `(p."publishedAt" < now())`)

	if !q.IsModerator {
		and = append(and, `((p."availability" != 'Private' AND i."ingestion" != 'Blocked') OR p."userId" = `+q.viewerArg(a)+`)`)
		if q.ViewerID != 0 {
			and = append(and, `(i."blockedFor" IS NULL OR i."userId" = `+a.add(q.ViewerID)+`)`)
		} else {
			and = append(and, `(i."blockedFor" IS NULL)`)
		}
	}
	if q.DisablePoi {
		and = append(and, `(i."poi" != TRUE OR p."userId" = `+q.viewerArg(a)+`)`)
	}
	if q.DisableMinor {
		if q.ViewerID != 0 {
			and = append(and, `(i."minor" != TRUE OR i."userId" = `+a.add(q.ViewerID)+`)`)
		} else {
			and = append(and, `(i."minor" != TRUE)`)
		}
	}
	if len(q.ExcludedTagIDs) > 0 {
		notExcluded := `NOT EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" toi
      WHERE toi."imageId" = i.id
        AND toi."tagId" = ANY(` + a.add(hydrate.Unique(q.ExcludedTagIDs)) + `::int[])
        AND toi."disabled" = FALSE
    )`
		if q.ViewerID != 0 {
			and = append(and, `(`+notExcluded+` OR i."userId" = `+a.add(q.ViewerID)+`)`)
		} else {
			and = append(and, notExcluded)
		}
	}

	from := `FROM "Image" i`
	var joins []string
	if q.ModelID != 0 || q.ModelVersionID != 0 {
		from = `FROM "ImageResourceNew" irr`
		joins = append(joins, `JOIN "Image" i ON i.id = irr."imageId"`)
		if q.ModelVersionID != 0 {
			and = append(and, `irr."modelVersionId" = `+a.add(q.ModelVersionID))
			cacheTTL = 10 * time.Minute // CacheTTL.md
			tags = append(tags, "images-modelVersion:"+strconv.Itoa(q.ModelVersionID))
		} else {
			joins = append(joins, `JOIN "ModelVersion" mv ON mv.id = irr."modelVersionId"`)
			and = append(and, `mv."modelId" = `+a.add(q.ModelID))
			cacheTTL = 10 * time.Minute
			tags = append(tags, "images-model:"+strconv.Itoa(q.ModelID))
		}
	}
	if q.Model3DID != 0 {
		and = append(and, `p."model3dId" = `+a.add(q.Model3DID))
		cacheTTL = 10 * time.Minute
		tags = append(tags, "images-model3d:"+strconv.Itoa(q.Model3DID))
	}
	if len(q.Generation) > 0 {
		and = append(and, `i."generationProcess" = ANY(`+a.add(q.Generation)+`::text[]::"ImageGenerationProcess"[])`)
	}
	if len(q.ExcludedUsers) > 0 {
		and = append(and, `i."userId" != ALL(`+a.add(q.ExcludedUsers)+`::int[])`)
	}

	var orderBy, cursorCol, cursorOp string
	switch {
	case q.Sort == SortOldest:
		orderBy, cursorCol, cursorOp = `i."id" ASC`, `i."id"`, ">="
	case strings.Contains(from, "irr"):
		// Sort by irr.imageId when reading from ImageResourceNew, for index use.
		orderBy, cursorCol, cursorOp = `irr."imageId" DESC`, `irr."imageId"`, "<="
	default:
		orderBy, cursorCol, cursorOp = `i."id" DESC`, `i."id"`, "<="
	}

	if q.Period != "" && q.Period != "AllTime" && q.PeriodMode != "stats" {
		// Period is one of a closed set (Parse), so inlining it is safe, as in Node.
		and = append(and, `i."createdAt" >= date_trunc('day', now()) - interval '1 `+strings.ToLower(q.Period)+`'`)
	}
	// getCursor: the last sort field is inclusive because the returned cursor is the look-ahead row.
	// A falsy cursor (0) adds nothing.
	if q.Cursor != 0 {
		and = append(and, `((`+cursorCol+` `+cursorOp+` `+a.add(q.Cursor)+`))`)
	}

	and = append(and, `i."needsReview" IS NULL`, `i."acceptableMinor" = FALSE`)
	and = append(and, `(i."nsfwLevel" & `+a.add(browsingLevel)+`) != 0 AND i."nsfwLevel" != 0`)
	and = append(and, hydrate.ImageReviewedSQL("i"))

	sql := `
    SELECT
      i.id,
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      i."hideMeta",
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
      ` + imageOnSiteSQL + ` as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId",
      i."createdAt",
      GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
      i."mimeType",
      i.type,
      i.metadata,
      i.ingestion,
      i."blockedFor",
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."postId",
      p."title" "postTitle",
      i."index",
      p."publishedAt",
      p.metadata->>'unpublishedAt' "unpublishedAt",
      p."modelVersionId",
      p."model3dId",
      p."availability",
      i.minor,
      i.poi,
      i."acceptableMinor",
      ` + cursorCol + ` "cursorId"
    ` + from + `
    ` + strings.Join(joins, "\n    ") + `
    JOIN "Post" p ON p.id = i."postId"
    WHERE ` + strings.Join(and, " AND ") + `
      -- Images with an R+ level may not use a license-restricted base model.
      AND (
        (i."nsfwLevel" & ` + strconv.Itoa(browsing.NSFWLevels) + `) = 0
        OR NOT i."modelRestricted"
      )
    ORDER BY ` + orderBy + `
    LIMIT ` + a.add(q.Limit+1)

	return Built{SQL: sql, Args: a.args, CacheTTL: cacheTTL, CacheTags: tags}
}

// imageOnSiteSQL is imageOnSiteSql('i.meta') (src/server/utils/image-onsite.ts).
const imageOnSiteSQL = `(i.meta->>'civitaiResources' IS NOT NULL
 AND NOT (i.meta ? 'Version')
 AND (NOT (i.meta ? 'Model') OR (i.meta->>'Model') LIKE 'urn:air:%'))`
