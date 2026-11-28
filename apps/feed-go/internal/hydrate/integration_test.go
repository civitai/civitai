//go:build integration

package hydrate

// Integration tests against a real Redis Cluster and a real Postgres (see internal/integtest and
// .github/workflows/feed-go.yml). Every cache value is written as the Node app writes it (msgpackr
// `pack`, see integtest.Pack) and every expected value is a literal written here.
//
// Ids in this file live in 1_100_000..1_199_999 (internal/feed's integration tests use 2_1xx_xxx), so
// the two packages, which `go test ./...` runs in parallel, never touch each other's rows or keys.

import (
	"context"
	"encoding/hex"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

type integEnv struct {
	c      *redis.ClusterClient
	pool   *pgxpool.Pool // nil unless asked for
	prefix string
	src    *Sources
}

func integSetup(t *testing.T, withPG bool) *integEnv {
	t.Helper()
	e := &integEnv{c: integtest.Cluster(t), prefix: integtest.Prefix(t)}
	if withPG {
		e.pool = integtest.Postgres(t)
	}
	e.src = &Sources{Packed: &PackedReader{Redis: e.c, Prefix: e.prefix}, Cache: e.c}
	if e.pool != nil {
		e.src.Replica = e.pool
	}
	return e
}

// put writes `${prefix}${key}:${id}` as the Node cache writes it, removed when the test ends.
func (e *integEnv) put(t *testing.T, key string, id int, v integtest.Obj) {
	t.Helper()
	full := e.prefix + key + ":" + strconv.Itoa(id)
	if err := e.c.Set(integtest.Ctx(t), full, integtest.Pack(v), 0).Err(); err != nil {
		t.Fatalf("set %s: %v", full, err)
	}
	t.Cleanup(func() { _ = e.c.Del(context.Background(), full).Err() })
}

func integPlain(t *testing.T, v any) string {
	t.Helper()
	b, err := superjson.Plain(v)
	if err != nil {
		t.Fatalf("plain %#v: %v", v, err)
	}
	return string(b)
}

func integWantReason(t *testing.T, err error, reason string) {
	t.Helper()
	if got := fallback.Reason(err); got != reason {
		t.Fatalf("err = %v (fallback reason %q), want fallback %q", err, got, reason)
	}
}

// TestIntegrationPackMatchesMsgpackr validates the instrument: integtest.Pack must write exactly the
// bytes msgpackr 1.11.5's module-level `pack` wrote for these values (goldens generated with node,
// `require('msgpackr').pack(v).toString('hex')`), and Unpack must read them back.
func TestIntegrationPackMatchesMsgpackr(t *testing.T) {
	// {id:7, username:'integ-user', when:new Date(Date.UTC(2024,0,2,3,4,5,678)),
	//  whole:new Date(Date.UTC(2024,0,2,3,4,5)), u:undefined, f:1.5, neg:-3, big:70000, n:null,
	//  b:true, arr:[1,'x']}
	const golden1 = "de000ba2696407a8757365726e616d65aa696e7465672d75736572a47768656ed7ffa1a5d60065937d25a577686f6c65d6ff65937d25a175d40000a166cb3ff8000000000000a36e6567fda3626967ce00011170a16ec0a162c3a36172729201a178"
	when := time.Date(2024, 1, 2, 3, 4, 5, 678e6, time.UTC)
	whole := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	v1 := integtest.O("id", 7, "username", "integ-user", "when", when, "whole", whole, "u", integtest.Undefined{},
		"f", 1.5, "neg", -3, "big", 70000, "n", nil, "b", true, "arr", []any{1, "x"})
	if got := hex.EncodeToString(integtest.Pack(v1)); got != golden1 {
		t.Fatalf("Pack(v1)\n got %s\nwant %s", got, golden1)
	}

	// {long:'integ-'+'x'.repeat(34), arr17:[0,10,…,160], n200:-200, n100:-100, huge:2**33, b200:200,
	//  e:{}, old:new Date(Date.UTC(1969,11,31,23,59,59,500))}
	const golden2 = "de0008a46c6f6e67d928696e7465672d78787878787878787878787878787878787878787878787878787878787878787878a56172723137dc0011000a141e28323c46505a646e78cc82cc8ccc96cca0a46e323030d1ff38a46e313030d09ca468756765cb4200000000000000a462323030ccc8a165de0000a36f6c64c70cff1dcd6500ffffffffffffffff"
	arr17 := make([]any, 17)
	for i := range arr17 {
		arr17[i] = i * 10
	}
	v2 := integtest.O("long", "integ-"+strings.Repeat("x", 34), "arr17", arr17, "n200", -200, "n100", -100,
		"huge", 8589934592, "b200", 200, "e", integtest.O(), "old", time.Date(1969, 12, 31, 23, 59, 59, 500e6, time.UTC))
	if got := hex.EncodeToString(integtest.Pack(v2)); got != golden2 {
		t.Fatalf("Pack(v2)\n got %s\nwant %s", got, golden2)
	}

	raw, _ := hex.DecodeString(golden1)
	got, err := Unpack(raw)
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("Unpack = %T, want a map", got)
	}
	for k, want := range map[string]time.Time{"when": when, "whole": whole} {
		at, ok := m[k].(time.Time)
		if !ok || !at.Equal(want) {
			t.Fatalf("%s = %#v, want %v", k, m[k], want)
		}
		delete(m, k)
	}
	want := map[string]any{
		"id": int64(7), "username": "integ-user", "f": 1.5, "neg": int64(-3), "big": uint64(70000),
		"n": nil, "b": true, "arr": []any{int64(1), "x"},
	}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("Unpack = %#v, want %#v (undefined dropped)", m, want)
	}
}

func TestIntegrationPackedReaderHitAndMarkers(t *testing.T) {
	e := integSetup(t, false)
	const key = "packed:caches:integ-markers"
	cachedAt := time.Now().Add(-time.Minute)
	e.put(t, key, 1100001, integtest.O("id", 1100001, "username", "integ-hit", "gone", integtest.Undefined{}, "cachedAt", cachedAt))
	e.put(t, key, 1100002, integtest.O("debounce", true))
	e.put(t, key, 1100003, integtest.O("notFound", true, "cachedAt", cachedAt))
	e.put(t, key, 1100005, integtest.O("debounce", false, "id", 1100005))

	got := e.src.Packed.Get(integtest.Ctx(t), key, []int{1100001, 1100002, 1100003, 1100004, 1100005}, time.Hour)

	if len(got) != 3 {
		t.Fatalf("got ids %v, want exactly 1100001, 1100003, 1100005", integKeys(got))
	}
	hit, ok := got[1100001]
	if !ok || hit.NotFound || hit.Stale {
		t.Fatalf("1100001 = %+v (present %v), want a fresh hit", hit, ok)
	}
	if want := map[string]any{"id": uint64(1100001), "username": "integ-hit"}; !reflect.DeepEqual(hit.Value, want) {
		t.Fatalf("1100001 value = %#v, want %#v (cachedAt and the undefined member removed)", hit.Value, want)
	}
	if _, ok := got[1100002]; ok {
		t.Fatal("a {debounce: true} marker must be a miss")
	}
	if nf, ok := got[1100003]; !ok || !nf.NotFound {
		t.Fatalf("1100003 = %+v (present %v), want NotFound", nf, ok)
	}
	if _, ok := got[1100003].Value["cachedAt"]; ok {
		t.Fatal("cachedAt left on a notFound entry")
	}
	if _, ok := got[1100004]; ok {
		t.Fatal("an absent key must be a miss")
	}
	if v, ok := got[1100005]; !ok || v.NotFound {
		t.Fatalf("1100005 = %+v (present %v): debounce false is data, not a marker", v, ok)
	}
	if miss := Missing([]int{1100001, 1100002, 1100003, 1100004, 1100005}, got); !reflect.DeepEqual(miss, []int{1100002, 1100004}) {
		t.Fatalf("Missing = %v, want [1100002 1100004]", miss)
	}
}

func TestIntegrationPackedReaderStaleness(t *testing.T) {
	e := integSetup(t, false)
	const key = "packed:caches:integ-stale"
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	e.src.Packed.Now = func() time.Time { return now }
	e.put(t, key, 1100101, integtest.O("v", "old", "cachedAt", now.Add(-25*time.Hour)))
	e.put(t, key, 1100102, integtest.O("v", "young", "cachedAt", now.Add(-23*time.Hour)))
	e.put(t, key, 1100103, integtest.O("v", "undated"))
	e.put(t, key, 1100104, integtest.O("notFound", true, "cachedAt", now.Add(-48*time.Hour)))
	ids := []int{1100101, 1100102, 1100103, 1100104}

	got := e.src.Packed.Get(integtest.Ctx(t), key, ids, 24*time.Hour)
	want := map[int]bool{1100101: true, 1100102: false, 1100103: false, 1100104: false}
	for id, stale := range want {
		entry, ok := got[id]
		if !ok {
			t.Fatalf("%d missing", id)
		}
		if entry.Stale != stale {
			t.Fatalf("%d Stale = %v, want %v", id, entry.Stale, stale)
		}
		if _, ok := entry.Value["cachedAt"]; ok {
			t.Fatalf("%d: cachedAt not removed", id)
		}
	}
	if got[1100101].Value["v"] != "old" {
		t.Fatalf("a stale entry is still served: got %#v", got[1100101].Value)
	}
	for id, entry := range e.src.Packed.Get(integtest.Ctx(t), key, ids, 0) {
		if entry.Stale {
			t.Fatalf("ttl 0: %d marked Stale", id)
		}
	}
}

func TestIntegrationPackedReaderSpreadsAcrossMasters(t *testing.T) {
	e := integSetup(t, false)
	const key = "packed:caches:integ-spread"
	var ids []int
	masters := map[string]bool{}
	for id := 1100201; id <= 1100212; id++ {
		ids = append(ids, id)
		e.put(t, key, id, integtest.O("n", "integ-"+strconv.Itoa(id)))
		masters[integtest.MasterOf(t, e.c, e.prefix+key+":"+strconv.Itoa(id))] = true
	}
	if len(masters) < 2 {
		t.Fatalf("the %d keys landed on %d master(s); the test needs >= 2 to exercise a cross-node pipeline", len(ids), len(masters))
	}
	got := e.src.Packed.Get(integtest.Ctx(t), key, ids, 0)
	if len(got) != len(ids) {
		t.Fatalf("got %d of %d ids across %d masters: %v", len(got), len(ids), len(masters), integKeys(got))
	}
	for _, id := range ids {
		if want := "integ-" + strconv.Itoa(id); got[id].Value["n"] != want {
			t.Fatalf("%d = %#v, want n=%q (a value landed on the wrong id)", id, got[id].Value, want)
		}
	}
}

func TestIntegrationPackedReaderPrefix(t *testing.T) {
	e := integSetup(t, false)
	const key = "packed:caches:integ-prefix"
	e.put(t, key, 1100301, integtest.O("n", "prefixed"))
	ctx := integtest.Ctx(t)
	if got := e.src.Packed.Get(ctx, key, []int{1100301}, 0); got[1100301].Value["n"] != "prefixed" {
		t.Fatalf("with the prefix: %#v", got)
	}
	for _, p := range []string{"", "integ-other-namespace:"} {
		r := &PackedReader{Redis: e.c, Prefix: p}
		if got := r.Get(ctx, key, []int{1100301}, 0); len(got) != 0 {
			t.Fatalf("prefix %q read the %q key: %#v", p, e.prefix, got)
		}
	}
}

func TestIntegrationBasicUsers(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "User" WHERE id BETWEEN 1101000 AND 1101999;
		INSERT INTO "User" (id, username, image, "deletedAt") VALUES
		  (1101001, 'integ-db-shadowed', 'integ-db-img', NULL),
		  (1101003, 'integ-db-notfound', NULL, NULL),
		  (1101004, 'integ-db-user', 'integ-db-avatar', '2023-04-05 06:07:08.009');`)
	deleted := time.Date(2022, 2, 3, 4, 5, 6, 0, time.UTC)
	e.put(t, KeyBasicUsers, 1101001, integtest.O("id", 1101001, "username", "integ-cache-user", "image", "integ-cache-img", "deletedAt", nil, "cachedAt", time.Now()))
	e.put(t, KeyBasicUsers, 1101002, integtest.O("id", 1101002, "username", "integ-stale-user", "image", nil, "deletedAt", deleted, "cachedAt", time.Now().Add(-30*24*time.Hour)))
	e.put(t, KeyBasicUsers, 1101003, integtest.O("notFound", true))

	got, err := e.src.BasicUsers(integtest.Ctx(t), []int{1101001, 1101002, 1101003, 1101004, 1101005, 1101001})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1101001, 1101002, 1101004}) {
		t.Fatalf("ids = %v, want [1101001 1101002 1101004] (notFound and an unknown id absent)", ids)
	}
	integWantUser(t, got[1101001], 1101001, "integ-cache-user", "integ-cache-img", nil)
	integWantUser(t, got[1101002], 1101002, "integ-stale-user", nil, &deleted) // stale is served
	dbDeleted := time.Date(2023, 4, 5, 6, 7, 8, 9e6, time.UTC)
	integWantUser(t, got[1101004], 1101004, "integ-db-user", "integ-db-avatar", &dbDeleted)
}

func integWantUser(t *testing.T, u BasicUser, id int, username, image any, deletedAt *time.Time) {
	t.Helper()
	if u.ID != id || u.Username != username || u.Image != image {
		t.Fatalf("user = %+v, want id %d username %#v image %#v", u, id, username, image)
	}
	if deletedAt == nil {
		if u.DeletedAt != nil {
			t.Fatalf("user %d deletedAt = %#v, want nil", id, u.DeletedAt)
		}
		return
	}
	if at, ok := u.DeletedAt.(*time.Time); !ok || !at.Equal(*deletedAt) {
		t.Fatalf("user %d deletedAt = %#v, want %v", id, u.DeletedAt, *deletedAt)
	}
}

func TestIntegrationCosmeticsAndUserCosmetics(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Cosmetic" WHERE id BETWEEN 1102000 AND 1102999;
		INSERT INTO "Cosmetic" (id, name, type, source, data, flags) VALUES
		  (1102001, 'integ-db-shadowed', 'NamePlate', 'Claim', '{}', 9),
		  (1102002, 'integ-cosmetic-db', 'ContentDecoration', 'Purchase', '{"url": "integ-frame-db", "glow": 2}', 5);`)
	e.put(t, KeyCosmetics, 1102001, integtest.O("id", 1102001, "name", "integ-cosmetic-hit", "type", "Badge",
		"data", integtest.O("url", "integ-badge", "animated", true), "source", "Trophy", "flags", 3, "cachedAt", time.Now()))
	e.put(t, KeyCosmetics, 1102003, integtest.O("notFound", true))
	ctx := integtest.Ctx(t)

	got, err := e.src.Cosmetics(ctx, []int{1102001, 1102002, 1102003, 1102004})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1102001, 1102002}) {
		t.Fatalf("ids = %v, want [1102001 1102002]", ids)
	}
	// The cached record's `data` keeps the order it was written in (Entry.Ordered); the replica row's
	// json column below is decoded into a map, its keys sorted.
	if s, want := integPlain(t, got[1102001]), `{"id":1102001,"name":"integ-cosmetic-hit","type":"Badge","data":{"url":"integ-badge","animated":true},"source":"Trophy","flags":3}`; s != want {
		t.Fatalf("cache hit:\n got %s\nwant %s", s, want)
	}
	if s, want := integPlain(t, got[1102002]), `{"id":1102002,"name":"integ-cosmetic-db","type":"ContentDecoration","data":{"glow":2,"url":"integ-frame-db"},"source":"Purchase","flags":5}`; s != want {
		t.Fatalf("database miss path:\n got %s\nwant %s", s, want)
	}

	e.put(t, KeyUserCosmetics, 1102101, integtest.O("cosmetics", []any{
		integtest.O("cosmeticId", 1102001, "data", integtest.O("color", "integ-red")),
		integtest.O("cosmeticId", 1102002, "data", nil),
		integtest.O("cosmeticId", 1102004, "data", nil), // a cosmetic found nowhere
	}))
	e.put(t, KeyUserCosmetics, 1102102, integtest.O("notFound", true))
	uc, err := e.src.UserCosmetics(ctx, []int{1102101, 1102102})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(uc); !reflect.DeepEqual(ids, []int{1102101}) {
		t.Fatalf("user ids = %v, want [1102101]", ids)
	}
	// The undefined `cosmetic` of the unknown record is omitted by Plain (JSON.stringify).
	want := `[{"cosmeticId":1102001,"data":{"color":"integ-red"},"cosmetic":{"id":1102001,"name":"integ-cosmetic-hit","type":"Badge","data":{"url":"integ-badge","animated":true},"source":"Trophy","flags":3}},` +
		`{"cosmeticId":1102002,"data":null,"cosmetic":{"id":1102002,"name":"integ-cosmetic-db","type":"ContentDecoration","data":{"glow":2,"url":"integ-frame-db"},"source":"Purchase","flags":5}},` +
		`{"cosmeticId":1102004,"data":null}]`
	if s := integPlain(t, uc[1102101]); s != want {
		t.Fatalf("user cosmetics:\n got %s\nwant %s", s, want)
	}

	_, err = e.src.UserCosmetics(ctx, []int{1102101, 1102103})
	integWantReason(t, err, "user-cosmetics-miss")
}

func TestIntegrationProfilePictures(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "User" WHERE id BETWEEN 1103000 AND 1103999;
		DELETE FROM "Image" WHERE id BETWEEN 1103000 AND 1103999;
		INSERT INTO "Image" (id, name, url, "userId", "nsfwLevel", hash, ingestion, type, width, height, metadata, "needsReview") VALUES
		  (1103102, 'integ-pp-db', 'integ-pp-url', 1103002, 2, 'integ-pp-hash', 'Scanned', 'image', 96, 97, '{"size": 1234}', NULL),
		  (1103103, 'integ-pp-blocked', 'integ-pp-blocked-url', 1103003, 1, NULL, 'Blocked', 'image', 10, 11, '{}', NULL),
		  (1103104, 'integ-pp-pending', 'integ-pp-pending-url', 1103004, 1, NULL, 'Pending', 'image', 10, 11, '{}', NULL),
		  (1103105, 'integ-pp-csam', 'integ-pp-csam-url', 1103005, 1, NULL, 'Scanned', 'image', 10, 11, '{}', 'csam'),
		  (1103107, 'integ-pp-minor', 'integ-pp-minor-url', 1103007, 1, NULL, 'Scanned', 'image', 10, 11, '{}', 'minor'),
		  (1103108, 'integ-pp-poi', 'integ-pp-poi-url', 1103008, 1, NULL, 'Scanned', 'image', 10, 11, '{}', 'poi');
		INSERT INTO "User" (id, username, "profilePictureId") VALUES
		  (1103002, 'integ-pp-user2', 1103102), (1103003, 'integ-pp-user3', 1103103),
		  (1103004, 'integ-pp-user4', 1103104), (1103005, 'integ-pp-user5', 1103105),
		  (1103006, 'integ-pp-user6', NULL), (1103007, 'integ-pp-user7', 1103107),
		  (1103008, 'integ-pp-user8', 1103108);`)
	e.put(t, KeyProfilePictures, 1103001, integtest.O("id", 1103101, "name", "integ-pp-hit", "url", "integ-pp-hit-url",
		"nsfwLevel", 1, "hash", nil, "userId", 1103001, "ingestion", "Scanned", "type", "image", "width", 50, "height", 51,
		"metadata", integtest.O("hash", "integ-blur"), "extra", "dropped"))

	got, err := e.src.ProfilePictures(integtest.Ctx(t), []int{1103001, 1103002, 1103003, 1103004, 1103005, 1103006, 1103007, 1103008})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1103001, 1103002, 1103008}) {
		t.Fatalf("ids = %v, want [1103001 1103002 1103008] (blocked, unscanned, csam, minor and no-picture users absent; another review stays)", ids)
	}
	if s, want := integPlain(t, got[1103001]), `{"id":1103101,"name":"integ-pp-hit","url":"integ-pp-hit-url","nsfwLevel":1,"hash":null,"userId":1103001,"ingestion":"Scanned","type":"image","width":50,"height":51,"metadata":{"hash":"integ-blur"}}`; s != want {
		t.Fatalf("cache hit:\n got %s\nwant %s", s, want)
	}
	if s, want := integPlain(t, got[1103002]), `{"id":1103102,"name":"integ-pp-db","url":"integ-pp-url","nsfwLevel":2,"hash":"integ-pp-hash","userId":1103002,"ingestion":"Scanned","type":"image","width":96,"height":97,"metadata":{"size":1234}}`; s != want {
		t.Fatalf("database miss path:\n got %s\nwant %s", s, want)
	}
}

func TestIntegrationImageFrames(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Cosmetic" WHERE id BETWEEN 1104000 AND 1104499;
		INSERT INTO "Cosmetic" (id, name, type, source, data) VALUES
		  (1104201, 'integ-frame', 'ContentDecoration', 'Purchase', '{"url": "integ-frame-url"}');`)
	e.put(t, KeyImageFrames, 1104001, integtest.O("cosmeticId", 1104201, "equippedToId", 1104001, "userData", nil))
	e.put(t, KeyImageFrames, 1104003, integtest.O("notFound", true))
	ctx := integtest.Ctx(t)

	got, err := e.src.ImageFrames(ctx, []int{1104001, 1104003})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1104001}) {
		t.Fatalf("ids = %v, want [1104001]", ids)
	}
	if s, want := integPlain(t, got[1104001]), `{"equippedToId":1104001,"userData":null,"id":1104201,"data":{"url":"integ-frame-url"}}`; s != want {
		t.Fatalf("frame:\n got %s\nwant %s", s, want)
	}

	_, err = e.src.ImageFrames(ctx, []int{1104001, 1104002})
	integWantReason(t, err, "image-frame-miss")

	e.put(t, KeyImageFrames, 1104004, integtest.O("cosmeticId", 1104299, "equippedToId", 1104004, "userData", nil))
	_, err = e.src.ImageFrames(ctx, []int{1104004})
	integWantReason(t, err, "image-frame-cosmetic-missing")
}

func TestIntegrationEventDecorations(t *testing.T) {
	e := integSetup(t, false)
	e.put(t, KeyImageEvents, 1104501, integtest.O("id", 1104601, "name", "integ-deco", "type", "ContentDecoration", "source", "Event",
		"data", integtest.O("event", "integ-event", "url", "integ-deco-url"), "equippedToId", 1104501, "equippedToType", "Image", "userId", 1104999))
	e.put(t, KeyImageEvents, 1104502, integtest.O("id", 1104602, "data", integtest.O("event", "integ-hidden-event")))
	e.put(t, KeyImageEvents, 1104503, integtest.O("notFound", true))
	ctx := integtest.Ctx(t)
	visible := map[string]bool{"integ-event": true}

	got, err := e.src.EventDecorations(ctx, []int{1104501, 1104502, 1104503}, visible)
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1104501}) {
		t.Fatalf("ids = %v, want [1104501]", ids)
	}
	if s, want := integPlain(t, got[1104501]), `{"id":1104601,"name":"integ-deco","type":"ContentDecoration","source":"Event","data":{"event":"integ-event","url":"integ-deco-url"},"equippedToId":1104501,"equippedToType":"Image"}`; s != want {
		t.Fatalf("decoration (userId must not be sent):\n got %s\nwant %s", s, want)
	}

	_, err = e.src.EventDecorations(ctx, []int{1104501, 1104504}, visible)
	integWantReason(t, err, "event-decoration-miss")

	// No visible event: no cache read, so even a miss is no fallback.
	if got, err := e.src.EventDecorations(ctx, []int{1104504}, nil); err != nil || len(got) != 0 {
		t.Fatalf("no visible events = %v, %v; want empty, nil", got, err)
	}
}

func TestIntegrationThumbnails(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1105000 AND 1105999;
		INSERT INTO "Image" (id, url, "userId", type, metadata, "nsfwLevel", width, height) VALUES
		  (1105002, 'integ-video-2', 1105900, 'video', '{"thumbnailId": 1105102}', 1, 1920, 1080),
		  (1105102, 'integ-thumb-db', 1105900, 'image', '{"parentId": 1105002}', 2, 640, 360),
		  (1105003, 'integ-image-3', 1105900, 'image', '{"thumbnailId": 1105103}', 1, 10, 10),
		  (1105103, 'integ-thumb-not-of-a-video', 1105900, 'image', '{"parentId": 1105003}', 1, 10, 10);`)
	e.put(t, KeyThumbnails, 1105001, integtest.O("url", "integ-thumb-hit", "nsfwLevel", 4, "width", 320, "height", 180, "cachedAt", time.Now()))
	e.put(t, KeyThumbnails, 1105004, integtest.O("notFound", true))

	got, err := e.src.Thumbnails(integtest.Ctx(t), []int{1105001, 1105002, 1105003, 1105004})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1105001, 1105002}) {
		t.Fatalf("ids = %v, want [1105001 1105002] (a non-video's thumbnailId is not followed)", ids)
	}
	render := func(th Thumbnail) string {
		return integPlain(t, superjson.Object{{Key: "url", Val: th.URL}, {Key: "nsfwLevel", Val: int64(th.NsfwLevel)},
			{Key: "hasNsfwKey", Val: th.HasNsfwKey}, {Key: "width", Val: th.Width}, {Key: "height", Val: th.Height}})
	}
	if s, want := render(got[1105001]), `{"url":"integ-thumb-hit","nsfwLevel":4,"hasNsfwKey":true,"width":320,"height":180}`; s != want {
		t.Fatalf("cache hit:\n got %s\nwant %s", s, want)
	}
	if s, want := render(got[1105002]), `{"url":"integ-thumb-db","nsfwLevel":2,"hasNsfwKey":true,"width":640,"height":360}`; s != want {
		t.Fatalf("database miss path:\n got %s\nwant %s", s, want)
	}
}

// The miss path's blockMarked / ownerMediaAllowed columns over real rows: a clean thumbnail, a hold
// that leaves the owner the media (AiNotVerified), a safety block (CSAM), a Blocked ingestion with no
// reason, and a Blocked level alone (a rating to the owner, a block marker to everyone else).
func TestIntegrationThumbnailOwnerMediaAllowed(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1105500 AND 1105599;
		INSERT INTO "Image" (id, url, "userId", type, metadata, "nsfwLevel", width, height, ingestion, "blockedFor") VALUES
		  (1105501, 'integ-oma-video-1', 1105900, 'video', '{"thumbnailId": 1105511}', 1, 1920, 1080, 'Scanned', NULL),
		  (1105511, 'integ-oma-clean', 1105900, 'image', '{"parentId": 1105501}', 1, 640, 360, 'Scanned', NULL),
		  (1105502, 'integ-oma-video-2', 1105900, 'video', '{"thumbnailId": 1105512}', 1, 1920, 1080, 'Scanned', NULL),
		  (1105512, 'integ-oma-hold', 1105900, 'image', '{"parentId": 1105502}', 1, 640, 360, 'Blocked', 'AiNotVerified'),
		  (1105503, 'integ-oma-video-3', 1105900, 'video', '{"thumbnailId": 1105513}', 1, 1920, 1080, 'Scanned', NULL),
		  (1105513, 'integ-oma-csam', 1105900, 'image', '{"parentId": 1105503}', 1, 640, 360, 'Blocked', 'CSAM'),
		  (1105504, 'integ-oma-video-4', 1105900, 'video', '{"thumbnailId": 1105514}', 1, 1920, 1080, 'Scanned', NULL),
		  (1105514, 'integ-oma-ingestion', 1105900, 'image', '{"parentId": 1105504}', 1, 640, 360, 'Blocked', NULL),
		  (1105505, 'integ-oma-video-5', 1105900, 'video', '{"thumbnailId": 1105515}', 1, 1920, 1080, 'Scanned', NULL),
		  (1105515, 'integ-oma-rating', 1105900, 'image', '{"parentId": 1105505}', 32, 640, 360, 'Scanned', NULL);`)

	got, err := e.src.Thumbnails(integtest.Ctx(t), []int{1105501, 1105502, 1105503, 1105504, 1105505})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		video                  int
		url                    string
		servable, ownerAllowed bool
	}{
		{1105501, "integ-oma-clean", true, true},
		{1105502, "integ-oma-hold", false, true},
		{1105503, "integ-oma-csam", false, false},
		{1105504, "integ-oma-ingestion", false, false},
		{1105505, "integ-oma-rating", false, true},
	} {
		th, ok := got[c.video]
		if !ok {
			t.Errorf("video %d: no thumbnail", c.video)
			continue
		}
		if th.URL != c.url || th.Servable != c.servable || th.OwnerMediaAllowed != c.ownerAllowed {
			t.Errorf("video %d: url %v servable %v ownerMediaAllowed %v, want %s %v %v",
				c.video, th.URL, th.Servable, th.OwnerMediaAllowed, c.url, c.servable, c.ownerAllowed)
		}
	}
}

func TestIntegrationImageMetrics(t *testing.T) {
	e := integSetup(t, false)
	ctx := integtest.Ctx(t)
	ids := []int{1106001, 1106002, 1106003, 1106004, 1106005, 1106006}
	keys := make([]string, 0, len(ids)+1)
	masters := map[string]bool{}
	for _, id := range ids {
		k := "metrics:Image:" + strconv.Itoa(id)
		keys = append(keys, k)
		masters[integtest.MasterOf(t, e.c, k)] = true
	}
	integtest.Del(t, e.c, append(keys, "metrics:Image:1106009")...)
	if len(masters) < 2 {
		t.Fatalf("the metric hashes landed on %d master(s); need >= 2", len(masters))
	}
	hashes := map[int][]any{
		1106001: {"Like", "3", "Heart", "5", "commentCount", "2", "_populatedAt", "1700000000000"},
		1106002: {"notFound", "1", "_populatedAt", "1700000000000"},
		1106003: {"Laugh", "7"},
		1106004: {"Cry", "11"},
		1106005: {"Collection", "13", "tippedAmount", "17"},
		1106006: {"Like", "19"},
	}
	for id, fields := range hashes {
		if err := e.c.HSet(ctx, "metrics:Image:"+strconv.Itoa(id), fields...).Err(); err != nil {
			t.Fatal(err)
		}
	}

	got, err := e.src.ImageMetrics(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]Metrics{
		1106001: {"Like": 3, "Heart": 5, "commentCount": 2},
		1106002: {},
		1106003: {"Laugh": 7},
		1106004: {"Cry": 11},
		1106005: {"Collection": 13, "tippedAmount": 17},
		1106006: {"Like": 19},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("metrics = %#v, want %#v", got, want)
	}

	_, err = e.src.ImageMetrics(ctx, []int{1106001, 1106009})
	integWantReason(t, err, "metrics-miss")
}

func TestIntegrationTagIDs(t *testing.T) {
	e := integSetup(t, false)
	e.put(t, KeyTagIDs, 1107001, integtest.O("tags", []any{11, 22, 330}))
	e.put(t, KeyTagIDs, 1107002, integtest.O("notFound", true))
	e.put(t, KeyTagIDs, 1107003, integtest.O("other", 1))
	ctx := integtest.Ctx(t)

	got, err := e.src.TagIDs(ctx, []int{1107001, 1107002, 1107003})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1107001}) {
		t.Fatalf("ids = %v, want [1107001]", ids)
	}
	if s := integPlain(t, got[1107001]); s != `[11,22,330]` {
		t.Fatalf("tags = %s, want [11,22,330]", s)
	}

	_, err = e.src.TagIDs(ctx, []int{1107001, 1107004})
	integWantReason(t, err, "tag-ids-miss")
}

func TestIntegrationImageResources(t *testing.T) {
	e := integSetup(t, false)
	e.put(t, KeyImageResources, 1108001, integtest.O("imageId", 1108001, "resources", []any{
		integtest.O("modelVersionId", 1108501, "detected", true, "modelType", "Checkpoint", "baseModel", "integ-base"),
		integtest.O("modelVersionId", 1108502, "detected", false, "modelType", "LORA", "baseModel", nil),
	}))
	e.put(t, KeyImageResources, 1108002, integtest.O("notFound", true))
	e.put(t, KeyImageResources, 1108003, integtest.O("resources", "not-an-array"))
	ctx := integtest.Ctx(t)

	got, err := e.src.ImageResources(ctx, []int{1108001, 1108002})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int][]ImageResource{1108001: {
		{ModelVersionID: 1108501, Detected: true, ModelType: "Checkpoint", BaseModel: "integ-base"},
		{ModelVersionID: 1108502, Detected: false, ModelType: "LORA", BaseModel: nil},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resources = %#v, want %#v", got, want)
	}

	_, err = e.src.ImageResources(ctx, []int{1108001, 1108004})
	integWantReason(t, err, "image-resources-miss")
	_, err = e.src.ImageResources(ctx, []int{1108003})
	integWantReason(t, err, "image-resources-shape")
}

func TestIntegrationPostVersionsAndVersionModels(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Post" WHERE id BETWEEN 1109000 AND 1109999;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 1109000 AND 1109999;
		INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
		  (1109001, 1109900, 1109888), (1109002, 1109900, 1109502), (1109003, 1109900, 1109503),
		  (1109004, 1109900, NULL), (1109006, 1109900, 1109506);
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (1109601, 1109777), (1109602, 1109702);`)
	now := time.Now()
	e.put(t, KeyPostVersion, 1109001, integtest.O("modelVersionId", 1109501, "cachedAt", now.Add(-time.Minute)))
	e.put(t, KeyPostVersion, 1109002, integtest.O("modelVersionId", 1109999, "cachedAt", now.Add(-2*time.Hour)))
	e.put(t, KeyPostVersion, 1109006, integtest.O("notFound", true))
	ctx := integtest.Ctx(t)

	got, err := e.src.PostVersions(ctx, []int{1109001, 1109002, 1109003, 1109004, 1109005, 1109006})
	if err != nil {
		t.Fatal(err)
	}
	// 1109001: fresh hit (the database says otherwise); 1109002: past the 1h TTL, re-read; 1109003: miss;
	// 1109004: a null version is 0; 1109005: found nowhere, absent; 1109006: a notFound marker re-read.
	want := map[int]int{1109001: 1109501, 1109002: 1109502, 1109003: 1109503, 1109004: 0, 1109006: 1109506}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("post versions = %v, want %v", got, want)
	}

	e.put(t, KeyVersionModel, 1109601, integtest.O("modelId", 1109701, "cachedAt", now.Add(-6*24*time.Hour)))
	vm, err := e.src.VersionModels(ctx, []int{1109601, 1109602, 1109603})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[int]int{1109601: 1109701, 1109602: 1109702}; !reflect.DeepEqual(vm, want) {
		t.Fatalf("version models = %v, want %v", vm, want)
	}
}

func TestIntegrationUserIDByUsername(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "User" WHERE id BETWEEN 1110000 AND 1110999;
		INSERT INTO "User" (id, username) VALUES (1110001, 'Integ_Mixed_Case');`)
	ctx := integtest.Ctx(t)
	// "User".username is citext: the lookup is case-insensitive, as on the replica.
	for _, name := range []string{"Integ_Mixed_Case", "integ_mixed_case"} {
		id, ok, err := e.src.UserIDByUsername(ctx, name)
		if err != nil || !ok || id != 1110001 {
			t.Fatalf("%q = %d, %v, %v; want 1110001, true, nil", name, id, ok, err)
		}
	}
	if id, ok, err := e.src.UserIDByUsername(ctx, "integ_nobody"); err != nil || ok || id != 0 {
		t.Fatalf("unknown = %d, %v, %v; want 0, false, nil", id, ok, err)
	}
}

// TagIDByName is the one tag lookup by name model.getAll and /api/v1/models both read. "Tag".name is
// citext, so a name in any case finds the tag, as getModelsRaw's findUnique does on the replica.
func TestIntegrationTagIDByName(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Tag" WHERE id BETWEEN 1190000 AND 1190999;
		INSERT INTO "Tag" (id, name) VALUES (1190001, 'integ-character'), (1190002, 'Integ Mixed Tag');`)
	ctx := integtest.Ctx(t)
	for name, want := range map[string]int{
		"integ-character": 1190001, "Integ-Character": 1190001, "INTEG-CHARACTER": 1190001,
		"Integ Mixed Tag": 1190002, "integ mixed tag": 1190002,
	} {
		id, found, err := TagIDByName(ctx, e.pool, name)
		if err != nil || !found || id != want {
			t.Errorf("%q = %d, %v, %v; want %d, true, nil", name, id, found, err, want)
		}
	}
	// No such tag; and a near miss is no match (citext folds case, nothing else).
	for _, name := range []string{"integ-nosuch", "integ-character ", "integ_character"} {
		if id, found, err := TagIDByName(ctx, e.pool, name); err != nil || found || id != 0 {
			t.Errorf("%q = %d, %v, %v; want 0, false, nil", name, id, found, err)
		}
	}
}

func TestIntegrationReactions(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "ImageReaction" WHERE id BETWEEN 1111000 AND 1111999;
		INSERT INTO "ImageReaction" (id, "imageId", "userId", reaction) VALUES
		  (1111101, 1111001, 1111901, 'Like'), (1111102, 1111001, 1111901, 'Heart'),
		  (1111103, 1111001, 1111902, 'Cry'), (1111104, 1111002, 1111901, 'Laugh'),
		  (1111105, 1111003, 1111902, 'Like');`)
	ctx := integtest.Ctx(t)

	got, err := e.src.Reactions(ctx, []int{1111001, 1111002, 1111003}, 1111901)
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1111001, 1111002}) {
		t.Fatalf("ids = %v, want [1111001 1111002] (only the viewer's reactions)", ids)
	}
	first := make([]string, 0, len(got[1111001]))
	for _, r := range got[1111001] {
		first = append(first, integPlain(t, r))
	}
	sort.Strings(first) // the query has no ORDER BY
	if want := []string{`{"userId":1111901,"reaction":"Heart"}`, `{"userId":1111901,"reaction":"Like"}`}; !reflect.DeepEqual(first, want) {
		t.Fatalf("1111001 reactions = %v, want %v", first, want)
	}
	if s := integPlain(t, got[1111002]); s != `[{"userId":1111901,"reaction":"Laugh"}]` {
		t.Fatalf("1111002 reactions = %s", s)
	}
	if got, err := e.src.Reactions(ctx, []int{1111001}, 0); err != nil || len(got) != 0 {
		t.Fatalf("signed out = %v, %v; want empty", got, err)
	}
}

func TestIntegrationVisibleModel3DIDs(t *testing.T) {
	e := integSetup(t, true)
	integtest.Exec(t, e.pool, `DELETE FROM "Model3D" WHERE id BETWEEN 1112000 AND 1112999;
		INSERT INTO "Model3D" (id, "userId", status, "deletedAt") VALUES
		  (1112001, 1112902, 'Published', NULL),
		  (1112002, 1112901, 'Draft', NULL),
		  (1112003, 1112902, 'Draft', NULL),
		  (1112004, 1112902, 'Published', '2024-01-01 00:00:00');`)
	ctx := integtest.Ctx(t)
	ids := []int{1112001, 1112002, 1112003, 1112004, 1112005}
	cases := []struct {
		viewer int
		mod    bool
		want   map[int]bool
	}{
		{0, false, map[int]bool{1112001: true}},
		{1112901, false, map[int]bool{1112001: true, 1112002: true}},
		{1112903, true, map[int]bool{1112001: true, 1112002: true, 1112003: true, 1112004: true}},
	}
	for _, c := range cases {
		got, err := e.src.VisibleModel3DIDs(ctx, ids, c.viewer, c.mod)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("viewer %d mod %v = %v, want %v", c.viewer, c.mod, got, c.want)
		}
	}
}

func integKeys[V any](m map[int]V) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}
