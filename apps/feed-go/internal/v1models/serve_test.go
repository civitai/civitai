package v1models

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The serve paths' fallbacks and miss paths, over a one-model world built here. (What a served
// answer contains is pinned by the golden fixtures, held to the Node code.)

var testNow = time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

// pack encodes v as msgpackr does for the values used here: an Object as a map in its key order.
func pack(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	var walk func(v any)
	walk = func(v any) {
		var err error
		switch x := v.(type) {
		case superjson.Object:
			err = enc.EncodeMapLen(len(x))
			for _, f := range x {
				if err == nil {
					err = enc.EncodeString(f.Key)
				}
				walk(f.Val)
			}
		case []any:
			err = enc.EncodeArrayLen(len(x))
			for _, e := range x {
				walk(e)
			}
		default:
			err = enc.Encode(x)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	walk(v)
	return buf.Bytes()
}

type testWorld struct {
	cache, sys *testkit.Redis
	entries    map[string]any // packed cache values by key (nil value: absent)
	raw        map[string]string
	modelRow   map[string]any
	dbErr      error
	queries    []string
	privacyDB  bool
	paidDB     bool
	usernames  map[string]int
	tagRows    map[int]string // the replica's Tag rows (tagCache's lookup), by id
	tagLookups int
	// The Training Data listing's rows (by file), its read error, and the candidates each read bound.
	tdRows       []map[string]any
	tdErr        error
	tdCandidates [][]int
}

func newTestWorld() *testWorld {
	cached := superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)}
	ver := meta("id", int64(6001), "index", int64(0), "name", "v1", "earlyAccessTimeFrame", int64(0), "baseModel", "SDXL 1.0",
		"status", "Published", "flags", int64(32), "availability", "Public", "nsfwLevel", int64(1), "description", "d",
		"trainedWords", []any{}, "covered", true, "coveredNext", false)
	return &testWorld{
		entries: map[string]any{
			KeyDataForModel + ":5001":            append(meta("modelId", int64(5001), "hashes", []any{}, "tags", []any{}, "versions", []any{ver}), cached),
			KeyModelTags + ":5001":               append(meta("modelId", int64(5001), "tagIds", []any{int64(11)}), cached),
			KeyBasicTags + ":11":                 append(meta("id", int64(11), "name", "style"), cached),
			hydrate.KeyBasicUsers + ":1001":      append(meta("id", int64(1001), "username", "artist_one", "deletedAt", nil, "image", nil), cached),
			hydrate.KeyProfilePictures + ":1001": meta("notFound", true),
			KeyPaidAccessVersion + ":6001":       append(meta("entityId", int64(6001), "endsAtMs", nil, "timeframeDays", nil), cached),
			KeyImagesForVersion + ":6001": append(meta("modelVersionId", int64(6001), "images", []any{
				meta("id", int64(8001), "url", "u1", "nsfwLevel", int64(1), "type", "image", "poi", false, "minor", false),
			}), cached),
			KeyFilesForVersion + ":6001": append(meta("modelVersionId", int64(6001), "files", []any{
				meta("id", int64(7001), "name", "a.safetensors", "type", "Model", "visibility", "Public", "modelVersionId", int64(6001),
					"hashes", []any{}, "metadata", meta("format", "SafeTensor")),
			}), cached),
			// The default addons exclude tags at every level, so the images' tag ids are read.
			KeyTagIDsForImages + ":8001": append(meta("imageId", int64(8001), "tags", []any{int64(1)}), cached),
			KeyMetricPrivacy + ":1001":   meta("hideModelBuzz", false, "hideModelDownloads", false, "hideModelGenerations", false),
		},
		raw: map[string]string{},
		modelRow: map[string]any{
			"id": int32(5001), "name": "M", "allowCommercialUse": "{Image}", "type": "Checkpoint", "nsfwLevel": int32(1),
			"status": "Published", "availability": "Public", "userId": int32(1001), "cursorId": "1|1|5001",
			"meta": map[string]any{}, "minor": false, "sfwOnly": false,
		},
		usernames: map[string]int{},
	}
}

func (w *testWorld) deps(t *testing.T) *Deps {
	t.Helper()
	w.cache, w.sys = testkit.NewRedis(), testkit.NewRedis()
	for k, v := range w.entries {
		if v != nil {
			w.cache.SetString(k, pack(t, v))
		}
	}
	for k, v := range w.raw {
		w.cache.SetString(k, []byte(v))
	}
	rows := testkit.NewRows
	db := &testkit.DB{Routes: []testkit.Route{
		{Match: `as "cursorId"`, Rows: func([]any) (*testkit.Rows, error) {
			if w.dbErr != nil {
				return nil, w.dbErr
			}
			if w.modelRow == nil {
				return rows([]string{"id"}), nil
			}
			cols := make([]string, 0, len(w.modelRow))
			vals := make([]any, 0, len(w.modelRow))
			for k, v := range w.modelRow {
				cols = append(cols, k)
				vals = append(vals, v)
			}
			return rows(cols, vals), nil
		}},
		{Match: `AS deadline`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"modelId"}, []any{int32(5001)}), nil
		}},
		{Match: `FROM "RecommendedResource"`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"sourceId", "resourceId", "settings"},
				[]any{int32(6001), int32(6999), map[string]any{"componentType": "VAE"}},
				[]any{int32(6001), int32(6998), map[string]any{"componentType": "TextEncoder"}}), nil
		}},
		{Match: `FROM "ModelVersionMetric"`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"modelVersionId", "downloadCount", "thumbsUpCount", "thumbsDownCount"},
				[]any{int32(6001), int32(5), int32(4), int32(3)}, []any{int32(6001), int32(50), int32(40), int32(30)}), nil
		}},
		{Match: `SELECT id, meta FROM "ModelVersion"`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"id", "meta"}, []any{int32(6001), `{"metricVisibility":{"downloads":"show"}}`}), nil
		}},
		{Match: `FROM "ModelMetric" WHERE`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"modelId", "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "tippedAmountCount"},
				[]any{int32(5001), int32(9), int32(8), int32(7), int32(6), int32(5)}), nil
		}},
		{Match: `FROM "ModelFile" WHERE`, Rows: func([]any) (*testkit.Rows, error) {
			return rows(vaeFileColumns, []any{int32(7999), "u", 1.5, "vae.safetensors", nil, "Model", "Public", map[string]any{"format": "SafeTensor"},
				"Success", nil, "Success", nil, testNow, int32(6999)}), nil
		}},
		{Match: `FROM "ModelFileHash"`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"fileId", "type", "hash"}, []any{int32(7999), "SHA256", "H"}), nil
		}},
		{Match: `FROM "PaidAccess"
    WHERE "entityType"`, Rows: func([]any) (*testkit.Rows, error) {
			w.paidDB = true
			return rows([]string{"entityId", "endsAt", "timeframeDays"},
				[]any{int32(6001), testNow.Add(time.Hour), int32(3)}), nil
		}},
		{Match: `SELECT id, settings FROM "User"`, Rows: func([]any) (*testkit.Rows, error) {
			w.privacyDB = true
			return rows([]string{"id", "settings"}, []any{int32(1001), map[string]any{"hideModelDownloads": true}}), nil
		}},
		{Match: `SELECT id, name FROM "Tag" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			w.tagLookups++
			var vals [][]any
			for _, id := range args[0].([]int) {
				if name, ok := w.tagRows[id]; ok {
					vals = append(vals, []any{int64(id), name})
				}
			}
			return rows([]string{"id", "name"}, vals...), nil
		}},
		{Match: `FROM "User" WHERE username`, Rows: func(args []any) (*testkit.Rows, error) {
			if id, ok := w.usernames[args[0].(string)]; ok {
				return rows([]string{"id"}, []any{int64(id)}), nil
			}
			return rows([]string{"id"}), nil
		}},
		{Match: `AS restricted`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			if sql != trainingDataListingSQL {
				return nil, errors.New("not the training data statement")
			}
			ids, _ := args[0].([]int)
			w.tdCandidates = append(w.tdCandidates, ids)
			if w.tdErr != nil {
				return nil, w.tdErr
			}
			cols := []string{"id", "virusScanResult", "nsfwLevel", "fullyRated", "restricted"}
			vals := make([][]any, 0, len(w.tdRows))
			for _, r := range w.tdRows {
				row := make([]any, len(cols))
				for i, c := range cols {
					row[i] = r[c]
				}
				vals = append(vals, row)
			}
			return rows(cols, vals...), nil
		}},
	}}
	packed := &hydrate.PackedReader{Redis: w.cache, Now: func() time.Time { return testNow }}
	return &Deps{
		DB: db, Packed: packed, Sources: &hydrate.Sources{Packed: packed, Cache: w.cache, Replica: db},
		Gallery: &feed.GalleryStore{Cache: w.cache, DB: db},
		Addons:  (&feed.AddonSource{Sys: w.sys}).Addons,
		Config: Config{
			ImageLocation: "https://image.example.test", BaseURL: "https://site.example.test",
			CoverageNext: false, BaseModelFeedMetrics: true, ResponseCacheTTL: 180 * time.Second, Production: true,
		},
		Now: func() time.Time { return testNow },
	}
}

func detailOf(t *testing.T, w *testWorld) (*Answer, error) {
	t.Helper()
	return ServeDetail(context.Background(), w.deps(t), DetailRequest{ID: "5001"})
}

func TestServeDetailBuilds(t *testing.T) {
	w := newTestWorld()
	ans, err := detailOf(t, w)
	if err != nil {
		t.Fatalf("serve: %v (%s)", err, reason(err))
	}
	if ans.Trivial || ans.Cached {
		t.Fatalf("answer flags: %+v", ans)
	}
	body, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"flags":0`, // the partner bit is stripped from the public API
		`"hasActivePaidAccess":true`, `"tags":["style"]`, `"supportsGeneration":true`,
		// The version's own `show` wins over nothing hidden; the first metric row per version counts.
		`"stats":{"downloadCount":5,"thumbsUpCount":4,"thumbsDownCount":3}`,
		`"name":"vae.safetensors"`, `"type":"VAE"`,
		`"downloadUrl":"https://site.example.test/api/download/models/6001?type=VAE&format=SafeTensor"`,
		`"downloadUrl":"https://site.example.test/api/download/models/6001?fileId=7001"`,
		`"url":"https://image.example.test/u1/original=true/8001.jpeg"`,
		`"creator":{"username":"artist_one","image":null}`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("body lacks %s:\n%s", want, body)
		}
	}
}

func TestServeDetailMissPaths(t *testing.T) {
	// The paid-access and metric-privacy caches fall through to the replica, as their lookups do.
	w := newTestWorld()
	w.entries[KeyPaidAccessVersion+":6001"] = nil
	w.entries[KeyMetricPrivacy+":1001"] = nil
	// The replica's settings hide downloads, so the owner's membership is read: a stored false.
	w.entries[KeyMembershipValid+":1001"] = false
	ans, err := detailOf(t, w)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	body, _ := superjson.Plain(ans.Body)
	if !w.paidDB || !w.privacyDB {
		t.Fatalf("miss reads: paid %v privacy %v", w.paidDB, w.privacyDB)
	}
	if !strings.Contains(string(body), `"paidAccess":{"permanent":false,"endsAt":"2026-06-15T13:00:00.000Z"}`) {
		t.Errorf("paid access from the replica:\n%s", body)
	}
}

func TestServeDetailFallbacks(t *testing.T) {
	stale := func(key string) func(w *testWorld) {
		return func(w *testWorld) {
			o := w.entries[key].(superjson.Object)
			w.entries[key] = append(omit(o, "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-48 * time.Hour)})
		}
	}
	for _, c := range []struct {
		name   string
		edit   func(w *testWorld)
		deps   func(d *Deps)
		reason string
	}{
		{"no image location", nil, func(d *Deps) { d.Config.ImageLocation = "" }, "v1-models-unconfigured-urls"},
		{"no base URL", nil, func(d *Deps) { d.Config.BaseURL = "" }, "v1-models-unconfigured-urls"},
		{"model data miss", func(w *testWorld) { w.entries[KeyDataForModel+":5001"] = nil }, nil, "v1-models-data-miss"},
		{"model tags miss", func(w *testWorld) { w.entries[KeyModelTags+":5001"] = nil }, nil, "v1-models-tags-miss"},
		{"tag name miss", func(w *testWorld) { w.entries[KeyBasicTags+":11"] = nil }, nil, "v1-models-tag-name-miss"},
		{"tag name stale", stale(KeyBasicTags + ":11"), nil, "v1-models-tag-name-stale"},
		{"images miss", func(w *testWorld) { w.entries[KeyImagesForVersion+":6001"] = nil }, nil, "v1-models-images-miss"},
		{"images stale", stale(KeyImagesForVersion + ":6001"), nil, "v1-models-images-stale"},
		{"files miss", func(w *testWorld) { w.entries[KeyFilesForVersion+":6001"] = nil }, nil, "v1-models-files-miss"},
		{"files stale", stale(KeyFilesForVersion + ":6001"), nil, "v1-models-files-stale"},
		{"membership miss", func(w *testWorld) {
			w.entries[KeyMetricPrivacy+":1001"] = meta("hideModelBuzz", true)
		}, nil, "v1-models-membership-miss"},
		{"held level unset", func(w *testWorld) {
			w.modelRow["minor"] = true
			w.raw["model:gallery-settings:5001"] = `{"sfwHeld":true}`
		}, nil, "v1-models-held-level-unset"},
		{"gallery settings miss", func(w *testWorld) { w.modelRow["sfwOnly"] = true }, nil, "gallery-settings-miss"},
		{"training data unread", func(w *testWorld) {
			w.entries[KeyFilesForVersion+":6001"] = meta("modelVersionId", int64(6001), "files", []any{
				meta("id", int64(7001), "name", "a.safetensors", "type", "Model", "visibility", "Public", "metadata", meta()),
				meta("id", int64(7002), "name", "d.zip", "type", "Training Data", "visibility", "Public", "metadata", meta()),
			}, "cachedAt", testNow.Add(-time.Minute))
			w.tdErr = errors.New("replica down")
		}, nil, "v1-models-training-data-unread"},
		{"bad id", nil, nil, "v1-models-id"},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := newTestWorld()
			if c.edit != nil {
				c.edit(w)
			}
			d := w.deps(t)
			if c.deps != nil {
				c.deps(d)
			}
			id := "5001"
			if c.name == "bad id" {
				id = "x"
			}
			_, err := ServeDetail(context.Background(), d, DetailRequest{ID: id})
			if reason(err) != c.reason {
				t.Fatalf("reason %q (%v), want %q", reason(err), err, c.reason)
			}
		})
	}
}

// With FEED_GO_COMPUTE_MISSES a tag-name miss is named by tagCache's lookup on the replica (a tag the
// replica lacks is dropped, as `.filter(isDefined)` drops it); off, it falls back (TestServeDetailFallbacks).
func TestServeDetailTagNameMissComputed(t *testing.T) {
	for _, c := range []struct {
		name    string
		rows    map[int]string
		want    string
		lookups int
	}{
		{"named by the replica", map[int]string{11: "style-db"}, `"tags":["style-db"]`, 1},
		{"not on the replica", nil, `"tags":[]`, 1},
	} {
		w := newTestWorld()
		w.entries[KeyBasicTags+":11"] = nil
		w.tagRows = c.rows
		d := w.deps(t)
		d.Config.ComputeMisses = true
		ans, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001"})
		if err != nil {
			t.Fatalf("%s: %v (%s)", c.name, err, reason(err))
		}
		body, _ := superjson.Plain(ans.Body)
		if !strings.Contains(string(body), c.want) || w.tagLookups != c.lookups {
			t.Errorf("%s: lookups %d, body:\n%s", c.name, w.tagLookups, body)
		}
	}
	// A cached name is read from the cache: no lookup.
	w := newTestWorld()
	d := w.deps(t)
	d.Config.ComputeMisses = true
	if _, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001"}); err != nil || w.tagLookups != 0 {
		t.Errorf("hit: lookups %d, %v", w.tagLookups, err)
	}
	// A stale entry still falls back (Node revalidates it), with or without the flag.
	w = newTestWorld()
	o := w.entries[KeyBasicTags+":11"].(superjson.Object)
	w.entries[KeyBasicTags+":11"] = append(omit(o, "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-48 * time.Hour)})
	d = w.deps(t)
	d.Config.ComputeMisses = true
	if _, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001"}); reason(err) != "v1-models-tag-name-stale" {
		t.Errorf("stale: %v", err)
	}
}

func TestServeDetailHeldAndNotFound(t *testing.T) {
	w := newTestWorld()
	w.modelRow["sfwOnly"] = true
	w.raw["model:gallery-settings:5001"] = `{"none":true}`
	ans, err := detailOf(t, w)
	if err != nil {
		t.Fatalf("held with no settings: %v", err)
	}
	if body, _ := superjson.Plain(ans.Body); !strings.Contains(string(body), `"url":"https://image.example.test/u1/`) {
		t.Errorf("a PG image within the SFW limit is kept:\n%s", body)
	}

	w = newTestWorld()
	w.modelRow = nil
	ans, err = detailOf(t, w)
	if err != nil || !ans.Trivial {
		t.Fatalf("not found: %+v %v", ans, err)
	}
	if body, _ := superjson.Plain(ans.Body); string(body) != `{"error":"No model with id 5001"}` {
		t.Errorf("not-found body %s", body)
	}

	w = newTestWorld()
	w.dbErr = errors.New("replica down")
	if _, err := detailOf(t, w); err == nil || reason(err) != "" {
		t.Errorf("a replica error is an error, not a fallback: %v", err)
	}
}

func TestServeDetailOriginCache(t *testing.T) {
	key := KeyPublicModelResponse + ":v2:5001:31"
	entry := func(age time.Duration) superjson.Object {
		return meta("data", meta("id", int64(5001), "name", "cached"), "cachedAt", float64(testNow.Add(-age).UnixMilli()))
	}
	w := newTestWorld()
	w.entries[key] = entry(time.Minute)
	ans, err := detailOf(t, w)
	if err != nil || !ans.Cached {
		t.Fatalf("fresh entry: %+v %v", ans, err)
	}
	// `{ ...body, modelVersions: (body.modelVersions ?? []).map(…) }`: a body without versions
	// gains an empty list at its end.
	if body, _ := superjson.Plain(ans.Body); string(body) != `{"id":5001,"name":"cached","modelVersions":[]}` {
		t.Errorf("cached body %s", body)
	}
	// An entry younger than NodeBuiltWindow is the one Node built for the sampled request: it is
	// built here too (a comparison of the port, not of Node's answer with itself). At the window's
	// edge and past it, the entry is read.
	for _, c := range []struct {
		age    time.Duration
		cached bool
	}{{0, false}, {time.Second, false}, {NodeBuiltWindow - time.Millisecond, false}, {NodeBuiltWindow, true}, {NodeBuiltWindow + 5*time.Second, true}} {
		w = newTestWorld()
		w.entries[key] = entry(c.age)
		ans, err := detailOf(t, w)
		if err != nil || ans.Cached != c.cached {
			t.Fatalf("entry %v old: cached %v, want %v (%v)", c.age, ans != nil && ans.Cached, c.cached, err)
		}
		body, _ := superjson.Plain(ans.Body)
		if built := !strings.Contains(string(body), `"name":"cached"`); built == c.cached {
			t.Errorf("entry %v old: body %s", c.age, body)
		}
	}
	// Past the logical TTL (physically present for 2x), and malformed entries, are built.
	for _, v := range []any{entry(4 * time.Minute), meta("cachedAt", float64(1)), meta("data", meta("id", int64(1))), "x"} {
		w = newTestWorld()
		w.entries[key] = v
		ans, err := detailOf(t, w)
		if err != nil || ans.Cached {
			t.Errorf("entry %v: %+v %v", v, ans, err)
		}
	}
	// A cached body's Training Data files go through the listing like a built body's: the cache keys on
	// neither the host nor a restriction placed since it was written.
	w = newTestWorld()
	w.entries[key] = meta("data", meta("modelVersions", []any{meta("id", int64(6001), "files", []any{
		meta("id", int64(7002), "type", "Training Data"), meta("id", int64(7001), "type", "Model"),
	})}), "cachedAt", float64(testNow.Add(-time.Minute).UnixMilli()))
	w.tdRows = []map[string]any{tdRow(7002, true)}
	ans, err = detailOf(t, w)
	if err != nil || !ans.Cached {
		t.Fatalf("cached training data: %+v %v", ans, err)
	}
	if body, _ := superjson.Plain(ans.Body); string(body) != `{"modelVersions":[{"id":6001,"files":[{"id":7001,"type":"Model"}]}]}` {
		t.Errorf("cached training data: %s", body)
	}
	if len(w.tdCandidates) != 1 || len(w.tdCandidates[0]) != 1 || w.tdCandidates[0][0] != 6001 {
		t.Errorf("candidates %v", w.tdCandidates)
	}
	// Without the mirror (Node off DataPacket) the key is not read.
	w = newTestWorld()
	w.entries[key] = entry(time.Minute)
	d := w.deps(t)
	d.Config.ResponseCacheTTL = 0
	if ans, err := ServeDetail(context.Background(), d, DetailRequest{ID: "5001"}); err != nil || ans.Cached {
		t.Errorf("cache off: %+v %v", ans, err)
	}
}

func TestServeList(t *testing.T) {
	list := func(w *testWorld, q, host string, edit func(*Deps)) (*Answer, error) {
		d := w.deps(t)
		if edit != nil {
			edit(d)
		}
		return ServeList(context.Background(), d, d.Sources, ListRequest{Query: q, Path: "/api/v1/models", Host: host})
	}
	w := newTestWorld()
	w.usernames["artist_one"] = 1001
	ans, err := list(w, "username=Artist%20One&limit=1&page=2", "Site.Example.Test:443", nil)
	if err != nil {
		t.Fatalf("list: %v (%s)", err, reason(err))
	}
	body, _ := superjson.Plain(ans.Body)
	for _, want := range []string{
		`"metadata":{"currentPage":2,"pageSize":1}`,
		`"downloadUrl":"https://site.example.test/api/download/models/6001","primary":true`,
		`"downloadUrl":"https://site.example.test/api/download/models/6001?type=VAE&format=SafeTensor"`,
		`"supportsGeneration":true,"files":[`,
		`"images":[{"id":8001,"url":"https://image.example.test/u1/original=true/8001.jpeg"`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("list body lacks %s:\n%s", want, body)
		}
	}

	for _, c := range []struct {
		name, q, host string
		edit          func(*Deps)
		reason        string
	}{
		{"unknown username", "username=nobody", "site.example.test", nil, "v1-models-username-miss"},
		{"bad host", "", "bad host!", nil, "v1-models-host"},
		{"a text query", "query=x", "site.example.test", nil, "v1-models-query"},
		{"no image location", "", "site.example.test", func(d *Deps) { d.Config.ImageLocation = "" }, "v1-models-unconfigured-urls"},
	} {
		if _, err := list(newTestWorld(), c.q, c.host, c.edit); reason(err) != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, reason(err), err, c.reason)
		}
	}
	if _, err := ServeList(context.Background(), newTestWorld().deps(t), nil, ListRequest{Query: "username=x", Path: "/api/v1/models", Host: "h"}); reason(err) != "v1-models-username-miss" {
		t.Errorf("no resolver: %v", err)
	}
	if _, err := ServeList(context.Background(), newTestWorld().deps(t), nil, ListRequest{Path: "/api/v1/modelsx", Host: "h"}); reason(err) != "v1-models-path" {
		t.Errorf("path: %v", err)
	}
	// Non-production: the localhost origin, and an empty page is trivial.
	w = newTestWorld()
	w.modelRow = nil
	ans, err = list(w, "", "ignored", func(d *Deps) { d.Config.Production = false })
	if err != nil || !ans.Trivial {
		t.Fatalf("empty page: %+v %v", ans, err)
	}
	if body, _ := superjson.Plain(ans.Body); string(body) != `{"items":[],"metadata":{}}` {
		t.Errorf("empty body %s", body)
	}
}

func TestUnpackOrderedThroughDeps(t *testing.T) {
	// GetOrdered: a non-map value and a missing key are misses.
	w := newTestWorld()
	w.entries["k:scalar"] = "x"
	d := w.deps(t)
	if _, ok := d.Packed.GetOrdered(context.Background(), "k:scalar"); ok {
		t.Error("a scalar is not an entry")
	}
	if _, ok := d.Packed.GetOrdered(context.Background(), "k:none"); ok {
		t.Error("a missing key is a miss")
	}
}

func TestServeDetailSendsEmptyImages(t *testing.T) {
	// A version whose images were all left out still sends images: [], never a missing key.
	w := newTestWorld()
	w.entries[KeyImagesForVersion+":6001"] = append(meta("modelVersionId", int64(6001), "images", []any{}),
		superjson.Field{Key: "cachedAt", Val: testNow.Add(-time.Minute)})
	ans, err := detailOf(t, w)
	if err != nil {
		t.Fatalf("serve: %v (%s)", err, reason(err))
	}
	body, _ := superjson.Plain(ans.Body)
	if !strings.Contains(string(body), `"images":[]`) {
		t.Errorf("body lacks \"images\":[]:\n%s", body)
	}
}
