package feed

import (
	"bytes"
	"encoding/json"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// image.getInfinite's `collectionId` (getAllImagesUncaptured in src/server/services/image.service.ts):
// requiresImageDbPath sends it to Postgres, where the viewer's read permission is checked
// (getUserCollectionPermissionsById, prefetched beside the other reads), no read is the empty page,
// and the page query joins the collection's CollectionItem rows as the `ct` CTE.

// SortRecentlyAdded is ImageSort.RecentlyAdded: `ct."collectionItemId" DESC`. Node refuses it without
// a collectionId (BAD_REQUEST), so ParseInfinite accepts it only beside one.
const SortRecentlyAdded = "Recently Added"

// CollectionItem is the collection columns the page query selects for a collection page
// (`ct.note`, `ct.status`, `ct."addedById"`). Nil on a row of any other query.
type CollectionItem struct {
	Note      *string `json:"note"`
	Status    string  `json:"status"`
	AddedByID *int    `json:"addedById"`
}

// collectionReadable is `getUserCollectionPermissionsById({ userId, isModerator, id }).read` for the
// cases this service answers. Node grants read when the collection's `read` is Public or Unlisted,
// when the viewer owns it, when the viewer is a moderator, or when the viewer's contributor row holds
// VIEW; a collection that does not exist reads for no one (createEmptyPermissions).
//
// The first two are read here, and so is the absence of all four (false: Node's empty page). A read
// granted only by the moderator branch or only by a contributor row falls back
// (`collection-moderator`, `collection-contributor`): a private collection's items are served only to
// its owner. viewer is the zero Viewer when signed out (no owner, contributor or moderator branch).
func collectionReadable(p *hydrate.CollectionPermission, viewer Viewer) (bool, error) {
	if p == nil {
		return false, nil
	}
	if p.Read == "Public" || p.Read == "Unlisted" {
		return true, nil
	}
	if viewer.ID == 0 {
		return false, nil
	}
	if viewer.ID == p.OwnerID {
		return true, nil
	}
	if viewer.IsModerator {
		return false, fallback.New("collection-moderator")
	}
	for _, perm := range p.Contributor {
		if perm == "VIEW" {
			return false, fallback.New("collection-contributor")
		}
	}
	return false, nil
}

// judgeScoreNull reports whether parseJudgeScore(note) (src/server/games/daily-challenge/
// daily-challenge.utils.ts: `JSON.parse(note)?.score ?? null`, null when the parse throws) is null:
// no note, a note that is not JSON, a JSON value that is not an object, or an object whose `score` is
// absent or null. Any other score (a judge's verdict) is not rebuilt here: the caller falls back.
func judgeScoreNull(note *string) bool {
	if note == nil || *note == "" {
		return true // `if (!note) return null`
	}
	raw := []byte(*note)
	if !json.Valid(raw) {
		return true // JSON.parse throws: caught, null
	}
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return true // null, a number, a string, a boolean or an array: `.score` is undefined
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false // valid but unreadable as an object: not answered here
	}
	score, ok := obj["score"] // a repeated key: the last one, as JSON.parse keeps
	return !ok || string(bytes.TrimSpace(score)) == "null"
}
