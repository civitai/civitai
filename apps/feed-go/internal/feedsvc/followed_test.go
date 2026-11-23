package feedsvc

import "testing"

// `followed` (image.getInfinite, signed in): the follow list's positive ids as `userIds`, in order,
// repeats kept, where the creator's id goes; a list past MAX_FOLLOWED, or a creator scope beside it,
// is an empty page, refused after the post ids and before the sort and cursor checks (the mapper's
// order: an unknown sort or an unparsed cursor would otherwise be a BAD_REQUEST). Without Followed a
// list is not sent. Expected strings are written by hand from mapSearchInputToFeedQuery.
func TestMapFollowed(t *testing.T) {
	for _, c := range []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "the follow list as userIds, after versionIds, before types",
			q: Query{BrowsingLevel: 1, ExcludedTagIDs: []int{9901}, ModelVersionID: 60, Types: []string{"image"}, Followed: true,
				FollowedUserIDs: []int{1002, 1005, 1002}, Sort: "Newest", Limit: 3},
			want: "levels=1&excludedTags=9901&versionIds=60&userIds=1002%2C1005%2C1002&types=image&sort=newest&limit=3",
		},
		{
			name: "non-positive ids dropped",
			q:    Query{BrowsingLevel: 1, Followed: true, FollowedUserIDs: []int{0, 7, -1}, Sort: "Oldest", Limit: 2},
			want: "levels=1&userIds=7&sort=oldest&limit=2",
		},
		{
			name: "not followedOn: a list is not sent",
			q:    Query{BrowsingLevel: 1, FollowedUserIDs: []int{1002}, Sort: "Newest", Limit: 2},
			want: "levels=1&sort=newest&limit=2",
		},
		{
			// The bound is `>`: MAX_FOLLOWED entries (all 0 here, so none sent) are not refused.
			name: "exactly MAX_FOLLOWED is not refused",
			q:    Query{BrowsingLevel: 1, Followed: true, FollowedUserIDs: make([]int, MaxFollowed), Sort: "Newest", Limit: 2},
			want: "levels=1&sort=newest&limit=2",
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

	long := make([]int, MaxFollowed+1)
	for i := range long {
		long[i] = i + 1
	}
	for _, c := range []struct {
		name   string
		q      Query
		reason string
	}{
		{"past MAX_FOLLOWED, before the sort", Query{BrowsingLevel: 1, Followed: true, FollowedUserIDs: long, Sort: "Most Buzz"}, "followed>10000"},
		{"a creator scope beside it, before the cursor", Query{BrowsingLevel: 1, Followed: true, FollowedUserIDs: []int{1002}, UserID: 1001,
			Sort: "Newest", CursorText: "not-a-cursor"}, "flag:followed:userId"},
		// After the post ids: a lone postId on the website route is refused first.
		{"after the post ids", Query{BrowsingLevel: 1, PostID: 7001, Followed: true, FollowedUserIDs: long, Sort: "Newest"}, "input:postId"},
	} {
		_, ref := Map(c.q)
		if ref == nil || ref.Reason != c.reason || ref.Rejected {
			t.Errorf("%s: refusal %+v, want the empty-page refusal %q", c.name, ref, c.reason)
		}
	}
	// Control: the same creator scope without Followed is sent (userIds is the creator).
	if got, ref := Map(Query{BrowsingLevel: 1, FollowedUserIDs: []int{1002}, UserID: 1001, Sort: "Newest", Limit: 2}); ref != nil ||
		got != "levels=1&userIds=1001&sort=newest&limit=2" {
		t.Errorf("creator without followed: %q %+v", got, ref)
	}
}
