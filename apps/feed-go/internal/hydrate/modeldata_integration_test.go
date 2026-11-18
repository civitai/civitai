//go:build integration

package hydrate

// The model-data, model-tags and official-models computations against the real Postgres (their SQL:
// the version columns as Postgres hands them over, the VAE subquery, the coverage join, the hash and
// official filters) and the real Redis Cluster (the writes). Ids live in 1_152_000..1_152_999. Every
// expected cache value is msgpackr 1.11.5's bytes for the value Node's fetch writes
// (`require('msgpackr').pack(v).toString('hex')`, cachedAt = 2026-06-15T12:00:00.000Z).

import (
	"encoding/hex"
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

const (
	// {modelId:1152001, hashes:['H1','H2'], tags:[], versions:[
	//   {id:1152010, index:0, name:'a', earlyAccessTimeFrame:3, baseModel:'SDXL 1.0', baseModelType:'Standard',
	//    createdAt:new Date('2026-01-02T03:04:05.000Z'), trainingStatus:'Approved', publishedAt:null, status:'Draft',
	//    flags:0, availability:'Private', nsfwLevel:4, description:null, trainedWords:[], vaeId:null, covered:false,
	//    coveredNext:false},
	//   {id:1152011, index:1, name:'b', earlyAccessTimeFrame:0, baseModel:'Pony', baseModelType:'Standard',
	//    createdAt:new Date('2026-01-02T03:04:05.000Z'), trainingStatus:null,
	//    publishedAt:new Date('2026-01-03T00:00:00.250Z'), status:'Published', flags:2, availability:'Public',
	//    nsfwLevel:1, description:'d', trainedWords:['w1','w2'], vaeId:1152099, covered:true, coveredNext:false}],
	//  cachedAt}
	integWantModelData = "de0005a76d6f64656c4964ce00119401a668617368657392a24831a24832a47461677390a876657273696f6e7392de0012a26964ce0011940aa5696e64657800a46e616d65a161b46561726c7941636365737354696d654672616d6503a9626173654d6f64656ca85344584c20312e30ad626173654d6f64656c54797065a85374616e64617264a9637265617465644174d6ff695735a5ae747261696e696e67537461747573a8417070726f766564ab7075626c69736865644174c0a6737461747573a54472616674a5666c61677300ac617661696c6162696c697479a750726976617465a96e7366774c6576656c04ab6465736372697074696f6ec0ac747261696e6564576f72647390a57661654964c0a7636f7665726564c2ab636f76657265644e657874c2de0012a26964ce0011940ba5696e64657801a46e616d65a162b46561726c7941636365737354696d654672616d6500a9626173654d6f64656ca4506f6e79ad626173654d6f64656c54797065a85374616e64617264a9637265617465644174d6ff695735a5ae747261696e696e67537461747573c0ab7075626c69736865644174d7ff3b9aca0069585c00a6737461747573a95075626c6973686564a5666c61677302ac617661696c6162696c697479a65075626c6963a96e7366774c6576656c01ab6465736372697074696f6ea164ac747261696e6564576f72647392a27731a27732a57661654964ce00119463a7636f7665726564c3ab636f76657265644e657874c2a86361636865644174d6ff6a2fe940"
	// {modelId:1152001, tagIds:[1152701, 1152702], cachedAt}
	integWantModelTags = "de0003a76d6f64656c4964ce00119401a674616749647392ce001196bdce001196bea86361636865644174d6ff6a2fe940"
	// {modelId:1152002, notFound:true, cachedAt}
	integWantModelTagsMarker = "de0003a76d6f64656c4964ce00119402a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {data:[{id:1152801, type:'Checkpoint'}], cachedAt: Date.now()}
	integWantOfficial = "de0002a46461746191de0002a26964ce00119721a474797065aa436865636b706f696e74a86361636865644174cb4279ecb272200000"
)

// integModelDataSetup seeds model 1152001 (two versions out of index order, one with a linked VAE
// whose file exists and coverage, the other with a VAE link to a missing file; four hashes, two of
// them SHA256 model files; two tags) and model 1152002 (a hash, no version, no tag).
func integModelDataSetup(t *testing.T) *integEnv {
	t.Helper()
	e := integMissSetup(t)
	integtest.Exec(t, e.pool, `DELETE FROM "ModelVersion" WHERE id BETWEEN 1152000 AND 1152999;
		DELETE FROM "ModelHash" WHERE "modelId" BETWEEN 1152000 AND 1152999;
		DELETE FROM "GenerationCoverage" WHERE "modelVersionId" BETWEEN 1152000 AND 1152999;
		DELETE FROM "RecommendedResource" WHERE "sourceId" BETWEEN 1152000 AND 1152999;
		DELETE FROM "ModelFile" WHERE id BETWEEN 1152000 AND 1152999;
		DELETE FROM "TagsOnModels" WHERE "modelId" BETWEEN 1152000 AND 1152999;
		DELETE FROM "Model" WHERE id BETWEEN 1152000 AND 1152999;
		INSERT INTO "ModelVersion" (id, "modelId", index, name, "earlyAccessTimeFrame", "baseModel", "baseModelType", "createdAt",
		  "trainingStatus", "publishedAt", status, flags, availability, "nsfwLevel", description, "trainedWords") VALUES
		  (1152011, 1152001, 1, 'b', 0, 'Pony', 'Standard', '2026-01-02 03:04:05', NULL, '2026-01-03 00:00:00.25', 'Published',
		   2, 'Public', 1, 'd', '{w1,w2}'),
		  (1152010, 1152001, 0, 'a', 3, 'SDXL 1.0', 'Standard', '2026-01-02 03:04:05', 'Approved', NULL, 'Draft',
		   0, 'Private', 4, NULL, '{}');
		INSERT INTO "GenerationCoverage" ("modelId", "modelVersionId", covered, "coveredNext") VALUES (1152001, 1152011, true, false);
		INSERT INTO "ModelFile" (id, type, "modelVersionId") VALUES (1152501, 'Model', 1152098);
		INSERT INTO "RecommendedResource" ("resourceId", "sourceId", settings) VALUES
		  (1152099, 1152011, '{"isLinkedComponent": true, "componentType": "VAE", "fileId": 1152501}'),
		  (1152097, 1152010, '{"isLinkedComponent": true, "componentType": "VAE", "fileId": 1152599}');
		INSERT INTO "ModelHash" ("modelId", "modelVersionId", "hashType", "fileType", hash) VALUES
		  (1152001, 1152011, 'SHA256', 'Model', 'H1'),
		  (1152001, 1152011, 'SHA256', 'Pruned Model', 'H2'),
		  (1152001, 1152011, 'AutoV2', 'Model', 'NOT-SHA'),
		  (1152001, 1152011, 'SHA256', 'Training Data', 'NOT-A-MODEL'),
		  (1152002, 1152012, 'SHA256', 'Model', 'NO-VERSION');
		INSERT INTO "TagsOnModels" ("modelId", "tagId") VALUES (1152001, 1152701), (1152001, 1152702);`)
	return e
}

// The model-data lookup against the real schema, written as Node writes it (a day); a model with no
// version has no record and nothing written.
func TestIntegrationModelDataMissComputed(t *testing.T) {
	e := integModelDataSetup(t)
	ctx := integtest.Ctx(t)
	ids := []int{1152001, 1152002}
	got, writable := e.src.read(ctx, KeyDataForModel, ids, 0)
	if err := e.src.fillModelData(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	if d, ok := got[1152002]; !ok || !d.NotFound {
		t.Fatalf("1152002 = %+v, want no record", d)
	}
	integWantPacked(t, e, KeyDataForModel, 1152001, integWantModelData, 24*time.Hour)
	if n, err := e.c.Exists(ctx, e.prefix+KeyDataForModel+":1152002").Result(); err != nil || n != 0 {
		t.Fatalf("1152002 written (%d, %v): cacheNotFound is off", n, err)
	}
}

// The model-tags lookup against the real schema, written as Node writes it; a model with no tag gets a
// day's notFound marker.
func TestIntegrationModelTagsMissComputed(t *testing.T) {
	e := integModelDataSetup(t)
	ctx := integtest.Ctx(t)
	ids := []int{1152001, 1152002}
	got, writable := e.src.read(ctx, KeyModelTags, ids, 0)
	if err := e.src.fillModelTags(ctx, ids, got, writable); err != nil {
		t.Fatal(err)
	}
	list := asList(got[1152001].Value["tagIds"])
	tagIDs := make([]int, 0, len(list))
	for _, v := range list {
		n, _ := Int(v)
		tagIDs = append(tagIDs, n)
	}
	if !reflect.DeepEqual(tagIDs, []int{1152701, 1152702}) {
		t.Fatalf("1152001 tag ids %v", tagIDs)
	}
	integWantPacked(t, e, KeyModelTags, 1152001, integWantModelTags, 24*time.Hour)
	integWantPacked(t, e, KeyModelTags, 1152002, integWantModelTagsMarker, 24*time.Hour)
}

// getOfficialModelIds' fetchFn against the real schema: official and published only, written under
// its lock as fetchThroughCache writes it (EX 600), the lock released.
func TestIntegrationOfficialModelsComputed(t *testing.T) {
	e := integModelDataSetup(t)
	integtest.Exec(t, e.pool, `INSERT INTO "Model" (id, "userId", type, status, "isOfficial") VALUES
		  (1152801, 1152901, 'Checkpoint', 'Published', true),
		  (1152802, 1152901, 'Checkpoint', 'Draft', true),
		  (1152803, 1152901, 'LORA', 'Published', false);`)
	ctx := integtest.Ctx(t)
	key := e.prefix + KeyOfficialModels
	lock := e.prefix + "cache-lock:" + key
	t.Cleanup(func() { _ = e.c.Del(integtest.Ctx(t), key, lock).Err() })
	got, err := e.src.OfficialModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if want := []OfficialModel{{ID: 1152801, Type: "Checkpoint"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("official %v, want %v", got, want)
	}
	b, err := e.c.Get(ctx, key).Bytes()
	if err != nil {
		t.Fatalf("not written: %v", err)
	}
	if h := hex.EncodeToString(b); h != integWantOfficial {
		t.Fatalf("written\n got %s\nwant %s (Node's bytes)", h, integWantOfficial)
	}
	if ttl := e.c.TTL(ctx, key).Val(); ttl <= 9*time.Minute || ttl > 10*time.Minute {
		t.Fatalf("TTL %v, want 10m", ttl)
	}
	if n, _ := e.c.Exists(ctx, lock).Result(); n != 0 {
		t.Fatal("the lock was left behind")
	}
}
