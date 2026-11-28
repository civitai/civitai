package hydrate

import (
	"context"
	"encoding/hex"
	"errors"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The miss computations (misses.go, metrics.go) over basePageFixture's page. Every expected cache
// write is msgpackr 1.11.5's own bytes for the value Node's fetch writes, from node:
//
//	const { pack } = require('msgpackr'); const now = new Date('2026-06-15T12:00:00.000Z');
//	pack(<value>).toString('hex')
//
// with the value named in each constant's comment.
const (
	// {userId:1002, cosmetics:[{cosmeticId:503, data:JSON.parse('{"b": 1, "a": 2}')}], cachedAt:now}
	wantUC1002 = "de0003a6757365724964cd03eaa9636f736d657469637391de0002aa636f736d657469634964cd01f7a464617461de0002a16201a16102a86361636865644174d6ff6a2fe940"
	// {userId:1003, notFound:true, cachedAt:now}
	wantUC1003Marker = "de0003a6757365724964cd03eba86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {cosmeticId:504, equippedToId:13, userData:JSON.parse('{"lights": 5}'), cachedAt:now}
	wantFrame13 = "de0004aa636f736d657469634964cd01f8ac6571756970706564546f49640da87573657244617461de0001a66c696768747305a86361636865644174d6ff6a2fe940"
	// {id:602, name:'deco2', type:'ContentDecoration', source:'Event', data:{event:'ev', url:'x.png'},
	//  equippedToId:12, equippedToType:'Image', userId:7, cachedAt:now}
	wantEvent12 = "de0009a26964cd025aa46e616d65a56465636f32a474797065b1436f6e74656e744465636f726174696f6ea6736f75726365a54576656e74a464617461de0002a56576656e74a26576a375726ca5782e706e67ac6571756970706564546f49640cae6571756970706564546f54797065a5496d616765a675736572496407a86361636865644174d6ff6a2fe940"
	// {equippedToId:13, notFound:true, cachedAt:now}
	wantEvent13Marker = "de0003ac6571756970706564546f49640da86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {id:603, name:'deco3', type:'ContentDecoration', source:'Event', data:JSON.parse('{"url": "y.png",
	//  "event": "ev"}'), equippedToId:14, equippedToType:'Image', userId:8, cachedAt:now}
	wantEvent14 = "de0009a26964cd025ba46e616d65a56465636f33a474797065b1436f6e74656e744465636f726174696f6ea6736f75726365a54576656e74a464617461de0002a375726ca5792e706e67a56576656e74a26576ac6571756970706564546f49640eae6571756970706564546f54797065a5496d616765a675736572496408a86361636865644174d6ff6a2fe940"
)

// missDB answers the miss lookups' queries (ahead of pageReplica's routes) from literal rows, keyed
// by the id the query filters on; fail makes one route answer an error.
type missDB struct {
	users      map[int][][]any // userId -> [userId, cosmeticId, data]
	frames     map[int][][]any // imageId -> [cosmeticId, equippedToId, userData, createdById]
	events     map[int][][]any // imageId -> [cosmeticId, equippedToId, userId]
	listings   map[int][][]any // cosmeticId -> [cosmeticId, addedById, status, meta, rejectionReason, createdById]
	tombstones map[int][]any   // cosmeticId -> [id, flags]
	records    map[int][]any   // cosmeticId -> [id, name, type, data, source, flags]
	tagRows    map[int][][]any // imageId -> [imageId, source, tagId]
	tags       map[int][]any   // tagId -> [id, name, type]
	fail       string          // a route name below, answered with errMissDB
	// before, when set, runs as a route is queried (before it answers), with the route's name.
	before func(name string)

	mu    sync.Mutex
	asked map[string][][]int
}

var errMissDB = errors.New("replica down")

func (m *missDB) route(name, match string, cols []string, rows func(id int) [][]any) testkit.Route {
	return testkit.Route{Match: match, Rows: func(args []any) (*testkit.Rows, error) {
		ids, _ := args[0].([]int)
		m.mu.Lock()
		if m.asked == nil {
			m.asked = map[string][][]int{}
		}
		m.asked[name] = append(m.asked[name], append([]int(nil), ids...))
		m.mu.Unlock()
		if m.before != nil {
			m.before(name)
		}
		if m.fail == name {
			return nil, errMissDB
		}
		out := testkit.NewRows(cols)
		for _, id := range ids {
			out.Data = append(out.Data, rows(id)...)
		}
		return out, nil
	}}
}

func (m *missDB) queries(name string) [][]int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.asked[name]
}

// load is f.load with m's routes first and a MissCompute.
func (m *missDB) load(f *pageFixture, c *MissCompute) (*Sources, *testkit.Redis) {
	s, r, db := f.load()
	one := func(v map[int][]any) func(int) [][]any {
		return func(id int) [][]any {
			if row, ok := v[id]; ok {
				return [][]any{row}
			}
			return nil
		}
	}
	many := func(v map[int][][]any) func(int) [][]any { return func(id int) [][]any { return v[id] } }
	routes := make([]testkit.Route, 0, 8+len(db.Routes))
	routes = append(routes,
		m.route("users", `FROM "UserCosmetic" WHERE "userId" = ANY`, []string{"userId", "cosmeticId", "data"}, many(m.users)),
		m.route("frames", `IS DISTINCT FROM 'string'`, []string{"cosmeticId", "equippedToId", "userData", "createdById"}, many(m.frames)),
		m.route("events", `jsonb_typeof(c.data->'event') = 'string'`, []string{"cosmeticId", "equippedToId", "userId"}, many(m.events)),
		m.route("listings", `FROM "CosmeticShopItem" si`, []string{"cosmeticId", "addedById", "status", "meta", "rejectionReason", "createdById"}, many(m.listings)),
		m.route("tombstones", `SELECT id, flags FROM "Cosmetic"`, []string{"id", "flags"}, one(m.tombstones)),
		m.route("records", `SELECT id, name, type::text AS type`, []string{"id", "name", "type", "data", "source", "flags"}, one(m.records)),
		m.route("tagrows", `FROM "TagsOnImageDetails" WHERE "imageId" = ANY`, []string{"imageId", "source", "tagId"}, many(m.tagRows)),
		m.route("tags", `FROM "Tag" WHERE id = ANY`, []string{"id", "name", "type"}, one(m.tags)),
	)
	db.Routes = append(routes, db.Routes...)
	if c.Now == nil {
		c.Now = func() time.Time { return pageNow }
	}
	if c.WriteBack.Any() && c.Primary == nil {
		c.Primary = db // the same rows: TestWriteBackReadsPrimary tells the two apart
	}
	s.Compute = c
	return s, r
}

// observed records MissCompute.Observe calls as "cache/result" -> ids.
type observed struct {
	mu sync.Mutex
	n  map[string]int
}

func (o *observed) observe(cache, result string, n int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.n == nil {
		o.n = map[string]int{}
	}
	o.n[cache+"/"+result] += n
}

func (o *observed) get() map[string]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := map[string]int{}
	for k, v := range o.n {
		out[k] = v
	}
	return out
}

func wantPacked(t *testing.T, r *testkit.Redis, key, wantHex string, ttl time.Duration) {
	t.Helper()
	b, ok := r.String(pageNS + key)
	if !ok {
		t.Fatalf("%s not written", key)
	}
	if got := hex.EncodeToString(b); got != wantHex {
		t.Fatalf("%s\n got %s\nwant %s (Node's bytes)", key, got, wantHex)
	}
	if got := r.Expiry(pageNS + key); got != ttl {
		t.Fatalf("%s expiry %v, want %v", key, got, ttl)
	}
}

func wantAbsent(t *testing.T, r *testkit.Redis, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if r.Has(k) {
			t.Fatalf("%s written; want nothing written there", k)
		}
	}
}

func missKey(prefix string, id int) string { return prefix + ":" + strconv.Itoa(id) }

// userCosmeticsMissDB: user 1002 equips 503 (data), 510 (a creator cosmetic whose creator listing is
// not displayable: withheld) and 511 (a creator cosmetic with no listing and the Withheld flag);
// 1003 equips nothing.
func userCosmeticsMissDB() *missDB {
	return &missDB{
		users: map[int][][]any{1002: {
			{int64(1002), int64(503), `{"b": 1, "a": 2}`},
			{int64(1002), int64(510), nil},
			{int64(1002), int64(511), nil},
		}},
		listings: map[int][][]any{
			510: {{int64(510), int64(77), "PendingReview", `{}`, nil, int64(77)}},
		},
		tombstones: map[int][]any{511: {int64(511), int64(4)}},
	}
}

// A user-cosmetics miss is the lookup's answer, withheld and tombstoned creator cosmetics dropped,
// joined as a hit is; written back only with WriteBack, as Node writes it.
func TestPageComputesUserCosmeticsMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := basePageFixture(t)
			f.del(KeyUserCosmetics, 1002)
			f.del(KeyUserCosmetics, 1003)
			m := userCosmeticsMissDB()
			obs := &observed{}
			s, r := m.load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			got, err := s.Page(context.Background(), pageRequest())
			if err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			if s, want := pagePlain(t, got.UserCosmetics[1002]), `[{"cosmeticId":503,"data":{"b":1,"a":2},"cosmetic":{"id":503,"name":"c503","type":"NamePlate","data":{},"source":"Claim","flags":3}}]`; s != want {
				t.Fatalf("user 1002 cosmetics:\n got %s\nwant %s", s, want)
			}
			if _, ok := got.UserCosmetics[1003]; ok {
				t.Fatal("user 1003 wears nothing: no list")
			}
			if q := m.queries("users"); !reflect.DeepEqual(q, [][]int{{1002, 1003}}) {
				t.Fatalf("UserCosmetic queries %v, want one for both misses", q)
			}
			if q := m.queries("listings"); !reflect.DeepEqual(q, [][]int{{503, 510, 511}}) {
				t.Fatalf("listing queries %v, want the equipped ids once", q)
			}
			if q := m.queries("tombstones"); !reflect.DeepEqual(q, [][]int{{503, 511}}) {
				t.Fatalf("tombstone queries %v, want the unlisted ids", q)
			}
			if o := obs.get(); o["user-cosmetics/computed"] != 2 || o["user-cosmetics/error"] != 0 {
				t.Fatalf("observed %v, want 2 computed user-cosmetics ids", o)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyUserCosmetics, 1002), pageNS+missKey(KeyUserCosmetics, 1003))
				return
			}
			wantPacked(t, r, missKey(KeyUserCosmetics, 1002), wantUC1002, 24*time.Hour)
			wantPacked(t, r, missKey(KeyUserCosmetics, 1003), wantUC1003Marker, 24*time.Hour)
		})
	}
}

// A miss Node would not write is computed but not written: a debounce marker (a bust's window) or a
// read that failed; and a key filled since the read is not overwritten (SET NX).
func TestComputedMissWritesOnlyWhereNodeWould(t *testing.T) {
	f := basePageFixture(t)
	f.put(t, KeyUserCosmetics, 1002, map[string]any{"debounce": true})
	f.del(KeyUserCosmetics, 1003)
	m := userCosmeticsMissDB()
	s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
	r.KeyErr = func(k string) error {
		if k == pageNS+missKey(KeyUserCosmetics, 1003) {
			return testkit.ErrDown
		}
		return nil
	}
	got, err := s.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatalf("Page: %v", err)
	}
	if len(got.UserCosmetics[1002]) != 1 {
		t.Fatalf("user 1002 = %v, want the computed list", got.UserCosmetics[1002])
	}
	if b, _ := r.String(pageNS + missKey(KeyUserCosmetics, 1002)); hex.EncodeToString(b) == wantUC1002 {
		t.Fatal("a debounced key was written")
	}
	r.KeyErr = nil
	wantAbsent(t, r, pageNS+missKey(KeyUserCosmetics, 1003))

	// Filled by another writer between the read and the write: SET NX leaves it.
	w := &Sources{Packed: s.Packed}
	r.SetString(pageNS+missKey(KeyUserCosmetics, 1003), []byte("other"))
	w.writePacked(context.Background(), []packedWrite{{key: pageNS + missKey(KeyUserCosmetics, 1003), val: []byte("mine"), ttl: time.Hour}})
	if b, _ := r.String(pageNS + missKey(KeyUserCosmetics, 1003)); string(b) != "other" {
		t.Fatalf("an existing key was overwritten with %q", b)
	}
}

// A failed lookup is the cache's `-failed` fallback, counted as an error.
func TestComputedMissLookupFailureFallsBack(t *testing.T) {
	for _, c := range []struct {
		fail, del, reason, cache string
	}{
		{"users", KeyUserCosmetics, "user-cosmetics-miss-failed", "user-cosmetics"},
		{"listings", KeyUserCosmetics, "user-cosmetics-miss-failed", "user-cosmetics"},
		{"frames", KeyImageFrames, "image-frame-miss-failed", "image-frames"},
		{"events", KeyImageEvents, "event-decoration-miss-failed", "event-decorations"},
		{"tagrows", KeyTagIDs, "tag-ids-miss-failed", "tag-ids"},
	} {
		t.Run(c.fail, func(t *testing.T) {
			f := basePageFixture(t)
			id := map[string]int{KeyUserCosmetics: 1002, KeyImageFrames: 13, KeyImageEvents: 13, KeyTagIDs: 11}[c.del]
			f.del(c.del, id)
			m := userCosmeticsMissDB()
			m.fail = c.fail
			obs := &observed{}
			s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
			_, err := s.Page(context.Background(), pageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("err %v (reason %q), want %q", err, got, c.reason)
			}
			if o := obs.get(); o[c.cache+"/error"] != 1 {
				t.Fatalf("observed %v, want 1 %s error", o, c.cache)
			}
			wantAbsent(t, r, pageNS+missKey(c.del, id))
		})
	}
}

// A frame miss is the lookup's raw row joined as a hit is (lights merged). With frame-cache-negative
// on, a no-row id gets an hour's marker; off, every marker is a miss and no marker is written.
func TestPageComputesFrameMiss(t *testing.T) {
	frames := func() *missDB {
		return &missDB{frames: map[int][][]any{
			13: {{int64(504), int64(13), `{"lights": 5}`, nil}},
			// A creator frame on 14 whose creator listing is not displayable: withheld.
			14: {{int64(520), int64(14), nil, int64(88)}},
		}, listings: map[int][][]any{520: {{int64(520), int64(88), "Rejected", `{}`, "no", int64(88)}}}}
	}
	t.Run("negative-on", func(t *testing.T) {
		f := basePageFixture(t)
		f.del(KeyImageFrames, 13)
		f.del(KeyImageFrames, 14)
		m := frames()
		s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
		got, err := s.Page(context.Background(), pageRequest())
		if err != nil {
			t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
		}
		if s, want := pagePlain(t, got.Frames[13]), `{"equippedToId":13,"id":504,"data":{"url":"f.png","lights":5}}`; s != want {
			t.Fatalf("frame 13:\n got %s\nwant %s", s, want)
		}
		if _, ok := got.Frames[14]; ok {
			t.Fatal("a withheld creator frame is shown")
		}
		if q := m.queries("frames"); !reflect.DeepEqual(q, [][]int{{13, 14}}) {
			t.Fatalf("frame queries %v, want one for the two misses", q)
		}
		if q := m.queries("listings"); !reflect.DeepEqual(q, [][]int{{520}}) {
			t.Fatalf("listing queries %v, want only the creator cosmetic", q)
		}
		wantPacked(t, r, missKey(KeyImageFrames, 13), wantFrame13, 24*time.Hour)
		b, _ := r.String(pageNS + missKey(KeyImageFrames, 14))
		v, _ := jspack.Decode(b)
		marker, _ := v.(jspack.Obj)
		id, _ := marker.Get("equippedToId")
		nf, _ := marker.Get("notFound")
		at, _ := marker.Get("cachedAt")
		if ts, ok := at.(time.Time); len(marker) != 3 || id != 14.0 || nf != true || !ok || !ts.Equal(pageNow) {
			t.Fatalf("frame 14 = %#v, want the notFound marker {equippedToId, notFound, cachedAt}", v)
		}
		if got := r.Expiry(pageNS + missKey(KeyImageFrames, 14)); got != time.Hour {
			t.Fatalf("frame 14 marker expiry %v, want 1h (notFoundTtl)", got)
		}
	})
	t.Run("negative-off", func(t *testing.T) {
		f := basePageFixture(t) // 13 and 14 hold notFound markers
		m := frames()
		s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: false})
		before13, _ := r.String(pageNS + missKey(KeyImageFrames, 13))
		got, err := s.Page(context.Background(), pageRequest())
		if err != nil {
			t.Fatalf("Page: %v", err)
		}
		if _, ok := got.Frames[13]; !ok {
			t.Fatal("frame 13's marker was not looked up (frame-cache-negative off)")
		}
		if q := m.queries("frames"); !reflect.DeepEqual(q, [][]int{{13, 14}}) {
			t.Fatalf("frame queries %v, want the two markers", q)
		}
		if after, _ := r.String(pageNS + missKey(KeyImageFrames, 13)); string(after) != string(before13) {
			t.Fatal("a key holding a marker was rewritten")
		}
	})
}

// eventsMissDB: image 12 wears 602 (cached cosmetic), 14 wears 603 (a cosmetic the cache does not
// hold: read from the replica); 13 wears nothing.
func eventsMissDB() *missDB {
	return &missDB{
		events: map[int][][]any{
			12: {{int64(602), int64(12), int64(7)}},
			14: {{int64(603), int64(14), int64(8)}},
		},
		records: map[int][]any{603: {int64(603), "deco3", "ContentDecoration", `{"url": "y.png", "event": "ev"}`, "Event", int64(0)}},
	}
}

func TestPageComputesEventDecorationMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := basePageFixture(t)
			for _, id := range []int{12, 13, 14} {
				f.del(KeyImageEvents, id)
			}
			f.strings[pageNS+missKey(KeyCosmetics, 602)] = jspack.Pack(jspack.O("id", 602, "name", "deco2", "type", "ContentDecoration",
				"data", jspack.O("event", "ev", "url", "x.png"), "source", "Event", "flags", 0, "cachedAt", pageNow))
			m := eventsMissDB()
			obs := &observed{}
			s, r := m.load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			got, err := s.Page(context.Background(), pageRequest())
			if err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			if s, want := pagePlain(t, got.Decorations[12]), `{"id":602,"name":"deco2","type":"ContentDecoration","source":"Event","data":{"event":"ev","url":"x.png"},"equippedToId":12,"equippedToType":"Image"}`; s != want {
				t.Fatalf("decoration 12:\n got %s\nwant %s", s, want)
			}
			if s, want := pagePlain(t, got.Decorations[14]), `{"id":603,"name":"deco3","type":"ContentDecoration","source":"Event","data":{"url":"y.png","event":"ev"},"equippedToId":14,"equippedToType":"Image"}`; s != want {
				t.Fatalf("decoration 14 (replica cosmetic):\n got %s\nwant %s", s, want)
			}
			if keys := sortedKeys(got.Decorations); !reflect.DeepEqual(keys, []int{11, 12, 14}) {
				t.Fatalf("decorations %v, want [11 12 14]", keys)
			}
			if q := m.queries("records"); !reflect.DeepEqual(q, [][]int{{603}}) {
				t.Fatalf("cosmetic record queries %v, want only the uncached 603", q)
			}
			if o := obs.get(); o["event-decorations/computed"] != 3 {
				t.Fatalf("observed %v, want 3 computed event-decoration ids", o)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyImageEvents, 12), pageNS+missKey(KeyImageEvents, 13), pageNS+missKey(KeyImageEvents, 14))
				return
			}
			wantPacked(t, r, missKey(KeyImageEvents, 12), wantEvent12, 24*time.Hour)
			wantPacked(t, r, missKey(KeyImageEvents, 13), wantEvent13Marker, time.Hour)
			wantPacked(t, r, missKey(KeyImageEvents, 14), wantEvent14, 24*time.Hour)
		})
	}
}

// The batched Page and the per-lookup reference compute the same misses.
func TestPageComputedMissesMatchPerLookup(t *testing.T) {
	build := func() (*Sources, *testkit.Redis) {
		f := basePageFixture(t)
		f.del(KeyUserCosmetics, 1002)
		f.del(KeyImageFrames, 13)
		for _, id := range []int{12, 13, 14} {
			f.del(KeyImageEvents, id)
		}
		f.strings[pageNS+missKey(KeyCosmetics, 602)] = jspack.Pack(jspack.O("id", 602, "name", "deco2", "type", "ContentDecoration",
			"data", jspack.O("event", "ev", "url", "x.png"), "source", "Event", "cachedAt", pageNow))
		m := eventsMissDB()
		u := userCosmeticsMissDB()
		m.users, m.listings, m.tombstones = u.users, u.listings, u.tombstones
		m.frames = map[int][][]any{13: {{int64(504), int64(13), `{"lights": 5}`, nil}}}
		return m.load(f, &MissCompute{FrameNegative: false})
	}
	s, _ := build()
	got, err := s.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	s, _ = build()
	want, err := perLookup(context.Background(), s, pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Page differs from the per-lookup answer:\n got %#v\nwant %#v", got, want)
	}
	if len(got.UserCosmetics[1002]) != 1 || got.Frames[13] == nil || got.Decorations[12] == nil {
		t.Fatalf("misses not computed: %+v", got)
	}
}

// isListingDisplayable's cases (packages/civitai-shared/src/knights-shop.ts), literal.
func TestListingDisplayable(t *testing.T) {
	cases := []struct {
		name   string
		status string
		meta   any
		reason any
		want   bool
	}{
		{"published", "Published", map[string]any{"takedown": true}, "x", true},
		{"takedown", "Draft", map[string]any{"takedown": map[string]any{}, "displayApproved": true}, nil, false},
		{"display approved", "PendingReview", map[string]any{"displayApproved": true}, nil, true},
		{"display approved null", "PendingReview", map[string]any{"displayApproved": nil, "lastApprovedAmount": 5.0}, nil, false},
		{"reviewed approve", "Draft", map[string]any{"history": []any{map[string]any{"kind": "reviewed", "action": "approve"}}}, nil, true},
		{"last review rejects", "Draft", map[string]any{"history": []any{
			map[string]any{"kind": "reviewed", "action": "approve"}, map[string]any{"kind": "reviewed", "action": "reject"},
		}}, nil, false},
		{"displayed edit after approval", "Draft", map[string]any{"history": []any{
			map[string]any{"kind": "reviewed", "action": "approve"},
			map[string]any{"kind": "edited", "changes": []any{map[string]any{"field": "price"}, map[string]any{"field": "artwork"}}},
		}}, nil, false},
		{"undisplayed edit after approval", "Draft", map[string]any{"history": []any{
			map[string]any{"kind": "reviewed", "action": "approve"},
			map[string]any{"kind": "edited", "changes": []any{map[string]any{"field": "price"}}},
		}}, nil, true},
		{"pre-history approved", "Draft", map[string]any{"lastApprovedAmount": 100.0}, nil, true},
		{"pre-history empty reason", "Draft", map[string]any{"lastApprovedAmount": 0.0}, "", true},
		{"pre-history rejected", "Draft", map[string]any{"lastApprovedAmount": 100.0}, "bad art", false},
		{"pre-history null amount", "Draft", map[string]any{"lastApprovedAmount": nil}, nil, false},
		{"no meta", "Draft", nil, nil, false},
	}
	for _, c := range cases {
		if got := ListingDisplayable(c.status, c.meta, c.reason); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// getWithheldCosmeticIds: only the creator's own listings count; any displayable one shows the
// cosmetic; with none, the Withheld flag decides.
func TestWithheldCosmeticIDs(t *testing.T) {
	m := &missDB{
		listings: map[int][][]any{
			1: {{int64(1), int64(5), "Draft", `{}`, nil, int64(5)}, {int64(1), int64(5), "Published", `{}`, nil, int64(5)}}, // shown
			2: {{int64(2), int64(5), "Draft", `{}`, nil, int64(5)}},                                                         // withheld
			3: {{int64(3), int64(6), "Draft", `{}`, nil, int64(5)}},                                                         // another user's listing: unlisted
			4: {{int64(4), nil, "Draft", `{}`, nil, int64(5)}},                                                              // no adder: unlisted
		},
		tombstones: map[int][]any{3: {int64(3), int64(4 | 1)}, 4: {int64(4), int64(2)}},
	}
	s, _ := m.load(basePageFixture(t), &MissCompute{})
	got, err := s.withheldCosmeticIDs(context.Background(), s.Replica, []int{1, 2, 3, 4, 2, 0})
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]int, 0, len(got))
	for id := range got {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	if !reflect.DeepEqual(ids, []int{2, 3}) {
		t.Fatalf("withheld %v, want [2 3]", ids)
	}
	if q := m.queries("tombstones"); !reflect.DeepEqual(q, [][]int{{3, 4}}) {
		t.Fatalf("tombstone query %v, want the unlisted [3 4]", q)
	}
	if got, err := s.withheldCosmeticIDs(context.Background(), s.Replica, nil); err != nil || len(got) != 0 || len(m.queries("listings")) != 1 {
		t.Fatalf("no ids: %v, %v, %d listing queries; want none sent", got, err, len(m.queries("listings")))
	}
}

// With write-back on, the frame and event-decoration lookups (and the frames' withheld check) read the
// primary, as Node's do: a value read from a lagging replica would be cached for a day. With it off
// they read the replica. Both databases hold the same rows; the test tells them apart by which one
// is asked.
func TestWriteBackReadsPrimary(t *testing.T) {
	build := func(writeBack bool) (*Sources, *missDB, *missDB) {
		f := basePageFixture(t)
		f.del(KeyImageFrames, 13)
		f.del(KeyImageEvents, 12)
		f.strings[pageNS+missKey(KeyCosmetics, 602)] = jspack.Pack(jspack.O("id", 602, "name", "deco2", "type", "ContentDecoration",
			"data", jspack.O("event", "ev", "url", "x.png"), "source", "Event", "cachedAt", pageNow))
		rows := func() *missDB {
			m := eventsMissDB()
			m.frames = map[int][][]any{13: {{int64(504), int64(13), nil, int64(88)}}} // a creator cosmetic: the withheld check runs
			m.listings = map[int][][]any{504: {{int64(504), int64(88), "Published", `{}`, nil, int64(88)}}}
			return m
		}
		primary, replica := rows(), rows()
		// The primary's routes alone: a frame or event query sent to it is answered.
		pdb := &testkit.DB{}
		pf := basePageFixture(t)
		ps, _ := primary.load(pf, &MissCompute{})
		pdb.Routes = ps.Replica.(*pageReplica).Routes
		s, _ := replica.load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Primary: pdb})
		return s, primary, replica
	}
	for _, writeBack := range []bool{true, false} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			s, primary, replica := build(writeBack)
			got, err := s.Page(context.Background(), pageRequest())
			if err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			if got.Frames[13] == nil || got.Decorations[12] == nil {
				t.Fatalf("frame 13 %v, decoration 12 %v: want both computed", got.Frames[13], got.Decorations[12])
			}
			on, off := primary, replica
			if !writeBack {
				on, off = replica, primary
			}
			for _, q := range []string{"frames", "listings", "events"} {
				if len(on.queries(q)) != 1 || len(off.queries(q)) != 0 {
					t.Errorf("write-back %v: %s queries: %d on the expected database, %d on the other; want 1 and 0",
						writeBack, q, len(on.queries(q)), len(off.queries(q)))
				}
			}
		})
	}
	// Write-back on with no primary configured: the lookup fails rather than read the replica.
	f := basePageFixture(t)
	f.del(KeyImageFrames, 13)
	m := &missDB{}
	s, _ := m.load(f, &MissCompute{FrameNegative: true})
	s.Compute.WriteBack = AllWrites()
	if _, err := s.Page(context.Background(), pageRequest()); fallback.Reason(err) != "image-frame-miss-failed" {
		t.Fatalf("no primary: %v, want image-frame-miss-failed", err)
	}
	if len(m.queries("frames")) != 0 {
		t.Fatal("write-back without a primary read the replica")
	}
}

// jsonColumn: NULL, text (as `::text` selects it) and bytes parse as JSON.parse would; any other type
// or malformed text is an error, not a guess.
func TestJSONColumn(t *testing.T) {
	if v, err := jsonColumn(nil); v != nil || err != nil {
		t.Fatalf("NULL = %#v, %v", v, err)
	}
	for _, in := range []any{`{"b": 1, "a": [true]}`, []byte(`{"b": 1, "a": [true]}`)} {
		v, err := jsonColumn(in)
		if err != nil || !reflect.DeepEqual(v, jspack.O("b", 1.0, "a", []any{true})) {
			t.Fatalf("%T = %#v, %v", in, v, err)
		}
	}
	for _, bad := range []any{42, `{"a":`} {
		if _, err := jsonColumn(bad); err == nil {
			t.Fatalf("%#v parsed", bad)
		}
	}
}

// cosmeticRecords: a cached record keeps its cached member order (cachedAt dropped), a notFound marker
// is absent, an undecodable or debounced entry is read from the replica, and a replica failure is
// the lookup's error.
func TestCosmeticRecords(t *testing.T) {
	f := basePageFixture(t)
	f.strings[pageNS+missKey(KeyCosmetics, 701)] = jspack.Pack(jspack.O("name", "n701", "id", 701, "cachedAt", pageNow))
	f.put(t, KeyCosmetics, 702, map[string]any{"notFound": true})
	f.strings[pageNS+missKey(KeyCosmetics, 703)] = []byte{0xc1}
	f.put(t, KeyCosmetics, 704, map[string]any{"debounce": true})
	m := &missDB{records: map[int][]any{
		703: {int64(703), "n703", "Badge", `{"z": 1, "a": 2}`, "Trophy", int64(0)},
		704: {int64(704), "n704", "Badge", nil, "Trophy", int64(1)},
	}}
	s, _ := m.load(f, &MissCompute{})
	got, err := s.cosmeticRecords(context.Background(), []int{701, 702, 703, 704, 705})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]jspack.Obj{
		701: jspack.O("name", "n701", "id", 701.0),
		703: jspack.O("id", 703, "name", "n703", "type", "Badge", "data", jspack.O("z", 1.0, "a", 2.0), "source", "Trophy", "flags", 0),
		704: jspack.O("id", 704, "name", "n704", "type", "Badge", "data", nil, "source", "Trophy", "flags", 1),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("records\n got %#v\nwant %#v", got, want)
	}
	if q := m.queries("records"); !reflect.DeepEqual(q, [][]int{{703, 704, 705}}) {
		t.Fatalf("replica asked %v, want the undecodable, debounced and absent ids", q)
	}
	if got, err := s.cosmeticRecords(context.Background(), nil); err != nil || len(got) != 0 {
		t.Fatalf("no ids = %v, %v", got, err)
	}
	m.fail = "records"
	if _, err := s.cosmeticRecords(context.Background(), []int{705}); !errors.Is(err, errMissDB) {
		t.Fatalf("replica failure = %v, want it returned", err)
	}
}
