//go:build integration

package hydrate

// The minor content rule's SQL against the real Postgres, over every rating minor-content-gate.sql.test.ts
// runs it over, and the shared showcase lookup with it. Ids live in 1_180_000..1_180_999.

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// Every (minor, nsfwLevel, owner) row, for a moderator, a signed-out viewer and viewer 1180042: the
// clause keeps exactly what the rule says (a restricted rating is NULL, 0, R, X, XXX, Blocked or a mask
// holding R), and the Go twin IsMinorMatureImage agrees with it row by row.
func TestIntegrationMinorMatureSQLOverEveryRating(t *testing.T) {
	ctx := integtest.Ctx(t)
	pg := integtest.Postgres(t)
	type row struct {
		minor *bool
		level *int
		owner int
	}
	tru, fls := true, false
	levels := []*int{nil}
	for _, n := range []int{0, 1, 2, 3, 4, 8, 16, 32, 5} {
		levels = append(levels, &n)
	}
	restricted := map[string]bool{"<nil>": true, "0": true, "4": true, "8": true, "16": true, "32": true, "5": true}
	levelKey := func(l *int) string {
		if l == nil {
			return "<nil>"
		}
		return strconv.Itoa(*l)
	}
	var rows []row
	var values []string
	for _, minor := range []*bool{&tru, &fls, nil} {
		for _, level := range levels {
			for _, owner := range []int{1180007, 1180042} {
				rows = append(rows, row{minor, level, owner})
				m, l := "NULL::boolean", "NULL::int"
				if minor != nil {
					m = strconv.FormatBool(*minor)
				}
				if level != nil {
					l = strconv.Itoa(*level) + "::int"
				}
				values = append(values, fmt.Sprintf("(%d, %s, %s, %d)", len(rows), m, l, owner))
			}
		}
	}
	for _, viewer := range []struct {
		name        string
		id          int
		isModerator bool
	}{{"moderator", 1180042, true}, {"signed out", 0, false}, {"viewer", 1180042, false}} {
		var args []any
		bind := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
		clause := MinorMatureImageVisibleSQL("i", viewer.id, viewer.isModerator, bind)
		q := `SELECT n FROM (VALUES ` + strings.Join(values, ", ") + `) AS i(n, minor, "nsfwLevel", "userId") WHERE ` +
			clause + ` ORDER BY n`
		res, err := pg.Query(ctx, q, args...)
		if err != nil {
			t.Fatalf("%s: %v\n%s", viewer.name, err, q)
		}
		got := map[int]bool{}
		for res.Next() {
			var n int
			if err := res.Scan(&n); err != nil {
				t.Fatal(err)
			}
			got[n] = true
		}
		res.Close()
		if err := res.Err(); err != nil {
			t.Fatal(err)
		}
		kept, dropped := 0, 0
		for i, r := range rows {
			hidden := r.minor != nil && *r.minor && restricted[levelKey(r.level)]
			want := viewer.isModerator || !hidden || (viewer.id != 0 && r.owner == viewer.id)
			if got[i+1] != want {
				t.Errorf("%s: minor=%v level=%s owner=%d kept %v, want %v", viewer.name, ptrVal(r.minor), levelKey(r.level), r.owner, got[i+1], want)
			}
			var minor, level any
			if r.minor != nil {
				minor = *r.minor
			}
			if r.level != nil {
				level = int64(*r.level)
			}
			if IsMinorMatureImage(minor, level) != hidden {
				t.Errorf("IsMinorMatureImage(%v, %v) = %v, the SQL rule says %v", minor, level, !hidden, hidden)
			}
			if got[i+1] {
				kept++
			} else {
				dropped++
			}
		}
		// Both outcomes occur except for a moderator, who keeps every row.
		if (viewer.isModerator && dropped != 0) || (!viewer.isModerator && (kept == 0 || dropped == 0)) {
			t.Errorf("%s: kept %d, dropped %d", viewer.name, kept, dropped)
		}
	}
}

func ptrVal(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

// The shared showcase lookup leaves out the owner's restricted minor images (R, and X) and keeps a
// minor PG-13 image and an unflagged R image (the controls).
func TestIntegrationVersionImagesLeaveOutMinorMature(t *testing.T) {
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1180700 AND 1180799;
		DELETE FROM "Post" WHERE id BETWEEN 1180700 AND 1180799;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 1180700 AND 1180799;
		DELETE FROM "Model" WHERE id BETWEEN 1180700 AND 1180799;
		INSERT INTO "Model" (id, "userId") VALUES (1180701, 1180801);
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (1180711, 1180701);
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (1180721, 1180801, 1180711, now());
		INSERT INTO "Image" (id, url, "userId", "postId", index, type, metadata, "nsfwLevel", ingestion, minor) VALUES
		  (1180731, 'u', 1180801, 1180721, 0, 'image', '{}', 4, 'Scanned', true),
		  (1180732, 'u', 1180801, 1180721, 1, 'image', '{}', 4, 'Scanned', false),
		  (1180733, 'u', 1180801, 1180721, 2, 'image', '{}', 2, 'Scanned', true),
		  (1180734, 'u', 1180801, 1180721, 3, 'image', '{}', 8, 'Scanned', true);`)
	t.Cleanup(func() {
		integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1180700 AND 1180799;
			DELETE FROM "Post" WHERE id BETWEEN 1180700 AND 1180799;
			DELETE FROM "ModelVersion" WHERE id BETWEEN 1180700 AND 1180799;
			DELETE FROM "Model" WHERE id BETWEEN 1180700 AND 1180799;`)
		_ = e.c.Del(integtest.Ctx(t), e.prefix+KeyVersionImages+":1180711").Err()
	})
	ctx := integtest.Ctx(t)
	ids := []int{1180711}
	got, writable := e.src.read(ctx, KeyVersionImages, ids, versionImagesTTL)
	if err := e.src.fillVersionImages(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	var kept []int
	for _, img := range asList(got[1180711].Value["images"]) {
		m, _ := img.(map[string]any)
		id, _ := Int(m["id"])
		kept = append(kept, id)
	}
	if want := []int{1180732, 1180733}; !reflect.DeepEqual(kept, want) {
		t.Fatalf("showcase ids %v, want %v", kept, want)
	}
}
