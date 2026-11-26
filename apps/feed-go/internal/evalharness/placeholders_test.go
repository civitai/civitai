package evalharness

import (
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

var ownerIdentity = Identity{UserID: 7301, Username: "evalowner", CollectionID: 8402, SearchText: "search owner q"}

// decodeEnv decodes a superjson envelope for comparison (numbers kept as written).
func decodeEnv(t *testing.T, s string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v map[string]any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return v
}

func TestSubstituteInput(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{
			"userId is a number, username a string, collection a number",
			`{"json":{"userId":"$self","username":"$self","collectionId":"$self-collection","limit":20}}`,
			`{"json":{"userId":7301,"username":"evalowner","collectionId":8402,"limit":20}}`,
		},
		{
			"`user` is a username key",
			`{"json":{"user":"$self"}}`,
			`{"json":{"user":"evalowner"}}`,
		},
		{
			"a bigint-annotated id stays a decimal string",
			`{"json":{"userId":"$self","collectionId":"$self-collection"},"meta":{"values":{"userId":["bigint"],"collectionId":["bigint"]}}}`,
			`{"json":{"userId":"7301","collectionId":"8402"},"meta":{"values":{"userId":["bigint"],"collectionId":["bigint"]}}}`,
		},
		{
			"*UserIds members are numbers; others kept; a bigint member stays a string",
			`{"json":{"excludedUserIds":[5,"$self",9],"prioritizedUserIds":["$self"]},"meta":{"values":{"prioritizedUserIds.0":["bigint"]}}}`,
			`{"json":{"excludedUserIds":[5,7301,9],"prioritizedUserIds":["7301"]},"meta":{"values":{"prioritizedUserIds.0":["bigint"]}}}`,
		},
		{
			"nested arrays of objects",
			`{"json":{"filters":[{"userId":"$self"},{"username":"$self"}]}}`,
			`{"json":{"filters":[{"userId":7301},{"username":"evalowner"}]}}`,
		},
		{
			"$search becomes the search text",
			`{"json":{"query":"$search","sort":"Newest"}}`,
			`{"json":{"query":"search owner q","sort":"Newest"}}`,
		},
		{
			"a meta annotation elsewhere is kept, a non-placeholder $ string too",
			`{"json":{"cursor":"$self-x","userId":"$self","publishedBefore":"2026-01-01T00:00:00.000Z"},"meta":{"values":{"publishedBefore":["Date"]}}}`,
			`{"json":{"cursor":"$self-x","userId":7301,"publishedBefore":"2026-01-01T00:00:00.000Z"},"meta":{"values":{"publishedBefore":["Date"]}}}`,
		},
	}
	for _, c := range cases {
		got, err := SubstituteInput(c.in, ownerIdentity)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !reflect.DeepEqual(decodeEnv(t, got), decodeEnv(t, c.want)) {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

func TestSubstituteInputUnchangedIsVerbatim(t *testing.T) {
	in := `{"json":{"limit":20,"sort":"Newest"},"meta":{"values":{}}}`
	if got, err := SubstituteInput(in, ownerIdentity); err != nil || got != in {
		t.Fatalf("%q %v", got, err)
	}
	in = `{"json":{"tag":"$5"}}` // a `$` but no placeholder
	if got, err := SubstituteInput(in, ownerIdentity); err != nil || got != in {
		t.Fatalf("%q %v", got, err)
	}
}

func TestSubstituteInputUnfilled(t *testing.T) {
	for _, c := range []struct {
		in string
		id Identity
	}{
		{`{"json":{"userId":"$self"}}`, Identity{SearchText: "x"}},
		{`{"json":{"username":"$self"}}`, Identity{UserID: 7101}},
		{`{"json":{"collectionId":"$self-collection"}}`, Identity{UserID: 7101, Username: "u"}},
		{`{"json":{"query":"$search"}}`, Identity{UserID: 7101, Username: "u"}},
	} {
		if _, err := SubstituteInput(c.in, c.id); !errors.Is(err, ErrPlaceholder) {
			t.Errorf("%s: err %v, want ErrPlaceholder", c.in, err)
		}
	}
	// Undecodable inputs holding a `$` (one without `$` is returned untouched, never decoded).
	for _, in := range []string{`{"json":{"a":"$self"`, `["$self"]`, `{"json":{"a":"$self"},"meta":`} {
		if _, err := SubstituteInput(in, ownerIdentity); err == nil || errors.Is(err, ErrPlaceholder) {
			t.Errorf("%s: err %v, want a decode error", in, err)
		}
	}
	// A syntax error inside the json member.
	if _, err := SubstituteInput(`{"json":{"a":"$self",}}`, ownerIdentity); err == nil {
		t.Error("an undecodable json member: no error")
	}
}

func TestSubstituteQuery(t *testing.T) {
	cases := []struct{ in, want string }{
		{"username=%24self&limit=5", "username=evalowner&limit=5"},
		{"userId=%24self&username=%24self&userId=%24self", "userId=7301&username=evalowner&userId=7301"},
		{"user=$self", "user=evalowner"},
		{"a=1&b=%24other", "a=1&b=%24other"},
		{"", ""},
	}
	for _, c := range cases {
		got, err := SubstituteQuery(c.in, ownerIdentity)
		if err != nil || got != c.want {
			t.Errorf("%q: %q %v, want %q", c.in, got, err, c.want)
		}
	}
	if got, _ := SubstituteQuery("username=%24self", Identity{UserID: 1, Username: "a b&c"}); got != "username="+url.QueryEscape("a b&c") {
		t.Errorf("escaping: %q", got)
	}
	if _, err := SubstituteQuery("userId=%24self", Identity{}); !errors.Is(err, ErrPlaceholder) {
		t.Errorf("signed out $self: %v", err)
	}
}
