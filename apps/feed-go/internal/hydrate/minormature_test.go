package hydrate

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

// minorMatureLevels is every rating minor-content-gate.sql.test.ts runs the rule over (null, 0, PG,
// PG-13, PG|PG-13, R, X, XXX, Blocked, PG|R), each with the answer isMinorRestrictedLevel gives it,
// written out: R and above, a mask holding R, a missing and an unrated rating are restricted.
var minorMatureLevels = []struct {
	level      any
	restricted bool
}{
	{nil, true},
	{int64(0), true},
	{int64(1), false},
	{int64(2), false},
	{int64(3), false},
	{int64(4), true},
	{int64(8), true},
	{int64(16), true},
	{int64(32), true},
	{int64(5), true},
}

func TestIsMinorRestrictedLevel(t *testing.T) {
	for _, c := range minorMatureLevels {
		if got := IsMinorRestrictedLevel(c.level); got != c.restricted {
			t.Errorf("IsMinorRestrictedLevel(%v) = %v, want %v", c.level, got, c.restricted)
		}
	}
	// The other decoded number types read as the same numbers.
	for _, c := range []struct {
		level      any
		restricted bool
	}{
		{float64(2), false}, {float64(4), true}, {float64(0), true}, {int(2), false}, {int(4), true},
		{int32(3), false}, {uint64(16), true}, {float32(1), false}, {float32(8), true},
	} {
		if got := IsMinorRestrictedLevel(c.level); got != c.restricted {
			t.Errorf("IsMinorRestrictedLevel(%T %v) = %v, want %v", c.level, c.level, got, c.restricted)
		}
	}
	// A level that is not a number is restricted, a string holding a safe number included.
	for _, v := range []any{"1", true, []any{}} {
		if !IsMinorRestrictedLevel(v) {
			t.Errorf("IsMinorRestrictedLevel(%T %v) = false, want true", v, v)
		}
	}
}

func TestIsMinorMatureImage(t *testing.T) {
	for _, c := range minorMatureLevels {
		if got := IsMinorMatureImage(true, c.level); got != c.restricted {
			t.Errorf("minor at %v = %v, want %v", c.level, got, c.restricted)
		}
		// Only the boolean true is the flag (`image.minor === true`).
		for _, minor := range []any{false, nil, "true", int64(1)} {
			if IsMinorMatureImage(minor, c.level) {
				t.Errorf("minor %#v at %v = true, want false", minor, c.level)
			}
		}
	}
}

const (
	// minorMatureClause is minorMatureImageVisibleSql's text with no viewer (Node binds the level; it
	// is the literal 4 here).
	minorMatureClause = `(NOT ((COALESCE(i."minor", FALSE)) AND (i."nsfwLevel" IS NULL OR i."nsfwLevel" = 0 OR i."nsfwLevel" >= 4)))`
	// minorMatureOwnerClause is the same with the viewer's own images exempt, the viewer bound as $7.
	minorMatureOwnerClause = `(NOT ((COALESCE(i."minor", FALSE)) AND (i."nsfwLevel" IS NULL OR i."nsfwLevel" = 0 OR i."nsfwLevel" >= 4)) OR i."userId" = $7)`
)

func TestMinorMatureImageVisibleSQL(t *testing.T) {
	var bound []any
	bind := func(v any) string { bound = append(bound, v); return "$7" }

	if got := MinorMatureImageVisibleSQL("i", 1003, true, bind); got != `TRUE` || len(bound) != 0 {
		t.Errorf("moderator: %q binding %v, want TRUE binding nothing", got, bound)
	}
	if got := MinorMatureImageVisibleSQL("i", 0, false, bind); got != minorMatureClause || len(bound) != 0 {
		t.Errorf("signed out:\n got %s binding %v\nwant %s binding nothing", got, bound, minorMatureClause)
	}
	if got := MinorMatureImageVisibleSQL("i", 1003, false, bind); got != minorMatureOwnerClause || !reflect.DeepEqual(bound, []any{1003}) {
		t.Errorf("signed in:\n got %s binding %v\nwant %s binding [1003]", got, bound, minorMatureOwnerClause)
	}
	if got := MinorMatureImageHiddenSQL("i"); got != minorMatureClause {
		t.Errorf("no viewer:\n got %s\nwant %s", got, minorMatureClause)
	}
	// The alias is the one given.
	if got := MinorMatureImageHiddenSQL("img"); !strings.Contains(got, `COALESCE(img."minor", FALSE)`) || strings.Contains(got, `i."`) {
		t.Errorf("alias img: %s", got)
	}
}

func TestWithoutMinorMatureImages(t *testing.T) {
	images := []map[string]any{
		{"id": 1, "minor": true, "nsfwLevel": int64(4)},  // restricted: dropped
		{"id": 2, "minor": false, "nsfwLevel": int64(4)}, // not flagged: kept
		{"id": 3, "minor": true, "nsfwLevel": int64(2)},  // PG-13: kept
		{"id": 4, "minor": true, "nsfwLevel": int64(0)},  // unrated: dropped
		{"id": 5, "nsfwLevel": int64(16)},                // no flag member: kept
		{"id": 6, "minor": true},                         // no level member: dropped
		{"id": 7, "minor": true, "nsfwLevel": int64(1)},  // PG: kept
	}
	got := WithoutMinorMatureImages(images, func(m map[string]any, k string) any { return m[k] })
	ids := make([]any, 0, len(got))
	for _, m := range got {
		ids = append(ids, m["id"])
	}
	if want := []any{2, 3, 5, 7}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("kept %v, want %v", ids, want)
	}
	if len(images) != 7 {
		t.Fatalf("the input was changed: %v", images)
	}
	if out := WithoutMinorMatureImages[map[string]any](nil, nil); out == nil || len(out) != 0 {
		t.Fatalf("no images: %#v, want an empty slice", out)
	}
}

// The appendFn's filter on the shared showcase cache: a restricted minor image cached before the
// lookup left it out is dropped from the version for every reader, before its tags are read (8101
// has no tag-ids entry, so a read of it would be a miss).
func TestVersionImagesDropsMinorMatureImages(t *testing.T) {
	f := newModelFixture()
	f.put(t, KeyVersionImages, 6001, map[string]any{"modelVersionId": 6001, "images": []any{
		map[string]any{"id": 8101, "userId": 1001, "nsfwLevel": 4, "minor": true},
		map[string]any{"id": 8102, "userId": 1001, "nsfwLevel": 4, "minor": false},
		map[string]any{"id": 8103, "userId": 1001, "nsfwLevel": 2, "minor": true},
	}})
	f.put(t, KeyVersionImages, 6002, map[string]any{"modelVersionId": 6002, "images": []any{
		map[string]any{"id": 8104, "userId": 1001, "nsfwLevel": 8, "minor": true},
	}})
	f.put(t, KeyTagIDs, 8102, map[string]any{"tags": []any{1}})
	f.put(t, KeyTagIDs, 8103, map[string]any{"tags": []any{2}})
	got, err := f.sources().VersionImages(context.Background(), []int{6001, 6002})
	if err != nil {
		t.Fatalf("VersionImages: %v", err)
	}
	ids := make([]int, 0, len(got[6001]))
	for _, img := range got[6001] {
		id, _ := Int(ObjectField(img, "id"))
		ids = append(ids, id)
	}
	if want := []int{8102, 8103}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("version 6001 images %v, want %v", ids, want)
	}
	// Every image filtered out: the version keeps its entry, with no images.
	if list, ok := got[6002]; !ok || len(list) != 0 {
		t.Fatalf("version 6002 = %v (present %v), want an empty list", list, ok)
	}
}

// The same read keeps only the images at a selectable level, for every reader.
func TestVersionImagesLevels(t *testing.T) {
	f := newModelFixture()
	f.put(t, KeyVersionImages, 6003, map[string]any{"modelVersionId": 6003, "images": []any{
		map[string]any{"id": 8201, "userId": 1001, "nsfwLevel": 32},
		map[string]any{"id": 8202, "userId": 1001, "nsfwLevel": 1},
		map[string]any{"id": 8203, "userId": 1001, "nsfwLevel": 16 | 32},
	}})
	for _, id := range []int{8201, 8202, 8203} {
		f.put(t, KeyTagIDs, id, map[string]any{"tags": []any{1}})
	}
	got, err := f.sources().VersionImages(context.Background(), []int{6003})
	if err != nil {
		t.Fatalf("VersionImages: %v", err)
	}
	ids := make([]int, 0, len(got[6003]))
	for _, img := range got[6003] {
		id, _ := Int(ObjectField(img, "id"))
		ids = append(ids, id)
	}
	if want := []int{8202, 8203}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("version 6003 images %v, want %v", ids, want)
	}
}

// The shared showcase lookup leaves the restricted minor images out (the integration test runs it).
func TestVersionImagesSQLHasTheMinorRule(t *testing.T) {
	if n := strings.Count(sqlVersionImages, minorMatureClause); n != 1 {
		t.Fatalf("the showcase query holds the minor content rule %d times, want 1:\n%s", n, sqlVersionImages)
	}
	if strings.Contains(sqlVersionImages, `OR i."userId" = $`) {
		t.Fatal("the showcase query exempts a viewer: the shared cache has none")
	}
}
