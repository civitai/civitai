package feed

import (
	"strconv"
	"strings"
	"testing"
)

const (
	songsHiddenSQL      = `i."type" != 'audio'`
	songsHiddenOwnerSQL = `(i."type" != 'audio' OR i."userId" = $`
)

// songsHiddenSql (getAllImagesUncaptured): no song but the viewer's own, right after the types
// clause; a cached model gallery names no viewer; moderators get no clause. feed-go cannot read the
// `music` flag, so a signed-in non-moderator is treated as not holding it.
func TestBuildSongsHidden(t *testing.T) {
	b := (&ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, Types: []string{"audio"}, ViewerID: 7}).Build()
	types := strings.Index(b.SQL, `i.type = ANY($`)
	songs := strings.Index(b.SQL, songsHiddenOwnerSQL)
	if types < 0 || songs < 0 || types >= songs {
		t.Fatalf("clause order types %d, songs %d:\n%s", types, songs, b.SQL)
	}
	n, err := strconv.Atoi(strings.SplitN(b.SQL[songs+len(songsHiddenOwnerSQL):], ")", 2)[0])
	if err != nil || n < 1 || n > len(b.Args) || b.Args[n-1] != any(7) {
		t.Fatalf("the owner carve-out does not bind the viewer: $%d of %v", n, b.Args)
	}

	b = (&ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1}).Build()
	if !strings.Contains(b.SQL, songsHiddenSQL) || strings.Contains(b.SQL, songsHiddenOwnerSQL) {
		t.Fatalf("signed out: want the bare clause:\n%s", b.SQL)
	}

	b = (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, ViewerID: 7}).Build()
	if !strings.Contains(b.SQL, songsHiddenSQL) || strings.Contains(b.SQL, songsHiddenOwnerSQL) {
		t.Fatalf("model gallery: want the bare clause, no viewer:\n%s", b.SQL)
	}

	b = (&ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, ViewerID: 7, IsModerator: true}).Build()
	if strings.Contains(b.SQL, songsHiddenSQL) {
		t.Fatalf("moderator: want no song clause:\n%s", b.SQL)
	}
}
