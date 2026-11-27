package feed

import (
	"math"
	"regexp"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
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

// judgeScore is parseJudgeScore(note) (src/server/games/daily-challenge/daily-challenge.utils.ts:
// `JSON.parse(note)?.score ?? null`, null when the parse throws) as a wire value: nil for no note, a
// note that is not JSON, a JSON value that is not an object, or an object whose `score` is absent or
// null; else the score as superjson writes the parsed value (objects in JS property order, a repeated
// key's last value). ok is false for a score this service does not rebuild byte for byte: a number
// superjson annotates (-0, or one past float64, which JSON.parse reads as ±Infinity), a `__proto__`
// key, and a note escaping a lone surrogate (Go's decoder replaces it, JSON.parse keeps it).
func judgeScore(note *string) (score any, ok bool) {
	if note == nil || *note == "" {
		return nil, true
	}
	if surrogateEscape.MatchString(*note) {
		return nil, false
	}
	v, err := jspack.FromJSON(*note)
	if err != nil {
		return nil, true // JSON.parse throws: null
	}
	obj, isObj := v.(jspack.Obj)
	if !isObj {
		return nil, true // `parsed?.score` of a string, number, boolean, array or null: undefined
	}
	s, present := obj.Get("score")
	if !present || s == nil {
		return nil, true
	}
	if !judgeScoreModelled(s) {
		return nil, false
	}
	w, err := hydrate.JSWire(s)
	if err != nil {
		return nil, false
	}
	return w, true
}

// surrogateEscape is a `\uD800`–`\uDFFF` escape (case-insensitive hex): an escaped surrogate half.
// A valid pair is two such escapes too; both are refused rather than told apart.
var surrogateEscape = regexp.MustCompile(`\\u[dD][89a-fA-F][0-9a-fA-F]{2}`)

// judgeScoreModelled reports whether v holds only values superjson writes as plain JSON here.
func judgeScoreModelled(v any) bool {
	switch t := v.(type) {
	case float64:
		return !math.IsInf(t, 0) && !math.IsNaN(t) && !(t == 0 && math.Signbit(t))
	case jspack.Obj:
		for _, kv := range t {
			if kv.K == "__proto__" || !judgeScoreModelled(kv.V) {
				return false
			}
		}
		return true
	case []any:
		for _, e := range t {
			if !judgeScoreModelled(e) {
				return false
			}
		}
		return true
	case nil, string, bool:
		return true
	}
	return false
}
