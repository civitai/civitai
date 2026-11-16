package feed

import (
	"encoding/json"
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
		`{"tags":[3],"aNewKey":true}`:          "input-tags",
		`{"userId":null,"someNewFilter":1}`:    "input-unknown-key",
	} {
		if _, err := Parse(parseObj(t, input)); fallback.Reason(err) != want {
			t.Errorf("unknown + unsupported %s: reason %q, want %q", input, fallback.Reason(err), want)
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
