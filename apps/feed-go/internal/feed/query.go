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
	Limit  int
	Cursor int
	// Skip is the offset-paging skip (the REST endpoint's `page`): `OFFSET <skip>`; 0 adds nothing.
	Skip           int
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
	// IDs is the feed-service hydrate (feedHydrateQuery): exactly these images, whatever their order.
	IDs []int
	// PostIDs is the gallery's post completion: only these posts' images.
	PostIDs []int
	// PostID is the input's own `postId` (the REST endpoint): `i."postId" = <postId>`.
	PostID int
	// TargetUserID is the creator filter (`userId`, or the id a `username` resolved to):
	// `i."userId" = <targetUserId>`. getAllImages marks that query personalized, so it is never cached.
	TargetUserID int
	// FollowedUserIDs is image.getInfinite's `followed` for a signed-in viewer with a non-empty
	// follow list (getUserFollows): `i."userId" = ANY(<follows>)` (Node's `IN (…)`). getAllImages marks that query
	// personalized, so it is never cached. Empty (signed out, no follows): no clause at all.
	FollowedUserIDs []int
	// TagIDs is the input's own `tags` inclusion filter, after the blocked tags are stripped: images
	// carrying any of them. getAllImages marks that query personalized, so it is never cached.
	TagIDs []int
	// IndexOrder is a post's own media (`postId` without `modelId`): ordered by `i."index"`, then
	// `i."id"`, and paged on the index (getAllImagesUncaptured's post branch). The cursor column is
	// then the nullable index (RawImage.CursorNull).
	IndexOrder bool
	// ThrowOnStatementTimeout makes a statement timeout an error instead of an empty page (the
	// feed-service hydrate sets it, so a slow hydrate is not read as a page the filters emptied).
	ThrowOnStatementTimeout bool
	// PrioritizedUserIDs is getAllImages' prioritizeUser branch with the version cache off (image.getInfinite's
	// `prioritizedUserIds`, never the system user alone: that sub-case falls back): no
	// ImageResourceNew join for the model scope; `p."modelVersionId" = <version>` when there is one;
	// only these creators' images; ordered oldest post first, then by index and id. The cursor
	// column stays the one the sort chose (the cursor itself is refused by the caller). Never cached.
	PrioritizedUserIDs []int
	// Pending is the input's `pending`: no published-before-now clause, and for a moderator or a
	// signed-in viewer the pending visibility in place of the reviewed one (then never cached).
	Pending bool
	// Techniques is the input's `techniques`: only images with an ImageTechnique row for any of these
	// technique ids. Not personalized: the query keeps its cache policy.
	Techniques []int
	// Tools is the input's `tools`: only images whose ImageTool rows hold every one of these tool ids
	// (an image with no tool row never matches). Not personalized: the query keeps its cache policy.
	Tools []int
	// BaseModels is image.getInfinite's `baseModels`, as sent: only images with an ImageResourceNew row
	// whose ModelVersion's `baseModel` is one of them. Not personalized: the query keeps its cache policy.
	BaseModels []string
}

// Built is the SQL for one page plus its caching policy.
type Built struct {
	SQL       string
	Args      []any
	CacheTTL  time.Duration // 0 = not cached
	CacheTags []string
	// ThrowOnStatementTimeout: see ImagesQuery.
	ThrowOnStatementTimeout bool
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
// same order (getAllImagesUncaptured in image.service.ts). Value lists use `= ANY($n)` where Node
// inlines `IN (…)`: same rows, one bind each.
func (q *ImagesQuery) Build() Built {
	a := &sqlArgs{}
	and := []string{`i."postId" IS NOT NULL`}
	cacheTTL := time.Duration(0)
	var tags []string

	browsingLevel := browsing.OnlySelectable(q.BrowsingLevel)
	if browsingLevel == 0 {
		browsingLevel = browsing.PublicLevels
	}

	if len(q.IDs) > 0 {
		and = append(and, `i."id" = ANY(`+a.add(q.IDs)+`::int[])`)
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
	// Not pending: strict published-only (the scheduled carve-out is a fallback shape). Pending: no
	// publish clause at all (the per-image transform still drops another creator's unpublished image).
	if !q.Pending {
		and = append(and, `(p."publishedAt" < now())`)
	}

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
	prioritized := len(q.PrioritizedUserIDs) > 0
	// `!prioritizeUser && (modelId || modelVersionId)`: a prioritized request does not join the model.
	if !prioritized && (q.ModelID != 0 || q.ModelVersionID != 0) {
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
	if q.TargetUserID != 0 {
		and = append(and, `i."userId" = `+a.add(q.TargetUserID))
	}
	if len(q.FollowedUserIDs) > 0 {
		// `userId && followed && prefetchedUserFollows?.length`, after the creator clause as there.
		and = append(and, `i."userId" = ANY(`+a.add(q.FollowedUserIDs)+`::int[])`)
	}
	if len(q.TagIDs) > 0 {
		and = append(and, `i.id IN (
      SELECT "imageId"
      FROM "TagsOnImageDetails"
      WHERE "tagId" = ANY(`+a.add(q.TagIDs)+`::int[]) AND "disabled" = FALSE
    )`)
	}
	if len(q.Generation) > 0 {
		and = append(and, `i."generationProcess" = ANY(`+a.add(q.Generation)+`::text[]::"ImageGenerationProcess"[])`)
	}
	if q.PostID != 0 {
		and = append(and, `i."postId" = `+a.add(q.PostID))
	}
	if len(q.PostIDs) > 0 {
		and = append(and, `i."postId" = ANY(`+a.add(q.PostIDs)+`::int[])`)
	}
	if len(q.ExcludedUsers) > 0 {
		and = append(and, `i."userId" != ALL(`+a.add(q.ExcludedUsers)+`::int[])`)
	}

	// The pending view of a moderator or a signed-in viewer (`effectivePending && (isModerator ||
	// ownerId)`).
	pendingView := q.Pending && (q.IsModerator || q.ViewerID != 0)
	if q.TargetUserID != 0 || len(q.FollowedUserIDs) > 0 || len(q.TagIDs) > 0 || prioritized || pendingView {
		// isPersonalized (the user-gallery path, a follow set, a tag combination, prioritizedUserIds,
		// the pending view): never cached.
		cacheTTL, tags = 0, nil
	}

	var orderBy, cursorCol, cursorOp string
	switch {
	case q.IndexOrder:
		// getCursor('i."index"'): ascending, inclusive on its only field; the id tie-break is
		// appended after the cursor clause, so the cursor stays the index.
		orderBy, cursorCol, cursorOp = `i."index"`, `i."index"`, ">="
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
	if q.IndexOrder {
		// A post's images can share an index.
		orderBy += `, i."id"`
	}
	if prioritized {
		// After getCursor, so the cursor column is still the sort's. The system user alone (an IIF
		// order over every creator when it has no post on the version) is a fallback upstream.
		if q.ModelVersionID != 0 {
			and = append(and, `p."modelVersionId" = `+a.add(q.ModelVersionID))
		}
		and = append(and, `i."userId" = ANY(`+a.add(q.PrioritizedUserIDs)+`::int[])`)
		orderBy = `(i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"` // oldest post first
	}
	if len(q.Tools) > 0 {
		// getAllImagesUncaptured's `tools` clause, after the prioritizeUser branch as there. The list
		// is bound as sent (Node joins it into ARRAY[…]::integer[]); `@>` ignores order and repeats.
		and = append(and, `EXISTS (
      SELECT 1
      FROM "ImageTool" it
      WHERE it."imageId" = i.id
      GROUP BY it."imageId"
      HAVING array_agg(it."toolId" ORDER BY it."toolId") @> `+a.add(q.Tools)+`::integer[]
    )`)
	}
	if len(q.Techniques) > 0 {
		// getAllImagesUncaptured's `techniques` clause (it follows `tools` there): any of the ids (Node
		// writes `IN (…)`, one bind per id; order and repeats change nothing).
		and = append(and, `EXISTS (
      SELECT 1
      FROM "ImageTechnique" it
      WHERE it."imageId" = i.id AND it."techniqueId" = ANY(`+a.add(q.Techniques)+`::int[])
    )`)
	}
	if len(q.BaseModels) > 0 {
		// getAllImagesUncaptured's `baseModels` clause, in Node's clause order (it follows `tools` and
		// `techniques` there), its RIGHT JOIN kept so the plan is Node's. The list is bound as sent
		// (Node inlines it into `IN (…)`): `= ANY` keeps the same rows, an empty name included.
		and = append(and, `EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      RIGHT JOIN "ImageResourceNew" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
      WHERE mv."baseModel" = ANY(`+a.add(q.BaseModels)+`::text[])
    )`)
	}

	if pendingView {
		if q.IsModerator {
			and = append(and, `((i."nsfwLevel" & `+a.add(browsingLevel)+`) != 0 OR i."nsfwLevel" = 0)`)
		} else {
			and = append(and, pendingViewerSQL(a, q.ViewerID, browsingLevel))
		}
	} else {
		and = append(and, `i."needsReview" IS NULL`, `i."acceptableMinor" = FALSE`)
		and = append(and, `(i."nsfwLevel" & `+a.add(browsingLevel)+`) != 0 AND i."nsfwLevel" != 0`)
		and = append(and, hydrate.ImageReviewedSQL("i"))
	}

	restrictedOwnerSQL := ""
	if q.ViewerID != 0 {
		restrictedOwnerSQL = ` OR i."userId" = ` + a.add(q.ViewerID)
	}

	offset := ""
	if q.Skip > 0 {
		// Inlined, as Node does: an int, never request text.
		offset = `
    OFFSET ` + strconv.Itoa(q.Skip)
	}

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
      -- No viewer exception: true for the uploader too (the owner's notice reads it).
      ((i."nsfwLevel" & ` + strconv.Itoa(browsing.NSFWLevels) + `) = 0 OR NOT i."modelRestricted") IS NOT TRUE "restricted",
      ` + cursorCol + ` "cursorId"
    ` + from + `
    ` + strings.Join(joins, "\n    ") + `
    JOIN "Post" p ON p.id = i."postId"
    WHERE ` + strings.Join(and, " AND ") + `
      -- An R+ image on a license-restricted base model is its uploader's alone.
      AND (
        (i."nsfwLevel" & ` + strconv.Itoa(browsing.NSFWLevels) + `) = 0
        OR NOT i."modelRestricted"` + restrictedOwnerSQL + `
      )
    ORDER BY ` + orderBy + offset + `
    LIMIT ` + a.add(q.Limit+1)

	return Built{SQL: sql, Args: a.args, CacheTTL: cacheTTL, CacheTags: tags, ThrowOnStatementTimeout: q.ThrowOnStatementTimeout}
}

// nsfwLevelBlocked is NsfwLevel.Blocked (src/server/common/enums.ts).
const nsfwLevelBlocked = 32

// pendingViewerSQL is pendingViewerImageSql({ userId, browsingLevel }) (collection-review.sql.ts,
// with pendingOthersImageConditions from common/image-visibility.ts), without a reviewCollectionId
// (server-set, never on image.getInfinite): another creator's image must not await review, not be
// acceptableMinor, and be reviewed if rated; the viewer's own are exempt, and shown unrated; a rated,
// reviewed image of a post in a collection the viewer MANAGEs shows above browsingLevel.
func pendingViewerSQL(a *sqlArgs, viewerID, browsingLevel int) string {
	own := func() string { return `i."userId" = ` + a.add(viewerID) }
	return `((i."needsReview" IS NULL OR i."needsReview" NOT IN (` + a.add("csam") + `, ` + a.add("minor") + `)) AND (i."needsReview" IS NULL OR ` + own() + `) AND (i."acceptableMinor" = FALSE OR ` + own() + `) AND (` + own() +
		` OR i."nsfwLevel" = 0 OR ` + hydrate.ImageReviewedSQL("i") + `)
    AND ((i."nsfwLevel" & ` + a.add(browsingLevel) + `) != 0 OR (i."nsfwLevel" = 0 AND ` + own() +
		`) OR (p."collectionId" IS NOT NULL AND i."nsfwLevel" NOT IN (0, ` + a.add(nsfwLevelBlocked) + `) AND (i."acceptableMinor" = FALSE OR ` + own() +
		`) AND EXISTS (SELECT 1 FROM "CollectionContributor" cc WHERE cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[] AND cc."collectionId" = p."collectionId" AND cc."userId" = ` + a.add(viewerID) + `))))`
}

// imageOnSiteSQL is imageOnSiteSql('i.meta'), shared with the version showcase lookup.
const imageOnSiteSQL = hydrate.ImageOnSiteSQL
