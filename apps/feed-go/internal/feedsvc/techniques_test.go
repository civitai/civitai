package feedsvc

import "testing"

// `techniques` as mapSearchInputToFeedQuery sends it: the positive ids (`ints`), in order, repeats
// kept, right after `tools` and before the post ids. Unlike `tags`, a list of only impossible ids is
// not refused (the mapper has no `techniques:none`): the param is left out.
func TestMapTechniques(t *testing.T) {
	for _, c := range []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "techniques on a version gallery",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Techniques: []int{4, 0, -2, 4, 3}, Sort: "Most Reactions", Limit: 6},
			want: "levels=1&versionIds=9&techniques=4%2C4%2C3&sort=reactions&limit=6",
		},
		{
			name: "after tools and the POI exclusion, before the post ids",
			q: Query{BrowsingLevel: 1, ExcludedTagIDs: []int{9901}, ModelVersionID: 9, DisablePoi: true, ViewerID: 1003,
				PostIDs: []int{7001}, Tools: []int{42}, Techniques: []int{3}, Sort: "Newest", Limit: 2},
			want: "levels=1&excludedTags=9901&versionIds=9&excludePoi=1&viewerId=1003&tools=42&techniques=3&postIds=7001&sort=newest&limit=2",
		},
		{
			name: "with tags: tags after levels, techniques after tools",
			q:    Query{BrowsingLevel: 1, Tags: []int{502}, Techniques: []int{3}, Sort: "Newest", Limit: 3},
			want: "levels=1&tags=502&techniques=3&sort=newest&limit=3",
		},
		{
			name: "only non-positive techniques send none",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Techniques: []int{0, -1}, Sort: "Newest", Limit: 10},
			want: "levels=1&versionIds=9&sort=newest&limit=10",
		},
	} {
		got, refusal := Map(c.q)
		if refusal != nil {
			t.Errorf("%s: refused %+v", c.name, refusal)
			continue
		}
		if got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}
