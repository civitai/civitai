package hydrate

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// holdModel is one Model row as sqlGalleryHold reads it: the flags and the stored level's JSON type
// and text (`jsonb_typeof(...)`, `->>`; both nil for no `level` key).
type holdModel struct {
	minor, sfwOnly bool
	levelType      any
	level          any
}

// holdReplica answers sqlGalleryHold from models; bound is each query's model ids, fail fails it.
type holdReplica struct {
	models map[int]holdModel
	fail   error
	bound  [][]int
}

func (h *holdReplica) db() *testkit.DB {
	return &testkit.DB{Routes: []testkit.Route{{
		Match: `SELECT id, minor, "sfwOnly", jsonb_typeof("gallerySettings"->'level') AS "levelType", "gallerySettings"->>'level' AS level FROM "Model" WHERE id = ANY($1::int[])`,
		Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			h.bound = append(h.bound, ids)
			if h.fail != nil {
				return nil, h.fail
			}
			var rows [][]any
			for _, id := range ids {
				if m, ok := h.models[id]; ok {
					rows = append(rows, []any{int64(id), m.minor, m.sfwOnly, m.levelType, m.level})
				}
			}
			return testkit.NewRows([]string{"id", "minor", "sfwOnly", "levelType", "level"}, rows...), nil
		}}}}
}

// getGallerySettingsByModelId's rebuild (src/server/services/model.service.ts) decides the hold from
// the model row: `sfwHeld = minor || sfwOnly`, and then `level = heldGalleryLevel(stored.level,
// model)` (src/shared/constants/browsingLevel.constants.ts): `Flags.intersection(stored ?? 0, limit)
// || limit`, the limit the SFW levels (PG|PG-13 = 3) for a minor or SFW-only model. A model with no
// row is no settings (null): absent from the answer. The literal levels below are that rule worked by
// hand.
func TestGalleryHoldsFromModelRow(t *testing.T) {
	num := func(s string) holdModel { return holdModel{sfwOnly: true, levelType: "number", level: s} }
	rep := &holdReplica{models: map[int]holdModel{
		5101: num("3"),
		5102: {minor: true, levelType: "number", level: "31"},
		5103: num("8"), // R only: nothing within the limit, so the whole limit
		5104: {sfwOnly: true},
		5105: {levelType: "number", level: "1"}, // neither flag: not held, whatever the level
		5106: num("1"),
		5107: {minor: true, levelType: "number", level: "2"},
		5111: {minor: true, levelType: "null"},                               // `level: null`: `null ?? 0`
		5112: {minor: true, sfwOnly: true, levelType: "number", level: "-1"}, // -1 & 3 = 3, as in JS
	}}
	src := &Sources{Replica: rep.db(), Compute: &MissCompute{}}
	got, err := src.GalleryHolds(context.Background(), []int{5101, 5102, 5103, 5104, 5105, 5106, 5107, 5108, 5111, 5112, 5101})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]GalleryHold{
		5101: {Held: true, Level: 3}, 5102: {Held: true, Level: 3}, 5103: {Held: true, Level: 3},
		5104: {Held: true, Level: 3}, 5105: {Held: false, Level: 0}, 5106: {Held: true, Level: 1},
		5107: {Held: true, Level: 2}, 5111: {Held: true, Level: 3}, 5112: {Held: true, Level: 3},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("holds %v, want %v", got, want)
	}
	// One query, each id once (5108 has no row: absent).
	if !reflect.DeepEqual(rep.bound, [][]int{{5101, 5102, 5103, 5104, 5105, 5106, 5107, 5108, 5111, 5112}}) {
		t.Errorf("bound %v", rep.bound)
	}
}

// A stored level JS would coerce or truncate (a string, a fraction, a number past int32) on a held
// model is not guessed at: the lookup fails and the request falls back (gallery-settings-miss-failed).
// On a model that is not held the level is never read.
func TestGalleryHoldsUnreadableLevel(t *testing.T) {
	for name, m := range map[string]holdModel{
		"a string":    {sfwOnly: true, levelType: "string", level: "3"},
		"a fraction":  {sfwOnly: true, levelType: "number", level: "1.5"},
		"past int32":  {minor: true, levelType: "number", level: "4294967299"},
		"a boolean":   {minor: true, levelType: "boolean", level: "true"},
		"an object":   {minor: true, levelType: "object", level: "{}"},
		"unparseable": {minor: true, levelType: "number", level: "x"},
	} {
		rep := &holdReplica{models: map[int]holdModel{5201: m}}
		_, err := (&Sources{Replica: rep.db(), Compute: &MissCompute{}}).GalleryHolds(context.Background(), []int{5201})
		if fallback.Reason(err) != "gallery-settings-miss-failed" {
			t.Errorf("%s: err %v, want gallery-settings-miss-failed", name, err)
		}
	}
	rep := &holdReplica{models: map[int]holdModel{5202: {levelType: "string", level: "3"}}}
	got, err := (&Sources{Replica: rep.db(), Compute: &MissCompute{}}).GalleryHolds(context.Background(), []int{5202})
	if err != nil || !reflect.DeepEqual(got, map[int]GalleryHold{5202: {}}) {
		t.Errorf("unheld model with a string level: %v (%v), want not held", got, err)
	}
}

// Node's rebuild reads the model through getDbWithoutLag('model', id): the primary for a model a
// recent write flagged (`lag-helper:model:<id>`, namespace prefixed, any non-empty value). This
// service reads only the replica, so a flagged model among the misses, or a failed flag read, is the
// gallery-settings-miss fallback with no query; a flag on another model, an empty flag or an
// unprefixed key changes nothing.
func TestGalleryHoldsLagFlag(t *testing.T) {
	const ns = "ns:"
	r := testkit.NewRedis()
	r.SetString(ns+"lag-helper:model:5302", []byte("true"))
	r.SetString(ns+"lag-helper:model:5303", []byte(""))
	r.SetString("lag-helper:model:5301", []byte("true")) // not the key Node writes
	r.SetString(ns+"lag-helper:modelVersion:5301", []byte("true"))
	r.KeyErr = func(key string) error {
		if key == ns+"lag-helper:model:5304" {
			return errors.New("shard down")
		}
		return nil
	}
	for _, c := range []struct {
		name     string
		ids      []int
		fallback string
		bound    [][]int
		obs      map[string]int
	}{
		{"unflagged: computed", []int{5301}, "", [][]int{{5301}}, map[string]int{"gallery-hold/computed": 1}},
		{"an empty flag: computed", []int{5303, 5301}, "", [][]int{{5303, 5301}}, map[string]int{"gallery-hold/computed": 2}},
		{"flagged: not computed", []int{5302}, "gallery-settings-miss", nil, map[string]int{}},
		{"one flagged among misses: not computed", []int{5301, 5302}, "gallery-settings-miss", nil, map[string]int{}},
		{"a failed flag read: not computed", []int{5304}, "gallery-settings-miss", nil, map[string]int{}},
	} {
		rep := &holdReplica{models: map[int]holdModel{5301: {sfwOnly: true}, 5302: {sfwOnly: true}, 5303: {minor: true}}}
		obs := &observed{}
		src := &Sources{Packed: &PackedReader{Redis: r, Prefix: ns}, Replica: rep.db(), Compute: &MissCompute{Observe: obs.observe}}
		_, err := src.GalleryHolds(context.Background(), c.ids)
		if got := fallback.Reason(err); got != c.fallback || (c.fallback == "" && err != nil) {
			t.Errorf("%s: err %v, want fallback %q", c.name, err, c.fallback)
		}
		if !reflect.DeepEqual(rep.bound, c.bound) {
			t.Errorf("%s: bound %v, want %v", c.name, rep.bound, c.bound)
		}
		if g := obs.get(); !reflect.DeepEqual(g, c.obs) {
			t.Errorf("%s: observed %v, want %v", c.name, g, c.obs)
		}
	}
}

// Without the miss computation, a replica, or under a Go-first probe, nothing is queried and the miss
// falls back as before; a failed query is gallery-settings-miss-failed, counted as an error. No answer
// is kept: a repeat queries again.
func TestGalleryHoldsOffFailsAndKeepsNothing(t *testing.T) {
	rep := &holdReplica{models: map[int]holdModel{5401: {sfwOnly: true}}}
	for name, src := range map[string]*Sources{
		"no computation": {Replica: rep.db()},
		"no replica":     {Compute: &MissCompute{}},
	} {
		if _, err := src.GalleryHolds(context.Background(), []int{5401}); fallback.Reason(err) != "gallery-settings-miss" {
			t.Errorf("%s: err %v, want gallery-settings-miss", name, err)
		}
	}
	probe := WithPresence(context.Background(), &PresenceProbe{})
	if _, err := (&Sources{Replica: rep.db(), Compute: &MissCompute{}}).GalleryHolds(probe, []int{5401}); fallback.Reason(err) != "gallery-settings-miss" {
		t.Errorf("probe: err %v, want gallery-settings-miss", err)
	}
	if len(rep.bound) != 0 {
		t.Fatalf("queried: %v", rep.bound)
	}

	src := &Sources{Replica: rep.db(), Compute: &MissCompute{}}
	for i := 0; i < 2; i++ {
		if _, err := src.GalleryHolds(context.Background(), []int{5401}); err != nil {
			t.Fatal(err)
		}
	}
	if len(rep.bound) != 2 {
		t.Errorf("a repeat was answered from memory: bound %v, want two queries", rep.bound)
	}

	obs := &observed{}
	bad := &holdReplica{fail: errors.New("replica down")}
	_, err := (&Sources{Replica: bad.db(), Compute: &MissCompute{Observe: obs.observe}}).GalleryHolds(context.Background(), []int{5402, 5403})
	if fallback.Reason(err) != "gallery-settings-miss-failed" {
		t.Errorf("failed query: %v, want gallery-settings-miss-failed", err)
	}
	if g := obs.get(); !reflect.DeepEqual(g, map[string]int{"gallery-hold/error": 2}) {
		t.Errorf("failed query observed %v", g)
	}
}

// The statement reads the Model row by primary key, the rebuild's three columns and nothing else.
func TestGalleryHoldSQL(t *testing.T) {
	for _, part := range []string{`FROM "Model" WHERE id = ANY($1::int[])`, `minor`, `"sfwOnly"`,
		`jsonb_typeof("gallerySettings"->'level')`, `"gallerySettings"->>'level'`} {
		if !strings.Contains(sqlGalleryHold, part) {
			t.Errorf("sqlGalleryHold lacks %s", part)
		}
	}
}
