package feed

import (
	"bytes"
	"encoding/json"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

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
//
// infiniteFromDB reads the permission and decides it here before the page query runs, so no
// collection row is fetched for a collection the viewer may not read (Node prefetches the permission
// in parallel with its other reads, and checks it before running the page query). A page holding a
// judged item falls back after the page query ran (`collection-judge-score`, fetchInfiniteRows).
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

// judgeScore is a stub over judgeScoreNull (the port is not written yet).
func judgeScore(note *string) (any, bool) { return nil, judgeScoreNull(note) }

// judgeScoreNull reports whether parseJudgeScore(note) (src/server/games/daily-challenge/
// daily-challenge.utils.ts: `JSON.parse(note)?.score ?? null`, null when the parse throws) is null:
// no note, a note that is not JSON, a JSON value that is not an object, or an object whose `score` is
// absent or null. Any other score (a judge's verdict) is not rebuilt here: the caller falls back.
func judgeScoreNull(note *string) bool {
	if note == nil || *note == "" {
		return true
	}
	raw := []byte(*note)
	if !json.Valid(raw) {
		return true
	}
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return true
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false
	}
	score, ok := obj["score"] // a repeated key: the last one, as JSON.parse keeps
	return !ok || string(bytes.TrimSpace(score)) == "null"
}
