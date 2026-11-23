package hydrate

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	// imageReadRe is a SQL read of the Image table (`FROM "Image"` or `JOIN "Image"`, any alias).
	imageReadRe = regexp.MustCompile(`(FROM|JOIN)\s+"Image"([^A-Za-z]|$)`)
	// showcaseCacheRe is a use of the shared version-showcase cache's key (imagesForModelVersionsCache).
	showcaseCacheRe = regexp.MustCompile(`\bKey(VersionImages|ImagesForVersion)\b`)
	// showcaseKeyDeclRe is the key's declaration, which is not a use.
	showcaseKeyDeclRe = regexp.MustCompile(`\bKey(VersionImages|ImagesForVersion)\s*=\s*"`)
	// minorRuleRe is a call of the minor content rule's helpers.
	minorRuleRe = regexp.MustCompile(`\b(MinorMatureImageVisibleSQL|MinorMatureImageHiddenSQL|WithoutMinorMatureImages)\(`)
	// minorRuleDeclRe is a helper's own declaration with an ordinary parameter list, which minorRuleRe
	// also matches and which is not a call.
	minorRuleDeclRe = regexp.MustCompile(`\bfunc (MinorMatureImageVisibleSQL|MinorMatureImageHiddenSQL|WithoutMinorMatureImages)\(`)
)

// minorRuleSite is one source file's image reads, showcase-cache uses and minor-rule calls, and why
// it applies the rule or why it need not.
type minorRuleSite struct {
	imageReads, cacheUses, ruleCalls int
	why                              string
}

// minorRuleSites is every non-test source file of the module that reads Image rows or the shared
// showcase cache, or calls the rule. A new read, a removed one, or a moved call changes a count here
// and fails TestMinorMatureCallSites: the new path must apply the rule (or say why it need not)
// before the ledger is updated.
var minorRuleSites = map[string]minorRuleSite{
	"internal/feed/query.go": {2, 0, 1,
		"getAllImagesUncaptured: every image page, completion, pinned/sponsored post, feed-service hydrate and REST read is built here, with minorMatureImageVisibleSql({ userId: ownerId, isModerator })"},
	"internal/hydrate/versionimages.go": {2, 0, 1,
		"imagesForModelVersionsCache's lookup (getImagesForModelVersion with no user): the rule with no viewer"},
	"internal/hydrate/models.go": {0, 1, 1,
		"getImagesForModelVersionCache's read: the appendFn's filter (isMinorMatureImage), for every viewer (model.getAll's and GET /api/v1/models' showcase read)"},
	"internal/hydrate/minormature.go": {0, 0, 1,
		"the rule itself (MinorMatureImageHiddenSQL calls MinorMatureImageVisibleSQL)"},
	"internal/hydrate/packed.go": {0, 1, 0,
		"orderedCaches names the key to decode its entries ordered; it reads nothing (the read is models.go's)"},
	"internal/hydrate/misses.go": {0, 1, 0,
		"the showcase cache's miss spec: the lookup it runs is versionimages.go's"},
	"internal/feed/pager.go": {1, 0, 0,
		"getPostImageCounts: an upper bound before any visibility filter, as Node counts"},
	"internal/modelfeed/assoc_images.go": {2, 0, 1,
		"getImagesForModelVersion for model.getAssociatedResourcesCardData's cards, with minorMatureImageVisibleSql({ userId, isModerator })"},
	"internal/modelfeed/serve.go": {2, 0, 0,
		"getCoverImages' locate step (post, version, model of a cover id), and the community-cover guard (ids only, to decide a fallback; it serves no image); the cover itself is read from the showcase cache"},
	"internal/hydrate/meta.go": {1, 0, 0,
		"the meta of images a filtered read already chose"},
	"internal/hydrate/users.go": {1, 0, 0,
		"profile pictures: Node's profile-picture reads do not apply the rule"},
	"internal/hydrate/images.go": {2, 0, 0,
		"video thumbnails of videos a filtered read already chose"},
}

// The relationship between the module's image reads and the minor content rule, as a ledger: every
// file that reads Image rows or the shared showcase cache, or calls the rule, is listed with its
// counts, and the files that serve a Node read applying the rule call it.
func TestMinorMatureCallSites(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]minorRuleSite{}
	scanned := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "testdata" || (strings.HasPrefix(name, ".") && path != root) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path) //nolint:gosec // G304: path is a source file of this module, from the walk
		if err != nil {
			return err
		}
		scanned++
		text := string(src)
		s := minorRuleSite{
			imageReads: len(imageReadRe.FindAllString(text, -1)),
			cacheUses:  len(showcaseCacheRe.FindAllString(text, -1)) - len(showcaseKeyDeclRe.FindAllString(text, -1)),
			ruleCalls:  len(minorRuleRe.FindAllString(text, -1)) - len(minorRuleDeclRe.FindAllString(text, -1)),
		}
		if s.imageReads != 0 || s.cacheUses != 0 || s.ruleCalls != 0 {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			got[filepath.ToSlash(rel)] = s
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The walk saw the module (positive control): the image query's own file is among the hits.
	if scanned < 50 {
		t.Fatalf("scanned %d source files under %s, want the whole module", scanned, root)
	}
	if _, ok := got["internal/feed/query.go"]; !ok {
		t.Fatalf("the walk found no image read in internal/feed/query.go: the patterns match nothing (%v)", got)
	}
	for file, s := range got {
		want, ok := minorRuleSites[file]
		if !ok {
			t.Errorf("%s reads Image rows or the showcase cache, or calls the rule (%d reads, %d cache uses, %d rule calls), and is not in the ledger: apply the rule if it serves a Node read that applies it, then list it", file, s.imageReads, s.cacheUses, s.ruleCalls)
			continue
		}
		if s.imageReads != want.imageReads || s.cacheUses != want.cacheUses || s.ruleCalls != want.ruleCalls {
			t.Errorf("%s: %d reads, %d cache uses, %d rule calls; the ledger says %d, %d, %d (%s)", file,
				s.imageReads, s.cacheUses, s.ruleCalls, want.imageReads, want.cacheUses, want.ruleCalls, want.why)
		}
	}
	for file := range minorRuleSites {
		if _, ok := got[file]; !ok {
			t.Errorf("%s is in the ledger but reads nothing and calls nothing: update the ledger", file)
		}
	}
}
