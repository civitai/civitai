package beacon

import (
	"math"

	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// pageViewBody is pageViewBeaconSchema's output (src/server/schema/track.schema.ts).
type pageViewBody struct {
	ads                                 bool
	duration, windowWidth, windowHeight float64
	path                                string
}

// numberOrNumericString: a finite number, or a string whose Number() is finite; anything else
// (absent, boolean, null, object, a non-numeric string, ±Infinity) is 0 (`.catch(0)`).
func numberOrNumericString(v jsvalue.Value, present bool) float64 {
	if !present {
		return 0
	}
	var n float64
	switch v.Kind {
	case jsvalue.Number:
		n = v.N
	case jsvalue.String:
		n = jsvalue.StringToNumber(v.S)
	default:
		return 0
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return n
}

// parsePageView is pageViewBeaconSchema.safeParse: an object (not null, not an array) whose `path`
// is a string; `ads` a boolean else false; the three dimensions numberOrNumericString.
func parsePageView(v jsvalue.Value) (pageViewBody, bool) {
	if !v.IsPlainObject() {
		return pageViewBody{}, false
	}
	path, ok := v.O.Get("path")
	if !ok || path.Kind != jsvalue.String {
		return pageViewBody{}, false
	}
	out := pageViewBody{path: path.S}
	if a, ok := v.O.Get("ads"); ok && a.Kind == jsvalue.Bool {
		out.ads = a.B
	}
	d, ok := v.O.Get("duration")
	out.duration = numberOrNumericString(d, ok)
	w, ok := v.O.Get("windowWidth")
	out.windowWidth = numberOrNumericString(w, ok)
	h, ok := v.O.Get("windowHeight")
	out.windowHeight = numberOrNumericString(h, ok)
	return out, true
}

// VIEW_TYPES and VIEW_ENTITY_TYPES (track.schema.ts), and addViewSchema's `ads` enum.
var (
	viewTypes = set("ProfileView", "ImageView", "PostView", "ModelView", "ModelVersionView",
		"ArticleView", "CollectionView", "BountyView", "BountyEntryView", "ComicProjectView",
		"ComicChapterView", "Model3DView")
	viewEntityTypes = set("User", "Image", "Post", "Model", "ModelVersion", "Article", "Collection",
		"Bounty", "BountyEntry", "ComicProject", "ComicChapter", "Model3D")
	viewAds = set("Member", "Blocked", "Served", "Off")
)

func set(vals ...string) map[string]bool {
	m := make(map[string]bool, len(vals))
	for _, v := range vals {
		m[v] = true
	}
	return m
}

// TrackDetailsMaxChars is TRACK_DETAILS_MAX_CHARS (256 KiB of JSON characters).
const TrackDetailsMaxChars = 256 * 1024

// addViewKeys are addViewSchema's keys in shape order: the order zod writes its output in.
var addViewKeys = []string{"type", "entityType", "entityId", "ads", "nsfw", "details", "nsfwLevel", "browsingLevel"}

func isEnum(v jsvalue.Value, allowed map[string]bool) bool {
	return v.Kind == jsvalue.String && allowed[v.S]
}

// isFiniteNumber is zod v4's z.number(): a number, not NaN, finite.
func isFiniteNumber(v jsvalue.Value) bool {
	return v.Kind == jsvalue.Number && !math.IsNaN(v.N) && !math.IsInf(v.N, 0)
}

// parseAddView is addViewSchema.safeParse (zod 4): the output object, with only the keys the input
// carried, in shape order. `details` is a loose object copied in the input's own key order without a
// top-level `__proto__` key (zod's catchall skips it), refused when its JSON is longer than
// TRACK_DETAILS_MAX_CHARS or measureJsonLength's value budget (half that) runs out.
func parseAddView(v jsvalue.Value) (*jsvalue.Object, bool) {
	if !v.IsPlainObject() {
		return nil, false
	}
	in := v.O
	get := func(k string) (jsvalue.Value, bool) { return in.Get(k) }
	if t, ok := get("type"); !ok || !isEnum(t, viewTypes) {
		return nil, false
	}
	if t, ok := get("entityType"); !ok || !isEnum(t, viewEntityTypes) {
		return nil, false
	}
	if n, ok := get("entityId"); !ok || !isFiniteNumber(n) {
		return nil, false
	}
	if a, ok := get("ads"); ok && !isEnum(a, viewAds) {
		return nil, false
	}
	if b, ok := get("nsfw"); ok && b.Kind != jsvalue.Bool {
		return nil, false
	}
	for _, k := range []string{"nsfwLevel", "browsingLevel"} {
		if n, ok := get(k); ok && !isFiniteNumber(n) {
			return nil, false
		}
	}
	out := jsvalue.NewObject()
	for _, k := range addViewKeys {
		val, ok := get(k)
		if !ok {
			continue
		}
		if k == "details" {
			if !val.IsPlainObject() {
				return nil, false
			}
			d := jsvalue.NewObject()
			for _, dk := range val.O.Keys() {
				if dk == "__proto__" {
					continue
				}
				dv, _ := val.O.Get(dk)
				d.Set(dk, dv)
			}
			val = jsvalue.ObjectValue(d)
			if !withinDetailsLimit(val) {
				return nil, false
			}
		}
		out.Set(k, val)
	}
	return out, true
}

// withinDetailsLimit is measureJsonLength([details], TRACK_DETAILS_MAX_CHARS) !== 'over' for a
// JSON-parsed value: the JSON.stringify length in UTF-16 units is at most the limit, and the walk
// visits at most half that many values (its default value budget).
func withinDetailsLimit(v jsvalue.Value) bool {
	if jsvalue.CountNodes(v) > TrackDetailsMaxChars/2 {
		return false
	}
	return jsvalue.UTF16Len(string(jsvalue.Stringify(v))) <= TrackDetailsMaxChars
}
