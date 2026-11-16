//go:build integration

package hydrate

// The miss computations against the real Postgres (their SQL, jsonb text order, the withheld check)
// and the real Redis Cluster (SET NX writes). Ids live in 1_150_000..
// 1_150_999. Every expected cache value is msgpackr 1.11.5's bytes for the value Node's fetch writes
// (node: `require('msgpackr').pack(v).toString('hex')`, cachedAt = 2026-06-15T12:00:00.000Z).

import (
	"context"
	"encoding/hex"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

var integMissNow = time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

const (
	// {userId:1150001, cosmetics:[{cosmeticId:1150101, data:JSON.parse('{"b": 2, "lights": 1}')}], cachedAt}
	integWantUC = "de0003a6757365724964ce00118c31a9636f736d657469637391de0002aa636f736d657469634964ce00118c95a464617461de0002a16202a66c696768747301a86361636865644174d6ff6a2fe940"
	// {userId:1150002, notFound:true, cachedAt}
	integWantUCMarker = "de0003a6757365724964ce00118c32a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {cosmeticId:1150106, equippedToId:1150201, userData:JSON.parse('{"a": 1, "lights": 3}'), cachedAt}
	integWantFrame = "de0004aa636f736d657469634964ce00118c9aac6571756970706564546f4964ce00118cf9a87573657244617461de0002a16101a66c696768747303a86361636865644174d6ff6a2fe940"
	// {id:1150107, name:'integ-hat', type:'ContentDecoration', source:'Event', data:JSON.parse('{"url":
	//  "integ-hat-url", "event": "integ-ev"}'), equippedToId:1150202, equippedToType:'Image', userId:1150001, cachedAt}
	integWantEvent = "de0009a26964ce00118c9ba46e616d65a9696e7465672d686174a474797065b1436f6e74656e744465636f726174696f6ea6736f75726365a54576656e74a464617461de0002a375726cad696e7465672d6861742d75726ca56576656e74a8696e7465672d6576ac6571756970706564546f4964ce00118cfaae6571756970706564546f54797065a5496d616765a6757365724964ce00118c31a86361636865644174d6ff6a2fe940"
	// {equippedToId:1150203, notFound:true, cachedAt}
	integWantEventMarker = "de0003ac6571756970706564546f4964ce00118cfba86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

func integMissSetup(t *testing.T) *integEnv {
	t.Helper()
	e := integSetup(t, true)
	e.src.Compute = &MissCompute{WriteBack: true, FrameNegative: true, Primary: e.pool, Now: func() time.Time { return integMissNow }}
	// The jsonb literals are written in a member order Postgres does not keep: the lookups must see
	// the order Postgres prints (key length, then bytes), as Prisma hands it to Node.
	integtest.Exec(t, e.pool, `DELETE FROM "Cosmetic" WHERE id BETWEEN 1150000 AND 1150999;
		DELETE FROM "UserCosmetic" WHERE "userId" BETWEEN 1150000 AND 1150999;
		DELETE FROM "CosmeticShopItem" WHERE "cosmeticId" BETWEEN 1150000 AND 1150999;
		INSERT INTO "Cosmetic" (id, name, type, source, data, flags, "createdById") VALUES
		  (1150101, 'integ-badge', 'Badge', 'Trophy', '{"url": "integ-badge-url"}', 0, NULL),
		  (1150102, 'integ-pending', 'Badge', 'Purchase', '{"url": "p"}', 0, 1150900),
		  (1150103, 'integ-removed', 'Badge', 'Purchase', '{"url": "r"}', 4, 1150900),
		  (1150104, 'integ-owned', 'Badge', 'Purchase', '{"url": "o"}', 0, NULL),
		  (1150106, 'integ-frame', 'ContentDecoration', 'Purchase', '{"url": "integ-frame-url"}', 0, NULL),
		  (1150107, 'integ-hat', 'ContentDecoration', 'Event', '{"event": "integ-ev", "url": "integ-hat-url"}', 0, NULL);
		INSERT INTO "CosmeticShopItem" ("cosmeticId", "addedById", status, meta, "rejectionReason") VALUES
		  (1150102, 1150900, 'PendingReview', '{}', NULL),
		  (1150101, 1150901, 'Rejected', '{"takedown": true}', 'not the creator');
		INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "equippedAt", data, "equippedToId", "equippedToType") VALUES
		  (1150001, 1150101, now(), '{"lights": 1, "b": 2}', NULL, NULL),
		  (1150001, 1150102, now(), NULL, NULL, NULL),
		  (1150001, 1150103, now(), NULL, NULL, NULL),
		  (1150001, 1150104, NULL, NULL, NULL, NULL),
		  (1150003, 1150106, now(), '{"lights": 3, "a": 1}', 1150201, 'Image'),
		  (1150004, 1150106, now(), NULL, 1150201, 'Post'),
		  (1150001, 1150107, now(), NULL, 1150202, 'Image');`)
	return e
}

func integWantPacked(t *testing.T, e *integEnv, key string, id int, wantHex string, ttl time.Duration) {
	t.Helper()
	full := e.prefix + key + ":" + strconv.Itoa(id)
	t.Cleanup(func() { _ = e.c.Del(integtest.Ctx(t), full).Err() })
	b, err := e.c.Get(integtest.Ctx(t), full).Bytes()
	if err != nil {
		t.Fatalf("%s: %v", full, err)
	}
	if got := hex.EncodeToString(b); got != wantHex {
		t.Fatalf("%s\n got %s\nwant %s (Node's bytes)", full, got, wantHex)
	}
	if got := e.c.TTL(integtest.Ctx(t), full).Val(); got <= ttl-time.Minute || got > ttl {
		t.Fatalf("%s TTL %v, want %v", full, got, ttl)
	}
}

func TestIntegrationUserCosmeticsMissComputed(t *testing.T) {
	e := integMissSetup(t)
	got, err := e.src.UserCosmetics(integtest.Ctx(t), []int{1150001, 1150002})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1150001}) {
		t.Fatalf("user ids %v, want [1150001]", ids)
	}
	// 1150102 withheld (its creator's listing is pending), 1150103 tombstoned, 1150104 not equipped.
	if s, want := integPlain(t, got[1150001]), `[{"cosmeticId":1150101,"data":{"b":2,"lights":1},"cosmetic":{"id":1150101,"name":"integ-badge","type":"Badge","data":{"url":"integ-badge-url"},"source":"Trophy","flags":0}}]`; s != want {
		t.Fatalf("user cosmetics:\n got %s\nwant %s", s, want)
	}
	integWantPacked(t, e, KeyUserCosmetics, 1150001, integWantUC, 24*time.Hour)
	integWantPacked(t, e, KeyUserCosmetics, 1150002, integWantUCMarker, 24*time.Hour)
}

func TestIntegrationFrameMissComputed(t *testing.T) {
	e := integMissSetup(t)
	got, err := e.src.ImageFrames(integtest.Ctx(t), []int{1150201, 1150202})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1150201}) {
		t.Fatalf("frames %v, want [1150201] (1150202 wears an event cosmetic, not a frame)", ids)
	}
	if s, want := integPlain(t, got[1150201]), `{"equippedToId":1150201,"id":1150106,"data":{"url":"integ-frame-url","lights":3}}`; s != want {
		t.Fatalf("frame:\n got %s\nwant %s", s, want)
	}
	integWantPacked(t, e, KeyImageFrames, 1150201, integWantFrame, 24*time.Hour)
	b, err := e.c.Get(integtest.Ctx(t), e.prefix+KeyImageFrames+":1150202").Bytes()
	if err != nil {
		t.Fatalf("no frame marker for 1150202: %v", err)
	}
	t.Cleanup(func() { _ = e.c.Del(integtest.Ctx(t), e.prefix+KeyImageFrames+":1150202").Err() })
	if v, _ := Unpack(b); !truthy(v.(map[string]any)["notFound"]) {
		t.Fatalf("1150202 = %#v, want a notFound marker", v)
	}
}

func TestIntegrationEventDecorationMissComputed(t *testing.T) {
	e := integMissSetup(t)
	got, err := e.src.EventDecorations(integtest.Ctx(t), []int{1150202, 1150203}, map[string]bool{"integ-ev": true})
	if err != nil {
		t.Fatal(err)
	}
	if s, want := integPlain(t, got[1150202]), `{"id":1150107,"name":"integ-hat","type":"ContentDecoration","source":"Event","data":{"event":"integ-ev","url":"integ-hat-url"},"equippedToId":1150202,"equippedToType":"Image"}`; s != want {
		t.Fatalf("decoration:\n got %s\nwant %s", s, want)
	}
	integWantPacked(t, e, KeyImageEvents, 1150202, integWantEvent, 24*time.Hour)
	integWantPacked(t, e, KeyImageEvents, 1150203, integWantEventMarker, time.Hour)
}

const (
	// {imageId:1150401, tags:[1150301,1150303,1150304], cachedAt}
	integWantTags = "de0003a7696d6167654964ce00118dc1a47461677393ce00118d5dce00118d5fce00118d60a86361636865644174d6ff6a2fe940"
	// {imageId:1150402, notFound:true, cachedAt}
	integWantTagsMarker = "de0003a7696d6167654964ce00118dc2a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {cosmeticId:1150106, equippedToId:1150501, userData:JSON.parse('{"a": 2, "lights": 4}'), cachedAt}
	integWantModelFrame = "de0004aa636f736d657469634964ce00118c9aac6571756970706564546f4964ce00118e25a87573657244617461de0002a16102a66c696768747304a86361636865644174d6ff6a2fe940"
)

// The tag-ids lookup against the real schema: its SQL (the enum and citext columns as text, the
// disabled filter), Node's Rekognition rule, and the written value and expiry (9h). Image 1150401 is
// WD14-tagged: its Rekognition Label 1150302 is dropped, its Rekognition Moderation tag 1150303 and
// gated label 1150304 kept; 1150305 is disabled and 1150399 has no Tag row. 1150402 has no row.
func TestIntegrationTagIDsMissComputed(t *testing.T) {
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `DELETE FROM "TagsOnImageDetails" WHERE "imageId" BETWEEN 1150400 AND 1150499;
		DELETE FROM "Tag" WHERE id BETWEEN 1150300 AND 1150399;
		INSERT INTO "Tag" (id, name, type) VALUES
		  (1150301, 'integ-miss-wd', 'Label'),
		  (1150302, 'integ-miss-label', 'Label'),
		  (1150303, 'integ-miss-mod', 'Moderation'),
		  (1150304, 'integ-miss-gated', 'Label');
		INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", disabled, source) VALUES
		  (1150401, 1150301, false, 'WD14'),
		  (1150401, 1150302, false, 'Rekognition'),
		  (1150401, 1150303, false, 'Rekognition'),
		  (1150401, 1150304, false, 'Rekognition'),
		  (1150401, 1150305, true, 'User'),
		  (1150401, 1150399, false, 'User');`)
	e.src.Compute.TagGate = func(context.Context) (map[int]bool, error) { return map[int]bool{1150304: true}, nil }
	got, err := e.src.TagIDs(integtest.Ctx(t), []int{1150401, 1150402})
	if err != nil {
		t.Fatal(err)
	}
	if ids := integKeys(got); !reflect.DeepEqual(ids, []int{1150401}) {
		t.Fatalf("tag ids for %v, want [1150401]", ids)
	}
	if s := integPlain(t, got[1150401]); s != `[1150301,1150303,1150304]` {
		t.Fatalf("tags = %s, want [1150301,1150303,1150304]", s)
	}
	integWantPacked(t, e, KeyTagIDs, 1150401, integWantTags, 9*time.Hour)
	integWantPacked(t, e, KeyTagIDs, 1150402, integWantTagsMarker, 9*time.Hour)
}

// The model frame lookup against the real schema: only rows placed on a Model (1150502 wears the same
// frame on an Image), written as Node writes them.
func TestIntegrationModelFrameMissComputed(t *testing.T) {
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "equippedAt", data, "equippedToId", "equippedToType") VALUES
		  (1150005, 1150106, now(), '{"lights": 4, "a": 2}', 1150501, 'Model'),
		  (1150006, 1150106, now(), NULL, 1150502, 'Image');`)
	ctx := integtest.Ctx(t)
	ids := []int{1150501, 1150502}
	got, writable := e.src.read(ctx, KeyModelFrames, ids, 0)
	if err := e.src.fillModelFrames(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	if fr := got[1150501]; fr.NotFound || fr.Value["cosmeticId"] == nil {
		t.Fatalf("1150501 = %+v, want its frame row", fr)
	}
	if fr, ok := got[1150502]; !ok || !fr.NotFound {
		t.Fatalf("1150502 = %+v, want a notFound entry (its frame is on an Image)", fr)
	}
	integWantPacked(t, e, KeyModelFrames, 1150501, integWantModelFrame, 24*time.Hour)
	b, err := e.c.Get(ctx, e.prefix+KeyModelFrames+":1150502").Bytes()
	if err != nil {
		t.Fatalf("no frame marker for 1150502: %v", err)
	}
	t.Cleanup(func() { _ = e.c.Del(integtest.Ctx(t), e.prefix+KeyModelFrames+":1150502").Err() })
	if v, _ := Unpack(b); !truthy(v.(map[string]any)["notFound"]) {
		t.Fatalf("1150502 = %#v, want a notFound marker", v)
	}
}
