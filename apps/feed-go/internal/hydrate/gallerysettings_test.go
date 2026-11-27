package hydrate

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// settingsModel is one Model row as the gallery-settings rebuild reads it: its jsonb as the text
// Postgres prints (members ordered by key length, then bytes; nil for NULL).
type settingsModel struct {
	userID         int
	settings       any
	minor, sfwOnly bool
}

// settingsDB answers the rebuild's reads: the Model rows, the Tag and User lookups and the creators'
// hidden users (by creator, in row order), recording each query's bound ids by table.
type settingsDB struct {
	models  map[int]settingsModel
	tags    [][]any // id, name, in row order
	users   [][]any // id, username
	hidden  [][]any // creatorId, userId
	modelOK bool    // whether this database answers the Model read at all
	bound   map[string][][]int
}

func (d *settingsDB) record(table string, args []any) []int {
	ids, _ := args[0].([]int)
	if d.bound == nil {
		d.bound = map[string][][]int{}
	}
	d.bound[table] = append(d.bound[table], ids)
	return ids
}

func containsID(ids []int, id int) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func (d *settingsDB) db() *testkit.DB {
	var routes []testkit.Route
	if d.modelOK {
		routes = append(routes, testkit.Route{
			Match: `SELECT id, "userId", "gallerySettings"::text AS "gallerySettings", minor, "sfwOnly" FROM "Model" WHERE id = ANY($1::int[])`,
			Rows: func(args []any) (*testkit.Rows, error) {
				ids := d.record("Model", args)
				var rows [][]any
				for _, id := range ids {
					if m, ok := d.models[id]; ok {
						rows = append(rows, []any{int64(id), int64(m.userID), m.settings, m.minor, m.sfwOnly})
					}
				}
				return testkit.NewRows([]string{"id", "userId", "gallerySettings", "minor", "sfwOnly"}, rows...), nil
			}})
	}
	pick := func(table string, rows [][]any, cols []string) func([]any) (*testkit.Rows, error) {
		return func(args []any) (*testkit.Rows, error) {
			ids := d.record(table, args)
			var out [][]any
			for _, r := range rows {
				if containsID(ids, int(r[0].(int64))) {
					out = append(out, r)
				}
			}
			return testkit.NewRows(cols, out...), nil
		}
	}
	routes = append(routes,
		testkit.Route{Match: `SELECT id, name FROM "Tag" WHERE id = ANY($1::int[])`, Rows: pick("Tag", d.tags, []string{"id", "name"})},
		testkit.Route{Match: `SELECT id, username FROM "User" WHERE id = ANY($1::int[])`, Rows: pick("User", d.users, []string{"id", "username"})},
		testkit.Route{
			Match: `FROM "CreatorGalleryHiddenUser" h JOIN "User" u ON u.id = h."userId" AND u."deletedAt" IS NULL WHERE h."creatorId" = ANY($1::int[])`,
			Rows:  pick("CreatorGalleryHiddenUser", d.hidden, []string{"creatorId", "userId"}),
		},
	)
	return &testkit.DB{Routes: routes}
}

// The entries Node's getGallerySettingsByModelId writes for these rows, as Node itself wrote them:
// each literal is the output of the function's own assembly (`{ ...getGalleryHiddenPreferences(...),
// creatorHiddenUserIds, sfwHeld }`, or the `none` marker, through toJson) run under node over the same
// rows, jsonb parsed from the text below. The held model's stored level 28 (R|X|XXX) has nothing
// within PG|PG-13, so heldGalleryLevel answers the whole limit, 3.
const (
	nodeHeldEntry   = `{"hiddenTags":[{"id":9001,"name":"anime"},{"id":9002,"name":"nsfw \"x\""}],"hiddenUsers":[{"id":1201,"username":"hidden_one"}],"hiddenImages":{"6001":[8099]},"level":3,"pinnedPosts":{"9":[2],"10":[3]},"creatorHiddenUserIds":[1301,1302],"sfwHeld":true}`
	nodeNoneEntry   = `{"none":true,"hiddenTags":[],"hiddenUsers":[],"hiddenImages":{},"pinnedPosts":{}}`
	nodeUnheldEntry = `{"hiddenTags":[],"hiddenUsers":[{"id":1202,"username":null}],"hiddenImages":null,"level":1,"pinnedPosts":{},"creatorHiddenUserIds":[],"sfwHeld":false}`
)

func settingsFixture() (replica, primary *settingsDB) {
	models := map[int]settingsModel{
		7101: {userID: 1101, sfwOnly: true,
			settings: `{"tags": [9002, 9001], "level": 28, "users": [1201], "pinnedPosts": {"9": [2], "10": [3]}, "hiddenImages": {"6001": [8099]}}`},
		7102: {userID: 1102},
		7103: {userID: 1103, settings: `{"level": 1, "users": [1202], "hiddenImages": null}`},
	}
	replica = &settingsDB{models: models, modelOK: true,
		tags:  [][]any{{int64(9001), "anime"}, {int64(9002), `nsfw "x"`}, {int64(9003), "other"}},
		users: [][]any{{int64(1201), "hidden_one"}, {int64(1202), nil}},
		// A replica that has not seen the creator's latest hide: never read (Node reads the primary).
		hidden: [][]any{{int64(1101), int64(1301)}},
	}
	primary = &settingsDB{models: models, modelOK: true,
		hidden: [][]any{{int64(1101), int64(1301)}, {int64(1101), int64(1302)}, {int64(1199), int64(1303)}},
	}
	return replica, primary
}

// With `gallery-settings` written back, a gallery-settings miss is rebuilt exactly as
// getGallerySettingsByModelId rebuilds it and written where and as Node writes it: the same key (under
// the cache key prefix), the same bytes (the Node-written literals above), a week's expiry
// (CacheTTL.week), SET NX. The model, its hidden tags and users are read from the replica (dbRead,
// getDbWithoutLag for an unflagged model), the creator's hidden users from the primary (`fresh`). A
// model with no row is answered as no settings and nothing is written for it (Node returns null before
// its SET). The holds the gates read come off the same entries.
func TestGallerySettingsWrittenAsNodeWritesThem(t *testing.T) {
	const ns = "ns:"
	replica, primary := settingsFixture()
	r := testkit.NewRedis()
	obs, writes := &observed{}, &observed{}
	src := &Sources{Packed: &PackedReader{Redis: r, Prefix: ns}, Replica: replica.db(), Compute: &MissCompute{
		WriteBack: WriteSet{"gallery-settings": true}, Primary: primary.db(), Observe: obs.observe, ObserveWrite: writes.observe}}
	got, err := src.GalleryHolds(context.Background(), []int{7101, 7102, 7103, 7104})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[int]GalleryHold{7101: {Held: true, Level: 3}, 7102: {}, 7103: {}}; !reflect.DeepEqual(got, want) {
		t.Errorf("holds %v, want %v", got, want)
	}
	for key, want := range map[string]string{
		"ns:model:gallery-settings:7101": nodeHeldEntry,
		"ns:model:gallery-settings:7102": nodeNoneEntry,
		"ns:model:gallery-settings:7103": nodeUnheldEntry,
	} {
		v, ok := r.String(key)
		if !ok || string(v) != want {
			t.Errorf("%s = %q (%v), want Node's %q", key, v, ok, want)
		}
		if ex := r.Expiry(key); ex != 604800*time.Second {
			t.Errorf("%s expiry %v, want 168h0m0s", key, ex)
		}
	}
	if r.Has("ns:model:gallery-settings:7104") || r.Has("model:gallery-settings:7101") {
		t.Errorf("wrote a key Node does not: %v", r.AllKeys())
	}
	if want := map[string][][]int{"Model": {{7101, 7102, 7103, 7104}}, "Tag": {{9002, 9001}}, "User": {{1201, 1202}}}; !reflect.DeepEqual(replica.bound, want) {
		t.Errorf("replica reads %v, want %v", replica.bound, want)
	}
	if want := map[string][][]int{"CreatorGalleryHiddenUser": {{1101, 1103}}}; !reflect.DeepEqual(primary.bound, want) {
		t.Errorf("primary reads %v, want %v", primary.bound, want)
	}
	if g := obs.get(); !reflect.DeepEqual(g, map[string]int{"gallery-settings/computed": 4}) {
		t.Errorf("observed %v", g)
	}
	if g := writes.get(); !reflect.DeepEqual(g, map[string]int{"gallery-settings/written": 3}) {
		t.Errorf("writes %v", g)
	}
}

// A key another writer (Node's own rebuild) filled between the read and the write is left as it is:
// the write is SET NX, counted nx_lost.
func TestGallerySettingsWriteIsNX(t *testing.T) {
	replica, primary := settingsFixture()
	r := testkit.NewRedis()
	r.SetString("model:gallery-settings:7101", []byte(`{"written":"by node"}`))
	writes := &observed{}
	src := &Sources{Packed: &PackedReader{Redis: r}, Replica: replica.db(), Compute: &MissCompute{
		WriteBack: WriteSet{"gallery-settings": true}, Primary: primary.db(), ObserveWrite: writes.observe}}
	if _, err := src.GalleryHolds(context.Background(), []int{7101}); err != nil {
		t.Fatal(err)
	}
	if v, _ := r.String("model:gallery-settings:7101"); string(v) != `{"written":"by node"}` {
		t.Errorf("overwrote the key: %q", v)
	}
	if g := writes.get(); !reflect.DeepEqual(g, map[string]int{"gallery-settings/nx_lost": 1}) {
		t.Errorf("writes %v", g)
	}
}

// getDbWithoutLag: a model a recent write flagged (`lag-helper:model:<id>`) is read from the primary,
// so the entry written for a week is not built from a lagging replica. (Without write-back the flag
// still falls back: TestGalleryHoldsLagFlag.) A failed flag read falls back with nothing read.
func TestGallerySettingsLagFlagReadsPrimary(t *testing.T) {
	replica, primary := settingsFixture()
	replica.modelOK = false // a Model read here fails the test
	r := testkit.NewRedis()
	r.SetString("lag-helper:model:7101", []byte("true"))
	src := &Sources{Packed: &PackedReader{Redis: r}, Replica: replica.db(), Compute: &MissCompute{
		WriteBack: WriteSet{"gallery-settings": true}, Primary: primary.db()}}
	got, err := src.GalleryHolds(context.Background(), []int{7101})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[int]GalleryHold{7101: {Held: true, Level: 3}}) {
		t.Errorf("holds %v", got)
	}
	if v, _ := r.String("model:gallery-settings:7101"); string(v) != nodeHeldEntry {
		t.Errorf("entry %q, want Node's %q", v, nodeHeldEntry)
	}
	if !reflect.DeepEqual(primary.bound["Model"], [][]int{{7101}}) {
		t.Errorf("primary Model reads %v, want [[7101]]", primary.bound["Model"])
	}

	r.KeyErr = func(key string) error {
		if key == "lag-helper:model:7105" {
			return errors.New("shard down")
		}
		return nil
	}
	primary.bound = nil
	if _, err := src.GalleryHolds(context.Background(), []int{7105}); fallback.Reason(err) != "gallery-settings-miss" {
		t.Errorf("failed flag read: %v, want gallery-settings-miss", err)
	}
	if len(primary.bound) != 0 {
		t.Errorf("read after a failed flag read: %v", primary.bound)
	}
}

// Write-back needs the primary (the creator's hidden users are a primary read): without one the miss
// falls back with nothing read or written. A stored value Node would reject (`tags` holding a string,
// a held model's level that is a string) fails the lookup (gallery-settings-miss-failed), counted as
// an error, and nothing is written.
func TestGallerySettingsWriteBackGuards(t *testing.T) {
	replica, _ := settingsFixture()
	r := testkit.NewRedis()
	src := &Sources{Packed: &PackedReader{Redis: r}, Replica: replica.db(), Compute: &MissCompute{WriteBack: WriteSet{"gallery-settings": true}}}
	if _, err := src.GalleryHolds(context.Background(), []int{7101}); fallback.Reason(err) != "gallery-settings-miss" {
		t.Errorf("no primary: %v, want gallery-settings-miss", err)
	}
	if len(replica.bound) != 0 || len(r.AllKeys()) != 0 {
		t.Errorf("no primary: read %v, wrote %v", replica.bound, r.AllKeys())
	}

	for name, m := range map[string]settingsModel{
		"tags holding a string": {userID: 1101, settings: `{"tags": ["9001"]}`},
		"a held string level":   {userID: 1101, sfwOnly: true, settings: `{"level": "3"}`},
		"a held fraction":       {userID: 1101, minor: true, settings: `{"level": 1.5}`},
	} {
		bad := &settingsDB{models: map[int]settingsModel{7201: m}, modelOK: true}
		obs := &observed{}
		r := testkit.NewRedis()
		src := &Sources{Packed: &PackedReader{Redis: r}, Replica: bad.db(), Compute: &MissCompute{
			WriteBack: WriteSet{"gallery-settings": true}, Primary: bad.db(), Observe: obs.observe}}
		if _, err := src.GalleryHolds(context.Background(), []int{7201}); fallback.Reason(err) != "gallery-settings-miss-failed" {
			t.Errorf("%s: %v, want gallery-settings-miss-failed", name, err)
		}
		if len(r.AllKeys()) != 0 {
			t.Errorf("%s: wrote %v", name, r.AllKeys())
		}
		if g := obs.get(); !reflect.DeepEqual(g, map[string]int{"gallery-settings/error": 1}) {
			t.Errorf("%s: observed %v", name, g)
		}
	}
}

// Without `gallery-settings` in the write-back set (another cache written back is not it), the miss
// is answered from the hold statement alone and nothing is written: the behaviour before write-back.
func TestGallerySettingsNotWrittenWithoutWriteBack(t *testing.T) {
	rep := &holdReplica{models: map[int]holdModel{7301: {sfwOnly: true}}}
	r := testkit.NewRedis()
	src := &Sources{Packed: &PackedReader{Redis: r}, Replica: rep.db(), Compute: &MissCompute{WriteBack: WriteSet{"tag-ids": true}}}
	got, err := src.GalleryHolds(context.Background(), []int{7301})
	if err != nil || !reflect.DeepEqual(got, map[int]GalleryHold{7301: {Held: true, Level: 3}}) {
		t.Fatalf("holds %v (%v)", got, err)
	}
	if len(r.AllKeys()) != 0 {
		t.Errorf("wrote %v", r.AllKeys())
	}
}
