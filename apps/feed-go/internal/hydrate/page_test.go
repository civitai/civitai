package hydrate

import (
	"context"
	"errors"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// perLookup is the hydration as it ran before Page: every lookup method on its own goroutine, each
// with its own pipeline (and the two cosmetic joins with one more each). It is the reference Page is
// compared with, and the baseline of BenchmarkHydratePage.
func perLookup(ctx context.Context, s *Sources, req PageRequest) (*Page, error) {
	out := &Page{}
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { out.Basic, err = s.BasicUsers(gctx, req.UserIDs); return })
	g.Go(func() (err error) { out.UserCosmetics, err = s.UserCosmetics(gctx, req.UserIDs); return })
	g.Go(func() (err error) { out.ProfilePics, err = s.ProfilePictures(gctx, req.UserIDs); return })
	g.Go(func() (err error) { out.Frames, err = s.ImageFrames(gctx, req.ImageIDs); return })
	g.Go(func() (err error) { out.Thumbs, err = s.Thumbnails(gctx, req.VideoIDs); return })
	g.Go(func() (err error) { out.Metrics, err = s.ImageMetrics(gctx, req.ImageIDs); return })
	g.Go(func() (err error) { out.TagIDs, err = s.TagIDs(gctx, req.ImageIDs); return })
	g.Go(func() (err error) {
		out.Decorations, err = s.EventDecorations(gctx, req.ImageIDs, req.VisibleEvents)
		return
	})
	g.Go(func() (err error) { out.Reactions, err = s.Reactions(gctx, req.ImageIDs, req.ViewerID); return })
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}

var pageNow = time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

const pageNS = "ns:"

// pageFixture is one page's cache contents: packed values by full key, metric hashes by key.
type pageFixture struct {
	strings map[string][]byte
	hashes  map[string]map[string]string
}

func packValue(tb testing.TB, v map[string]any) []byte {
	tb.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		tb.Fatal(err)
	}
	return b
}

func (f *pageFixture) put(tb testing.TB, key string, id int, v map[string]any) {
	tb.Helper()
	f.strings[pageNS+key+":"+strconv.Itoa(id)] = packValue(tb, v)
}

func (f *pageFixture) del(key string, id int) { delete(f.strings, pageNS+key+":"+strconv.Itoa(id)) }

// basePageFixture is a page of four images (11, 12 by users 1001 and 1002; videos 13 and 14 by
// users 1003 and 1001) whose every lookup has hits, and most have a miss answered by the replica, a
// notFound marker, a debounce marker or a stale entry:
//
//   - basic users: 1001 hit, 1002 debounce (replica), 1003 stale (served)
//   - user cosmetics: 1001 [501, 502], 1002 [503, 509], 1003 notFound
//   - cosmetics: 501 hit, 502 replica, 503 stale (served), 504 hit, 505 replica, 509 nowhere
//   - profile pictures: 1001 hit, 1002 replica, 1003 notFound
//   - frames: 11 -> 504, 12 -> 505 (with lights), 13 and 14 notFound
//   - thumbnails: 13 stale (served), 14 replica
//   - tag ids: 11 and 13 hits, 12 notFound, 14 without tags
//   - event decorations: 11 visible, 12 a hidden event, 13 and 14 notFound
//   - metrics: every image, 12 a notFound hash
func basePageFixture(tb testing.TB) *pageFixture {
	tb.Helper()
	f := &pageFixture{strings: map[string][]byte{}, hashes: map[string]map[string]string{}}
	old := pageNow.Add(-30 * 24 * time.Hour)
	notFound := map[string]any{"notFound": true}
	f.put(tb, KeyBasicUsers, 1001, map[string]any{"id": 1001, "username": "cache-user-1001", "image": "a.jpeg", "deletedAt": nil, "cachedAt": pageNow})
	f.put(tb, KeyBasicUsers, 1002, map[string]any{"debounce": true})
	f.put(tb, KeyBasicUsers, 1003, map[string]any{"id": 1003, "username": "stale-user-1003", "image": nil, "deletedAt": nil, "cachedAt": old})
	f.put(tb, KeyUserCosmetics, 1001, map[string]any{"cosmetics": []any{
		map[string]any{"cosmeticId": 501, "data": map[string]any{"color": "red"}},
		map[string]any{"cosmeticId": 502, "data": nil},
	}})
	f.put(tb, KeyUserCosmetics, 1002, map[string]any{"cosmetics": []any{
		map[string]any{"cosmeticId": 503, "data": nil},
		map[string]any{"cosmeticId": 509, "data": nil},
	}})
	f.put(tb, KeyUserCosmetics, 1003, notFound)
	f.put(tb, KeyCosmetics, 501, map[string]any{"id": 501, "name": "c501", "type": "Badge", "data": map[string]any{"url": "b.png"}, "source": "Trophy", "cachedAt": pageNow})
	f.put(tb, KeyCosmetics, 503, map[string]any{"id": 503, "name": "c503", "type": "NamePlate", "data": map[string]any{}, "source": "Claim", "flags": 3, "cachedAt": old})
	f.put(tb, KeyCosmetics, 504, map[string]any{"id": 504, "name": "c504", "type": "ContentDecoration", "data": map[string]any{"url": "f.png"}, "source": "Purchase"})
	f.put(tb, KeyProfilePictures, 1001, map[string]any{"id": 7001, "name": "pp", "url": "pp.jpeg", "nsfwLevel": 1, "hash": nil, "userId": 1001,
		"ingestion": "Scanned", "type": "image", "width": 10, "height": 11, "metadata": map[string]any{"hash": "h"}, "extra": "dropped"})
	f.put(tb, KeyProfilePictures, 1003, notFound)
	f.put(tb, KeyImageFrames, 11, map[string]any{"cosmeticId": 504, "equippedToId": 11, "userData": nil})
	f.put(tb, KeyImageFrames, 12, map[string]any{"cosmeticId": 505, "equippedToId": 12, "userData": map[string]any{"lights": 3}})
	f.put(tb, KeyImageFrames, 13, notFound)
	f.put(tb, KeyImageFrames, 14, notFound)
	f.put(tb, KeyThumbnails, 13, map[string]any{"url": "t13.jpeg", "nsfwLevel": 2, "width": 320, "height": 180, "cachedAt": old})
	f.put(tb, KeyTagIDs, 11, map[string]any{"tags": []any{1, 2}})
	f.put(tb, KeyTagIDs, 12, notFound)
	f.put(tb, KeyTagIDs, 13, map[string]any{"tags": []any{3}})
	f.put(tb, KeyTagIDs, 14, map[string]any{"other": 1})
	f.put(tb, KeyImageEvents, 11, map[string]any{"id": 601, "name": "deco", "type": "ContentDecoration", "source": "Event",
		"data": map[string]any{"event": "ev", "url": "d.png"}, "equippedToId": 11, "equippedToType": "Image", "userId": 9})
	f.put(tb, KeyImageEvents, 12, map[string]any{"id": 602, "data": map[string]any{"event": "hidden"}})
	f.put(tb, KeyImageEvents, 13, notFound)
	f.put(tb, KeyImageEvents, 14, notFound)
	f.hashes["metrics:Image:11"] = map[string]string{"Like": "3"}
	f.hashes["metrics:Image:12"] = map[string]string{"notFound": "1", "_populatedAt": "1700000000000"}
	f.hashes["metrics:Image:13"] = map[string]string{"Heart": "2"}
	f.hashes["metrics:Image:14"] = map[string]string{"Cry": "1", "_populatedAt": "1700000000000"}
	return f
}

// pageRequest is the request of basePageFixture's page, as feed.Hydrate builds it (a repeated user).
func pageRequest() PageRequest {
	return PageRequest{
		UserIDs: []int{1001, 1002, 1003, 1001}, ImageIDs: []int{11, 12, 13, 14}, VideoIDs: []int{13, 14},
		VisibleEvents: map[string]bool{"ev": true}, ViewerID: 1001,
	}
}

// pageReplica answers the miss queries of basePageFixture's ids, and records each Cosmetic query's ids.
type pageReplica struct {
	*testkit.DB
	mu        sync.Mutex
	cosmetics [][]int
	users     [][]int
}

func newPageReplica() *pageReplica {
	p := &pageReplica{}
	only := func(args []any, rows map[int][]any, cols ...string) *testkit.Rows {
		ids, _ := args[0].([]int)
		out := testkit.NewRows(cols)
		for _, id := range ids {
			if row, ok := rows[id]; ok {
				out.Data = append(out.Data, row)
			}
		}
		return out
	}
	p.DB = &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "ImageReaction"`, Rows: func(args []any) (*testkit.Rows, error) {
			if viewer, _ := args[1].(int); viewer != 1001 {
				return testkit.NewRows([]string{"imageId", "reaction"}), nil
			}
			return only(args, map[int][]any{11: {int64(11), "Like"}, 13: {int64(13), "Cry"}}, "imageId", "reaction"), nil
		}},
		{Match: `FROM "Cosmetic"`, Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			sorted := slices.Clone(ids)
			sort.Ints(sorted)
			p.mu.Lock()
			p.cosmetics = append(p.cosmetics, sorted)
			p.mu.Unlock()
			return only(args, map[int][]any{
				501: {int64(501), "c501-db", "Badge", map[string]any{"url": "b-db.png"}, "Trophy", int64(0)},
				502: {int64(502), "c502", "Badge", map[string]any{"url": "d.png"}, "Purchase", nil},
				505: {int64(505), "c505", "ContentDecoration", map[string]any{"url": "g.png"}, "Purchase", int64(1)},
			}, "id", "name", "type", "data", "source", "flags"), nil
		}},
		{Match: `JOIN "Image" i ON i.id = u."profilePictureId"`, Rows: func(args []any) (*testkit.Rows, error) {
			return only(args, map[int][]any{1002: {int64(7002), "pp-db", "pp-db.jpeg", int64(2), "hh", int64(1002), "Scanned", "image", int64(96), int64(97), map[string]any{"size": float64(1)}}},
				"id", "name", "url", "nsfwLevel", "hash", "userId", "ingestion", "type", "width", "height", "metadata"), nil
		}},
		{Match: `cast(metadata->'thumbnailId' as int)`, Rows: func(args []any) (*testkit.Rows, error) {
			return only(args, map[int][]any{14: {int64(7114), "t14.jpeg", int64(640), int64(360), int64(3), int64(14)}},
				"id", "url", "width", "height", "nsfwLevel", "parentId"), nil
		}},
		{Match: `FROM "User" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			sorted := slices.Clone(ids)
			sort.Ints(sorted)
			p.mu.Lock()
			p.users = append(p.users, sorted)
			p.mu.Unlock()
			return only(args, map[int][]any{
				1001: {int64(1001), "db-user-1001", nil, "db1001.jpeg"},
				1002: {int64(1002), "db-user-1002", nil, "db.jpeg"},
			}, "id", "username", "deletedAt", "image"), nil
		}},
	}}
	return p
}

func (p *pageReplica) cosmeticQueries() [][]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.cosmetics)
}

func (p *pageReplica) userQueries() [][]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.users)
}

// load builds Sources over a fresh copy of f.
func (f *pageFixture) load() (*Sources, *testkit.Redis, *pageReplica) {
	r := testkit.NewRedis()
	for k, v := range f.strings {
		r.SetString(k, v)
	}
	for k, h := range f.hashes {
		r.SetHash(k, h)
	}
	db := newPageReplica()
	s := &Sources{Packed: &PackedReader{Redis: r, Prefix: pageNS, Now: func() time.Time { return pageNow }}, Cache: r, Replica: db}
	return s, r, db
}

func pagePlain(t *testing.T, v any) string {
	t.Helper()
	b, err := superjson.Plain(v)
	if err != nil {
		t.Fatalf("plain %#v: %v", v, err)
	}
	return string(b)
}

func sortedKeys[V any](m map[int]V) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// Page answers exactly what the per-lookup methods answer, in 2 pipelines instead of 10, with one
// Cosmetic replica query for both joins instead of two.
func TestPageMatchesPerLookup(t *testing.T) {
	f := basePageFixture(t)
	ctx := context.Background()

	s, r, db := f.load()
	got, err := s.Page(ctx, pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	pipelines, cosmeticQueries := r.Calls, db.cosmeticQueries()

	s, r, db = f.load()
	want, err := perLookup(ctx, s, pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Page differs from the per-lookup answer:\n got %#v\nwant %#v", got, want)
	}
	if pipelines != 2 || r.Calls != 10 {
		t.Fatalf("pipelines: Page %d, per-lookup %d; want 2 and 10", pipelines, r.Calls)
	}
	if want := [][]int{{502, 505, 509}}; !reflect.DeepEqual(cosmeticQueries, want) {
		t.Fatalf("Page's Cosmetic queries = %v, want %v (one, for both joins' misses)", cosmeticQueries, want)
	}
	if q := db.cosmeticQueries(); len(q) != 2 {
		t.Fatalf("per-lookup Cosmetic queries = %v, want 2", q)
	}

	// Literal values, so the comparison above is not one implementation checked against itself.
	if u := got.Basic[1002]; u.Username != "db-user-1002" || u.Image != "db.jpeg" {
		t.Fatalf("debounced user = %+v, want the replica's row", u)
	}
	if u := got.Basic[1003]; u.Username != "stale-user-1003" {
		t.Fatalf("stale user = %+v, want the stale entry served", u)
	}
	if s, want := pagePlain(t, got.UserCosmetics[1001]), `[{"cosmeticId":501,"data":{"color":"red"},"cosmetic":{"id":501,"name":"c501","type":"Badge","data":{"url":"b.png"},"source":"Trophy"}},`+
		`{"cosmeticId":502,"data":null,"cosmetic":{"id":502,"name":"c502","type":"Badge","data":{"url":"d.png"},"source":"Purchase","flags":null}}]`; s != want {
		t.Fatalf("user 1001 cosmetics:\n got %s\nwant %s", s, want)
	}
	if s, want := pagePlain(t, got.UserCosmetics[1002]), `[{"cosmeticId":503,"data":null,"cosmetic":{"id":503,"name":"c503","type":"NamePlate","data":{},"source":"Claim","flags":3}},{"cosmeticId":509,"data":null}]`; s != want {
		t.Fatalf("user 1002 cosmetics (stale record served, unknown one undefined):\n got %s\nwant %s", s, want)
	}
	if _, ok := got.UserCosmetics[1003]; ok {
		t.Fatal("a notFound user-cosmetics entry has no list")
	}
	if s, want := pagePlain(t, got.Frames[11]), `{"equippedToId":11,"userData":null,"id":504,"data":{"url":"f.png"}}`; s != want {
		t.Fatalf("frame 11:\n got %s\nwant %s", s, want)
	}
	if s, want := pagePlain(t, got.Frames[12]), `{"equippedToId":12,"id":505,"data":{"url":"g.png","lights":3}}`; s != want {
		t.Fatalf("frame 12 (replica cosmetic, lights merged):\n got %s\nwant %s", s, want)
	}
	if keys := sortedKeys(got.Frames); !reflect.DeepEqual(keys, []int{11, 12}) {
		t.Fatalf("frames = %v, want [11 12]", keys)
	}
	if keys := sortedKeys(got.ProfilePics); !reflect.DeepEqual(keys, []int{1001, 1002}) {
		t.Fatalf("profile pictures = %v, want [1001 1002]", keys)
	}
	if got.Thumbs[13].URL != "t13.jpeg" || got.Thumbs[14].URL != "t14.jpeg" || got.Thumbs[14].NsfwLevel != 3 {
		t.Fatalf("thumbnails = %+v, want 13 stale-served and 14 from the replica", got.Thumbs)
	}
	if want := map[int]Metrics{11: {"Like": 3}, 12: {}, 13: {"Heart": 2}, 14: {"Cry": 1}}; !reflect.DeepEqual(got.Metrics, want) {
		t.Fatalf("metrics = %v, want %v", got.Metrics, want)
	}
	if keys := sortedKeys(got.TagIDs); !reflect.DeepEqual(keys, []int{11, 13}) {
		t.Fatalf("tag ids = %v, want [11 13] (a notFound entry and one without tags absent)", keys)
	}
	if s := pagePlain(t, got.TagIDs[11]); s != `[1,2]` {
		t.Fatalf("tag ids of 11 = %s", s)
	}
	if keys := sortedKeys(got.Decorations); !reflect.DeepEqual(keys, []int{11}) {
		t.Fatalf("decorations = %v, want [11]", keys)
	}
	if keys := sortedKeys(got.Reactions); !reflect.DeepEqual(keys, []int{11, 13}) {
		t.Fatalf("reactions = %v, want [11 13]", keys)
	}
}

// Every per-lookup fallback is Page's fallback, with the same reason.
func TestPageFallbackReasonsMatchPerLookup(t *testing.T) {
	cases := []struct {
		name   string
		change func(testing.TB, *pageFixture)
		reason string
	}{
		{"user cosmetics absent", func(_ testing.TB, f *pageFixture) { f.del(KeyUserCosmetics, 1002) }, "user-cosmetics-miss"},
		{"user cosmetics debounced", func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyUserCosmetics, 1001, map[string]any{"debounce": true})
		}, "user-cosmetics-miss"},
		{"frame absent", func(_ testing.TB, f *pageFixture) { f.del(KeyImageFrames, 13) }, "image-frame-miss"},
		{"frame cosmetic gone", func(tb testing.TB, f *pageFixture) {
			f.put(tb, KeyImageFrames, 11, map[string]any{"cosmeticId": 599, "equippedToId": 11, "userData": nil})
		}, "image-frame-cosmetic-missing"},
		{"tag ids absent", func(_ testing.TB, f *pageFixture) { f.del(KeyTagIDs, 14) }, "tag-ids-miss"},
		{"tag ids undecodable", func(_ testing.TB, f *pageFixture) {
			f.strings[pageNS+KeyTagIDs+":11"] = []byte{0xc1}
		}, "tag-ids-miss"},
		{"event decoration absent", func(_ testing.TB, f *pageFixture) { f.del(KeyImageEvents, 12) }, "event-decoration-miss"},
		{"metric hash absent", func(_ testing.TB, f *pageFixture) { delete(f.hashes, "metrics:Image:13") }, "metrics-miss"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := basePageFixture(t)
			c.change(t, f)
			s, r, _ := f.load()
			_, err := s.Page(context.Background(), pageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("Page err = %v (reason %q), want %q", err, got, c.reason)
			}
			if r.Calls > 2 {
				t.Fatalf("Page sent %d pipelines, want at most 2", r.Calls)
			}
			s, _, _ = f.load()
			_, err = perLookup(context.Background(), s, pageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("per-lookup err = %v (reason %q), want %q", err, got, c.reason)
			}
		})
	}
}

// With no visible event the decoration cache is not read, so its misses are no fallback (as
// EventDecorations); and a page whose users and images wear no cosmetic needs no stage 2.
func TestPageNoEventsNoCosmeticsIsOnePipeline(t *testing.T) {
	f := basePageFixture(t)
	f.del(KeyImageEvents, 12)
	for _, uid := range []int{1001, 1002} {
		f.put(t, KeyUserCosmetics, uid, map[string]any{"notFound": true})
	}
	for _, id := range []int{11, 12} {
		f.put(t, KeyImageFrames, id, map[string]any{"notFound": true})
	}
	req := pageRequest()
	req.VisibleEvents = nil
	s, r, db := f.load()
	got, err := s.Page(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if r.Calls != 1 || len(db.cosmeticQueries()) != 0 {
		t.Fatalf("%d pipelines and Cosmetic queries %v; want 1 and none", r.Calls, db.cosmeticQueries())
	}
	if len(got.Decorations) != 0 || len(got.Frames) != 0 || len(got.UserCosmetics) != 0 {
		t.Fatalf("decorations %v, frames %v, user cosmetics %v; want all empty", got.Decorations, got.Frames, got.UserCosmetics)
	}
	s, _, _ = f.load()
	want, err := perLookup(context.Background(), s, req)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Page differs from the per-lookup answer:\n got %#v\nwant %#v", got, want)
	}
}

// Without the 'cosmetics' include (image.getInfinite's `include: []`), neither the user-cosmetics
// nor the frames cache is read, no cosmetic record is (stage 2), no cosmetic lookup runs on the
// replica, both maps are empty, and every other lookup answers as the full page.
func TestPageWithoutCosmetics(t *testing.T) {
	f := basePageFixture(t)
	s, r, db := f.load()
	keys := recordKeys(r)
	req := pageRequest()
	req.NoCosmetics = true
	got, err := s.Page(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.UserCosmetics == nil || len(got.UserCosmetics) != 0 || got.Frames == nil || len(got.Frames) != 0 {
		t.Fatalf("UserCosmetics %#v, Frames %#v; want two empty maps", got.UserCosmetics, got.Frames)
	}
	// Exact key shapes: KeyCosmetics is also a prefix of the event-decoration key
	// (`cosmetics2:event:v2:Image:<id>`), which this page still reads.
	cosmeticRecord := regexp.MustCompile(`^` + regexp.QuoteMeta(pageNS+KeyCosmetics) + `:\d+$`)
	for _, k := range keys() {
		if strings.HasPrefix(k, pageNS+KeyUserCosmetics+":") || strings.HasPrefix(k, pageNS+KeyImageFrames+":") || cosmeticRecord.MatchString(k) {
			t.Errorf("a cosmetic key was read: %s", k)
		}
	}
	// Control: the matcher sees each of the three shapes, and not the decoration key.
	for k, want := range map[string]bool{
		pageNS + KeyUserCosmetics + ":1001": true, pageNS + KeyImageFrames + ":11": true, pageNS + KeyCosmetics + ":501": true,
		pageNS + KeyImageEvents + ":11": false,
	} {
		got := strings.HasPrefix(k, pageNS+KeyUserCosmetics+":") || strings.HasPrefix(k, pageNS+KeyImageFrames+":") || cosmeticRecord.MatchString(k)
		if got != want {
			t.Fatalf("matcher control: %s matched %v, want %v", k, got, want)
		}
	}
	for _, c := range db.Calls {
		if strings.Contains(c, `"UserCosmetic"`) || strings.Contains(c, `FROM "Cosmetic"`) {
			t.Fatalf("a cosmetic replica query ran: %s", c)
		}
	}
	// Positive control: the full page reads both caches and their cosmetic records, and answers some.
	s2, r2, _ := basePageFixture(t).load()
	keys2 := recordKeys(r2)
	full, err := s2.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	fullRead := strings.Join(keys2(), " ")
	for _, k := range []string{pageNS + KeyUserCosmetics + ":1001", pageNS + KeyImageFrames + ":11", pageNS + KeyCosmetics + ":501"} {
		if !strings.Contains(fullRead, k) {
			t.Fatalf("control: the full page never read %s: %s", k, fullRead)
		}
	}
	if len(full.UserCosmetics) == 0 || len(full.Frames) == 0 {
		t.Fatalf("control: the full page answered user cosmetics %v and frames %v", full.UserCosmetics, full.Frames)
	}
	got.UserCosmetics, got.Frames, full.UserCosmetics, full.Frames = nil, nil, nil, nil
	if !reflect.DeepEqual(got, full) {
		t.Fatalf("the rest of the page differs:\n got %#v\nwant %#v", got, full)
	}

	// The probe's seam: Presence reads exactly the keys Page reads for this request, and reports no
	// cosmetic cache (the full fixture misses three cosmetic records, which this page never names).
	s3, r3, _ := basePageFixture(t).load()
	presenceKeys := recordKeys(r3)
	misses, err := s3.Presence(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := presenceKeys(), keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Presence read\n  %v\nPage read\n  %v", got, want)
	}
	if want := map[string]int{CacheBasicUsers: 1, CacheProfilePictures: 1, CacheThumbnails: 1}; !reflect.DeepEqual(misses, want) {
		t.Fatalf("misses %v, want %v", misses, want)
	}
}

// Without the 'profilePictures' include (image.getInfinite), no profile picture is read from the
// replica (nor queued on the cache pipeline), ProfilePics is an empty map, and every other lookup answers as the full page.
func TestPageWithoutProfilePictures(t *testing.T) {
	s, _, db := basePageFixture(t).load()
	req := pageRequest()
	req.NoProfilePictures = true
	got, err := s.Page(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ProfilePics == nil || len(got.ProfilePics) != 0 {
		t.Fatalf("ProfilePics = %#v, want an empty map", got.ProfilePics)
	}
	for _, c := range db.Calls {
		if strings.Contains(c, `u."profilePictureId"`) {
			t.Fatalf("a profile-picture replica query ran: %s", c)
		}
	}
	// Positive control: the same page with the include reads 1002's from the replica.
	s2, _, db2 := basePageFixture(t).load()
	full, err := s2.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if len(full.ProfilePics) != 2 {
		t.Fatalf("full page profile pictures = %v, want 1001 and 1002", sortedKeys(full.ProfilePics))
	}
	ran := false
	for _, c := range db2.Calls {
		ran = ran || strings.Contains(c, `u."profilePictureId"`)
	}
	if !ran {
		t.Fatal("control: the full page never queried the replica for a profile picture")
	}
	got.ProfilePics, full.ProfilePics = nil, nil
	if !reflect.DeepEqual(got, full) {
		t.Fatalf("the rest of the page differs:\n got %#v\nwant %#v", got, full)
	}
}

// An empty page reads nothing at all, and answers the same empty maps as the per-lookup methods.
func TestPageEmptyReadsNothing(t *testing.T) {
	s, r, db := basePageFixture(t).load()
	got, err := s.Page(context.Background(), PageRequest{ViewerID: 1001, VisibleEvents: map[string]bool{"ev": true}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Calls != 0 || len(db.Calls) != 0 {
		t.Fatalf("%d pipelines, queries %v; want none", r.Calls, db.Calls)
	}
	want, err := perLookup(context.Background(), s, PageRequest{ViewerID: 1001, VisibleEvents: map[string]bool{"ev": true}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("empty Page = %#v, want %#v", got, want)
	}
}

// A store failure is a failure, never a silent empty page; ImageMetrics names it.
func TestPageStoreDownFails(t *testing.T) {
	s, r, _ := basePageFixture(t).load()
	r.Err = testkit.ErrDown
	if _, err := s.Page(context.Background(), pageRequest()); err == nil {
		t.Fatal("Page with the cache down returned no error")
	}
	_, err := s.ImageMetrics(context.Background(), []int{11})
	if got := fallback.Reason(err); got != "metrics-read-failed" || !strings.Contains(err.Error(), testkit.ErrDown.Error()) {
		t.Fatalf("ImageMetrics err = %v (reason %q), want metrics-read-failed naming the transport error", err, got)
	}
}

// A replica error in a miss query is the page's error.
func TestPageReplicaErrorIsTheError(t *testing.T) {
	s, _, _ := basePageFixture(t).load()
	boom := errors.New("replica on fire")
	s.Replica = &testkit.DB{Routes: []testkit.Route{{Match: "SELECT", Rows: func([]any) (*testkit.Rows, error) { return nil, boom }}}}
	if _, err := s.Page(context.Background(), pageRequest()); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// A batch sends one pipeline per distinct client, none when nothing is queued.
func TestBatchOnePipelinePerClient(t *testing.T) {
	a, b := testkit.NewRedis(), testkit.NewRedis()
	a.SetString("k:1", packValue(t, map[string]any{"v": "a1"}))
	b.SetString("k:2", packValue(t, map[string]any{"v": "b2"}))
	b.SetHash("metrics:Image:7", map[string]string{"Like": "1"})
	pa, pb := &PackedReader{Redis: a}, &PackedReader{Redis: b}
	s := &Sources{Packed: pb, Cache: b}

	batch := NewBatch()
	ra1 := pa.Queue(batch, "k", []int{1}, 0)
	rb := pb.Queue(batch, "k", []int{2, 3}, 0)
	ra2 := pa.Queue(batch, "k", []int{2}, 0) // a second read of client a, same pipeline
	none := pa.Queue(batch, "k", nil, 0)
	m := s.queueMetrics(batch, []int{7})
	batch.Exec(context.Background())
	if a.Calls != 1 || b.Calls != 1 {
		t.Fatalf("pipelines: a %d, b %d; want 1 each", a.Calls, b.Calls)
	}
	if got := ra1.Entries(); got[1].Value["v"] != "a1" || len(got) != 1 {
		t.Fatalf("a [1] = %#v", got)
	}
	if got := rb.Entries(); got[2].Value["v"] != "b2" || len(got) != 1 {
		t.Fatalf("b [2 3] = %#v, want only 2", got)
	}
	if got := ra2.Entries(); len(got) != 0 {
		t.Fatalf("a [2] = %#v, want a miss (the key is on b)", got)
	}
	if got := none.Entries(); len(got) != 0 {
		t.Fatalf("no ids = %#v", got)
	}
	if got, err := m.result(context.Background(), s); err != nil || !reflect.DeepEqual(got, map[int]Metrics{7: {"Like": 1}}) {
		t.Fatalf("metrics = %v, %v", got, err)
	}

	empty := NewBatch()
	pa.Queue(empty, "k", nil, 0)
	(&PackedReader{}).Queue(empty, "k", []int{1}, 0) // no client: every id a miss, nothing sent
	empty.Exec(context.Background())
	if a.Calls != 1 {
		t.Fatalf("an empty batch sent a pipeline (a.Calls = %d)", a.Calls)
	}
}

// Reads of one client share its group, a different client gets its own.
func TestBatchGroupsByClientIdentity(t *testing.T) {
	r, other := testkit.NewRedis(), testkit.NewRedis()
	batch := NewBatch()
	(&PackedReader{Redis: r}).Queue(batch, "k", []int{1}, 0)
	(&PackedReader{Redis: r}).Queue(batch, "j", []int{1}, 0)
	(&PackedReader{Redis: other}).Queue(batch, "k", []int{1}, 0)
	if len(batch.groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(batch.groups))
	}
	if batch.groups[0].client != r || len(batch.groups[0].queue) != 2 || batch.groups[1].client != other || len(batch.groups[1].queue) != 1 {
		t.Fatalf("groups = [%d reads, %d reads], want r with 2 then other with 1", len(batch.groups[0].queue), len(batch.groups[1].queue))
	}
}

// BenchmarkHydratePage hydrates basePageFixture's page with Page through the in-memory Redis fake and
// reports the pipelines it sends per page (asserted: 2).
func BenchmarkHydratePage(b *testing.B) {
	f := basePageFixture(b)
	b.Run("pipelined", func(b *testing.B) {
		s, r, _ := f.load()
		ctx := context.Background()
		req := pageRequest()
		if _, err := s.Page(ctx, req); err != nil {
			b.Fatal(err)
		}
		if r.Calls != 2 {
			b.Fatalf("Page sent %d pipelines per page, want 2", r.Calls)
		}
		before := r.Calls
		b.ReportAllocs()
		for b.Loop() {
			if _, err := s.Page(ctx, req); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(float64(r.Calls-before)/float64(b.N), "pipelines/op")
	})
}
