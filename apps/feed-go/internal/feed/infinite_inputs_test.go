package feed

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// `baseModels` is z.string().array(): image.getInfinite reads it, kept as sent (getAllImages binds the
// whole list; the feed query drops the empty names). A value the schema rejects is Node's BAD_REQUEST
// (input-invalid). The posts gallery does not read it yet and still falls back.
func TestParseInfiniteBaseModels(t *testing.T) {
	for _, c := range []struct {
		input string
		want  []string
	}{
		{`{"limit":10}`, nil},
		{`{"baseModels":[]}`, []string{}},
		{`{"baseModels":["Pony"]}`, []string{"Pony"}},
		// Order, repeats and an empty name as sent; any string (the schema has no enum).
		{`{"baseModels":["SDXL 1.0","","Pony","SDXL 1.0"]}`, []string{"SDXL 1.0", "", "Pony", "SDXL 1.0"}},
		{`{"baseModels":["Not A Real Base Model ~*"]}`, []string{"Not A Real Base Model ~*"}},
	} {
		in, err := ParseInfinite(parseObj(t, c.input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", c.input, fallback.Reason(err), err)
			continue
		}
		if !reflect.DeepEqual(in.BaseModels, c.want) {
			t.Errorf("ParseInfinite %s: BaseModels = %#v, want %#v", c.input, in.BaseModels, c.want)
		}
	}
	for input, want := range map[string]string{
		`{"baseModels":"Pony"}`:             "input-invalid",
		`{"baseModels":null}`:               "input-invalid",
		`{"baseModels":42}`:                 "input-invalid",
		`{"baseModels":{"0":"Pony"}}`:       "input-invalid",
		`{"baseModels":["Pony",null]}`:      "input-invalid",
		`{"baseModels":[1]}`:                "input-invalid",
		`{"baseModels":[["Pony"]]}`:         "input-invalid",
		`{"baseModels":["Pony"],"x":1}`:     "input-unknown-key",
		`{"baseModels":["Pony"],"ids":[1]}`: "input-ids", // another unported key still names the gap
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != want {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, want)
		}
	}
	// Scoped to image.getInfinite: the posts gallery still hands it back.
	if _, err := Parse(parseObj(t, `{"baseModels":["Pony"]}`)); fallback.Reason(err) != "input-baseModels" {
		t.Errorf("Parse with baseModels: reason %q (err %v), want input-baseModels", fallback.Reason(err), err)
	}
}

// The baseModels clause: getAllImagesUncaptured's EXISTS over the image's ImageResourceNew rows and
// their ModelVersion, the list bound once as sent, and the cache policy untouched (Node does not mark
// it personalized).
func TestBuildBaseModelsClause(t *testing.T) {
	const clause = `EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      RIGHT JOIN "ImageResourceNew" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
      WHERE mv."baseModel" = ANY($`
	base := ImagesQuery{Limit: 10, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 9}
	if b := base.Build(); strings.Contains(b.SQL, `mv."baseModel"`) {
		t.Fatal("no baseModels: the query must not read ModelVersion.baseModel")
	}
	empty := base
	empty.BaseModels = []string{}
	if b := empty.Build(); strings.Contains(b.SQL, `mv."baseModel"`) {
		t.Fatal("an empty baseModels list filters nothing (`baseModels?.length`)")
	}
	q := base
	q.BaseModels = []string{"SDXL 1.0", "", "SDXL 1.0"}
	b := q.Build()
	i := strings.Index(b.SQL, clause)
	if i < 0 {
		t.Fatalf("SQL lacks the baseModels clause:\n%s", b.SQL)
	}
	rest := b.SQL[i+len(clause):]
	end := strings.Index(rest, "::text[])\n    )")
	if end < 0 {
		t.Fatalf("baseModels clause not closed as `$n::text[]) )`:\n%s", b.SQL)
	}
	n, err := strconv.Atoi(rest[:end])
	if err != nil || n < 1 || n > len(b.Args) {
		t.Fatalf("baseModels clause binds %q, not one of the %d args", rest[:end], len(b.Args))
	}
	if got, ok := b.Args[n-1].([]string); !ok || !reflect.DeepEqual(got, []string{"SDXL 1.0", "", "SDXL 1.0"}) {
		t.Fatalf("baseModels clause binds %#v, want the list as sent", b.Args[n-1])
	}
	if strings.Count(b.SQL, `mv."baseModel"`) != 1 {
		t.Fatal("the baseModels clause must appear once")
	}
	// After the tools clause, as in getAllImagesUncaptured.
	q.Tools = []int{42}
	if s := q.Build().SQL; strings.Index(s, `"ImageTool"`) > strings.Index(s, `mv."baseModel"`) {
		t.Fatalf("baseModels clause before the tools clause:\n%s", s)
	}
	if b.CacheTTL != 10*time.Minute || !reflect.DeepEqual(b.CacheTags, []string{"images-modelVersion:9"}) {
		t.Fatalf("cache policy with baseModels = %v %v, want 10m [images-modelVersion:9]", b.CacheTTL, b.CacheTags)
	}
}

// Clients the site no longer ships send `useIndex` and `search` to image.getInfinite; zod strips both,
// so Node answers as if they were absent. ParseInfinite must too: each parses to exactly the Input
// the same request without it parses to. The values are none the parser could read into a field.
func TestParseInfiniteIgnoresStrippedLegacyKeys(t *testing.T) {
	const base = `{"limit":7,"sort":"Oldest","userId":9}`
	want, err := ParseInfinite(parseObj(t, base))
	if err != nil {
		t.Fatal(err)
	}
	if want.Limit != 7 || want.Sort != SortOldest || want.UserID != 9 {
		t.Fatalf("base input parsed as limit %d sort %q userId %d, want 7, Oldest, 9", want.Limit, want.Sort, want.UserID)
	}
	for _, extra := range []string{
		`"useIndex":true`,
		`"useIndex":false`,
		`"search":"red fox"`,
		`"search":null`,
		`"useIndex":true,"search":"x","view":"feed"`,
	} {
		input := base[:len(base)-1] + "," + extra + "}"
		got, err := ParseInfinite(parseObj(t, input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", input, fallback.Reason(err), err)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ParseInfinite %s = %+v, want the input without it: %+v", input, *got, *want)
		}
	}
	for input, reason := range map[string]string{
		`{"useIndex":true,"someNewFilter":1}`: "input-unknown-key",
		`{"search":"x","zzz":1}`:              "input-unknown-key",
		`{"useIndex":true,"hubId":5}`:         "input-hubId",
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != reason {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, reason)
		}
	}
	// Scoped to image.getInfinite: the posts gallery still falls back on them.
	for _, input := range []string{`{"useIndex":true}`, `{"search":"x"}`} {
		if _, err := Parse(parseObj(t, input)); fallback.Reason(err) != "input-unknown-key" {
			t.Errorf("Parse %s: reason %q (err %v), want input-unknown-key", input, fallback.Reason(err), err)
		}
	}
}

// Invariant guard (the parity condition, not the change): the legacy keys are ignored only because
// zod strips them, so none may be a getInfiniteImagesSchema key. A key the schema starts reading must
// be parsed instead, and feed-go must ship before the web change that adds it (DESIGN.md §5.1).
func TestStrippedLegacyKeysAreStrippedByZod(t *testing.T) {
	for _, k := range strippedLegacyKeys {
		if imagesSchema.Has(k) {
			t.Errorf("%s is a getInfiniteImagesSchema key now: parse it (or classify it) instead of ignoring it", k)
		}
		if !infiniteAbsentKeys[k] {
			t.Errorf("%s is not in infiniteAbsentKeys", k)
		}
	}
}

// `include` values getAllImagesUncaptured never reads ('count', 'report') leave image.getInfinite's
// answer as it is without them; the ones that hydrate more still fall back, and so does the posts
// gallery, which this change does not widen.
func TestParseInfiniteIncludeCountAndReport(t *testing.T) {
	for base, inputs := range map[string][]string{
		`{"include":["cosmetics","profilePictures"],"limit":3}`: {
			`{"include":["cosmetics","count","profilePictures"],"limit":3}`,
			`{"include":["report","cosmetics","profilePictures","count"],"limit":3}`,
		},
		// No 'cosmetics' left: the same as an include without it (no cosmetics read).
		`{"include":[],"limit":3}`: {
			`{"include":["count"],"limit":3}`,
			`{"include":["report","count"],"limit":3}`,
		},
	} {
		want, err := ParseInfinite(parseObj(t, base))
		if err != nil {
			t.Fatal(err)
		}
		for _, input := range inputs {
			m := parseObj(t, input)
			got, err := ParseInfinite(m)
			if err != nil {
				t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", input, fallback.Reason(err), err)
				continue
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("ParseInfinite %s = %+v, want the input without them: %+v", input, *got, *want)
			}
			// The caller's map is not edited.
			if fresh := parseObj(t, input); !reflect.DeepEqual(m, fresh) {
				t.Errorf("ParseInfinite %s edited its input to %v", input, m)
			}
		}
	}
	for input, reason := range map[string]string{
		`{"include":["cosmetics","count","tags","metaSelect"]}`: "input-include",
		`{"include":["cosmetics","metaSelect"]}`:                "input-include",
		`{"include":["cosmetics","notAnInclude"]}`:              "input-include",
		`{"include":["cosmetics",7]}`:                           "input-include",
		`{"include":"count"}`:                                   "input-invalid",
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != reason {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, reason)
		}
	}
	if _, err := Parse(parseObj(t, `{"include":["cosmetics","count"]}`)); fallback.Reason(err) != "input-include" {
		t.Errorf("Parse with include count: reason %q (err %v), want input-include", fallback.Reason(err), err)
	}
}

// `include: ['tags']` is answered on image.getInfinite (the votable tags are hydrated: IncludeTags),
// alone or beside the other includes, while the posts gallery still falls back on it with the value
// as the detail. Regression: before the port every one of these fell back with input-include.
func TestParseInfiniteIncludeTags(t *testing.T) {
	for _, c := range []struct {
		input                 string
		cosmetics, profilePic bool
	}{
		{`{"include":["cosmetics","tags"],"limit":3}`, true, false},
		{`{"include":["tags"]}`, false, false},
		{`{"include":["tags","profilePictures","cosmetics","count"]}`, true, true},
	} {
		in, err := ParseInfinite(parseObj(t, c.input))
		if err != nil {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want it parsed", c.input, fallback.Reason(err), err)
			continue
		}
		if !in.IncludeTags || in.IncludeCosmetics != c.cosmetics || in.IncludeProfilePictures != c.profilePic {
			t.Errorf("ParseInfinite %s: tags %v, cosmetics %v, profile pictures %v; want true, %v, %v",
				c.input, in.IncludeTags, in.IncludeCosmetics, in.IncludeProfilePictures, c.cosmetics, c.profilePic)
		}
	}
	// Without it the include is not read as asking for tags (the default and an explicit list).
	for _, input := range []string{`{}`, `{"include":["cosmetics","tagIds"]}`} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil || in.IncludeTags {
			t.Errorf("ParseInfinite %s: err %v, IncludeTags %v; want parsed without tags", input, err, in != nil && in.IncludeTags)
		}
	}
	// Another include still falls back, naming itself, with tags beside it.
	_, err := ParseInfinite(parseObj(t, `{"include":["tags","metaSelect"]}`))
	if fallback.Reason(err) != "input-include" || fallback.SafeDetail(err) != "metaSelect" {
		t.Errorf("ParseInfinite tags+metaSelect: reason %q detail %q, want input-include / metaSelect", fallback.Reason(err), fallback.SafeDetail(err))
	}
	// The gallery is not widened.
	for _, input := range []string{`{"include":["cosmetics","tags"]}`, `{"include":["tags","cosmetics","metaSelect"]}`} {
		_, err := Parse(parseObj(t, input))
		if fallback.Reason(err) != "input-include" || fallback.SafeDetail(err) != "tags" {
			t.Errorf("Parse %s: reason %q detail %q, want input-include / tags", input, fallback.Reason(err), fallback.SafeDetail(err))
		}
	}
}
