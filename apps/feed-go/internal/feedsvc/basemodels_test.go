package feedsvc

import "testing"

// `baseModels` (image.getInfinite): after the POI exclusion and before `tools`, the non-empty names
// in order with repeats (`.map(String).filter(Boolean)`), joined with `,` and written as
// URLSearchParams.toString() writes them. Expected strings are written by hand from that serializer.
func TestMapBaseModels(t *testing.T) {
	for _, c := range []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "between the POI exclusion and tools, empty names dropped, repeats kept",
			q: Query{BrowsingLevel: 1, ExcludedTagIDs: []int{9901}, DisablePoi: true, ViewerID: 1003,
				BaseModels: []string{"SDXL 1.0", "", "Pony", "SDXL 1.0"}, Tools: []int{42}, Sort: "Newest", Limit: 3},
			want: "levels=1&excludedTags=9901&excludePoi=1&viewerId=1003&baseModels=SDXL+1.0%2CPony%2CSDXL+1.0&tools=42&sort=newest&limit=3",
		},
		{
			name: "only empty names send no baseModels",
			q:    Query{BrowsingLevel: 1, BaseModels: []string{"", ""}, Sort: "Newest", Limit: 3},
			want: "levels=1&sort=newest&limit=3",
		},
		{
			name: "an empty list sends none",
			q:    Query{BrowsingLevel: 1, BaseModels: []string{}, Sort: "Newest", Limit: 3},
			want: "levels=1&sort=newest&limit=3",
		},
		{
			// The form serializer keeps `*` and escapes `~`, the two bytes url.QueryEscape treats the
			// other way; `(`, `)`, `!`, `'`, `/` and non-ASCII are escaped by both.
			name: "free-text names",
			q:    Query{BrowsingLevel: 1, BaseModels: []string{"a*b~c", "Flux.1 D (x)!'/", "Ünï_-"}, Sort: "Oldest", Limit: 2},
			want: "levels=1&baseModels=a*b%7Ec%2CFlux.1+D+%28x%29%21%27%2F%2C%C3%9Cn%C3%AF_-&sort=oldest&limit=2",
		},
	} {
		got, ref := Map(c.q)
		if ref != nil {
			t.Errorf("%s: refused %+v", c.name, ref)
			continue
		}
		if got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// formEncode against literals of the WHATWG application/x-www-form-urlencoded serializer: every ASCII
// byte class, a multi-byte code point and U+FFFD.
func TestFormEncode(t *testing.T) {
	for in, want := range map[string]string{
		"":               "",
		"azAZ09*-._":     "azAZ09*-._",
		" ":              "+",
		"~":              "%7E",
		",|&=+%#?":       "%2C%7C%26%3D%2B%25%23%3F",
		"\x00\x1f\x7f":   "%00%1F%7F",
		"é":              "%C3%A9",
		"\uFFFD":         "%EF%BF%BD",
		"SD 1.5 LCM~v2*": "SD+1.5+LCM%7Ev2*",
	} {
		if got := formEncode(in); got != want {
			t.Errorf("formEncode(%q) = %q, want %q", in, got, want)
		}
	}
}
