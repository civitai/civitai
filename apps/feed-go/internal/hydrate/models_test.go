package hydrate

import (
	"context"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
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
}

func newModelFixture() *modelFixture {
	return &modelFixture{entries: map[string][]byte{}, tags: map[int]bool{}, users: map[int][]any{}}
}

func (f *modelFixture) put(t *testing.T, key string, id int, v any) {
	t.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	f.entries[pageNS+key+":"+strconv.Itoa(id)] = b
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
	}}
	return &Sources{
		Packed:  &PackedReader{Redis: r, Prefix: pageNS, Now: func() time.Time { return pageNow }},
		Cache:   r,
		Replica: db,
	}
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
	if id, _ := Int(md.Versions[1]["id"]); id != 6002 {
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
	if !reflect.DeepEqual(got[6001][0]["tags"], []any{int64(1), int64(2)}) || !reflect.DeepEqual(got[6001][1]["tags"], []any{}) {
		t.Fatalf("tags %v %v", got[6001][0]["tags"], got[6001][1]["tags"])
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
