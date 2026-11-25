package feedsvc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A hub (mapHubSources): its any-of lists after excludedUserIds (whose head is the hub's own keep-outs,
// then the request's, without repeats) and before versionIds; tag groups as `a,b;c`, written as
// URLSearchParams writes them. Expected strings are written by hand from mapSearchInputToFeedQuery.
func TestMapHub(t *testing.T) {
	full := &Hub{
		UserIDs: []int{1002, 1005}, VersionIDs: []int{6002, 6001}, TagGroups: [][]int{{501, 502}, {520}},
		ExcludedUserIDs: []int{1009}, ExcludedVersionIDs: []int{6401}, ExcludedTagGroups: [][]int{{531, 532}},
	}
	for _, c := range []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "every list, the hub's keep-outs ahead of the request's",
			q: Query{BrowsingLevel: 3, ExcludedTagIDs: []int{9901}, ExcludedUserIDs: []int{1009, 1010, 0}, ModelVersionID: 6301,
				DisablePoi: true, Sort: "Newest", Limit: 4, Hub: full},
			want: "levels=1%2C2&excludedTags=9901&excludedUserIds=1009%2C1010&anyUserIds=1002%2C1005&anyVersionIds=6002%2C6001" +
				"&anyTagGroups=501%2C502%3B520&excludedVersionIds=6401&excludedTagGroups=531%2C532&versionIds=6301&excludePoi=1&sort=newest&limit=4",
		},
		{
			name: "only creators: no empty lists sent",
			q:    Query{BrowsingLevel: 1, Sort: "Oldest", Limit: 2, Hub: &Hub{UserIDs: []int{7}}},
			want: "levels=1&anyUserIds=7&sort=oldest&limit=2",
		},
		{
			name: "only a tag group, with a keep-out creator and none from the request",
			q:    Query{BrowsingLevel: 1, Sort: "Most Reactions", Limit: 2, Hub: &Hub{TagGroups: [][]int{{3}}, ExcludedUserIDs: []int{8}}},
			want: "levels=1&excludedUserIds=8&anyTagGroups=3&sort=reactions&limit=2",
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

	n := func(count int) []int {
		out := make([]int, count)
		for i := range out {
			out[i] = i + 1
		}
		return out
	}
	groups := func(count, size int) [][]int {
		out := make([][]int, count)
		for i := range out {
			out[i] = n(size)
		}
		return out
	}
	for _, c := range []struct {
		name   string
		q      Query
		reason string
	}{
		{"beside a creator, before the sort", Query{BrowsingLevel: 1, UserID: 1002, Sort: "Most Buzz", Hub: full}, "hub:driver"},
		{"beside followed as sent", Query{BrowsingLevel: 1, FollowedSent: true, Sort: "Newest", Hub: full}, "hub:driver"},
		{"beside newCreators", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: []int{1}, Sort: "Newest", Hub: full}, "hub:driver"},
		{"beside a Model3D", Query{BrowsingLevel: 1, Model3DID: 4, Sort: "Newest", Hub: full}, "hub:driver"},
		{"a non-positive id", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: []int{1, 0}}}, "hub:ids"},
		{"an empty tag group", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: []int{1}, ExcludedTagGroups: [][]int{{}}}}, "hub:ids"},
		{"no positive source", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{ExcludedUserIDs: []int{1}}}, "hub:none"},
		{"51 creators", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: n(51)}}, "hub:users>50"},
		{"751 versions", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{VersionIDs: n(751)}}, "hub:versions>750"},
		{"51 tag groups", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{TagGroups: groups(51, 1)}}, "hub:tagGroups>50"},
		{"751 excluded versions", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: []int{1}, ExcludedVersionIDs: n(751)}}, "hub:excludedVersions>750"},
		{"21 excluded tag groups", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: []int{1}, ExcludedTagGroups: groups(21, 1)}}, "hub:excludedTagGroups>20"},
		{"51 tags in an excluded group", Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: []int{1}, ExcludedTagGroups: groups(1, 51)}}, "hub:tagsPerGroup>50"},
		// After the new-creators checks: a long board is refused for itself first.
		{"after the board's length", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: make([]int, MaxFollowed+1), Sort: "Newest", Hub: full}, "newCreators>10000"},
	} {
		_, ref := Map(c.q)
		if ref == nil || ref.Reason != c.reason || ref.Rejected {
			t.Errorf("%s: %+v, want the empty-page refusal %q", c.name, ref, c.reason)
		}
	}
	// At the bounds, nothing is refused.
	if _, ref := Map(Query{BrowsingLevel: 1, Sort: "Newest", Hub: &Hub{UserIDs: n(50), VersionIDs: n(750), TagGroups: groups(50, 50),
		ExcludedVersionIDs: n(750), ExcludedTagGroups: groups(20, 50)}}); ref != nil {
		t.Fatalf("at every bound: refused %+v", ref)
	}
}

// The answer's `route` is read when it is a string; anything else reads as no route.
func TestClientFetchRoute(t *testing.T) {
	for body, want := range map[string]string{
		`{"items":[1],"route":"union-walk"}`: "union-walk",
		`{"items":[1],"route":7}`:            "",
		`{"items":[1]}`:                      "",
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		a, err := (&Client{BaseURL: srv.URL, HTTP: srv.Client()}).Fetch(context.Background(), "levels=1")
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if a.Route != want {
			t.Errorf("%s: route %q, want %q", body, a.Route, want)
		}
	}
	if !HubRoutes["union-walk"] || !HubRoutes["union-gather"] || !HubRoutes["empty"] || HubRoutes["walk"] || len(HubRoutes) != 3 {
		t.Fatalf("HubRoutes = %v, want exactly union-walk, union-gather, empty", HubRoutes)
	}
}
