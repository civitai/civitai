package feed

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// minorMatureRe finds minorMatureImageVisibleSql's clause in a built query: the level it restricts
// from, and the placeholder of the owner it exempts (empty: none).
var minorMatureRe = regexp.MustCompile(`\(NOT \(\(COALESCE\(i\."minor", FALSE\)\) AND \(i\."nsfwLevel" IS NULL OR i\."nsfwLevel" = 0 OR i\."nsfwLevel" >= (\d+)\)\)(?: OR i\."userId" = \$(\d+))?\)`)

// minorMatureIn is the clause's occurrences in b and, for the first, the level and the bound owner
// (0: none).
func minorMatureIn(t *testing.T, b Built) (count, from, owner int) {
	t.Helper()
	all := minorMatureRe.FindAllStringSubmatch(b.SQL, -1)
	if len(all) == 0 {
		return 0, 0, 0
	}
	from, _ = strconv.Atoi(all[0][1])
	if all[0][2] != "" {
		n, _ := strconv.Atoi(all[0][2])
		if n < 1 || n > len(b.Args) {
			t.Fatalf("the clause binds $%d, not one of the %d args", n, len(b.Args))
		}
		owner, _ = b.Args[n-1].(int)
	}
	return len(all), from, owner
}

// Every image query Build writes carries the minor content rule once, whatever DisableMinor says: for
// a signed-in viewer with their own images exempt, signed out exempting no one, and not for a
// moderator (minorMatureImageVisibleSql answers TRUE).
func TestBuildAppliesTheMinorContentRule(t *testing.T) {
	shapes := map[string]ImagesQuery{
		"version gallery":      {Limit: 10, BrowsingLevel: 31, ModelVersionID: 9},
		"model gallery":        {Limit: 10, BrowsingLevel: 31, ModelID: 7},
		"feed-service hydrate": {Limit: 3, BrowsingLevel: 31, IDs: []int{1, 2, 3}, ThrowOnStatementTimeout: true},
		"post completion":      {Limit: 200, BrowsingLevel: 31, PostIDs: []int{5}},
		"post scope":           {Limit: 5, BrowsingLevel: 31, PostID: 5, IndexOrder: true},
		"collection":           {Limit: 5, BrowsingLevel: 31, CollectionID: 9101},
		"pending":              {Limit: 5, BrowsingLevel: 31, Pending: true},
		"disableMinor":         {Limit: 5, BrowsingLevel: 31, DisableMinor: true},
		"prioritized":          {Limit: 5, BrowsingLevel: 31, ModelVersionID: 9, PrioritizedUserIDs: []int{4}},
	}
	for name, q := range shapes {
		signedIn := q
		signedIn.ViewerID = 1003
		if n, from, owner := minorMatureIn(t, signedIn.Build()); n != 1 || from != 4 || owner != 1003 {
			t.Errorf("%s, signed in: %d clause(s), from level %d, owner %d; want 1, 4, 1003", name, n, from, owner)
		}
		signedOut := q
		if n, from, owner := minorMatureIn(t, signedOut.Build()); n != 1 || from != 4 || owner != 0 {
			t.Errorf("%s, signed out: %d clause(s), from level %d, owner %d; want 1, 4, none", name, n, from, owner)
		}
		mod := q
		mod.ViewerID, mod.IsModerator = 1004, true
		b := mod.Build()
		if n, _, _ := minorMatureIn(t, b); n != 0 || strings.Contains(b.SQL, `COALESCE(i."minor", FALSE)`) {
			t.Errorf("%s, moderator: the rule is applied:\n%s", name, b.SQL)
		}
	}
}
