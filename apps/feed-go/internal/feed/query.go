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
	// SessionUserID is getAllImages' `userId` (`user?.id`) where it differs from ViewerID, the owner
	// view (feedViewer's id): a scoped API key on /api/v1/images, whose user is not the owner of its
	// own content there (credentialViews) but still makes a page of their own content theirs alone
	// (`personalizedPage`). 0 = ViewerID.
	SessionUserID int
	// IDs is the feed-service hydrate (feedHydrateQuery): exactly these images, whatever their order.
	IDs []int
	// PostIDs is the gallery's post completion, or image.getInfinite's own `postIds`: only these
	// posts' images.
	PostIDs []int
	// PostID is the input's own `postId` (the REST endpoint): `i."postId" = <postId>`.
	PostID int
	// ImageID is the REST endpoint's `imageId` (0 = none): `i.id = <imageId>`, after the post clauses.
	// getAllImages marks that query personalized, so it is never cached.
	ImageID int
	// RequiringMeta is the input's `requiringMeta` (getAllImages, every caller that spreads its input:
	// image.getInfinite's Postgres page, the gallery's page and its pinned and sponsored posts, the
	// REST endpoint's legacy path): `i."blockedFor" = 'AiNotVerified'`, after the visibility gates.
	// With Domain "red" those gates (the level and the reviewed clause) are left out for it.
	RequiringMeta bool
	// Domain is getAllImages' `domain` (getRequestBoardDomainColor of the request's host; "" when the
	// caller passes none, as the REST endpoint does). Read only beside RequiringMeta.
	Domain string
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
	// `prioritizedUserIds`): no ImageResourceNew join for the model scope; `p."modelVersionId" =
	// <version>` when there is one; only these creators' images, ordered oldest post first, then by
	// index and id (PrioritizedSystemOrder replaces those two for the system user alone). The cursor
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
	// CollectionID is image.getInfinite's `collectionId`, after the read permission was granted: the
	// collection's image items as the `ct` CTE, joined on the image, with their note, status and
	// adder selected. Its items are the ACCEPTED ones, and for a signed-in viewer also the ones they
	// added that are not REJECTED. In a collection the viewer's own acceptableMinor images are kept,
	// and a moderator's view has no acceptableMinor clause. Not personalized: the query keeps its
	// cache policy (the viewer id is bound into it for a signed-in viewer).
	CollectionID int
	// CollectionTagID is `collectionTagId` (with a CollectionID only; 0 = none): only the items
	// carrying that tag.
	CollectionTagID int
	// NewCreators is image.getInfinite's `newCreators: true`: only the creators on the "new &
	// upcoming" board (NewCreatorUserIDs, `i."userId" = ANY(<board>)`, Node's `IN (…)`), or no row at
	// all for an empty board (`1 = 0`). Not personalized: the query keeps its cache policy.
	NewCreators       bool
	NewCreatorUserIDs []int
	// Reactions is image.getInfinite's `reactions` for a signed-in viewer (ViewerID): only the images
	// the viewer reacted to with one of them. Personalized: never cached. Without a viewer Node adds no
	// clause, so the caller leaves it empty.
	Reactions []string
	// PrioritizedSystemOrder is the prioritizeUser branch for the system user alone (-1) with no post
	// of its own on the version: no creator clause, and every creator's images ordered by
	// `IIF(i."userId" IN (-1), i.index, 1000)` ahead of the sort's own order. Only with
	// PrioritizedUserIDs = [-1].
	PrioritizedSystemOrder bool
	// RandomSeed is a collection page's Random order (Sort SortRandom, with a CollectionID): the seed
	// the `ct` CTE hashes each item id with (`abs(mod(hashtext(concat(ci.id::text, '<seed>')),
	// 1000000000))`, its "sortKey"), ordered `ct."sortKey" DESC, i."id" DESC`, the sort key selected as
	// the cursor column. Never cached (isPersonalized).
	RandomSeed int64
	// RandomCursor pages a Random collection page inside the CTE: `"sortKey" < <sortKey> OR ("sortKey"
	// = <sortKey> AND "imageId" < <id>)`; nil = the first page. Its Seed is not read here (RandomSeed).
	RandomCursor *RandomCursor
	// PerVersionTopN reads a model scope (ModelID without a ModelVersionID) one version at a time: each
	// of the model's versions contributes its first Skip+Limit+1 matching rows in the page's order
	// (`CROSS JOIN LATERAL`, a newest-first or oldest-first index scan of the version's resource rows),
	// and those are merged, offset and limited (perVersionModelScope). Same rows as the single join
	// getAllImages runs, without reading the model's whole gallery first. Read only for the image-id
	// orders (none of IndexOrder, a collection, the prioritized branch).
	PerVersionTopN bool
}

// perVersionModelScope is whether Build reads the model scope per version (PerVersionTopN): only
// where the page's order is the resource row's image id, which each version's slice shares.
func (q *ImagesQuery) perVersionModelScope() bool {
	return q.PerVersionTopN && q.ModelID != 0 && q.ModelVersionID == 0 && len(q.PrioritizedUserIDs) == 0 &&
		q.CollectionID == 0 && !q.IndexOrder
}

// random is a collection page in the Random order.
func (q *ImagesQuery) random() bool {
	return q.Sort == SortRandom && q.CollectionID != 0
}

// reviewReactions is the ReviewReactions enum (the `reactions` schema's z.enum).
var reviewReactions = map[string]bool{"Like": true, "Dislike": true, "Laugh": true, "Cry": true, "Heart": true}

// Built is the SQL for one page plus its caching policy.
type Built struct {
	SQL       string
	Args      []any
	CacheTTL  time.Duration // 0 = not cached
	CacheTags []string
	// ThrowOnStatementTimeout: see ImagesQuery.
	ThrowOnStatementTimeout bool
	// PersonalizedViewerID is the viewer of a page only they see (their reactions, their own
	// gallery), else 0: a statement timeout on it is a fallback, never an empty page (FetchRows).
	PersonalizedViewerID int
	// Collection: the SQL selects the collection item columns after "cursorId" (a CollectionID).
	Collection bool
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
	collection := q.CollectionID != 0
	with := ""
	if collection {
		with = q.collectionCTE(a)
	}

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
		// blockedMediaListConditions({ userId: ownerId }): the owner keeps a blocked image, and any of
		// their own, only where ownerMediaAllowed allows it (#10505).
		and = append(and, hydrate.BlockedMediaListSQL(q.ViewerID, false, a.add)...)
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
	// minorMatureImageVisibleSql({ userId: ownerId, isModerator }), whatever DisableMinor says: on every
	// read built here (the page, the post completion, the pinned and sponsored posts, the feed-service
	// hydrate, the REST endpoint).
	and = append(and, hydrate.MinorMatureImageVisibleSQL("i", q.ViewerID, q.IsModerator, a.add))
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
	perVersion := q.perVersionModelScope()
	modelArg := ""
	// `!prioritizeUser && (modelId || modelVersionId)`: a prioritized request does not join the model.
	if !prioritized && (q.ModelID != 0 || q.ModelVersionID != 0) {
		from = `FROM "ImageResourceNew" irr`
		joins = append(joins, `JOIN "Image" i ON i.id = irr."imageId"`)
		switch {
		case q.ModelVersionID != 0:
			and = append(and, `irr."modelVersionId" = `+a.add(q.ModelVersionID))
			cacheTTL = 10 * time.Minute // CacheTTL.md
			tags = append(tags, "images-modelVersion:"+strconv.Itoa(q.ModelVersionID))
		case perVersion:
			// The version is the lateral's (perVersionModelScope); the model is the outer query's.
			and = append(and, `irr."modelVersionId" = mv.id`)
			modelArg = a.add(q.ModelID)
			cacheTTL = 10 * time.Minute
			tags = append(tags, "images-model:"+strconv.Itoa(q.ModelID))
		default:
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
	if q.NewCreators {
		// After the follow clause and before the tag scope, as in getAllImagesUncaptured: an empty
		// board is no row at all, never the unfiltered feed.
		if len(q.NewCreatorUserIDs) > 0 {
			and = append(and, `i."userId" = ANY(`+a.add(q.NewCreatorUserIDs)+`::int[])`)
		} else {
			and = append(and, `1 = 0`)
		}
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
	if q.ImageID != 0 {
		// getAllImages' `imageId` (the public API's), after the post clauses as there.
		and = append(and, `i.id = `+a.add(q.ImageID))
	}
	if len(q.ExcludedUsers) > 0 {
		and = append(and, `i."userId" != ALL(`+a.add(q.ExcludedUsers)+`::int[])`)
	}

	// The pending view of a moderator or a signed-in viewer (`effectivePending && (isModerator ||
	// ownerId)`).
	pendingView := q.Pending && (q.IsModerator || q.ViewerID != 0)
	reactions := len(q.Reactions) > 0 && q.ViewerID != 0
	if q.TargetUserID != 0 || len(q.FollowedUserIDs) > 0 || len(q.TagIDs) > 0 || q.ImageID != 0 || prioritized || pendingView || reactions || q.random() {
		// isPersonalized (the user-gallery path, a follow set, a tag combination, a single image,
		// prioritizedUserIds, the pending view, the viewer's own reactions, a collection's Random
		// order): never cached.
		cacheTTL, tags = 0, nil
	}

	var orderBy, cursorCol, cursorOp string
	switch {
	case q.IndexOrder:
		// getCursor('i."index"'): ascending, inclusive on its only field; the id tie-break is
		// appended after the cursor clause, so the cursor stays the index.
		orderBy, cursorCol, cursorOp = `i."index"`, `i."index"`, ">="
	case q.random():
		// The collection's items by their seeded hash, then the image id. The cursor is paged inside
		// the CTE (collectionCTE), never by a clause here: the caller leaves Cursor 0.
		orderBy, cursorCol, cursorOp = `ct."sortKey" DESC, i."id" DESC`, `ct."sortKey"`, "<="
	case q.Sort == SortRecentlyAdded:
		// The collection's newest items first (only beside a collectionId: ParseInfinite), the cursor
		// on the item id (getCursor, descending and inclusive).
		orderBy, cursorCol, cursorOp = `ct."collectionItemId" DESC`, `ct."collectionItemId"`, "<="
	case perVersion && q.Sort == SortOldest:
		// i."id" ASC, spelled on the resource row (the same value) so each version's slice is an index
		// scan of its resource rows from the cursor up.
		orderBy, cursorCol, cursorOp = `irr."imageId" ASC`, `irr."imageId"`, ">="
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
		// After getCursor, so the cursor column is still the sort's.
		if q.ModelVersionID != 0 {
			and = append(and, `p."modelVersionId" = `+a.add(q.ModelVersionID))
		}
		if q.PrioritizedSystemOrder {
			// The system user alone, with no post of its own on the version: every creator's images,
			// the system user's first by their index. Node inlines the joined id list (`-1`).
			orderBy = `IIF(i."userId" IN (-1), i.index, 1000),  ` + orderBy
		} else {
			and = append(and, `i."userId" = ANY(`+a.add(q.PrioritizedUserIDs)+`::int[])`)
			orderBy = `(i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"` // oldest post first
		}
	}
	if reactions {
		// `userId && reactions?.length`, after the prioritizeUser branch: the viewer's own reactions,
		// read first as an array (ARRAY(), as in Node, so the plan starts from them).
		and = append(and, `i.id = ANY(ARRAY(
      SELECT ir."imageId" FROM "ImageReaction" ir
      WHERE ir."userId" = `+a.add(q.ViewerID)+` AND ir.reaction = ANY(`+a.add(q.Reactions)+`::text[]::"ReviewReactions"[])
    ))`)
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
		and = append(and, `i."needsReview" IS NULL`)
		switch {
		case !collection:
			and = append(and, `i."acceptableMinor" = FALSE`)
		case q.IsModerator:
			// In a collection a moderator still sees an acceptableMinor image: no clause.
		case q.ViewerID != 0:
			// In a collection the image's owner still sees it.
			and = append(and, `(i."acceptableMinor" = FALSE OR i."userId" = `+a.add(q.ViewerID)+`)`)
		default:
			and = append(and, `i."acceptableMinor" = FALSE`)
		}
		// `if (!requiringMeta || domain !== 'red')`: a metadata-blocked image reads Blocked for its
		// ingestion and its level, which these gates drop, so only red, which shows every level, lists it.
		if !q.RequiringMeta || q.Domain != "red" {
			and = append(and, `(i."nsfwLevel" & `+a.add(browsingLevel)+`) != 0 AND i."nsfwLevel" != 0`)
			and = append(and, hydrate.ImageReviewedSQL("i"))
		}
	}
	if q.RequiringMeta {
		// `if (requiringMeta) AND.push(i."blockedFor" = BlockedReason.AiNotVerified)`, after the gates.
		and = append(and, `i."blockedFor" = `+a.add("AiNotVerified"))
	}

	restrictedOwnerSQL := ""
	if q.ViewerID != 0 {
		restrictedOwnerSQL = ` OR i."userId" = ` + a.add(q.ViewerID)
	}

	collectionCols, collectionJoin := "", ""
	if collection {
		collectionCols = `, ct.note as "collectionItemNote", ct.status as "collectionItemStatus", ct."addedById" as "collectionItemAddedById"`
		collectionJoin = `
    JOIN ct ON ct."imageId" = i.id`
	}

	offset := ""
	if q.Skip > 0 {
		// Inlined, as Node does: an int, never request text.
		offset = `
    OFFSET ` + strconv.Itoa(q.Skip)
	}

	selectSQL := `
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
      image_sort_at(p."publishedAt", i."scannedAt", i."createdAt", i."firstVisibleAt") as "sortAt",
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
      ` + cursorCol + ` "cursorId"` + collectionCols + `
    ` + from + `
    ` + strings.Join(joins, "\n    ") + `
    JOIN "Post" p ON p.id = i."postId"` + collectionJoin + `
    WHERE ` + strings.Join(and, " AND ") + `
      -- An R+ image on a license-restricted base model is its uploader's alone.
      AND (
        (i."nsfwLevel" & ` + strconv.Itoa(browsing.NSFWLevels) + `) = 0
        OR NOT i."modelRestricted"` + restrictedOwnerSQL + `
      )
    ORDER BY ` + orderBy

	var sql string
	if perVersion {
		// getAllImages' model scope is one join over every resource row of the model's versions, sorted
		// and then limited: Postgres reads the whole gallery first. The page is the same rows read per
		// version: a row of the page is among its own version's first Skip+Limit+1 in the page's order
		// (one resource row per image and version, the primary key), so each version contributes those
		// and the merge keeps the order, the offset and the limit. An image the model's versions share
		// is one row per version, as in the join; its rows are identical (nothing per version is
		// selected), so their order among themselves cannot show.
		dir := "DESC"
		if q.Sort == SortOldest {
			dir = "ASC"
		}
		sql = with + `
    SELECT t.* FROM "ModelVersion" mv
    CROSS JOIN LATERAL (` + selectSQL + `
    LIMIT ` + a.add(q.Skip+q.Limit+1) + `
    ) t
    WHERE mv."modelId" = ` + modelArg + `
    ORDER BY t."cursorId" ` + dir + offset + `
    LIMIT ` + a.add(q.Limit+1)
	} else {
		sql = with + selectSQL + offset + `
    LIMIT ` + a.add(q.Limit+1)
	}

	// personalizedPage: `!!userId && (reactions || targetUserId === userId)`, userId the session user.
	sessionUser := q.ViewerID
	if q.SessionUserID != 0 {
		sessionUser = q.SessionUserID
	}
	personalizedViewer := 0
	if sessionUser != 0 && (reactions || q.TargetUserID == sessionUser) {
		personalizedViewer = sessionUser
	}
	return Built{SQL: sql, Args: a.args, CacheTTL: cacheTTL, CacheTags: tags, ThrowOnStatementTimeout: q.ThrowOnStatementTimeout,
		PersonalizedViewerID: personalizedViewer, Collection: collection}
}

// collectionCTE is getAllImagesUncaptured's `ct` CTE for a collection page outside the Random sort
// (an empty seed in the sortKey hash, no cursor clause and no ORDER BY inside it): the collection's
// image items, narrowed to CollectionTagID when set, with the status filter `ci."status" = 'ACCEPTED'`,
// or for a signed-in viewer `(ci."status" = 'ACCEPTED' OR (ci."status" <> 'REJECTED' AND
// ci."addedById" = <viewer>))`. Node inlines the tag and the viewer; both are bound here.
//
// In the Random order (random) the hash takes the seed (Node inlines `'<seed>'`; bound here as text,
// first, as the text reads), the CTE pages on its Random cursor (`WHERE ("sortKey" < <key> OR
// ("sortKey" = <key> AND "imageId" < <id>))`, both inlined in Node, bound here) and ends with `ORDER BY
// "sortKey" DESC`.
func (q *ImagesQuery) collectionCTE(a *sqlArgs) string {
	seed := `''`
	if q.random() {
		seed = a.add(strconv.FormatInt(q.RandomSeed, 10)) + `::text`
	}
	// Bound in the order the text reads: the collection, the tag, the viewer.
	collection := a.add(q.CollectionID)
	tag := ""
	if q.CollectionTagID != 0 {
		tag = `
              AND ci."tagId" = ` + a.add(q.CollectionTagID)
	}
	status := `(ci."status" = 'ACCEPTED')`
	if q.ViewerID != 0 {
		status = `(ci."status" = 'ACCEPTED' OR (ci."status" <> 'REJECTED' AND ci."addedById" = ` + a.add(q.ViewerID) + `))`
	}
	tail := ""
	if q.random() {
		if c := q.RandomCursor; c != nil {
			key, id := a.add(c.SortKey), a.add(c.ID)
			tail += `
          WHERE (
                  "sortKey" < ` + key + `
                  OR (
                    "sortKey" = ` + key + `
                    AND "imageId" < ` + id + `
                  )
                )`
		}
		tail += `
          ORDER BY "sortKey" DESC`
	}
	return `WITH
        ct AS (
          SELECT "imageId", note, status, "addedById", "collectionItemId", "sortKey"
          FROM (
            SELECT
              ci."imageId",
              ci.note,
              ci.status,
              ci."addedById",
              ci.id as "collectionItemId",
              abs(mod(hashtext(concat(ci.id::text, ` + seed + `)), 1000000000)) as "sortKey"
            FROM "CollectionItem" ci
            WHERE ci."collectionId" = ` + collection + tag + `
              AND ci."imageId" IS NOT NULL
              AND ` + status + `
          ) sub` + tail + `
        )`
}

// nsfwLevelBlocked is NsfwLevel.Blocked (src/server/common/enums.ts).
const nsfwLevelBlocked = 32

// pendingViewerSQL is pendingViewerImageSql({ userId, browsingLevel }) (collection-review.sql.ts,
// with pendingOthersImageConditions from common/image-visibility.ts), without a reviewCollectionId
// (server-set, never on image.getInfinite): another creator's image must not await review, not be
// acceptableMinor, and be reviewed if rated; the viewer's own are exempt (held ones included: a feed-go
// viewer is always a cookie session, the owner's view), and shown unrated; a rated,
// reviewed image of a post in a collection the viewer MANAGEs shows above browsingLevel.
func pendingViewerSQL(a *sqlArgs, viewerID, browsingLevel int) string {
	own := func() string { return `i."userId" = ` + a.add(viewerID) }
	return `((i."needsReview" IS NULL OR i."needsReview" NOT IN (` + a.add("csam") + `, ` + a.add("minor") + `) OR ` + own() + `) AND (i."needsReview" IS NULL OR ` + own() + `) AND (i."acceptableMinor" = FALSE OR ` + own() + `) AND (` + own() +
		` OR i."nsfwLevel" = 0 OR ` + hydrate.ImageReviewedSQL("i") + `)
    AND ((i."nsfwLevel" & ` + a.add(browsingLevel) + `) != 0 OR (i."nsfwLevel" = 0 AND ` + own() +
		`) OR (p."collectionId" IS NOT NULL AND i."nsfwLevel" NOT IN (0, ` + a.add(nsfwLevelBlocked) + `) AND (i."acceptableMinor" = FALSE OR ` + own() +
		`) AND EXISTS (SELECT 1 FROM "CollectionContributor" cc WHERE cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[] AND cc."collectionId" = p."collectionId" AND cc."userId" = ` + a.add(viewerID) + `))))`
}

// imageOnSiteSQL is imageOnSiteSql('i.meta'), shared with the version showcase lookup.
const imageOnSiteSQL = hydrate.ImageOnSiteSQL
