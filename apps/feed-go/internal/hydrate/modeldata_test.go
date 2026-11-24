package hydrate

import (
	"context"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// msgpackr 1.11.5's bytes (`require('msgpackr').pack(v).toString('hex')`, cachedAt = pageNow) for the
// values dataForModelsCache's and modelTagCache's fetch write on these fixtures' misses.
const (
	// {modelId:5001, hashes:['H1','H2'], tags:[], versions:[
	//   {id:6001, index:0, name:'v1', earlyAccessTimeFrame:0, baseModel:'Pony', baseModelType:'Standard',
	//    createdAt:new Date('2026-01-02T03:04:05.000Z'), trainingStatus:null,
	//    publishedAt:new Date('2026-01-03T00:00:00.250Z'), status:'Published', flags:2, availability:'Public',
	//    nsfwLevel:1, description:'<p>d</p>', trainedWords:['w1','w2'], vaeId:6099, covered:true, coveredNext:false},
	//   {id:6002, index:1, name:'v2', earlyAccessTimeFrame:3, baseModel:'SDXL 1.0', baseModelType:null,
	//    createdAt:new Date('2026-01-02T03:04:05.000Z'), trainingStatus:'Approved', publishedAt:null,
	//    status:'Draft', flags:0, availability:'Private', nsfwLevel:4, description:null, trainedWords:[],
	//    vaeId:null, covered:false, coveredNext:true}], cachedAt}
	wantModelData5001 = "de0005a76d6f64656c4964cd1389a668617368657392a24831a24832a47461677390a876657273696f6e7392de0012a26964cd1771a5696e64657800a46e616d65a27631b46561726c7941636365737354696d654672616d6500a9626173654d6f64656ca4506f6e79ad626173654d6f64656c54797065a85374616e64617264a9637265617465644174d6ff695735a5ae747261696e696e67537461747573c0ab7075626c69736865644174d7ff3b9aca0069585c00a6737461747573a95075626c6973686564a5666c61677302ac617661696c6162696c697479a65075626c6963a96e7366774c6576656c01ab6465736372697074696f6ea83c703e643c2f703eac747261696e6564576f72647392a27731a27732a57661654964cd17d3a7636f7665726564c3ab636f76657265644e657874c2de0012a26964cd1772a5696e64657801a46e616d65a27632b46561726c7941636365737354696d654672616d6503a9626173654d6f64656ca85344584c20312e30ad626173654d6f64656c54797065c0a9637265617465644174d6ff695735a5ae747261696e696e67537461747573a8417070726f766564ab7075626c69736865644174c0a6737461747573a54472616674a5666c61677300ac617661696c6162696c697479a750726976617465a96e7366774c6576656c04ab6465736372697074696f6ec0ac747261696e6564576f72647390a57661654964c0a7636f7665726564c2ab636f76657265644e657874c3a86361636865644174d6ff6a2fe940"
	// {modelId:5001, tagIds:[8, 7], cachedAt}
	wantModelTags5001 = "de0003a76d6f64656c4964cd1389a6746167496473920807a86361636865644174d6ff6a2fe940"
	// {modelId:5002, notFound:true, cachedAt}
	wantModelTags5002Marker = "de0003a76d6f64656c4964cd138aa86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

var (
	modelDataCreated   = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	modelDataPublished = time.Date(2026, 1, 3, 0, 0, 0, 250_000_000, time.UTC)
)

// modelDataColumns is the versions query's select list, in order (pgx's types: int4 as int32, text[]
// as []any).
var modelDataColumns = []string{"id", "index", "modelId", "name", "earlyAccessTimeFrame", "baseModel", "baseModelType",
	"createdAt", "trainingStatus", "publishedAt", "status", "flags", "availability", "nsfwLevel", "description",
	"trainedWords", "vaeId", "covered", "coveredNext"}

// modelDataRows are the versions query's rows by model id (5001's two versions); modelHashRows the
// hashes query's.
var (
	modelDataRows = map[int][][]any{5001: {
		{int32(6001), int32(0), int32(5001), "v1", int32(0), "Pony", "Standard", modelDataCreated, nil, modelDataPublished,
			"Published", int32(2), "Public", int32(1), "<p>d</p>", []any{"w1", "w2"}, int32(6099), true, false},
		{int32(6002), int32(1), int32(5001), "v2", int32(3), "SDXL 1.0", nil, modelDataCreated, "Approved", nil,
			"Draft", int32(0), "Private", int32(4), nil, []any{}, nil, false, true},
	}}
	modelHashRows = map[int][][]any{5001: {{int32(5001), "H1"}, {int32(5001), "H2"}}, 5002: {{int32(5002), "HX"}}}
	modelTagRows  = map[int][][]any{5001: {{int32(5001), int32(8)}, {int32(5001), int32(7)}}}
)

// modelDataRoutes answer the model-data and model-tags lookups from the rows above, recording name+"-data",
// name+"-hashes" and name+"-tags" per query; fail makes the versions query fail.
func (f *modelFixture) modelDataRoutes(name string, fail bool) []testkit.Route {
	return []testkit.Route{
		{Match: `"RecommendedResource"`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record(name + "-data")
			if fail {
				return nil, errMissDB
			}
			out := testkit.NewRows(modelDataColumns)
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, modelDataRows[id]...)
			}
			return out, nil
		}},
		{Match: `FROM "ModelHash"`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record(name + "-hashes")
			out := testkit.NewRows([]string{"modelId", "hash"})
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, modelHashRows[id]...)
			}
			return out, nil
		}},
		{Match: `FROM "TagsOnModels" WHERE "modelId"`, Rows: func(args []any) (*testkit.Rows, error) {
			f.record(name + "-tags")
			out := testkit.NewRows([]string{"modelId", "tagId"})
			for _, id := range args[0].([]int) {
				out.Data = append(out.Data, modelTagRows[id]...)
			}
			return out, nil
		}},
	}
}

// modelDataSources is computedModelSources with the model lookups' routes on the replica (named
// "replica") and, with write-back on, on a separate primary (named "primary").
func modelDataSources(f *modelFixture, c *MissCompute) (*Sources, *testkit.Redis) {
	s, r := computedModelSources(f, c)
	db := s.Replica.(*testkit.DB)
	db.Routes = append(f.modelDataRoutes("replica", false), db.Routes...)
	if c.WriteBack.Any() {
		c.Primary = &testkit.DB{Routes: f.modelDataRoutes("primary", false)}
	}
	return s, r
}

func (f *modelFixture) queriesNamed(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, q := range f.queries {
		if len(q) > len(prefix) && q[:len(prefix)] == prefix {
			out = append(out, q)
		}
	}
	return out
}

// A model-data miss is dataForModelsCache's lookup: the versions in (modelId, index) order with their
// members as the row holds them, the SHA256 hashes, `tags: []` (the appendFn's model-tags cache still
// supplies the tag ids). A model the lookup finds no version for (5002, which has a hash) is left out
// and, the cache's cacheNotFound being off, nothing is written for it. With write-back the value is
// written as Node writes it, for a day.
func TestModelPageComputesModelDataMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := fullModelFixture(t)
			f.del(KeyDataForModel, 5001)
			f.del(KeyDataForModel, 5002)
			obs := &observed{}
			s, r := modelDataSources(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			p, err := s.ModelPage(context.Background(), modelPageRequest())
			if err != nil {
				t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
			}
			if _, ok := p.Data[5002]; ok || len(p.Data) != 1 {
				t.Fatalf("data %v, want 5001 only (5002 has no version)", p.Data)
			}
			md := p.Data[5001]
			if !reflect.DeepEqual(md.Hashes, []any{"H1", "H2"}) || !reflect.DeepEqual(md.TagIDs, []int{7, 8}) || len(md.Versions) != 2 {
				t.Fatalf("5001: %+v", md)
			}
			v := md.Versions[0]
			if id, _ := Int(ObjectField(v, "id")); id != 6001 || ObjectField(v, "baseModel") != "Pony" || ObjectField(v, "status") != "Published" {
				t.Fatalf("first version %v", v)
			}
			if at, _ := ObjectField(v, "publishedAt").(time.Time); !at.Equal(modelDataPublished) {
				t.Fatalf("publishedAt %v, want %v", ObjectField(v, "publishedAt"), modelDataPublished)
			}
			if v2 := md.Versions[1]; ObjectField(v2, "trainingStatus") != "Approved" || ObjectField(v2, "publishedAt") != nil || ObjectField(v2, "description") != nil {
				t.Fatalf("second version %v", v2)
			}
			if o := obs.get(); o["model-data/computed"] != 2 {
				t.Fatalf("observed %v, want 2 computed model-data ids", o)
			}
			want := []string{"replica-data", "replica-hashes"}
			if got := f.queriesNamed("replica-"); !reflect.DeepEqual(got, want) {
				t.Fatalf("replica reads %v, want %v (one batched lookup; the tags were cached)", got, want)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyDataForModel, 5001), pageNS+missKey(KeyDataForModel, 5002))
				return
			}
			wantPacked(t, r, missKey(KeyDataForModel, 5001), wantModelData5001, 24*time.Hour)
			wantAbsent(t, r, pageNS+missKey(KeyDataForModel, 5002))
		})
	}
}

// A model-tags miss is modelTagCache's lookup on the replica: the tag ids in row order (tag 8 a
// basic-tags miss the replica holds, so kept; 7 cached). A model with no row gets a day's notFound
// marker and keeps its data entry's own tags. Only models the data cache answered are looked up.
func TestModelPageComputesModelTagsMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f := fullModelFixture(t)
			f.del(KeyModelTags, 5001)
			f.del(KeyModelTags, 5002)
			f.put(t, KeyDataForModel, 5002, map[string]any{"modelId": 5002, "hashes": []any{}, "tags": []any{map[string]any{"tagId": 42, "name": "x"}},
				"versions": []any{map[string]any{"id": 6003, "baseModel": "Pony"}}})
			obs := &observed{}
			s, r := modelDataSources(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
			p, err := s.ModelPage(context.Background(), modelPageRequest())
			if err != nil {
				t.Fatalf("ModelPage: %v (%q)", err, fallback.Reason(err))
			}
			if got := p.Data[5001].TagIDs; !reflect.DeepEqual(got, []int{8, 7}) {
				t.Fatalf("5001 tags %v, want [8 7] (row order)", got)
			}
			if got := p.Data[5002].TagIDs; !reflect.DeepEqual(got, []int{42}) {
				t.Fatalf("5002 tags %v, want the entry's own [42]", got)
			}
			if o := obs.get(); o["model-tags/computed"] != 2 {
				t.Fatalf("observed %v, want 2 computed model-tags ids", o)
			}
			if got := f.queriesNamed("replica-"); !reflect.DeepEqual(got, []string{"replica-tags"}) {
				t.Fatalf("replica reads %v, want one tag lookup", got)
			}
			if got := f.queriesNamed("primary-"); len(got) != 0 {
				t.Fatalf("primary reads %v: modelTagCache's fetch reads dbRead", got)
			}
			if !writeBack {
				wantAbsent(t, r, pageNS+missKey(KeyModelTags, 5001), pageNS+missKey(KeyModelTags, 5002))
				return
			}
			wantPacked(t, r, missKey(KeyModelTags, 5001), wantModelTags5001, 24*time.Hour)
			wantPacked(t, r, missKey(KeyModelTags, 5002), wantModelTags5002Marker, 24*time.Hour)
		})
	}
}

// A model whose data entry is a notFound marker is never asked of the tag lookup (the appendFn asks
// the tag cache for the records the data cache answered only).
func TestModelTagsLookupOnlyForFoundModels(t *testing.T) {
	f := fullModelFixture(t) // 5002's data is a notFound marker
	f.del(KeyModelTags, 5002)
	s, _ := modelDataSources(f, &MissCompute{FrameNegative: true})
	if _, err := s.ModelPage(context.Background(), modelPageRequest()); err != nil {
		t.Fatal(err)
	}
	if got := f.queriesNamed("replica-"); len(got) != 0 {
		t.Fatalf("lookups %v, want none", got)
	}
}

// With write-back on, a model whose lag flag (`lag-helper:model:<id>`) a recent write set sends the
// lookup (both queries) to the primary, as getDbWithoutLagBatch('model', ids) does; unflagged, the
// replica. With write-back off the replica answers either way.
func TestModelDataLagFlagReadsPrimary(t *testing.T) {
	for _, c := range []struct {
		name      string
		writeBack bool
		flag      *string
		want      []string
	}{
		{"flagged", true, ptr("1"), []string{"primary-data", "primary-hashes"}},
		{"unflagged", true, nil, []string{"replica-data", "replica-hashes"}},
		{"empty flag", true, ptr(""), []string{"replica-data", "replica-hashes"}},
		{"flagged, write-back off", false, ptr("1"), []string{"replica-data", "replica-hashes"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := fullModelFixture(t)
			f.del(KeyDataForModel, 5001)
			s, r := modelDataSources(f, &MissCompute{WriteBack: writeSet(c.writeBack), FrameNegative: true})
			if c.flag != nil {
				r.SetString(pageNS+"lag-helper:model:5001", []byte(*c.flag))
			}
			if _, err := s.ModelPage(context.Background(), modelPageRequest()); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, q := range f.queries {
				if q != "tags" {
					got = append(got, q)
				}
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("queries %v, want %v", got, c.want)
			}
		})
	}
}

// A failed model-data lookup is model-data-miss-failed, nothing written; without a computation the
// miss is model-data-miss (TestModelPageFallbacks).
func TestModelDataLookupFailureFallsBack(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyDataForModel, 5001)
	obs := &observed{}
	s, r := computedModelSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	s.Compute.Primary = &testkit.DB{Routes: f.modelDataRoutes("primary", true)}
	db := s.Replica.(*testkit.DB)
	db.Routes = append(f.modelDataRoutes("replica", true), db.Routes...)
	_, err := s.ModelPage(context.Background(), modelPageRequest())
	if got := fallback.Reason(err); got != "model-data-miss-failed" {
		t.Fatalf("err %v (%q), want model-data-miss-failed", err, got)
	}
	if o := obs.get(); o["model-data/error"] != 1 {
		t.Fatalf("observed %v, want 1 model-data error", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyDataForModel, 5001))
}

// Under a Go-first probe (WithPresence) a model-data or model-tags miss is recorded with its one query
// and looked up (a model with no data is dropped, and its tags decide the excluded-tag drop, so "no
// entry" would change the page): on the replica even with write-back on and a lag flag set, outside
// Observe, and nothing is written.
func TestModelDataUnderPresenceLooksUpOnTheReplica(t *testing.T) {
	f := fullModelFixture(t)
	f.del(KeyDataForModel, 5001)
	f.del(KeyModelTags, 5001)
	obs := &observed{}
	s, r := modelDataSources(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true, Observe: obs.observe})
	r.SetString(pageNS+"lag-helper:model:5001", []byte("1"))
	rec := &PresenceProbe{Now: func() time.Time { return pageNow }}
	p, err := s.ModelPage(WithPresence(context.Background(), rec), modelPageRequest())
	if err != nil {
		t.Fatalf("ModelPage: %v", err)
	}
	if md, ok := p.Data[5001]; !ok || len(md.Versions) != 2 || !reflect.DeepEqual(md.TagIDs, []int{8, 7}) {
		t.Fatalf("5001 = %+v, want the looked-up data and tags", p.Data[5001])
	}
	if got := f.queriesNamed("primary-"); len(got) != 0 {
		t.Fatalf("primary reads %v under the probe", got)
	}
	if got := f.queriesNamed("replica-"); !reflect.DeepEqual(got, []string{"replica-data", "replica-hashes", "replica-tags"}) {
		t.Fatalf("replica reads %v", got)
	}
	if got, want := rec.Misses(), map[string]int{"model-data": 1, "model-tags": 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if got, want := rec.DBReads(), map[string]int{"model-data": 1, "model-tags": 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
	if o := obs.get(); len(o) != 0 {
		t.Fatalf("observed %v under the probe, want nothing", o)
	}
	wantAbsent(t, r, pageNS+missKey(KeyDataForModel, 5001), pageNS+missKey(KeyModelTags, 5001))
}
