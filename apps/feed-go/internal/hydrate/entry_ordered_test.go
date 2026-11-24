package hydrate

import (
	"bytes"
	"context"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The fixtures below write every object's keys in an order that is neither sorted nor reverse
// sorted, with array-index keys after other keys, so a read that sorts the keys (hydrate.Wire over a
// Go map) or keeps them as written without JS own-key order fails each test.

// packArray writes a msgpack array of pre-encoded elements.
func packArray(t *testing.T, elems ...[]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := msgpack.NewEncoder(&buf).EncodeArrayLen(len(elems)); err != nil {
		t.Fatal(err)
	}
	for _, e := range elems {
		buf.Write(e)
	}
	return buf.Bytes()
}

// orderedEntry decodes b as an ordered cache's entry.
func orderedEntry(t *testing.T, b []byte) Entry {
	t.Helper()
	e, st := decodeBytes(b, 0, time.Now(), true)
	if st != stateEntry {
		t.Fatalf("% x: state %d, want an entry", b, st)
	}
	return e
}

// keysOfObject is o's keys in order; a non-object is reported as nil.
func keysOfObject(v any) []string {
	o, ok := v.(superjson.Object)
	if !ok {
		return nil
	}
	out := make([]string, len(o))
	for i, f := range o {
		out[i] = f.Key
	}
	return out
}

func wantKeys(t *testing.T, what string, v any, want ...string) {
	t.Helper()
	if got := keysOfObject(v); !reflect.DeepEqual(got, want) {
		t.Fatalf("%s keys %q, want %q", what, got, want)
	}
}

// An ordered cache's entry holds the record with its written key order (array-index keys first, as a
// JS engine orders them), nested objects included, `cachedAt` removed; its markers and staleness are
// read as an unordered entry's are. The same bytes read as another cache's entry are sorted.
func TestOrderedCacheEntry(t *testing.T) {
	at := time.Date(2026, 6, 15, 11, 0, 0, 0, time.UTC)
	b := packMap(t,
		"zeta", int64(1),
		"meta", packMap(t, "z", int64(1), "10", "ten", "a", int64(2), "2", "two"),
		"cachedAt", at,
		"alpha", "x",
	)
	e, st := decodeBytes(b, time.Hour, at.Add(2*time.Hour), true)
	if st != stateEntry || !e.Stale || e.NotFound || !e.CachedAt.Equal(at) || e.Value != nil {
		t.Fatalf("entry %+v state %d: want a stale entry stamped %v, Value nil", e, st, at)
	}
	want := superjson.Object{
		{Key: "zeta", Val: int64(1)},
		{Key: "meta", Val: superjson.Object{{Key: "2", Val: "two"}, {Key: "10", Val: "ten"}, {Key: "z", Val: int64(1)}, {Key: "a", Val: int64(2)}}},
		{Key: "alpha", Val: "x"},
	}
	if got := e.Ordered(); !reflect.DeepEqual(got, want) {
		t.Fatalf("ordered:\n got  %#v\n want %#v", got, want)
	}
	if fresh, _ := decodeBytes(b, 3*time.Hour, at.Add(2*time.Hour), true); fresh.Stale {
		t.Fatal("an entry within its ttl is stale")
	}

	// The control: the same bytes as an unordered cache's entry (Value, then Wire) come out sorted.
	u, st := decodeBytes(b, time.Hour, at.Add(2*time.Hour), false)
	if st != stateEntry || !u.Stale || !u.CachedAt.Equal(at) || len(u.Value) != 3 {
		t.Fatalf("unordered entry %+v state %d", u, st)
	}
	wantKeys(t, "unordered", u.Ordered(), "alpha", "meta", "zeta")
	wantKeys(t, "unordered meta", ObjectField(u.Ordered(), "meta"), "10", "2", "a", "z")

	// The marker and failure states match decodeBytes' unordered ones.
	for name, c := range map[string]struct {
		b        []byte
		st       readState
		notFound bool
	}{
		"notFound":    {packMap(t, "userId", int64(1), "notFound", true, "cachedAt", at), stateEntry, true},
		"debounce":    {packMap(t, "debounce", true), stateHeld, false},
		"not a map":   {[]byte{0x01}, stateAbsent, false},
		"undecodable": {[]byte{0xc1}, stateAbsent, false},
		"empty":       {nil, stateAbsent, false},
	} {
		for _, ordered := range []bool{true, false} {
			e, st := decodeBytes(c.b, 0, at, ordered)
			if st != c.st || e.NotFound != c.notFound {
				t.Errorf("%s (ordered %v): state %d notFound %v, want %d %v", name, ordered, st, e.NotFound, c.st, c.notFound)
			}
		}
	}
}

// The ordered caches are exactly the caches whose records an answer carries with their keys: a cache
// added to or dropped from the set fails here until this list says so. A read queued on one of them
// decodes ordered; any other key does not.
func TestOrderedCaches(t *testing.T) {
	want := []string{KeyCosmetics, KeyDataForModel, KeyImageEvents, KeyModelEvents, KeyProfilePictures, KeyUserCosmetics, KeyVersionImages}
	got := make([]string, 0, len(orderedCaches))
	for k, on := range orderedCaches {
		if on {
			got = append(got, k)
		}
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ordered caches %q, want %q", got, want)
	}
	p := &PackedReader{}
	for _, k := range want {
		if !p.Queue(NewBatch(), k, nil, 0).opts.ordered {
			t.Errorf("%s: read unordered", k)
		}
	}
	for _, k := range []string{KeyBasicUsers, KeyImageFrames, KeyModelFrames, KeyTagIDs, KeyModelTags, KeyThumbnails} {
		if p.Queue(NewBatch(), k, nil, 0).opts.ordered {
			t.Errorf("%s: read ordered", k)
		}
	}
}

// Each cached record an answer carries keeps the key order Node wrote it with, through the reader
// that shapes it: a profile picture's `metadata`, a cosmetic's `data`, an event decoration's `data`,
// an equipped cosmetic's `data`, a model's versions (and their nested objects).
func TestOrderedRecordsKeepNodeKeyOrder(t *testing.T) {
	ctx := context.Background()
	s := &Sources{}

	t.Run("profile picture metadata", func(t *testing.T) {
		got := map[int]Entry{1001: orderedEntry(t, packMap(t,
			"id", int64(7001), "url", "pp.jpeg", "name", "pp",
			"metadata", packMap(t, "width", int64(5), "hash", "h", "3", "three")))}
		out, err := s.profilePicturesFrom(ctx, []int{1001}, got)
		if err != nil {
			t.Fatal(err)
		}
		// The members are the lookup's columns, in their order; the json column as written.
		wantKeys(t, "profile picture", out[1001], "id", "name", "url", "metadata")
		wantKeys(t, "metadata", ObjectField(out[1001], "metadata"), "3", "width", "hash")
	})

	t.Run("cosmetic data", func(t *testing.T) {
		got := map[int]Entry{501: orderedEntry(t, packMap(t,
			"id", int64(501), "name", "c", "type", "Badge",
			"data", packMap(t, "url", "b.png", "animated", true, "0", "zero"),
			"source", "Trophy", "flags", int64(0)))}
		out, err := s.cosmeticsFrom(ctx, []int{501}, got)
		if err != nil {
			t.Fatal(err)
		}
		wantKeys(t, "cosmetic", out[501], "id", "name", "type", "data", "source", "flags")
		wantKeys(t, "data", ObjectField(out[501], "data"), "0", "url", "animated")
	})

	t.Run("event decoration data", func(t *testing.T) {
		got := map[int]Entry{11: orderedEntry(t, packMap(t,
			"id", int64(601), "name", "d", "type", "ContentDecoration", "source", "Event",
			"data", packMap(t, "url", "h.png", "event", "ev", "offset", packMap(t, "y", int64(1), "x", int64(2))),
			"equippedToId", int64(11), "equippedToType", "Image", "userId", int64(9)))}
		out, err := VisibleEventDecorations([]int{11}, got, map[string]bool{"ev": true})
		if err != nil {
			t.Fatal(err)
		}
		wantKeys(t, "decoration", out[11], "id", "name", "type", "source", "data", "equippedToId", "equippedToType")
		data := ObjectField(out[11], "data")
		wantKeys(t, "data", data, "url", "event", "offset")
		wantKeys(t, "offset", ObjectField(data.(superjson.Object), "offset"), "y", "x")
		// The event is read from the ordered record: another event is not shown.
		if hidden, _ := VisibleEventDecorations([]int{11}, got, map[string]bool{"other": true}); len(hidden) != 0 {
			t.Fatalf("a decoration of an event not visible: %v", hidden)
		}
	})

	t.Run("equipped cosmetic data", func(t *testing.T) {
		got := map[int]Entry{1001: orderedEntry(t, packMap(t,
			"userId", int64(1001),
			"cosmetics", packArray(t, packMap(t, "cosmeticId", int64(501), "data", packMap(t, "z", int64(1), "a", int64(2), "7", "seven")))))}
		perUser, cids, err := userCosmeticsFrom([]int{1001}, got)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cids, []int{501}) {
			t.Fatalf("cosmetic ids %v, want [501]", cids)
		}
		joined := joinUserCosmetics(perUser, map[int]superjson.Object{501: {{Key: "id", Val: int64(501)}}})
		if len(joined[1001]) != 1 {
			t.Fatalf("joined %v", joined)
		}
		item := joined[1001][0]
		wantKeys(t, "equipped", item, "cosmeticId", "data", "cosmetic")
		wantKeys(t, "equipped data", ObjectField(item.(superjson.Object), "data"), "7", "z", "a")
	})

	t.Run("model versions", func(t *testing.T) {
		data := map[int]Entry{5001: orderedEntry(t, packMap(t,
			"modelId", int64(5001),
			"hashes", packArray(t),
			"tags", packArray(t, packMap(t, "tagId", int64(7), "name", "t")),
			"versions", packArray(t, packMap(t,
				"name", "v", "id", int64(6001), "status", "Published",
				"settings", packMap(t, "strength", int64(1), "1", "one", "clip", int64(2)))),
		))}
		tags := map[int]Entry{5001: {NotFound: true}}
		out, err := s.modelDataFrom(ctx, []int{5001}, data, tags)
		if err != nil {
			t.Fatal(err)
		}
		md := out[5001]
		if len(md.Versions) != 1 || !reflect.DeepEqual(md.TagIDs, []int{7}) || len(md.Hashes) != 0 {
			t.Fatalf("model data %+v", md)
		}
		wantKeys(t, "version", md.Versions[0], "name", "id", "status", "settings")
		wantKeys(t, "settings", ObjectField(md.Versions[0], "settings"), "1", "strength", "clip")
	})
}

// A version's showcase images keep their cached key order, nested `metadata` included; the
// appendFn's `tags` takes the place of a cached `tags` member and goes last on an image without one;
// the cached record itself is not changed.
func TestVersionImagesKeepNodeKeyOrder(t *testing.T) {
	f := newModelFixture()
	f.entries[pageNS+KeyVersionImages+":6001"] = packMap(t,
		"modelVersionId", int64(6001),
		"images", packArray(t,
			packMap(t, "url", "a.jpeg", "id", int64(8001), "nsfwLevel", int64(1), "metadata", packMap(t, "width", int64(5), "hash", "h")),
			packMap(t, "tags", packArray(t), "id", int64(8002), "nsfwLevel", int64(2)),
		))
	f.put(t, KeyTagIDs, 8001, map[string]any{"tags": []any{1}})
	f.put(t, KeyTagIDs, 8002, map[string]any{"tags": []any{2}})
	got, err := f.sources().VersionImages(context.Background(), []int{6001})
	if err != nil {
		t.Fatal(err)
	}
	if len(got[6001]) != 2 {
		t.Fatalf("images %v", got)
	}
	first, second := got[6001][0], got[6001][1]
	wantKeys(t, "first image", first, "url", "id", "nsfwLevel", "metadata", "tags")
	wantKeys(t, "first metadata", ObjectField(first, "metadata"), "width", "hash")
	wantKeys(t, "second image", second, "tags", "id", "nsfwLevel")
	if !reflect.DeepEqual(ObjectField(first, "tags"), []any{int64(1)}) || !reflect.DeepEqual(ObjectField(second, "tags"), []any{int64(2)}) {
		t.Fatalf("tags %v %v, want the image-tag cache's", ObjectField(first, "tags"), ObjectField(second, "tags"))
	}
}

// An entry built in code (no recorded order) reads with its keys sorted, nested objects included, as
// Wire writes a Go map.
func TestEntryOrderedWithoutBytesIsSorted(t *testing.T) {
	e := Entry{Value: map[string]any{"b": int64(1), "a": map[string]any{"y": int64(1), "x": int64(2)}}}
	want := superjson.Object{{Key: "a", Val: superjson.Object{{Key: "x", Val: int64(2)}, {Key: "y", Val: int64(1)}}}, {Key: "b", Val: int64(1)}}
	if got := e.Ordered(); !reflect.DeepEqual(got, want) {
		t.Fatalf("%#v, want %#v", got, want)
	}
}
