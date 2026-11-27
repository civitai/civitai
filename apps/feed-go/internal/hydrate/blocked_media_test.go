package hydrate

import (
	"reflect"
	"strconv"
	"testing"
)

// The Go twins of imageBlockedForConditions, ownerMediaSql and blockedMediaListConditions
// (src/server/common/image-visibility.ts), as literal SQL with the binds they make.
func TestBlockedMediaListSQL(t *testing.T) {
	const oma = `(CASE WHEN "i"."blockedFor" IS NOT NULL THEN "i"."blockedFor" IN ('AiNotVerified') ELSE "i"."ingestion" <> 'Blocked'::"ImageIngestionStatus" END)`
	binder := func() (*[]any, func(any) string) {
		args := &[]any{"first"}
		return args, func(v any) string {
			*args = append(*args, v)
			return "$" + strconv.Itoa(len(*args))
		}
	}
	for _, c := range []struct {
		name     string
		viewer   int
		mod      bool
		list     bool // BlockedMediaListSQL, else ImageBlockedForSQL
		want     []string
		wantArgs []any
	}{
		{"list, owner", 77, false, true, []string{
			`(i."blockedFor" IS NULL OR (i."userId" = $2 AND ` + oma + `))`,
			`("i"."userId" <> $3 OR ` + oma + `)`,
		}, []any{"first", 77, 77}},
		{"list, signed out", 0, false, true, []string{`(i."blockedFor" IS NULL)`, `TRUE`}, []any{"first"}},
		{"list, moderator", 77, true, true, nil, []any{"first"}},
		{"blockedFor only, owner", 77, false, false, []string{
			`(i."blockedFor" IS NULL OR (i."userId" = $2 AND ` + oma + `))`,
		}, []any{"first", 77}},
		{"blockedFor only, signed out", 0, false, false, []string{`(i."blockedFor" IS NULL)`}, []any{"first"}},
		{"blockedFor only, moderator", 77, true, false, nil, []any{"first"}},
	} {
		args, bind := binder()
		var got []string
		if c.list {
			got = BlockedMediaListSQL(c.viewer, c.mod, bind)
		} else {
			got = ImageBlockedForSQL(c.viewer, c.mod, bind)
		}
		if !reflect.DeepEqual(got, c.want) || !reflect.DeepEqual(*args, c.wantArgs) {
			t.Errorf("%s:\n got %q args %v\nwant %q args %v", c.name, got, *args, c.want, c.wantArgs)
		}
	}
	// OwnerMediaSQL alone, signed out: TRUE, no bind.
	args, bind := binder()
	if got := OwnerMediaSQL(0, bind); got != `TRUE` || len(*args) != 1 {
		t.Errorf("OwnerMediaSQL signed out = %q args %v, want TRUE and no bind", got, *args)
	}
}
