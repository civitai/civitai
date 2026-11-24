package modelfeed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// The model-assoc golden fixtures (testdata/golden/model-assoc, written by gen-assoc.mjs from the Node
// code path: README.md "model-assoc"). Each is run through ParseAssociated and ServeAssociated over
// fakes holding exactly the fixture's world, with the real hidden-preferences and gate-rule readers
// over in-memory Redis; the answer must equal Node's envelope (shadow.Compare), or the fallback be the
// one named.

const assocGoldenDir = "../../testdata/golden/model-assoc"

// assocGoldenMin is the fixture count: a generator run that wrote fewer fails here.
const assocGoldenMin = 33

type assocFixture struct {
	Name    string `json:"name"`
	Request struct {
		Input  string `json:"input"`
		Viewer *struct {
			ID          int    `json:"id"`
			Username    string `json:"username"`
			IsModerator bool   `json:"isModerator"`
		} `json:"viewer"`
		Cap int `json:"cap"`
	} `json:"request"`
	Config struct {
		CoverageNext bool   `json:"coverageNext"`
		Promotions   string `json:"promotions"`
	} `json:"config"`
	World struct {
		Source *struct {
			Poi    bool `json:"poi"`
			UserID int  `json:"userId"`
		} `json:"source"`
		Associations    [][]*int                         `json:"associations"`
		Promotions      int                              `json:"promotions"`
		Addons          []browsing.Addon                 `json:"addons"`
		Gallery         map[string]*feed.GallerySettings `json:"gallery"`
		PrivacyDefaults map[string]map[string]bool       `json:"privacyDefaults"`
		Memberships     []int                            `json:"memberships"`
		HiddenPrefs     *[]int                           `json:"hiddenPrefs"`
		GateRules       struct {
			Migrated bool     `json:"migrated"`
			Entries  []string `json:"entries"`
		} `json:"gateRules"`
		Users map[string]struct {
			Username *string `json:"username"`
			Image    *string `json:"image"`
		} `json:"users"`
		ModelRows []assocFixtureRow `json:"modelRows"`
		ModelData map[string]struct {
			Hashes   []any            `json:"hashes"`
			TagIDs   []int            `json:"tagIds"`
			Versions []map[string]any `json:"versions"`
		} `json:"modelData"`
		ImageRows [][]any `json:"imageRows"`
	} `json:"world"`
	Binds *struct {
		PageIDs         []int `json:"pageIds"`
		PageLevel       int   `json:"pageLevel"`
		ImageVersionIDs []int `json:"imageVersionIds"`
	} `json:"binds"`
	Expect struct {
		Fallback string          `json:"fallback"`
		Envelope json.RawMessage `json:"envelope"`
	} `json:"expect"`
}

type assocFixtureRow struct {
	ID              int             `json:"id"`
	Name            string          `json:"name"`
	SfwName         *string         `json:"sfwName"`
	CoverImageID    *int            `json:"coverImageId"`
	SfwCoverImageID *int            `json:"sfwCoverImageId"`
	Type            string          `json:"type"`
	Minor           bool            `json:"minor"`
	SfwOnly         bool            `json:"sfwOnly"`
	Poi             bool            `json:"poi"`
	Nsfw            bool            `json:"nsfw"`
	NsfwLevel       int             `json:"nsfwLevel"`
	Status          string          `json:"status"`
	CreatedAt       time.Time       `json:"createdAt"`
	LastVersionAt   time.Time       `json:"lastVersionAt"`
	PublishedAt     time.Time       `json:"publishedAt"`
	Locked          bool            `json:"locked"`
	Meta            json.RawMessage `json:"meta"`
	Mode            *string         `json:"mode"`
	Availability    string          `json:"availability"`
	Rank            json.RawMessage `json:"rank"`
	UserID          int             `json:"userId"`
}

// values is the row in modelColumns order, as the page query answers it.
func (r assocFixtureRow) values() []any {
	var sfwName, cover, sfwCover, mode, meta any
	if r.SfwName != nil {
		sfwName = *r.SfwName
	}
	if r.CoverImageID != nil {
		cover = *r.CoverImageID
	}
	if r.SfwCoverImageID != nil {
		sfwCover = *r.SfwCoverImageID
	}
	if r.Mode != nil {
		mode = *r.Mode
	}
	if len(r.Meta) > 0 && string(r.Meta) != "null" {
		meta = []byte(r.Meta)
	}
	return []any{r.ID, r.Name, sfwName, cover, sfwCover, r.Type, r.Minor, r.SfwOnly, r.Poi, r.Nsfw, r.NsfwLevel, r.Status,
		r.CreatedAt, r.LastVersionAt, r.PublishedAt, r.Locked, meta, mode, r.Availability, []byte(r.Rank), r.UserID, nil}
}

func loadAssocFixture(t *testing.T, path string) *assocFixture {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // G304: a fixture of this module's testdata
	if err != nil {
		t.Fatal(err)
	}
	fx := &assocFixture{}
	if err := json.Unmarshal(b, fx); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return fx
}

func assocFixtureFiles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(assocGoldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < assocGoldenMin {
		t.Fatalf("%d model-assoc fixtures, want at least %d", len(files), assocGoldenMin)
	}
	return files
}

func sameInts(arg any, want []int) bool {
	l, ok := arg.([]int)
	return ok && reflect.DeepEqual(l, want)
}

// assocGoldenDeps builds the fixture's world: the replica (asserting the binds Node recorded), the
// cache readers, the gallery settings, the hidden-preferences hash and the gate-rule store.
func assocGoldenDeps(t *testing.T, fx *assocFixture) *AssocDeps {
	t.Helper()
	w := fx.World
	sources := &fakeSources{
		page: hydrate.ModelPage{
			Basic: map[int]hydrate.BasicUser{}, ProfilePics: map[int]superjson.Object{}, UserCosmetics: map[int][]any{},
			Data: map[int]hydrate.ModelData{}, Frames: map[int]superjson.Object{}, Decorations: map[int]superjson.Object{},
			PrivacyDefaults: map[int]hydrate.PrivacyDefaults{},
		},
		members: map[int]bool{},
	}
	for k, u := range w.Users {
		id, _ := strconv.Atoi(k)
		b := hydrate.BasicUser{ID: id}
		if u.Username != nil {
			b.Username = *u.Username
		}
		if u.Image != nil {
			b.Image = *u.Image
		}
		sources.page.Basic[id] = b
	}
	for k, d := range w.ModelData {
		id, _ := strconv.Atoi(k)
		versions := make([]superjson.Object, len(d.Versions))
		for i, v := range d.Versions {
			versions[i] = sortedRecord(v)
		}
		sources.page.Data[id] = hydrate.ModelData{Hashes: d.Hashes, TagIDs: d.TagIDs, Versions: versions}
	}
	for k, p := range w.PrivacyDefaults {
		id, _ := strconv.Atoi(k)
		sources.page.PrivacyDefaults[id] = hydrate.PrivacyDefaults{Buzz: p["hideModelBuzz"], Downloads: p["hideModelDownloads"], Generations: p["hideModelGenerations"]}
	}
	for _, id := range w.Memberships {
		sources.members[id] = true
	}
	gallery := &fakeGallery{settings: map[int]*feed.GallerySettings{}}
	for k, s := range w.Gallery {
		id, _ := strconv.Atoi(k)
		gallery.settings[id] = s
	}
	db := &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "Model" WHERE "id" = $1`, Rows: func(_ []any) (*testkit.Rows, error) {
			if w.Source == nil {
				return testkit.NewRows([]string{"poi", "userId"}), nil
			}
			return testkit.NewRows([]string{"poi", "userId"}, []any{w.Source.Poi, w.Source.UserID}), nil
		}},
		{Match: `FROM "ModelAssociations"`, Rows: func(_ []any) (*testkit.Rows, error) {
			rows := make([][]any, len(w.Associations))
			for i, a := range w.Associations {
				row := []any{nil, nil}
				for j, p := range a {
					if p != nil {
						row[j] = *p
					}
				}
				rows[i] = row
			}
			return testkit.NewRows([]string{"toModelId", "toArticleId"}, rows...), nil
		}},
		{Match: `FROM "Placement"`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"count"}, []any{w.Promotions}), nil
		}},
		{Match: `"cursorId"`, Rows: func(args []any) (*testkit.Rows, error) {
			if fx.Binds == nil {
				return nil, errors.New("golden: a page query, Node ran none")
			}
			ids, level := false, false
			for _, a := range args {
				ids = ids || sameInts(a, fx.Binds.PageIDs)
				level = level || a == fx.Binds.PageLevel
			}
			if !ids || !level {
				return nil, fmt.Errorf("golden: page query args %v, Node bound ids %v at level %d", args, fx.Binds.PageIDs, fx.Binds.PageLevel)
			}
			rows := make([][]any, len(w.ModelRows))
			for i, r := range w.ModelRows {
				rows[i] = r.values()
			}
			return testkit.NewRows(modelColumns, rows...), nil
		}},
		{Match: `GROUP BY mv."modelId"`, Rows: func(_ []any) (*testkit.Rows, error) {
			return testkit.NewRows([]string{"modelId", "deadline"}), nil
		}},
		{Match: `AS full_mv(id)`, Rows: func(args []any) (*testkit.Rows, error) {
			if fx.Binds == nil || !sameInts(args[0], fx.Binds.ImageVersionIDs) {
				return nil, fmt.Errorf("golden: image query versions %v, Node read %v", args[0], fx.Binds)
			}
			return testkit.NewRows(assocImageColumns, w.ImageRows...), nil
		}},
	}}
	cache := testkit.NewRedis()
	if w.HiddenPrefs != nil {
		packed := func(ids []int) string {
			rows := make([]map[string]any, len(ids))
			for i, id := range ids {
				rows[i] = map[string]any{"id": id, "username": nil}
			}
			b, err := msgpack.Marshal(rows)
			if err != nil {
				t.Fatal(err)
			}
			return string(b)
		}
		key := "packed:user:-1:hidden-prefs"
		if v := fx.Request.Viewer; v != nil {
			key = "packed:user:" + strconv.Itoa(v.ID) + ":hidden-prefs"
		}
		cache.SetHash(key, map[string]string{"hidden-users-5": packed(*w.HiddenPrefs), "blocked-by-users-2": packed(nil), "blocked-users-2": packed(nil)})
	}
	sys := testkit.NewRedis()
	if w.GateRules.Migrated {
		sys.SetString(gateRulesMigratedKey, []byte("1"))
	}
	entries := map[string]string{}
	for i, e := range w.GateRules.Entries {
		entries["r"+strconv.Itoa(i)] = e
	}
	sys.SetHash(gateRulesKey, entries)
	promotions := feed.PromotionsOff
	if fx.Config.Promotions == "unknown" {
		promotions = feed.PromotionsUnknown
	}
	addons := w.Addons
	return &AssocDeps{
		Deps: &Deps{
			DB: db, Sources: sources, Gallery: gallery,
			Addons: func(context.Context) []browsing.Addon { return addons },
			Config: Config{CoverageNext: fx.Config.CoverageNext, LoadingOpenToAll: true, BaseModelMetrics: true, ImagesSlim: true},
			Now:    func() time.Time { return testNow },
		},
		Prefs:      &PackedHiddenPrefs{Redis: cache},
		Gates:      &SysGateRules{Sys: sys},
		Promotions: promotions,
	}
}

// runAssocGolden computes a fixture's request; payload is nil on a fallback or an error.
func runAssocGolden(t *testing.T, fx *assocFixture) ([]byte, error) {
	t.Helper()
	m, err := trpc.DecodeEnvelope([]byte(fx.Request.Input))
	if err != nil {
		t.Fatal(err)
	}
	in, err := ParseAssociated(m)
	if err != nil {
		return nil, err
	}
	req := AssocRequest{Input: in, Cap: fx.Request.Cap}
	if v := fx.Request.Viewer; v != nil {
		req.Viewer = &Viewer{ID: v.ID, Username: v.Username, IsModerator: v.IsModerator}
	}
	ans, err := ServeAssociated(context.Background(), assocGoldenDeps(t, fx), req)
	if err != nil {
		return nil, err
	}
	return superjson.Serialize(ans.Value)
}

func TestAssocGolden(t *testing.T) {
	for _, path := range assocFixtureFiles(t) {
		fx := loadAssocFixture(t, path)
		t.Run(fx.Name, func(t *testing.T) {
			payload, err := runAssocGolden(t, fx)
			if want := fx.Expect.Fallback; want != "" {
				if got := fallback.Reason(err); got != want {
					t.Fatalf("fallback %q (%v), want %q", got, err, want)
				}
				return
			}
			if err != nil {
				t.Fatalf("ServeAssociated: %v (fallback %q)", err, fallback.Reason(err))
			}
			rep, err := shadow.Compare(payload, fx.Expect.Envelope)
			if err != nil {
				t.Fatal(err)
			}
			if !rep.Match {
				t.Fatalf("differs from Node's answer: %+v\n%s", rep.Diffs, payload)
			}
		})
	}
}

// The harness can fail: a fixture whose expected answer is changed in one field no longer matches,
// and one whose recorded binds differ from what feed-go binds is an error.
func TestAssocGoldenHarnessCanFail(t *testing.T) {
	fx := loadAssocFixture(t, filepath.Join(assocGoldenDir, "signed-in-every-level.json"))
	payload, err := runAssocGolden(t, fx)
	if err != nil {
		t.Fatal(err)
	}
	changed := bytes.Replace(fx.Expect.Envelope, []byte(`"canGenerate": false`), []byte(`"canGenerate": true`), 1)
	if bytes.Equal(changed, fx.Expect.Envelope) {
		t.Fatal("the control found no canGenerate:false to change")
	}
	rep, err := shadow.Compare(payload, changed)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Match {
		t.Fatal("a changed expectation still matches: the comparison sees nothing")
	}
	fx.Binds.PageIDs = append([]int{1}, fx.Binds.PageIDs...)
	if _, err := runAssocGolden(t, fx); err == nil || !strings.Contains(err.Error(), "page query args") {
		t.Fatalf("wrong binds: %v, want the page query refused", err)
	}
}
