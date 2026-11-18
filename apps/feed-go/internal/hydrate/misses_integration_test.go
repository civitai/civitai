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
	e := integTagIDsSetup(t)
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

// A stale tag-ids entry (cachedAt past the 8h ttl, as a bust leaves it) on the real cluster: looked up
// again under the revalidation lock, its value replaced (a plain SET over the existing key), the lock
// released.
func TestIntegrationStaleTagIDsReplaced(t *testing.T) {
	e := integTagIDsSetup(t)
	e.put(t, KeyTagIDs, 1150401, integtest.O("imageId", 1150401, "tags", []any{1}, "cachedAt", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	ctx := integtest.Ctx(t)
	got, err := e.src.TagIDs(ctx, []int{1150401})
	if err != nil {
		t.Fatal(err)
	}
	if s := integPlain(t, got[1150401]); s != `[1150301,1150303,1150304]` {
		t.Fatalf("tags = %s, want the looked-up [1150301,1150303,1150304]", s)
	}
	integWantPacked(t, e, KeyTagIDs, 1150401, integWantTags, 9*time.Hour)
	if n := e.c.Exists(ctx, e.src.tagIDsLockKey(1150401)).Val(); n != 0 {
		t.Fatal("the revalidation lock was left behind")
	}
}

// integTagIDsSetup is integMissSetup with the tag rows of TestIntegrationTagIDsMissComputed and a
// gate holding 1150304.
func integTagIDsSetup(t *testing.T) *integEnv {
	t.Helper()
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
	return e
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

const (
	// {modelVersionId:1150711, images:[
	//   {id:1150731, userId:1150801, name:'integ-a', url:'integ-url-a', nsfwLevel:1, width:8, height:9, hash:'integ-hash',
	//    type:'image', metadata:JSON.parse('{"width": 8, "height": 9}'), minor:false, poi:false, modelVersionId:1150711,
	//    availability:'Public', hasMeta:true, hasPositivePrompt:true, onSite:true, remixOfId:null},
	//   {id:1150738, userId:1150801, name:null, url:'integ-url-b', nsfwLevel:2, width:null, height:null, hash:null,
	//    type:'video', metadata:JSON.parse('{}'), minor:false, poi:true, modelVersionId:1150711, availability:'Public',
	//    hasMeta:false, hasPositivePrompt:false, onSite:false, remixOfId:77}], cachedAt}
	integWantVersionImages = "de0003ae6d6f64656c56657273696f6e4964ce00118ef7a6696d6167657392de0012a26964ce00118f0ba6757365724964ce00118f51a46e616d65a7696e7465672d61a375726cab696e7465672d75726c2d61a96e7366774c6576656c01a5776964746808a668656967687409a468617368aa696e7465672d68617368a474797065a5696d616765a86d65746164617461de0002a5776964746808a668656967687409a56d696e6f72c2a3706f69c2ae6d6f64656c56657273696f6e4964ce00118ef7ac617661696c6162696c697479a65075626c6963a76861734d657461c3b1686173506f73697469766550726f6d7074c3a66f6e53697465c3a972656d69784f664964c0de0012a26964ce00118f12a6757365724964ce00118f51a46e616d65c0a375726cab696e7465672d75726c2d62a96e7366774c6576656c02a57769647468c0a6686569676874c0a468617368c0a474797065a5766964656fa86d65746164617461de0000a56d696e6f72c2a3706f69c3ae6d6f64656c56657273696f6e4964ce00118ef7ac617661696c6162696c697479a65075626c6963a76861734d657461c2b1686173506f73697469766550726f6d7074c2a66f6e53697465c2a972656d69784f6649644da86361636865644174d6ff6a2fe940"
	// {modelVersionId:1150712, notFound:true, cachedAt}
	integWantVersionImagesMarker = "de0003ae6d6f64656c56657273696f6e4964ce00118ef8a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

// The showcase lookup against the real schema: of model 1150701's version 1150711, only the owner's
// published post's images that are rated, reviewed (scanned, or a mod-locked level over a scan error
// that was not permanent), not blocked, not a ToS violation, not awaiting review, and not an R+ image
// on a license-restricted model, in (post, index, id) order; the computed columns (hasMeta under
// hideMeta, hasPositivePrompt, onSite, remixOfId) as Postgres computes them. 1150712 has no image:
// a minute's marker. Written as Node writes them (2 d). An acceptableMinor image is excluded, and so
// is a mod-locked image whose scan errored permanently (imageReviewedSql: an Error row with a
// permanent failure in scanJobs is not reviewed, where 1150738's plain Error row is). On the
// system-owned model 1150702 (userId -1) every published post's images are included: the system
// user's own post and another user's. Version 1150714's ids run against its (post, index) order:
// 1150750 then 1150748 by index in post 1150726, then 1150747 in the later post 1150727, an order
// that id alone, (index, id), or (post, id) would each change.
func TestIntegrationVersionImagesMissComputed(t *testing.T) {
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1150700 AND 1150799;
		DELETE FROM "Post" WHERE id BETWEEN 1150700 AND 1150799;
		DELETE FROM "ModelVersion" WHERE id BETWEEN 1150700 AND 1150799;
		DELETE FROM "Model" WHERE id BETWEEN 1150700 AND 1150799;
		INSERT INTO "Model" (id, "userId") VALUES (1150701, 1150801), (1150702, -1);
		INSERT INTO "ModelVersion" (id, "modelId") VALUES (1150711, 1150701), (1150712, 1150701), (1150713, 1150702),
		  (1150714, 1150701);
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
		  (1150721, 1150801, 1150711, now()),
		  (1150722, 1150802, 1150711, now()),
		  (1150723, 1150801, 1150711, NULL),
		  (1150724, -1, 1150713, now()),
		  (1150725, 1150802, 1150713, now()),
		  (1150726, 1150801, 1150714, now()),
		  (1150727, 1150801, 1150714, now());
		INSERT INTO "Image" (id, name, url, "userId", "postId", index, hash, width, height, type, metadata, meta, "hideMeta",
		  "nsfwLevel", "nsfwLevelLocked", ingestion, "blockedFor", "tosViolation", "needsReview", "modelRestricted", poi) VALUES
		  (1150731, 'integ-a', 'integ-url-a', 1150801, 1150721, 1, 'integ-hash', 8, 9, 'image', '{"height": 9, "width": 8}',
		   '{"prompt": "p", "civitaiResources": []}', false, 1, false, 'Scanned', NULL, false, NULL, false, false),
		  (1150732, 'restricted', 'u', 1150801, 1150721, 0, NULL, NULL, NULL, 'image', '{}', NULL, false, 4, false, 'Scanned', NULL, false, NULL, true, false),
		  (1150733, 'unscanned', 'u', 1150801, 1150721, 2, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Pending', NULL, false, NULL, false, false),
		  (1150734, 'unrated', 'u', 1150801, 1150721, 3, NULL, NULL, NULL, 'image', '{}', NULL, false, 0, false, 'Scanned', NULL, false, NULL, false, false),
		  (1150735, 'blocked', 'u', 1150801, 1150721, 4, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Scanned', 'tos', false, NULL, false, false),
		  (1150736, 'tos', 'u', 1150801, 1150721, 5, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Scanned', NULL, true, NULL, false, false),
		  (1150737, 'review', 'u', 1150801, 1150721, 6, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Scanned', NULL, false, 'minor', false, false),
		  (1150738, NULL, 'integ-url-b', 1150801, 1150721, 7, NULL, NULL, NULL, 'video', '{}',
		   '{"prompt": "hidden", "extra": {"remixOfId": 77}}', true, 2, true, 'Error', NULL, false, NULL, false, true),
		  (1150739, 'not-the-owner', 'u', 1150802, 1150722, 0, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Scanned', NULL, false, NULL, false, false),
		  (1150740, 'unpublished', 'u', 1150801, 1150723, 0, NULL, NULL, NULL, 'image', '{}', NULL, false, 1, false, 'Scanned', NULL, false, NULL, false, false);
		INSERT INTO "Image" (id, name, url, "userId", "postId", index, type, metadata, "nsfwLevel", "nsfwLevelLocked", ingestion,
		  "scanJobs", "acceptableMinor") VALUES
		  (1150741, 'acceptable-minor', 'u', 1150801, 1150721, 8, 'image', '{}', 1, false, 'Scanned', NULL, true),
		  (1150742, 'permanent-failure', 'u', 1150801, 1150721, 9, 'image', '{}', 1, true, 'Error',
		   '{"lastFailure": {"failureClass": "permanent"}}', false),
		  (1150745, 'system-post', 'u', -1, 1150724, 0, 'image', '{}', 1, false, 'Scanned', NULL, false),
		  (1150746, 'system-model-other-post', 'u', 1150802, 1150725, 0, 'image', '{}', 1, false, 'Scanned', NULL, false),
		  (1150750, 'order-post1-index0', 'u', 1150801, 1150726, 0, 'image', '{}', 1, false, 'Scanned', NULL, false),
		  (1150748, 'order-post1-index1', 'u', 1150801, 1150726, 1, 'image', '{}', 1, false, 'Scanned', NULL, false),
		  (1150747, 'order-post2-index0', 'u', 1150801, 1150727, 0, 'image', '{}', 1, false, 'Scanned', NULL, false);`)
	ctx := integtest.Ctx(t)
	ids := []int{1150711, 1150712, 1150713, 1150714}
	t.Cleanup(func() {
		_ = e.c.Del(integtest.Ctx(t), e.prefix+KeyVersionImages+":1150713", e.prefix+KeyVersionImages+":1150714").Err()
	})
	got, writable := e.src.read(ctx, KeyVersionImages, ids, versionImagesTTL)
	if err := e.src.fillVersionImages(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	if d := got[1150711]; d.NotFound {
		t.Fatalf("1150711 = %+v, want its showcase", d)
	}
	if d, ok := got[1150712]; !ok || !d.NotFound {
		t.Fatalf("1150712 = %+v, want a notFound entry", d)
	}
	// The image ids first, so a wrongly admitted row is named (the bytes below pin the rest).
	for v, want := range map[int][]int{1150711: {1150731, 1150738}, 1150713: {1150745, 1150746}, 1150714: {1150750, 1150748, 1150747}} {
		var ids []int
		for _, img := range asList(got[v].Value["images"]) {
			m, _ := img.(map[string]any)
			id, _ := Int(m["id"])
			ids = append(ids, id)
		}
		if !reflect.DeepEqual(ids, want) {
			t.Fatalf("version %d showcase ids %v, want %v", v, ids, want)
		}
	}
	integWantPacked(t, e, KeyVersionImages, 1150711, integWantVersionImages, 48*time.Hour)
	integWantPacked(t, e, KeyVersionImages, 1150712, integWantVersionImagesMarker, time.Minute)
}

const (
	// {id:1150107, name:'integ-hat', type:'ContentDecoration', source:'Event', data:JSON.parse('{"url":
	//  "integ-hat-url", "event": "integ-ev"}'), equippedToId:1150601, equippedToType:'Model', userId:1150005, cachedAt}
	integWantModelEvent = "de0009a26964ce00118c9ba46e616d65a9696e7465672d686174a474797065b1436f6e74656e744465636f726174696f6ea6736f75726365a54576656e74a464617461de0002a375726cad696e7465672d6861742d75726ca56576656e74a8696e7465672d6576ac6571756970706564546f4964ce00118e89ae6571756970706564546f54797065a54d6f64656ca6757365724964ce00118c35a86361636865644174d6ff6a2fe940"
	// {equippedToId:1150602, notFound:true, cachedAt}
	integWantModelEventMarker = "de0003ac6571756970706564546f4964ce00118e8aa86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

// The model decoration lookup against the real schema: only rows placed on a Model (1150602 wears the
// same hat on an Image), written as Node writes them (a day; the marker an hour).
func TestIntegrationModelDecorationMissComputed(t *testing.T) {
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "equippedAt", data, "equippedToId", "equippedToType") VALUES
		  (1150005, 1150107, now(), NULL, 1150601, 'Model'),
		  (1150006, 1150107, now(), NULL, 1150602, 'Image');`)
	ctx := integtest.Ctx(t)
	ids := []int{1150601, 1150602}
	got, writable := e.src.read(ctx, KeyModelEvents, ids, 0)
	if err := e.src.fillModelEvents(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	if d := got[1150601]; d.NotFound || d.Value["equippedToType"] != "Model" {
		t.Fatalf("1150601 = %+v, want its Model decoration", d)
	}
	if d, ok := got[1150602]; !ok || !d.NotFound {
		t.Fatalf("1150602 = %+v, want a notFound entry (its hat is on an Image)", d)
	}
	integWantPacked(t, e, KeyModelEvents, 1150601, integWantModelEvent, 24*time.Hour)
	integWantPacked(t, e, KeyModelEvents, 1150602, integWantModelEventMarker, time.Hour)
}
