package shared

import (
	"context"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

type releases struct{ got []string }

func (r *releases) View(context.Context, string, string, int64) (session.Snapshot, error) {
	return session.Snapshot{}, nil
}

func (r *releases) Release(token, schema string) { r.got = append(r.got, token+" "+schema) }

// Release asks the level manager to release every level stream of the major, and the per-viewer
// manager the viewer's own stream; a signed-out viewer has none, and an invalid reference nothing.
func TestReleaseNamesEveryStreamOfTheMajor(t *testing.T) {
	levels, viewers := &releases{}, &releases{}
	r := &Reader{Levels: levels, Viewers: viewers}
	r.Release(Viewer{Token: "tok-v"}, "todo-app", "notes", 3)
	const s3 = "urn:schema:apps.civitai.com:todo-app/notes@v3"
	want := make([]string, 0, 6)
	for _, l := range []string{"none", "1", "2", "4", "8", "16"} {
		want = append(want, "level:"+l+"|"+s3+" "+s3)
	}
	if got := strings.Join(levels.got, ","); got != strings.Join(want, ",") {
		t.Fatalf("levels released:\n%s\nwant\n%s", got, strings.Join(want, ","))
	}
	if got := strings.Join(viewers.got, ","); got != "tok-v urn:schema:apps.civitai.com:todo-app/notes.viewer@v3" {
		t.Fatalf("viewers released: %s", got)
	}
	r.Release(Viewer{Anonymous: &Anonymous{Mask: 1}}, "todo-app", "notes", 2)
	r.Release(Viewer{Token: "tok-v"}, "Bad Slug", "notes", 2)
	if len(viewers.got) != 1 || len(levels.got) != 12 {
		t.Fatalf("after a signed-out and an invalid release: %d viewer, %d level releases; want 1, 12", len(viewers.got), len(levels.got))
	}
}
