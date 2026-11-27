package feed

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// ownerMediaAllowedSQL is ownerMediaAllowedSql('i') (src/server/common/image-visibility.ts) as the
// image query must spell it, OWNER_MEDIA_EXEMPT_BLOCKS inlined.
const ownerMediaAllowedSQL = `(CASE WHEN "i"."blockedFor" IS NOT NULL THEN "i"."blockedFor" IN ('AiNotVerified') ELSE "i"."ingestion" <> 'Blocked'::"ImageIngestionStatus" END)`

// The block terms of getAllImagesUncaptured (blockedMediaListConditions({ userId: ownerId })): for
// a signed-in viewer, an image with a blockedFor reason is kept only as their own and only where
// ownerMediaAllowed allows it, and their own images are held to ownerMediaAllowed whatever
// blockedFor says; both bind the viewer's id. Signed out, only `(i."blockedFor" IS NULL)`; for a
// moderator, neither.
func TestBuildBlockedMediaListConditions(t *testing.T) {
	owner := (&ImagesQuery{Limit: 10, BrowsingLevel: 1, ViewerID: 4242}).Build()
	reBlocked := regexp.MustCompile(`\(i\."blockedFor" IS NULL OR \(i\."userId" = \$(\d+) AND ` + regexp.QuoteMeta(ownerMediaAllowedSQL) + `\)\)`)
	reOwnerMedia := regexp.MustCompile(`\("i"\."userId" <> \$(\d+) OR ` + regexp.QuoteMeta(ownerMediaAllowedSQL) + `\)`)
	for name, re := range map[string]*regexp.Regexp{"imageBlockedForConditions": reBlocked, "ownerMediaSql": reOwnerMedia} {
		ms := re.FindAllStringSubmatch(owner.SQL, -1)
		if len(ms) != 1 {
			t.Fatalf("signed in: %s clause found %d time(s), want 1\n%s", name, len(ms), owner.SQL)
		}
		n, _ := strconv.Atoi(ms[0][1])
		if n < 1 || n > len(owner.Args) || owner.Args[n-1] != 4242 {
			t.Fatalf("signed in: %s binds $%d = %v, want the viewer 4242", name, n, owner.Args)
		}
	}
	// No bare owner exemption from a block survives.
	if strings.Contains(owner.SQL, `(i."blockedFor" IS NULL OR i."userId" = $`) {
		t.Fatalf("signed in: a bare owner exemption from blockedFor\n%s", owner.SQL)
	}

	signedOut := (&ImagesQuery{Limit: 10, BrowsingLevel: 1}).Build()
	if !strings.Contains(signedOut.SQL, `(i."blockedFor" IS NULL)`) {
		t.Fatalf("signed out: no `(i.\"blockedFor\" IS NULL)`\n%s", signedOut.SQL)
	}
	if strings.Contains(signedOut.SQL, `"userId" <> `) || strings.Contains(signedOut.SQL, ownerMediaAllowedSQL) {
		t.Fatalf("signed out: an owner term with no owner\n%s", signedOut.SQL)
	}

	mod := (&ImagesQuery{Limit: 10, BrowsingLevel: 1, ViewerID: 4242, IsModerator: true}).Build()
	if strings.Contains(mod.SQL, `blockedFor" IS`) || strings.Contains(mod.SQL, ownerMediaAllowedSQL) {
		t.Fatalf("moderator: a block term\n%s", mod.SQL)
	}
}
