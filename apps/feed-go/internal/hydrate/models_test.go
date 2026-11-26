package hydrate

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// modelFixture is a cache cluster and a replica for the model feed's readers.
type modelFixture struct {
	entries map[string][]byte
	mu      sync.Mutex
	queries []string
	tags    map[int]bool  // the Tag table's ids
	users   map[int][]any // the privacy-defaults query's rows
	// frames are the model frame lookup's rows by model id: [cosmeticId, equippedToId, userData,
	// createdById]; frameSQL the last frame query's text; failFrames makes that query fail.
	frames     map[int][][]any
	frameSQL   string
	failFrames bool
	// tagRows are the tag-ids lookup's rows by image id: [imageId, source, tagId]; tagRecords the Tag
	// rows it reads: [id, name, type].
	tagRows    map[int][][]any
	tagRecords map[int][]any
	// showcases are the version-images lookup's rows by version id (versionImageColumns order);
	// failShowcases makes that query fail.
	showcases     map[int][][]any
	failShowcases bool
	// events are the model decoration lookup's rows by model id: [cosmeticId, equippedToId, userId];
	// eventSQL the last decoration query's text; failEvents makes that query fail.
	events     map[int][][]any
	eventSQL   string
	failEvents bool
}

func newModelFixture() *modelFixture {
	return &modelFixture{entries: map[string][]byte{}, tags: map[int]bool{}, users: map[int][]any{},
		frames: map[int][][]any{}, tagRows: map[int][][]any{}, tagRecords: map[int][]any{}, showcases: map[int][][]any{},
		events: map[int][][]any{}}
}

func (f *modelFixture) put(t *testing.T, key string, id int, v any) {
	t.Helper()
	f.entries[pageNS+key+":"+strconv.Itoa(id)] = packSorted(t, v)
}

// record notes a replica read (the readers run concurrently).
func (f *modelFixture) record(q string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, q)
}

func (f *modelFixture) del(key string, id int) { delete(f.entries, pageNS+key+":"+strconv.Itoa(id)) }

// sources builds Sources over the fixture's entries as they are now.
func (f *modelFixture) sources() *Sources {
	r := testkit.NewRedis()
	for k, v := range f.entries {
		r.SetString(k, v)
	}
	db := &testkit.DB{Routes: []testkit.Route{
		f.showcaseRoute("showcases"),
		{Match: `SELECT id FROM "Tag" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record("tags")
			out := testkit.NewRows([]string{"id"})
			for _, id := range args[0].([]int) {
				if f.tags[id] {
					out.Data = append(out.Data, []any{int64(id)})
				}
			}
			return out, nil
		}},
		{Match: `settings->'hideModelBuzz'`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record("privacy")
			out := testkit.NewRows([]string{"id", "hideModelBuzz", "hideModelDownloads", "hideModelGenerations"})
			for _, id := range args[0].([]int) {
				if row, ok := f.users[id]; ok {
					out.Data = append(out.Data, row)
				}
			}
			return out, nil
		}},
		{Match: `FROM "User" WHERE id = ANY`, Rows: func(_ []any) (*testkit.Rows, error) {
			f.record("basic")
			return testkit.NewRows([]string{"id", "username", "deletedAt", "image"}), nil
		}},
		{Match: `FROM "Cosmetic"`, Rows: func(_ []any) (*testkit.Rows, error) {
			f.record("cosmetics")
			return testkit.NewRows([]string{"id", "name", "type", "data", "source", "flags"}), nil
		}},
		{Match: `JOIN "Image" i ON i.id = u."profilePictureId"`, Rows: func(_ []any) (*testkit.Rows, error) {
			f.record("pictures")
			return testkit.NewRows(profilePictureColumns), nil
		}},
		{Match: `IS DISTINCT FROM 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			f.record("frames")
			f.mu.Lock()
			f.frameSQL = sql
			f.mu.Unlock()
			if f.failFrames {
				return nil, errMissDB
			}
			out := testkit.NewRows([]string{"cosmeticId", "equippedToId", "userData", "createdById"})
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, f.frames[id]...)
			}
			return out, nil
		}},
		{Match: `jsonb_typeof(c.data->'event') = 'string'`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			f.record("events")
			f.mu.Lock()
			f.eventSQL = sql
			f.mu.Unlock()
			if f.failEvents {
				return nil, errMissDB
			}
			out := testkit.NewRows([]string{"cosmeticId", "equippedToId", "userId"})
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, f.events[id]...)
			}
			return out, nil
		}},
		{Match: `FROM "TagsOnImageDetails"`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record("tagrows")
			out := testkit.NewRows([]string{"imageId", "source", "tagId"})
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, f.tagRows[id]...)
			}
			return out, nil
		}},
		{Match: `FROM "Tag" WHERE id = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record("tagrecords")
			out := testkit.NewRows([]string{"id", "name", "type"})
			for _, id := range args[0].([]int) {
				if row, ok := f.tagRecords[id]; ok {
					out.Data = append(out.Data, row)
				}
			}
			return out, nil
		}},
	}}
	return &Sources{
		Packed:  &PackedReader{Redis: r, Prefix: pageNS, Now: func() time.Time { return pageNow }},
		Cache:   r,
		Replica: db,
	}
}

// showcaseRoute answers the version-images lookup from f.showcases, recording name per query.
func (f *modelFixture) showcaseRoute(name string) testkit.Route {
	return testkit.Route{Match: `AS full_mv(id)`, Rows: func(args []any) (*testkit.Rows, error) {
		f.record(name)
		if f.failShowcases {
			return nil, errMissDB
		}
		out := testkit.NewRows(versionImageColumns)
		for _, id := range args[0].([]int) {
			out.Data = append(out.Data, f.showcases[id]...)
		}
		return out, nil
	}}
}

var notFoundMarker = map[string]any{"notFound": true}

// fullModelFixture is two models (5001 with data, tags and a decoration; 5002 a notFound data entry
// with a frame) by one owner with a cached profile, cosmetics and privacy defaults.
func fullModelFixture(t *testing.T) *modelFixture {
	f := newModelFixture()
	f.put(t, KeyBasicUsers, 1001, map[string]any{"id": 1001, "username": "artist_one", "image": nil, "deletedAt": nil, "cachedAt": pageNow})
	f.put(t, KeyProfilePictures, 1001, notFoundMarker)
	f.put(t, KeyUserCosmetics, 1001, map[string]any{"cosmetics": []any{map[string]any{"cosmeticId": 301, "data": nil}}})
	f.put(t, KeyCosmetics, 301, map[string]any{"id": 301, "name": "Badge", "type": "Badge", "data": map[string]any{"url": "b"}, "source": "Trophy"})
	f.put(t, KeyCosmetics, 302, map[string]any{"id": 302, "name": "Frame", "type": "ContentDecoration", "data": map[string]any{"url": "f"}, "source": "Purchase"})
	f.put(t, KeyMetricPrivacyDefaults, 1001, map[string]any{"hideModelBuzz": true, "hideModelDownloads": false, "hideModelGenerations": false})
	f.put(t, KeyDataForModel, 5001, map[string]any{"modelId": 5001, "hashes": []any{"H1"}, "tags": []any{},
		"versions": []any{map[string]any{"id": 6001, "baseModel": "Pony"}, map[string]any{"id": 6002, "baseModel": "SDXL 1.0"}}})
	f.put(t, KeyDataForModel, 5002, notFoundMarker)
	f.put(t, KeyModelTags, 5001, map[string]any{"modelId": 5001, "tagIds": []any{7, 8, 9}})
	f.put(t, KeyModelTags, 5002, notFoundMarker)
	f.put(t, KeyBasicTags, 7, map[string]any{"id": 7, "name": "seven"})
	f.put(t, KeyBasicTags, 9, notFoundMarker) // 8 is a miss, answered by the replica
	f.tags[8] = true
	f.put(t, KeyModelFrames, 5001, notFoundMarker)
	f.put(t, KeyModelFrames, 5002, map[string]any{"cosmeticId": 302, "equippedToId": 5002, "userData": nil})
	f.put(t, KeyModelEvents, 5001, map[string]any{"id": 401, "name": "Hat", "type": "ContentDecoration", "source": "Claim",
		"data": map[string]any{"event": "ev"}, "equippedToId": 5001, "equippedToType": "Model", "userId": 1001})
	f.put(t, KeyModelEvents, 5002, notFoundMarker)
	return f
}

func modelPageRequest() ModelPageRequest {
	return ModelPageRequest{OwnerIDs: []int{1001, 1001}, ModelIDs: []int{5001, 5002}, VisibleEvents: map[string]bool{"ev": true}}
}

func TestModelPage(t *testing.T) {
	f := fullModelFixture(t)
	p, err := f.sources().ModelPage(context.Background(), modelPageRequest())
	if err != nil {
		t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
	}
	md, ok := p.Data[5001]
	if !ok || len(p.Data) != 1 {
		t.Fatalf("data %v: want 5001 only (5002 is a notFound entry)", p.Data)
	}
	// Tag 9 is a notFound marker in the tag cache, 8 a miss the replica holds: [7, 8] in cache order.
	if !reflect.DeepEqual(md.TagIDs, []int{7, 8}) || !reflect.DeepEqual(md.Hashes, []any{"H1"}) || len(md.Versions) != 2 {
		t.Fatalf("5001: %+v", md)
	}
	if id, _ := Int(ObjectField(md.Versions[1], "id")); id != 6002 {
		t.Fatalf("versions in cache order: %v", md.Versions)
	}
	if p.Basic[1001].Username != "artist_one" {
		t.Fatalf("basic %v", p.Basic)
	}
	if _, ok := p.ProfilePics[1001]; ok {
		t.Fatal("a notFound profile picture is none")
	}
	if !reflect.DeepEqual(p.PrivacyDefaults, map[int]PrivacyDefaults{1001: {Buzz: true}}) {
		t.Fatalf("privacy %v", p.PrivacyDefaults)
	}
	if len(p.UserCosmetics[1001]) != 1 {
		t.Fatalf("user cosmetics %v", p.UserCosmetics)
	}
	frame, ok := p.Frames[5002]
	if !ok || len(p.Frames) != 1 {
		t.Fatalf("frames %v", p.Frames)
	}
	if id, _ := frame.Get("id"); id != int64(302) {
		t.Fatalf("frame %v", frame)
	}
	if _, ok := p.Decorations[5001]; !ok || len(p.Decorations) != 1 {
		t.Fatalf("decorations %v", p.Decorations)
	}
	if !reflect.DeepEqual(f.queries, []string{"tags"}) {
		t.Fatalf("replica reads %v, want only the tag miss", f.queries)
	}
}

// A model-tags entry that is a notFound marker leaves the data entry's own tags.
func TestModelPageTagsNotFoundKeepsTheEntrysTags(t *testing.T) {
	f := fullModelFixture(t)
	f.put(t, KeyModelTags, 5001, notFoundMarker)
	f.put(t, KeyDataForModel, 5001, map[string]any{"modelId": 5001, "hashes": []any{}, "tags": []any{map[string]any{"tagId": 42, "name": "x"}}, "versions": []any{}})
	p, err := f.sources().ModelPage(context.Background(), modelPageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.Data[5001].TagIDs, []int{42}) {
		t.Fatalf("%v", p.Data[5001])
	}
}

func TestModelPageFallbacks(t *testing.T) {
	for _, c := range []struct {
		name   string
		mutate func(*modelFixture)
		reason string
	}{
		{"model data miss", func(f *modelFixture) { f.del(KeyDataForModel, 5001) }, "model-data-miss"},
		{"model tags miss", func(f *modelFixture) { f.del(KeyModelTags, 5001) }, "model-tags-miss"},
		{"frame miss", func(f *modelFixture) { f.del(KeyModelFrames, 5001) }, "model-frame-miss"},
		{"decoration miss", func(f *modelFixture) { f.del(KeyModelEvents, 5002) }, "model-decoration-miss"},
		{"user cosmetics miss", func(f *modelFixture) { f.del(KeyUserCosmetics, 1001) }, "user-cosmetics-miss"},
		{"frame cosmetic gone", func(f *modelFixture) { f.del(KeyCosmetics, 302) }, "model-frame-cosmetic-missing"},
	} {
		f := fullModelFixture(t)
		c.mutate(f)
		_, err := f.sources().ModelPage(context.Background(), modelPageRequest())
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
}

// The tag cache is asked only for the models the data cache answered: 5002's data is a notFound
// entry, so its model-tags key is never needed.
func TestModelPageTagsReadOnlyForFoundModels(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyModelTags, 5002)
	if _, err := f.sources().ModelPage(context.Background(), modelPageRequest()); err != nil {
		t.Fatalf("a notFound model's tags miss: %v", err)
	}
}

// No visible event: the decoration keys are not read at all (a miss there is then no fallback).
func TestModelPageNoEventsReadsNoDecorations(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyModelEvents, 5002)
	req := modelPageRequest()
	req.VisibleEvents = nil
	p, err := f.sources().ModelPage(context.Background(), req)
	if err != nil || len(p.Decorations) != 0 {
		t.Fatalf("%v %v", err, p)
	}
}

// A privacy-defaults miss is the user's settings on the replica: any truthy JSON value hides.
func TestModelPagePrivacyDefaultsMiss(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyMetricPrivacyDefaults, 1001)
	f.users[1001] = []any{int64(1001), "yes", nil, float64(0)}
	req := modelPageRequest()
	req.OwnerIDs = []int{1001, 1002} // 1002 has no row at all: hides nothing
	f.put(t, KeyBasicUsers, 1002, map[string]any{"id": 1002, "username": "b", "cachedAt": pageNow})
	f.put(t, KeyProfilePictures, 1002, notFoundMarker)
	f.put(t, KeyUserCosmetics, 1002, notFoundMarker)
	p, err := f.sources().ModelPage(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]PrivacyDefaults{1001: {Buzz: true}, 1002: {}}
	if !reflect.DeepEqual(p.PrivacyDefaults, want) {
		t.Fatalf("%v, want %v", p.PrivacyDefaults, want)
	}
}

func TestVersionImages(t *testing.T) {
	f := newModelFixture()
	f.put(t, KeyVersionImages, 6001, map[string]any{"modelVersionId": 6001, "images": []any{
		map[string]any{"id": 8001, "nsfwLevel": 1, "tags": []any{99}},
		map[string]any{"id": 8002, "nsfwLevel": 2},
	}})
	f.put(t, KeyVersionImages, 6002, notFoundMarker)
	f.put(t, KeyTagIDs, 8001, map[string]any{"tags": []any{1, 2}})
	f.put(t, KeyTagIDs, 8002, notFoundMarker)
	s := f.sources()
	got, err := s.VersionImages(context.Background(), []int{6001, 6002, 6001})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got[6002]; ok || len(got[6001]) != 2 {
		t.Fatalf("%v", got)
	}
	// The cached `tags` is replaced by the image-tag cache's ids; a notFound entry is [].
	if !reflect.DeepEqual(ObjectField(got[6001][0], "tags"), []any{int64(1), int64(2)}) || !reflect.DeepEqual(ObjectField(got[6001][1], "tags"), []any{}) {
		t.Fatalf("tags %v %v", ObjectField(got[6001][0], "tags"), ObjectField(got[6001][1], "tags"))
	}
	f.del(KeyTagIDs, 8002)
	s = f.sources()
	if _, err := s.VersionImages(context.Background(), []int{6001}); fallback.Reason(err) != "tag-ids-miss" {
		t.Fatalf("image-tag miss: %v", err)
	}
	if _, err := s.VersionImages(context.Background(), []int{6003}); fallback.Reason(err) != "model-images-miss" {
		t.Fatalf("version miss: %v", err)
	}
	if out, err := s.VersionImages(context.Background(), nil); err != nil || len(out) != 0 {
		t.Fatalf("no versions: %v %v", out, err)
	}
	// A version whose images are all gone answers an empty list and reads no tags.
	f.put(t, KeyVersionImages, 6004, map[string]any{"modelVersionId": 6004, "images": []any{}})
	s = f.sources()
	if out, err := s.VersionImages(context.Background(), []int{6004}); err != nil || out[6004] == nil || len(out[6004]) != 0 {
		t.Fatalf("empty version: %v %v", out, err)
	}
}

func TestCreatorMemberships(t *testing.T) {
	f := newModelFixture()
	f.put(t, KeyMembershipValid, 1, true)
	f.put(t, KeyMembershipValid, 2, false)
	s := f.sources()
	got, err := s.CreatorMemberships(context.Background(), []int{1, 2, 1})
	if err != nil || !reflect.DeepEqual(got, map[int]bool{1: true, 2: false}) {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := s.CreatorMemberships(context.Background(), []int{3}); fallback.Reason(err) != "membership-miss" {
		t.Fatalf("miss: %v", err)
	}
	f.put(t, KeyMembershipValid, 4, map[string]any{"x": 1})
	s = f.sources()
	if _, err := s.CreatorMemberships(context.Background(), []int{4}); fallback.Reason(err) != "membership-miss" {
		t.Fatalf("not a boolean: %v", err)
	}
	if out, err := s.CreatorMemberships(context.Background(), nil); err != nil || len(out) != 0 {
		t.Fatalf("none: %v %v", out, err)
	}
	if _, err := (&Sources{Packed: &PackedReader{}}).CreatorMemberships(context.Background(), []int{1}); fallback.Reason(err) != "membership-miss" {
		t.Fatalf("no client: %v", err)
	}
}

// The model page's joined frame is the image frame's shape: JoinFrame over the cosmetics record.
func TestModelPageFrameShape(t *testing.T) {
	f := fullModelFixture(t)
	p, err := f.sources().ModelPage(context.Background(), modelPageRequest())
	if err != nil {
		t.Fatal(err)
	}
	b, err := superjson.Plain(p.Frames[5002])
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"equippedToId":5002,"userData":null,"id":302,"data":{"url":"f"}}` {
		t.Fatalf("%s", b)
	}
}

// msgpackr 1.11.5's bytes (misses_test.go) for the values cosmeticEntityCaches.Model's fetch writes:
const (
	// {cosmeticId:303, equippedToId:5001, userData:JSON.parse('{"lights": 2}'), cachedAt:now}
	wantModelFrame5001 = "de0004aa636f736d657469634964cd012fac6571756970706564546f4964cd1389a87573657244617461de0001a66c696768747302a86361636865644174d6ff6a2fe940"
	// {equippedToId:5002, notFound:true, cachedAt:now}
	wantModelFrame5002Marker = "de0003ac6571756970706564546f4964cd138aa86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

// computedModelSources is f.sources() with a miss computation (write-back on: the frame lookup reads
// Primary, here the same fake).
func computedModelSources(f *modelFixture, c *MissCompute) (*Sources, *testkit.Redis) {
	s := f.sources()
	if c.Now == nil {
		c.Now = func() time.Time { return pageNow }
	}
	if c.WriteBack.Any() && c.Primary == nil {
		c.Primary = s.Replica
	}
	s.Compute = c
	r, _ := s.Cache.(*testkit.Redis)
	return s, r
}

// A model frame miss is the frame lookup over the models (equippedToType 'Model'), joined as a hit
// is (lights merged); a model with no row gets an hour's marker with frame-cache-negative on. Written
// back only with WriteBack.
func TestModelPageComputesFrameMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := fullModelFixture(t)
			f.del(KeyModelFrames, 5001)
			f.del(KeyModelFrames, 5002)
			f.frames[5001] = [][]any{{int64(303), int64(5001), `{"lights": 2}`, nil}}
			f.put(t, KeyCosmetics, 303, map[string]any{"id": 303, "name": "Frame3", "type": "ContentDecoration", "data": map[string]any{"url": "f3"}, "source": "Purchase"})
			obs := &observed{}
			s, r := computedModelSources(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			p, err := s.ModelPage(context.Background(), modelPageRequest())
			if err != nil {
				t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
			}
			b, err := superjson.Plain(p.Frames[5001])
			if err != nil {
				t.Fatal(err)
			}
			if want := `{"equippedToId":5001,"id":303,"data":{"url":"f3","lights":2}}`; string(b) != want {
				t.Fatalf("frame 5001:\n got %s\nwant %s", b, want)
			}
			if _, ok := p.Frames[5002]; ok || len(p.Frames) != 1 {
				t.Fatalf("frames %v, want 5001 only (5002 has no row)", p.Frames)
			}
			if !strings.Contains(f.frameSQL, `uc."equippedToType" = 'Model'::"CosmeticEntity"`) {
				t.Fatalf("the frame lookup is not the Model entity's:\n%s", f.frameSQL)
			}
			if o := obs.get(); o["model-frames/computed"] != 2 {
				t.Fatalf("observed %v, want 2 computed model-frames ids", o)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyModelFrames, 5001), pageNS+missKey(KeyModelFrames, 5002))
				return
			}
			wantPacked(t, r, missKey(KeyModelFrames, 5001), wantModelFrame5001, 24*time.Hour)
			wantPacked(t, r, missKey(KeyModelFrames, 5002), wantModelFrame5002Marker, time.Hour)
		})
	}
}

// frame-cache-negative off: a model frame notFound marker is a miss, looked up, and no marker is
// written; on, it is an answer and nothing is looked up.
func TestModelFrameMarkersFollowFrameNegative(t *testing.T) {
	for _, negative := range []bool{false, true} {
		f := fullModelFixture(t) // 5001's frame is a notFound marker
		f.frames[5001] = [][]any{{int64(302), int64(5001), nil, nil}}
		s, _ := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: negative})
		p, err := s.ModelPage(context.Background(), modelPageRequest())
		if err != nil {
			t.Fatal(err)
		}
		_, has := p.Frames[5001]
		if has == negative {
			t.Errorf("negative %v: frame 5001 shown %v", negative, has)
		}
		frameQueries := 0
		for _, q := range f.queries {
			if q == "frames" {
				frameQueries++
			}
		}
		if want := map[bool]int{false: 1, true: 0}[negative]; frameQueries != want {
			t.Errorf("negative %v: %d frame queries, want %d", negative, frameQueries, want)
		}
	}
}

// A failed model frame lookup is model-frame-miss-failed; without a computation the miss is
// model-frame-miss (TestModelPageFallbacks).
func TestModelFrameLookupFailureFallsBack(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyModelFrames, 5001)
	f.failFrames = true
	obs := &observed{}
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	_, err := s.ModelPage(context.Background(), modelPageRequest())
	if got := fallback.Reason(err); got != "model-frame-miss-failed" {
		t.Fatalf("err %v (%q), want model-frame-miss-failed", err, got)
	}
	if o := obs.get(); o["model-frames/error"] != 1 {
		t.Fatalf("observed %v, want 1 model-frames error", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyModelFrames, 5001))
}

// Under a Go-first probe (WithPresence) a computed miss is recorded, with its one lookup query, and
// answered as no entry: nothing is queried or written, and the page is counted. A miss Go falls back
// on still falls back.
func TestModelPageUnderPresence(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyModelFrames, 5001)
	f.del(KeyModelFrames, 5002)
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
	rec := &PresenceProbe{Now: func() time.Time { return pageNow }}
	p, err := s.ModelPage(WithPresence(context.Background(), rec), modelPageRequest())
	if err != nil {
		t.Fatalf("ModelPage: %v", err)
	}
	if len(p.Frames) != 0 {
		t.Fatalf("frames %v, want none (answered as no entry)", p.Frames)
	}
	for _, q := range f.queries {
		if q == "frames" {
			t.Fatal("the probe looked a frame miss up")
		}
	}
	wantAbsent(t, r, pageNS+missKey(KeyModelFrames, 5001), pageNS+missKey(KeyModelFrames, 5002))
	if got, want := rec.Misses(), map[string]int{MissModelFrames: 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if got, want := rec.DBReads(), map[string]int{MissModelFrames: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
	if first, pages := rec.FirstCheck(); pages != 1 || !first.Equal(pageNow) {
		t.Fatalf("pages %d first %v, want 1 page at %v", pages, first, pageNow)
	}
	// The same page without the computation falls back under the probe as when serving.
	f.del(KeyModelFrames, 5001)
	plain := f.sources()
	if _, err := plain.ModelPage(WithPresence(context.Background(), &PresenceProbe{}), modelPageRequest()); fallback.Reason(err) != "model-frame-miss" {
		t.Fatalf("no computation under the probe: %v, want model-frame-miss", err)
	}
}

// The version images' tag-ids miss is computed as the image feed's (fillTagIDs).
func TestVersionImagesComputesTagIDsMiss(t *testing.T) {
	f := newModelFixture()
	f.put(t, KeyVersionImages, 6001, map[string]any{"modelVersionId": 6001, "images": []any{
		map[string]any{"id": 8001, "nsfwLevel": 1},
		map[string]any{"id": 8002, "nsfwLevel": 2},
	}})
	f.put(t, KeyTagIDs, 8001, map[string]any{"tags": []any{1, 2}})
	f.tagRows[8002] = [][]any{{int64(8002), "User", int64(31)}, {int64(8002), "User", int64(32)}}
	f.tagRecords[31] = []any{int64(31), "thirty-one", "Label"} // 32 is in no table: dropped
	s, _ := computedModelSources(f, &MissCompute{FrameNegative: true})
	got, err := s.VersionImages(context.Background(), []int{6001})
	if err != nil {
		t.Fatalf("VersionImages: %v (%q)", err, fallback.Reason(err))
	}
	if !reflect.DeepEqual(ObjectField(got[6001][1], "tags"), []any{int64(31)}) || !reflect.DeepEqual(ObjectField(got[6001][0], "tags"), []any{int64(1), int64(2)}) {
		t.Fatalf("tags %v %v, want [31] computed and [1 2] cached", ObjectField(got[6001][1], "tags"), ObjectField(got[6001][0], "tags"))
	}
	if !reflect.DeepEqual(f.queries, []string{"tagrows", "tagrecords"}) {
		t.Fatalf("replica reads %v, want the tag rows and the tag records", f.queries)
	}
}

// The model frame query is the image frame query with the Model entity, nothing else changed.
func TestModelFrameSQLIsTheImageOnesForModels(t *testing.T) {
	if got := strings.Replace(sqlModelFrames, `'Model'::"CosmeticEntity"`, `'Image'::"CosmeticEntity"`, 1); got != sqlImageFrames || sqlModelFrames == sqlImageFrames {
		t.Fatalf("sqlModelFrames:\n%s\nis not sqlImageFrames over 'Model':\n%s", sqlModelFrames, sqlImageFrames)
	}
}

// msgpackr 1.11.5's bytes (misses_test.go) for the values imagesForModelVersionsCache's fetch writes,
// each image the lookup's row in its SELECT order (versionImageColumns):
const (
	// {modelVersionId:6001, images:[
	//   {id:8101, userId:1001, name:'a.png', url:'u1', nsfwLevel:1, width:832, height:1216, hash:'H1', type:'image',
	//    metadata:JSON.parse('{"width": 832, "height": 1216}'), minor:false, poi:false, modelVersionId:6001,
	//    availability:'Public', hasMeta:true, hasPositivePrompt:true, onSite:false, remixOfId:null},
	//   {id:8102, userId:1001, name:null, url:'u2', nsfwLevel:4, width:null, height:null, hash:null, type:'video',
	//    metadata:JSON.parse('{"duration": 2.5}'), minor:false, poi:true, modelVersionId:6001,
	//    availability:'Public', hasMeta:false, hasPositivePrompt:false, onSite:true, remixOfId:123}], cachedAt:now}
	wantVersion6001 = "de0003ae6d6f64656c56657273696f6e4964cd1771a6696d6167657392de0012a26964cd1fa5a6757365724964cd03e9a46e616d65a5612e706e67a375726ca27531a96e7366774c6576656c01a57769647468cd0340a6686569676874cd04c0a468617368a24831a474797065a5696d616765a86d65746164617461de0002a57769647468cd0340a6686569676874cd04c0a56d696e6f72c2a3706f69c2ae6d6f64656c56657273696f6e4964cd1771ac617661696c6162696c697479a65075626c6963a76861734d657461c3b1686173506f73697469766550726f6d7074c3a66f6e53697465c2a972656d69784f664964c0de0012a26964cd1fa6a6757365724964cd03e9a46e616d65c0a375726ca27532a96e7366774c6576656c04a57769647468c0a6686569676874c0a468617368c0a474797065a5766964656fa86d65746164617461de0001a86475726174696f6ecb4004000000000000a56d696e6f72c2a3706f69c3ae6d6f64656c56657273696f6e4964cd1771ac617661696c6162696c697479a65075626c6963a76861734d657461c2b1686173506f73697469766550726f6d7074c2a66f6e53697465c3a972656d69784f6649647ba86361636865644174d6ff6a2fe940"
	// {modelVersionId:6002, notFound:true, cachedAt:now}
	wantVersion6002Marker = "de0003ae6d6f64656c56657273696f6e4964cd1772a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {modelVersionId:6003, images:[{id:8301, userId:1002, name:'c.png', url:'u3', nsfwLevel:2, width:512,
	//   height:512, hash:'H3', type:'image', metadata:JSON.parse('{}'), minor:true, poi:false, modelVersionId:6003,
	//   availability:'Private', hasMeta:true, hasPositivePrompt:false, onSite:false, remixOfId:null}], cachedAt:now}
	wantVersion6003 = "de0003ae6d6f64656c56657273696f6e4964cd1773a6696d6167657391de0012a26964cd206da6757365724964cd03eaa46e616d65a5632e706e67a375726ca27533a96e7366774c6576656c02a57769647468cd0200a6686569676874cd0200a468617368a24833a474797065a5696d616765a86d65746164617461de0000a56d696e6f72c3a3706f69c2ae6d6f64656c56657273696f6e4964cd1773ac617661696c6162696c697479a750726976617465a76861734d657461c3b1686173506f73697469766550726f6d7074c2a66f6e53697465c2a972656d69784f664964c0a86361636865644174d6ff6a2fe940"
)

// showcaseFixture: version 6001 has two showcase rows (an image, and a video with no name, size or
// hash, a remix), 6002 none (a marker), 6003 one; each image's tag ids are cached.
func showcaseFixture(t *testing.T) *modelFixture {
	f := newModelFixture()
	f.showcases[6001] = [][]any{
		{int64(8101), int64(1001), "a.png", "u1", int64(1), int64(832), int64(1216), "H1", "image", `{"width": 832, "height": 1216}`,
			false, false, int64(6001), "Public", true, true, false, nil},
		{int64(8102), int64(1001), nil, "u2", int64(4), nil, nil, nil, "video", `{"duration": 2.5}`,
			false, true, int64(6001), "Public", false, false, true, "123"},
	}
	f.showcases[6003] = [][]any{
		{int64(8301), int64(1002), "c.png", "u3", int64(2), int64(512), int64(512), "H3", "image", `{}`,
			true, false, int64(6003), "Private", true, false, false, "null"},
	}
	for _, id := range []int{8101, 8102, 8301} {
		f.put(t, KeyTagIDs, id, map[string]any{"tags": []any{id - 8000}})
	}
	return f
}

// A version-images miss is the showcase lookup's rows grouped by version, in row order, members in
// column order; a version with none gets a minute's marker. Values are a day plus the SWR tail (2 d).
// Written back only with WriteBack, as Node writes it; each image's tags are the image-tag cache's.
func TestVersionImagesComputesMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := showcaseFixture(t)
			obs := &observed{}
			s, r := computedModelSources(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			got, err := s.VersionImages(context.Background(), []int{6001, 6002, 6003})
			if err != nil {
				t.Fatalf("VersionImages: %v (%q)", err, fallback.Reason(err))
			}
			if len(got) != 2 || len(got[6001]) != 2 || len(got[6003]) != 1 {
				t.Fatalf("versions %v, want 6001 (2 images) and 6003 (1)", got)
			}
			id, _ := Int(ObjectField(got[6001][1], "id"))
			if remix, _ := Int(ObjectField(got[6001][1], "remixOfId")); id != 8102 || remix != 123 || ObjectField(got[6001][1], "name") != nil || ObjectField(got[6003][0], "remixOfId") != nil {
				t.Fatalf("6001's second image %v", got[6001][1])
			}
			if fmt.Sprint(ObjectField(got[6001][0], "tags")) != "[101]" || fmt.Sprint(ObjectField(got[6003][0], "tags")) != "[301]" {
				t.Fatalf("tags %v %v, want the image-tag cache's", ObjectField(got[6001][0], "tags"), ObjectField(got[6003][0], "tags"))
			}
			if o := obs.get(); o["version-images/computed"] != 3 {
				t.Fatalf("observed %v, want 3 computed version-images ids", o)
			}
			if !reflect.DeepEqual(f.queries, []string{"showcases"}) {
				t.Fatalf("replica reads %v, want one showcase query", f.queries)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyVersionImages, 6001), pageNS+missKey(KeyVersionImages, 6002), pageNS+missKey(KeyVersionImages, 6003))
				return
			}
			wantPacked(t, r, missKey(KeyVersionImages, 6001), wantVersion6001, 48*time.Hour)
			wantPacked(t, r, missKey(KeyVersionImages, 6002), wantVersion6002Marker, time.Minute)
			wantPacked(t, r, missKey(KeyVersionImages, 6003), wantVersion6003, 48*time.Hour)
		})
	}
}

// With write-back on, a version whose lag flag a recent write set (any non-empty value) sends the
// whole batch to the primary, as getDbWithoutLagBatch does; with none flagged it reads the replica.
// With write-back off the replica answers either way.
func TestVersionImagesLagFlagReadsPrimary(t *testing.T) {
	for _, c := range []struct {
		name      string
		writeBack bool
		flag      *string // the lag flag of 6003 (nil = absent)
		want      string
	}{
		{"flagged", true, ptr("true"), "primary"},
		{"unflagged", true, nil, "showcases"},
		{"empty flag", true, ptr(""), "showcases"},
		{"flagged, write-back off", false, ptr("true"), "showcases"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := showcaseFixture(t)
			s, r := computedModelSources(f, &MissCompute{WriteBack: writeSet(c.writeBack), FrameNegative: true})
			if c.writeBack {
				s.Compute.Primary = &testkit.DB{Routes: []testkit.Route{f.showcaseRoute("primary")}}
			}
			if c.flag != nil {
				r.SetString(pageNS+"lag-helper:modelVersion:6003", []byte(*c.flag))
			}
			if _, err := s.VersionImages(context.Background(), []int{6001, 6003}); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(f.queries, []string{c.want}) {
				t.Fatalf("queries %v, want [%s]", f.queries, c.want)
			}
		})
	}
}

// A stale entry (cachedAt past the day's ttl) is revalidated as the tag ids are: with write-back on
// under the revalidation lock, its value replaced (a plain SET) and the lock released; with the lock
// held elsewhere the stale entry is served and nothing is queried.
func TestVersionImagesStaleRevalidated(t *testing.T) {
	stale := jspack.Pack(jspack.O("modelVersionId", 6003, "images", []any{jspack.O("id", 8399, "nsfwLevel", 1)}, "cachedAt", pageNow.Add(-25*time.Hour)))
	lock := pageNS + "cache-lock:" + pageNS + missKey(KeyVersionImages, 6003)
	t.Run("lock taken", func(t *testing.T) {
		f := showcaseFixture(t)
		f.entries[pageNS+missKey(KeyVersionImages, 6003)] = stale
		s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
		got, err := s.VersionImages(context.Background(), []int{6003})
		if err != nil {
			t.Fatal(err)
		}
		if id, _ := Int(ObjectField(got[6003][0], "id")); id != 8301 {
			t.Fatalf("6003 = %v, want the looked-up 8301", got[6003])
		}
		wantPacked(t, r, missKey(KeyVersionImages, 6003), wantVersion6003, 48*time.Hour)
		if r.Has(lock) {
			t.Fatal("the revalidation lock was left behind")
		}
	})
	t.Run("lock held", func(t *testing.T) {
		f := showcaseFixture(t)
		f.entries[pageNS+missKey(KeyVersionImages, 6003)] = stale
		f.entries[lock] = []byte("1")
		f.put(t, KeyTagIDs, 8399, map[string]any{"tags": []any{}})
		s, _ := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
		got, err := s.VersionImages(context.Background(), []int{6003})
		if err != nil {
			t.Fatal(err)
		}
		if id, _ := Int(ObjectField(got[6003][0], "id")); id != 8399 || len(f.queries) != 0 {
			t.Fatalf("6003 = %v, queries %v: want the stale entry served, nothing queried", got[6003], f.queries)
		}
	})
}

// A failed showcase lookup is model-images-miss-failed, nothing written; without a computation the
// miss is model-images-miss (TestVersionImages).
func TestVersionImagesLookupFailureFallsBack(t *testing.T) {
	f := showcaseFixture(t)
	f.failShowcases = true
	obs := &observed{}
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	_, err := s.VersionImages(context.Background(), []int{6001, 6002})
	if got := fallback.Reason(err); got != "model-images-miss-failed" {
		t.Fatalf("err %v (%q), want model-images-miss-failed", err, got)
	}
	if o := obs.get(); o["version-images/error"] != 2 {
		t.Fatalf("observed %v, want 2 version-images error ids", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyVersionImages, 6001), pageNS+missKey(KeyVersionImages, 6002))
}

// Under a Go-first probe (WithPresence) a showcase miss is recorded with its one query and, unlike
// the other computed misses, looked up (a model without images is dropped, so "no entry" would change
// the page): on the replica even with write-back on and a lag flag set, outside Observe, and nothing
// is written.
func TestVersionImagesUnderPresenceLooksUpOnTheReplica(t *testing.T) {
	f := showcaseFixture(t)
	obs := &observed{}
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	s.Compute.Primary = &testkit.DB{Routes: []testkit.Route{f.showcaseRoute("primary")}}
	r.SetString(pageNS+"lag-helper:modelVersion:6001", []byte("true"))
	rec := &PresenceProbe{Now: func() time.Time { return pageNow }}
	got, err := s.VersionImages(WithPresence(context.Background(), rec), []int{6001, 6002})
	if err != nil {
		t.Fatalf("VersionImages: %v", err)
	}
	if len(got[6001]) != 2 || len(got) != 1 {
		t.Fatalf("versions %v, want 6001's two images", got)
	}
	if !reflect.DeepEqual(f.queries, []string{"showcases"}) {
		t.Fatalf("queries %v, want one replica showcase query", f.queries)
	}
	if got, want := rec.Misses(), map[string]int{MissVersionImages: 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if got, want := rec.DBReads(), map[string]int{MissVersionImages: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
	if o := obs.get(); len(o) != 0 {
		t.Fatalf("observed %v under the probe, want nothing", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyVersionImages, 6001), pageNS+missKey(KeyVersionImages, 6002))
}

// The showcase query's filters, as getImagesForModelVersion builds them with no user, no level and
// no include (the shared cache's call). Pinned clause by clause: the integration test runs it.
func TestVersionImagesSQLClauses(t *testing.T) {
	for _, clause := range []string{
		`(p."userId" = m."userId" OR m."userId" = -1)`,
		`p."publishedAt" IS NOT NULL`,
		`i."tosViolation" = FALSE`,
		`(i."blockedFor" IS NULL)`,
		`i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`,
		`(i."nsfwLevel" & 31) != 0`,
		ImageReviewedSQL("i"),
		`(i."nsfwLevel" & 60) = 0`,
		`OR NOT i."modelRestricted"`,
		`ORDER BY i."postId", i.index, i.id
    LIMIT 20`,
		`ORDER BY i."postId", i."index", i.id`,
	} {
		if !strings.Contains(sqlVersionImages, clause) {
			t.Errorf("the showcase query lacks %q", clause)
		}
	}
	if strings.Contains(sqlVersionImages, `i.meta,`) || strings.Contains(sqlVersionImages, "TagsOnImageDetails") {
		t.Error("the showcase query selects meta or filters tags: the shared cache's call has neither")
	}
}

func ptr(s string) *string { return &s }

// msgpackr 1.11.5's bytes (misses_test.go) for the values eventDecorationEntityCaches.Model's fetch
// writes:
const (
	// {id:401, name:'Hat', type:'ContentDecoration', source:'Claim', data:{event:'ev', url:'h.png'},
	//  equippedToId:5001, equippedToType:'Model', userId:1001, cachedAt:now}
	wantModelEvent5001 = "de0009a26964cd0191a46e616d65a3486174a474797065b1436f6e74656e744465636f726174696f6ea6736f75726365a5436c61696da464617461de0002a56576656e74a26576a375726ca5682e706e67ac6571756970706564546f4964cd1389ae6571756970706564546f54797065a54d6f64656ca6757365724964cd03e9a86361636865644174d6ff6a2fe940"
	// {equippedToId:5002, notFound:true, cachedAt:now}
	wantModelEvent5002Marker = "de0003ac6571756970706564546f4964cd138aa86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

// decorationMissFixture is fullModelFixture with both models' decoration entries gone: 5001 wears
// 401 (a cached event cosmetic), 5002 a row whose cosmetic 402 is found nowhere (skipped: no hat).
func decorationMissFixture(t *testing.T) *modelFixture {
	f := fullModelFixture(t)
	f.del(KeyModelEvents, 5001)
	f.del(KeyModelEvents, 5002)
	f.events[5001] = [][]any{{int64(401), int64(5001), int64(1001)}}
	f.events[5002] = [][]any{{int64(402), int64(5002), int64(1001)}}
	f.entries[pageNS+missKey(KeyCosmetics, 401)] = jspack.Pack(jspack.O("id", 401, "name", "Hat", "type", "ContentDecoration",
		"data", jspack.O("event", "ev", "url", "h.png"), "source", "Claim", "flags", 0, "cachedAt", pageNow))
	return f
}

// A model decoration miss is the event decoration lookup over the models (equippedToType 'Model'),
// built from the cosmetic record as the image one is; a model with no hat gets an hour's marker.
// Written back only with WriteBack, as Node writes it.
func TestModelPageComputesDecorationMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := decorationMissFixture(t)
			obs := &observed{}
			s, r := computedModelSources(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			p, err := s.ModelPage(context.Background(), modelPageRequest())
			if err != nil {
				t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
			}
			b, err := superjson.Plain(p.Decorations[5001])
			if err != nil {
				t.Fatal(err)
			}
			if want := `{"id":401,"name":"Hat","type":"ContentDecoration","source":"Claim","data":{"event":"ev","url":"h.png"},"equippedToId":5001,"equippedToType":"Model"}`; string(b) != want {
				t.Fatalf("decoration 5001:\n got %s\nwant %s", b, want)
			}
			if _, ok := p.Decorations[5002]; ok || len(p.Decorations) != 1 {
				t.Fatalf("decorations %v, want 5001 only (5002's cosmetic is found nowhere)", p.Decorations)
			}
			if !strings.Contains(f.eventSQL, `uc."equippedToType" = 'Model'::"CosmeticEntity"`) {
				t.Fatalf("the decoration lookup is not the Model entity's:\n%s", f.eventSQL)
			}
			if o := obs.get(); o["model-decorations/computed"] != 2 {
				t.Fatalf("observed %v, want 2 computed model-decorations ids", o)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyModelEvents, 5001), pageNS+missKey(KeyModelEvents, 5002))
				return
			}
			wantPacked(t, r, missKey(KeyModelEvents, 5001), wantModelEvent5001, 24*time.Hour)
			wantPacked(t, r, missKey(KeyModelEvents, 5002), wantModelEvent5002Marker, time.Hour)
		})
	}
}

// A failed model decoration lookup is model-decoration-miss-failed, nothing written; without a
// computation the miss is model-decoration-miss (TestModelPageFallbacks).
func TestModelDecorationLookupFailureFallsBack(t *testing.T) {
	f := decorationMissFixture(t)
	f.failEvents = true
	obs := &observed{}
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	_, err := s.ModelPage(context.Background(), modelPageRequest())
	if got := fallback.Reason(err); got != "model-decoration-miss-failed" {
		t.Fatalf("err %v (%q), want model-decoration-miss-failed", err, got)
	}
	if o := obs.get(); o["model-decorations/error"] != 2 {
		t.Fatalf("observed %v, want 2 model-decorations error ids", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyModelEvents, 5001), pageNS+missKey(KeyModelEvents, 5002))
}

// Under a Go-first probe (WithPresence) a decoration miss is recorded, with its one lookup query, and
// answered as no entry: no decoration query, no write.
func TestModelPageDecorationsUnderPresence(t *testing.T) {
	f := decorationMissFixture(t)
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
	rec := &PresenceProbe{Now: func() time.Time { return pageNow }}
	p, err := s.ModelPage(WithPresence(context.Background(), rec), modelPageRequest())
	if err != nil {
		t.Fatalf("ModelPage: %v", err)
	}
	if len(p.Decorations) != 0 {
		t.Fatalf("decorations %v, want none (answered as no entry)", p.Decorations)
	}
	for _, q := range f.queries {
		if q == "events" {
			t.Fatal("the probe looked a decoration miss up")
		}
	}
	wantAbsent(t, r, pageNS+missKey(KeyModelEvents, 5001), pageNS+missKey(KeyModelEvents, 5002))
	if got, want := rec.Misses(), map[string]int{MissModelDecorations: 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if got, want := rec.DBReads(), map[string]int{MissModelDecorations: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
}

// No visible event: the decoration cache is not read, so nothing is computed either.
func TestModelPageNoEventsComputesNoDecorations(t *testing.T) {
	f := decorationMissFixture(t)
	s, _ := computedModelSources(f, &MissCompute{FrameNegative: true})
	req := modelPageRequest()
	req.VisibleEvents = nil
	if _, err := s.ModelPage(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	for _, q := range f.queries {
		if q == "events" {
			t.Fatal("a decoration lookup ran with no visible event")
		}
	}
}

// The model decoration query is the image one with the Model entity, nothing else changed.
func TestModelEventSQLIsTheImageOnesForModels(t *testing.T) {
	if got := strings.Replace(sqlModelEvents, `'Model'::"CosmeticEntity"`, `'Image'::"CosmeticEntity"`, 1); got != sqlImageEvents || sqlModelEvents == sqlImageEvents {
		t.Fatalf("sqlModelEvents:\n%s\nis not sqlImageEvents over 'Model':\n%s", sqlModelEvents, sqlImageEvents)
	}
}
