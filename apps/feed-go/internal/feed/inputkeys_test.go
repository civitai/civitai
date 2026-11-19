package feed

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
)

// ledgerProblems lists how the classified keys and the schema's keys differ, in EITHER direction: a
// key the app added must be read, made a fallback or knowingly ignored here, and a key it removed must
// be dropped from the lists. Also a key classified twice.
func ledgerProblems(schema []string, classified ...[]string) []string {
	out := make([]string, 0, len(schema))
	seen := map[string]int{}
	for _, list := range classified {
		for _, k := range list {
			seen[k]++
		}
	}
	inSchema := map[string]bool{}
	for _, k := range schema {
		inSchema[k] = true
		if seen[k] == 0 {
			out = append(out, "schema key "+k+" is not classified (read it, add it to the fallback list, or to the ignored list)")
		}
	}
	for k, n := range seen {
		if !inSchema[k] {
			out = append(out, "classified key "+k+" is not in the schema")
		}
		if n > 1 {
			out = append(out, "key "+k+" is classified more than once")
		}
	}
	sort.Strings(out)
	return out
}

func TestInputKeyLedger(t *testing.T) {
	for _, p := range ledgerProblems(imagesSchema.Keys(), parsedKeys, unsupportedKeys, ignoredKeys) {
		t.Errorf("getInfiniteImagesSchema: %s", p)
	}
	for _, p := range ledgerProblems(v1Schema.Keys(), v1ParsedKeys) {
		t.Errorf("imagesEndpointSchema: %s", p)
	}
	// Controls: the ledger goes red on a key added to the schema, one removed from it, and a duplicate.
	if got := ledgerProblems([]string{"limit", "newKey"}, []string{"limit"}); len(got) != 1 {
		t.Errorf("control (added key): %v", got)
	}
	if got := ledgerProblems([]string{"limit"}, []string{"limit", "goneKey"}); len(got) != 1 {
		t.Errorf("control (removed key): %v", got)
	}
	if got := ledgerProblems([]string{"limit"}, []string{"limit"}, []string{"limit"}); len(got) != 1 {
		t.Errorf("control (duplicate): %v", got)
	}
}

func parseObj(t *testing.T, s string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

// A key outside getInfiniteImagesSchema falls back, on both image procedures; the tRPC client's own
// keys (`authed`, `direction`) do not.
func TestParseUnknownKeyFallsBack(t *testing.T) {
	for _, c := range []struct {
		input string
		want  string
	}{
		{`{"limit":10,"someNewFilter":true}`, "input-unknown-key"},
		{`{"someNewFilter":null}`, "input-unknown-key"}, // present at all, whatever the value
		{`{"limit":10,"authed":true,"direction":"forward"}`, ""},
		{`{"limit":10,"cursor":"5"}`, ""},
	} {
		_, err := Parse(parseObj(t, c.input))
		if got := fallback.Reason(err); got != c.want || (c.want == "" && err != nil) {
			t.Errorf("Parse %s: reason %q (err %v), want %q", c.input, got, err, c.want)
		}
		_, err = ParseInfinite(parseObj(t, c.input))
		if got := fallback.Reason(err); got != c.want || (c.want == "" && err != nil) {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", c.input, got, err, c.want)
		}
	}
	// An unsupported key wins over an unknown one, so the reason names the parity gap; an empty value
	// of it is not one, and the unknown key then decides.
	for input, want := range map[string]string{
		`{"collectionId":5,"someNewFilter":1}`: "input-collectionId",
		`{"someNewFilter":1,"userId":7}`:       "input-userId",
		`{"hidden":true,"aNewKey":true}`:       "input-hidden",
		`{"userId":null,"someNewFilter":1}`:    "input-unknown-key",
	} {
		if _, err := Parse(parseObj(t, input)); fallback.Reason(err) != want {
			t.Errorf("unknown + unsupported %s: reason %q, want %q", input, fallback.Reason(err), want)
		}
	}
}

// The site's images feeds put their URL query into image.getInfinite's input, and four of its keys
// are not getInfiniteImagesSchema keys, so zod strips them and Node answers as if they were absent.
// ParseInfinite must too: each parses, to exactly the Input the same request without it parses to.
// The values are none of the schema's defaults and none of the base input's, so a parser that read
// one into a field would change the Input.
func TestParseInfiniteIgnoresStrippedURLKeys(t *testing.T) {
	const base = `{"limit":10,"sort":"Newest","userId":7}`
	want, err := ParseInfinite(parseObj(t, base))
	if err != nil {
		t.Fatal(err)
	}
	// Positive control: the base input is read, so a comparison against it can see a change.
	if want.Limit != 10 || want.Sort != SortNewest || want.UserID != 7 {
		t.Fatalf("base input parsed as limit %d sort %q userId %d, want 10, Newest, 7", want.Limit, want.Sort, want.UserID)
	}
	for _, extra := range []string{
		`"view":"feed"`,
		`"section":"reactions"`,
		`"query":"red fox in snow"`,
		`"similarTo":4242`,
		`"view":"categories","section":"images","query":"x","similarTo":"99"`,
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
	// Any other key outside the schema still falls back, alongside an ignored one too; and an
	// unsupported key still names the parity gap.
	for input, reason := range map[string]string{
		`{"limit":10,"view":"feed","someNewFilter":true}`: "input-unknown-key",
		`{"limit":10,"someNewFilter":true}`:               "input-unknown-key",
		`{"section":"images","collectionId":5}`:           "input-collectionId",
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != reason {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, reason)
		}
	}
	// Scoped to image.getInfinite: the posts gallery (Parse) still falls back on them.
	if _, err := Parse(parseObj(t, `{"limit":10,"view":"feed"}`)); fallback.Reason(err) != "input-unknown-key" {
		t.Errorf("Parse with view: reason %q (err %v), want input-unknown-key", fallback.Reason(err), err)
	}
}

// The URL keys ParseInfinite ignores are ignored because zod strips them: none may be a
// getInfiniteImagesSchema key (schemas.json, kept in step with zod by its schema-drift test). A key
// the schema starts reading must be parsed instead, and feed-go must ship before the web change that
// adds it (DESIGN.md §5.1). This checks one direction only: a key added to imagesQueryParamSchema
// alone is not detected here and falls back as input-unknown-key.
func TestStrippedURLKeysAreStrippedByZod(t *testing.T) {
	if want := []string{"query", "section", "similarTo", "view"}; !reflect.DeepEqual(strippedURLKeys, want) {
		t.Errorf("strippedURLKeys = %v, want %v (a change here is a reviewed parity decision)", strippedURLKeys, want)
	}
	inSchema := map[string]bool{}
	for _, k := range imagesSchema.Keys() {
		inSchema[k] = true
	}
	for _, k := range strippedURLKeys {
		if inSchema[k] {
			t.Errorf("%s is a getInfiniteImagesSchema key now: parse it (or classify it) instead of ignoring it", k)
		}
		if !infiniteAbsentKeys[k] {
			t.Errorf("%s is not in infiniteAbsentKeys", k)
		}
	}
}

// The defaults come from the schema (schemas.json); pinned here as the literals the Node schema
// holds, so a regenerated file that changes one is reviewed rather than silently adopted.
func TestParseDefaultsAreTheSchemas(t *testing.T) {
	in, err := Parse(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 100 || in.Sort != "Most Reactions" || in.Period != "AllTime" || in.PeriodMode != "published" {
		t.Fatalf("defaults = limit %d sort %q period %q periodMode %q, want 100, Most Reactions, AllTime, published",
			in.Limit, in.Sort, in.Period, in.PeriodMode)
	}
	if !knownSorts[in.Sort] || !knownPeriods[in.Period] {
		t.Fatal("a schema default is not one this port serves")
	}
	v1, err := ParseV1("")
	if err != nil {
		t.Fatal(err)
	}
	if v1.Limit != 100 || v1.Sort != "Most Reactions" || v1.Period != "AllTime" {
		t.Fatalf("v1 defaults = limit %d sort %q period %q, want 100, Most Reactions, AllTime", v1.Limit, v1.Sort, v1.Period)
	}
}

// A query key outside imagesEndpointSchema falls back; `token` (the API key) is left to Resolve.
func TestParseV1UnknownKeyFallsBack(t *testing.T) {
	for q, want := range map[string]string{
		"limit=2&utm_source=x": "input-unknown-key",
		"foo":                  "input-unknown-key",
		"limit=2&token=abc":    "",
		"limit=2&sort=Newest":  "",
		// An unported shape wins over an unknown key, so the reason names the shape.
		"tags=5&utm_source=x":    "v1-tags",
		"utm_source=x&imageId=3": "v1-image-id",
		"baseModels=Pony&foo=1":  "v1-base-models",
		"modelId=3&utm_source=x": "input-unknown-key", // v1-model-only is decided later, after the values
	} {
		_, err := ParseV1(q)
		if got := fallback.Reason(err); got != want || (want == "" && err != nil) {
			t.Errorf("%s: reason %q (err %v), want %q", q, got, err, want)
		}
	}
}

func TestSchemaNamesResolve(t *testing.T) {
	for _, n := range []string{inputschema.InfiniteImages, inputschema.ImagesEndpoint} {
		if len(inputschema.Get(n).Keys()) == 0 {
			t.Fatalf("%s has no keys", n)
		}
	}
}
