package clock

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// wantNowReads is every read of clock.Now outside this package, per file: the reads that decide what
// an answer holds, which FEED_GO_EVAL_NOW must reach (the package doc). The ledger fails when a read
// is added (decide it belongs here, then add it) and when one goes (a read put back on time.Now is
// exactly what eval mode cannot see). Behaviour is pinned per package by the TestEvalClockReaches*
// tests (auth, feed, hydrate, server); this pins every EXISTING clock.Now site, including the ones those
// do not drive. It cannot see a new answer-affecting time.Now() nor a SQL now() (DESIGN.md §19.7 lists
// the queries that still read the database's clock): it is an invariant guard on the known sites, not
// proof that the seam is complete.
var wantNowReads = map[string]int{
	"auth/bearer.go":      1, // API-key expiry
	"auth/jwt.go":         1, // session-token exp / nbf / signedAt (tokenNow; the key set's pacing stays on the wall clock)
	"feed/infinite.go":    1, // image.getInfinite publish and schedule filters
	"feed/newcreators.go": 1, // the new-creators board's staleness
	"feed/posts.go":       1, // the gallery's publish filters
	"feed/v1images.go":    2, // /api/v1/images publish filter (both paths)
	"hydrate/batch.go":    1, // cache-entry staleness
	"hydrate/official.go": 1, // the official-models entry's TTL
	"hydrate/ordered.go":  1, // cache-entry staleness
	"hydrate/showcase.go": 1, // the version showcase's staleness
	"modelfeed/assoc.go":  1, // the promotions window
	"modelfeed/serve.go":  1, // model.getAll's time filters
	"server/server.go":    1, // regionMatches: every dated region rule
	"v1models/build.go":   1, // /api/v1/models time filters
}

func TestClockNowReadsLedger(t *testing.T) {
	got := map[string]int{}
	fset := token.NewFileSet()
	files := 0
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel("..", path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "clock/") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		files++
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Now" {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == "clock" {
				got[rel]++
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Positive control on the walk itself: an empty map must not pass because nothing was read.
	if files < 50 {
		t.Fatalf("walked %d files: not the internal tree", files)
	}
	if !reflect.DeepEqual(got, wantNowReads) {
		t.Fatalf("clock.Now reads = %v\nwant %v", got, wantNowReads)
	}
}
