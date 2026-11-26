package feedsvc

import "testing"

// `newCreators` (image.getInfinite): the board's positive ids as `userIds`, in order, where the
// creator's id goes; a board past MAX_USER_IDS, or beside a creator scope or any `followed: true`
// (signed in or not), is an empty page, refused right after the follow list and before the sort and
// cursor checks. Without NewCreators a board is not sent. Expected strings are written by hand from
// mapSearchInputToFeedQuery.
func TestMapNewCreators(t *testing.T) {
	for _, c := range []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "the board as userIds, after versionIds, before types and the POI exclusion",
			q: Query{BrowsingLevel: 1, ExcludedTagIDs: []int{9901, 9921}, ModelVersionID: 60, Types: []string{"image"}, DisablePoi: true,
				NewCreators: true, NewCreatorUserIDs: []int{1002, 1001, 1002}, Sort: "Newest", Limit: 4},
			want: "levels=1&excludedTags=9901%2C9921&versionIds=60&userIds=1002%2C1001%2C1002&types=image&excludePoi=1&sort=newest&limit=4",
		},
		{
			name: "non-positive ids dropped",
			q:    Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: []int{0, 7, -1}, Sort: "Oldest", Limit: 2},
			want: "levels=1&userIds=7&sort=oldest&limit=2",
		},
		{
			name: "not newCreators: a board is not sent",
			q:    Query{BrowsingLevel: 1, NewCreatorUserIDs: []int{1002}, Sort: "Newest", Limit: 2},
			want: "levels=1&sort=newest&limit=2",
		},
		{
			// The bound is `>`: MAX_USER_IDS entries (all 0 here, so none sent) are not refused.
			name: "exactly MAX_USER_IDS is not refused",
			q:    Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: make([]int, MaxFollowed), Sort: "Newest", Limit: 2},
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
		{"past MAX_USER_IDS, before the sort", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: long, Sort: "Most Buzz"}, "newCreators>10000"},
		{"a creator scope beside it, before the cursor", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: []int{1002}, UserID: 1001,
			Sort: "Newest", CursorText: "not-a-cursor"}, "flag:newCreators:userId"},
		// `input.followed === true`, whatever the viewer: signed out (no followedOn) it is still refused.
		{"followed sent, signed out", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: []int{1002}, FollowedSent: true,
			Sort: "Newest"}, "flag:newCreators:userId"},
		// Signed in with a follow list, the follow checks pass and the board's then refuses.
		{"followed signed in", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: []int{1002}, FollowedSent: true,
			Followed: true, FollowedUserIDs: []int{1005}, Sort: "Newest"}, "flag:newCreators:userId"},
		// After the follow list's own checks.
		{"after the follow list", Query{BrowsingLevel: 1, NewCreators: true, NewCreatorUserIDs: long, Followed: true,
			FollowedUserIDs: []int{1002}, UserID: 1001, Sort: "Newest"}, "flag:followed:userId"},
	} {
		_, ref := Map(c.q)
		if ref == nil || ref.Reason != c.reason || ref.Rejected {
			t.Errorf("%s: refusal %+v, want the empty-page refusal %q", c.name, ref, c.reason)
		}
	}
	// Control: `followed: true` without newCreators (signed out) is sent as the plain feed.
	if got, ref := Map(Query{BrowsingLevel: 1, FollowedSent: true, Sort: "Newest", Limit: 2}); ref != nil || got != "levels=1&sort=newest&limit=2" {
		t.Errorf("followed without newCreators: %q %+v", got, ref)
	}
}
