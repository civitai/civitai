package sitesearch

import (
	"slices"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

// The index uids (src/server/common/constants.ts; MODELS_SEARCH_INDEX in
// packages/civitai-shared/src/search-index-queue.ts).
const (
	ModelsIndex      = "models_v9"
	ImagesIndex      = "images_v6"
	ArticlesIndex    = "articles_v5"
	UsersIndex       = "users_v3"
	CollectionsIndex = "collections_v3"
	BountiesIndex    = "bounties_v3"
	ToolsIndex       = "tools_v2"
	ComicsIndex      = "comics_v1"
)

// Indexes is SITE_SEARCH_INDEXES (site-search.service.ts): the indexes the site's search UI may query,
// less RETIRED_SEARCH_INDEXES (images_v6, metrics_images_v1). Any other uid is refused by Node (403
// index_not_accessible), and falls back here.
var Indexes = []string{ModelsIndex, ArticlesIndex, UsersIndex, CollectionsIndex, BountiesIndex, ToolsIndex, ComicsIndex}

// IsSearchable reports whether uid is one of Indexes.
func IsSearchable(uid string) bool { return slices.Contains(Indexes, uid) }

// Viewer is SiteSearchViewer (site-search.service.ts): what scopes a search, all of it from the
// session and the host, never from the request body.
type Viewer struct {
	// UserID is the signed-in viewer's id (restOwnerOrModeratorViewer), 0 when signed out.
	UserID int
	// IsModerator skips the POI and privacy clauses, not the browsing-level cap.
	IsModerator bool
	// Cap is the most this request may be served (requestDomainBrowsingLevelCap); 0 = none.
	Cap int
	// CollectionImageLevel is collectionImageLevelFor's value; 0 = none.
	CollectionImageLevel int
	// ShowSfwFace: model hits carry their civitai.com face (`sfwName`) as their `name`.
	ShowSfwFace bool
}

// Session is what the viewer is derived from: the session user's fields the handler reads and the
// host's rules. SignedIn is false for no session; a banned session never gets here (Node refuses it
// with a 403, which falls back).
type Session struct {
	SignedIn    bool
	ID          int
	IsModerator bool
	// BrowsingLevel and ShowNsfw are the session user's saved `browsingLevel` (0 when absent) and
	// `showNsfw`.
	BrowsingLevel int
	ShowNsfw      bool
	// CanViewNsfw is the request's `canViewNsfw` feature (browsing.CanViewNsfw).
	CanViewNsfw bool
}

// ViewerLevel is getRequestBrowsingLevel (src/server/utils/browsing-level.ts, getServerBrowsingLevel):
// where NSFW is not viewable, SFW signed in and PG signed out; elsewhere the saved level (held to the
// selectable levels unless a moderator's) when showNsfw is on and the level is set, else PG.
func ViewerLevel(s Session) int {
	if !s.CanViewNsfw {
		if s.SignedIn {
			return browsing.SFWLevels
		}
		return browsing.PublicLevels
	}
	if !s.SignedIn {
		return browsing.PublicLevels
	}
	saved := s.BrowsingLevel
	if saved != 0 && !s.IsModerator {
		saved = browsing.OnlySelectable(saved)
	}
	if s.ShowNsfw && saved != 0 {
		return saved
	}
	return browsing.PublicLevels
}

// ViewerOf is the handler's SiteSearchViewer for a session.
func ViewerOf(s Session) Viewer {
	// requestDomainBrowsingLevelCap: the verified-crawler header never reaches this route (the API
	// request policy removes it on a path that is not bot-aware), so only the session authorizes.
	cap := browsing.DomainCap(s.SignedIn, s.CanViewNsfw)
	level := ViewerLevel(s)
	v := Viewer{
		Cap: cap,
		// !Flags.intersects(level, nsfwBrowsingLevelsFlag)
		ShowSfwFace: level&browsing.NSFWLevels == 0,
	}
	if s.SignedIn {
		v.UserID = s.ID
		v.IsModerator = s.IsModerator
	}
	// collectionImageLevelFor: only where the site caps nothing, for a signed-in non-moderator, and only
	// when the level is not every level (effectiveBrowsingCeiling(all, level) = all & level).
	if cap == 0 && s.SignedIn && !s.IsModerator {
		if l := browsing.AllLevels & level; l|browsing.AllLevels != l {
			v.CollectionImageLevel = l
		}
	}
	return v
}

// levelBits is the NsfwLevel enum's values in declaration order (LEVEL_BITS, search-filters.ts).
var levelBits = []int{browsing.PG, browsing.PG13, browsing.R, browsing.X, browsing.XXX, browsing.Blocked}

// browsingLevelAttribute is BROWSING_LEVEL_ATTRIBUTE by index uid: users and tools have none.
func browsingLevelAttribute(uid string) string {
	switch uid {
	case ModelsIndex, ImagesIndex, ArticlesIndex, CollectionsIndex, BountiesIndex, ComicsIndex:
		return "nsfwLevel"
	}
	return ""
}

// IndexBrowsingLevelClause is indexBrowsingLevelClause (src/components/Search/search-filters.ts): ""
// for an index with no level attribute or a level with no bit. Comics match by subset (every level of
// the item inside the cap, an unrated one out); every other index by any bit.
func IndexBrowsingLevelClause(uid string, level int) string {
	attr := browsingLevelAttribute(uid)
	if attr == "" {
		return ""
	}
	// Flags.instanceToArray: the level's bits, lowest first (32 possible values).
	var bits []int
	for i := 0; i < 32; i++ {
		if b := 1 << i; level&b != 0 {
			bits = append(bits, b)
		}
	}
	if len(bits) == 0 {
		return ""
	}
	if uid == ComicsIndex {
		var outside []string
		for _, b := range levelBits {
			if b&level == 0 {
				outside = append(outside, strconv.Itoa(b))
			}
		}
		clause := attr + " IS NOT EMPTY"
		if len(outside) > 0 {
			clause += " AND " + attr + " NOT IN [" + strings.Join(outside, ", ") + "]"
		}
		return clause
	}
	parts := make([]string, len(bits))
	for i, b := range bits {
		parts[i] = attr + "=" + strconv.Itoa(b)
	}
	return strings.Join(parts, " OR ")
}

// Clauses is viewerSearchClauses: what every query on uid is held to. Moderators skip the POI and
// privacy clauses on models; everyone is held to the cap.
func Clauses(uid string, v Viewer) []string {
	var clauses []string
	if !v.IsModerator && uid == ModelsIndex {
		own := ""
		if v.UserID > 0 {
			own = " OR user.id = " + strconv.Itoa(v.UserID)
		}
		clauses = append(clauses, "poi != true"+own, "availability != Private"+own)
	}
	if v.Cap != 0 {
		if c := IndexBrowsingLevelClause(uid, v.Cap); c != "" {
			clauses = append(clauses, c)
		}
	}
	return clauses
}

// HitsNeedShaping is hitsNeedShaping: model hits always (their `sfwName` is never sent); collection
// hits under a cap or a collection image level; comic, bounty, article and user hits under a cap; any
// other index never.
func HitsNeedShaping(uid string, v Viewer) bool {
	switch uid {
	case ModelsIndex:
		return true
	case CollectionsIndex:
		return v.Cap != 0 || v.CollectionImageLevel != 0
	case ComicsIndex, BountiesIndex, ArticlesIndex, UsersIndex:
		return v.Cap != 0
	}
	return false
}
