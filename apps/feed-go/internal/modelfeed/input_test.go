package modelfeed

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func parseJSON(t *testing.T, raw string, ports ...Ports) (*Input, error) {
	t.Helper()
	m, err := trpc.DecodeEnvelope([]byte(raw))
	if err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	var p Ports
	if len(ports) > 0 {
		p = ports[0]
	}
	return ParseWith(m, p)
}

// The shape the browse page sends most (the access-log sample's top shapes): every key read, the
// client-only ones (`direction`, `authed`) ignored, the false-valued unsupported keys not a fallback.
func TestParseBrowseShape(t *testing.T) {
	in, err := parseJSON(t, `{"json":{"period":"Month","periodMode":"published","sort":"Most Downloaded",
		"types":["LORA","Checkpoint"],"checkpointType":"Trained","baseModels":["SDXL 1.0","Pony"],
		"browsingLevel":3,"excludedTagIds":[11,12],"disablePoi":true,"disableMinor":true,"limit":32,
		"cursor":"12|34|5001","tagname":"Anime","earlyAccess":false,"followed":false,"hidden":false,
		"newCreators":false,"pending":false,"direction":"forward","authed":true,
		"allowCommercialUse":"Sell","allowDerivatives":false,"fileFormats":["SafeTensor"],
		"excludedUserIds":[7],"hidePaid":true}}`, Ports{HidePaid: true})
	if err != nil {
		t.Fatalf("Parse: %v (reason %q)", err, fallback.Reason(err))
	}
	f := false
	want := &Input{
		Limit: 32, Cursor: "12|34|5001", Sort: SortMostDownloaded, Period: "Month", PeriodMode: "published",
		BrowsingLevel: ptrInt(3), Tag: "Anime", Types: []string{"LORA", "Checkpoint"},
		BaseModels: []string{"SDXL 1.0", "Pony"}, CheckpointType: "Trained",
		AllowCommercialUse: []string{"Sell"}, AllowDerivatives: &f, HidePaid: true,
		FileFormats: []string{"SafeTensor"}, DisablePoi: true, DisableMinor: true,
		ExcludedTagIDs: []int{11, 12}, ExcludedUserIDs: []int{7},
	}
	if !reflect.DeepEqual(in, want) {
		t.Fatalf("got  %+v\nwant %+v", in, want)
	}
}

func TestParseDefaults(t *testing.T) {
	in, err := parseJSON(t, `{"json":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 100 || in.Sort != SortHighestRated || in.Period != "AllTime" || in.PeriodMode != "published" || in.BrowsingLevel != nil {
		t.Fatalf("defaults: %+v", in)
	}
}

func ptrInt(n int) *int { return &n }

func TestParseFallbacks(t *testing.T) {
	for _, c := range []struct{ input, reason string }{
		{`{"json":{"query":"x"}}`, "input-query"},
		// collectionId and collectionTagId are z.number(): anything else, null included, is a 400; a
		// number that is not an int4 integer is not ported.
		{`{"json":{"collectionId":5.5}}`, "model-collection-id"},
		{`{"json":{"collectionId":3000000000}}`, "model-collection-id"},
		{`{"json":{"collectionId":5,"collectionTagId":1.5}}`, "model-collection-id"},
		{`{"json":{"collectionId":"5"}}`, "input-invalid"},
		{`{"json":{"collectionId":null}}`, "input-invalid"},
		{`{"json":{"collectionTagId":"x"}}`, "input-invalid"},
		{`{"json":{"collectionId":5,"sort":"Recently Added"}}`, "model-sort-recently-added"},
		{`{"json":{"hidden":true}}`, "input-hidden"},
		{`{"json":{"followed":true}}`, "input-followed"},
		{`{"json":{"newCreators":true}}`, "input-newCreators"},
		{`{"json":{"ids":[1]}}`, "input-ids"},
		// Node: [] stays [] and "" becomes [0], each truthy, so both turn off hidePrivateModels.
		{`{"json":{"ids":[]}}`, "input-ids"},
		{`{"json":{"ids":""}}`, "input-ids"},
		{`{"json":{"ids":null}}`, "input-ids"},
		{`{"json":{"status":["Draft"]}}`, "input-status"},
		{`{"json":{"pending":true}}`, "input-pending"},
		{`{"json":{"supportsGeneration":true}}`, "input-supportsGeneration"},
		{`{"json":{"isFeatured":true}}`, "input-isFeatured"},
		{`{"json":{"publishedFrom":"2026-01-01"}}`, "input-publishedFrom"},
		{`{"json":{"sort":"Recently Added"}}`, "model-sort-recently-added"},
		{`{"json":{"sort":"Random"}}`, "input-invalid"},
		{`{"json":{"cursor":5}}`, "model-cursor"},
		{`{"json":{"limit":101}}`, "input-invalid"},
		{`{"json":{"limit":32.5}}`, "input-invalid"},
		{`{"json":{"types":["Nope"]}}`, "input-invalid"},
		{`{"json":{"fileFormats":["exe"]}}`, "input-invalid"},
		{`{"json":{"allowCommercialUse":["Nope"]}}`, "input-invalid"},
		{`{"json":{"earlyAccess":"maybe"}}`, "input-invalid"},
		{`{"json":{"disablePoi":"true"}}`, "input-invalid"},
	} {
		_, err := parseJSON(t, c.input)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: reason %q (%v), want %q", c.input, got, err, c.reason)
		}
	}
}

// The zero values of the unsupported keys are no filter in Node (`if (collectionId)` and friends).
func TestParseIgnoresFalsyUnsupportedKeys(t *testing.T) {
	_, err := parseJSON(t, `{"json":{"query":"","collectionId":0,"hidden":false,"status":[],"pending":false}}`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
}

// collectionId and collectionTagId as getModelsRaw reads them: a tag only with a collection, 0 as no
// filter, a negative id kept (Node binds it; no collection holds it).
func TestParseCollection(t *testing.T) {
	for raw, want := range map[string][2]int{
		`{"json":{"collectionId":42}}`:                                   {42, 0},
		`{"json":{"collectionId":42,"collectionTagId":88}}`:              {42, 88},
		`{"json":{"collectionId":42,"collectionTagId":0}}`:               {42, 0},
		`{"json":{"collectionTagId":88}}`:                                {0, 0},
		`{"json":{"collectionId":0,"collectionTagId":1.5}}`:              {0, 0},
		`{"json":{"collectionId":-3}}`:                                   {-3, 0},
		`{"json":{"collectionId":42,"collectionItemStatus":["REVIEW"]}}`: {42, 0},
	} {
		in, err := parseJSON(t, raw)
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", raw, err, fallback.Reason(err))
		}
		if got := [2]int{in.CollectionID, in.CollectionTagID}; got != want {
			t.Errorf("%s: collection, tag = %v, want %v", raw, got, want)
		}
	}
}

func TestParseTagAndCreator(t *testing.T) {
	// tagname ?? tag: a present tagname wins, even empty.
	in, _ := parseJSON(t, `{"json":{"tag":"a","tagname":"b"}}`)
	if in.Tag != "b" {
		t.Fatalf("tag %q, want b", in.Tag)
	}
	in, _ = parseJSON(t, `{"json":{"tag":"a","tagname":""}}`)
	if in.Tag != "" {
		t.Fatalf("tag %q, want empty", in.Tag)
	}
	in, _ = parseJSON(t, `{"json":{"tag":"a"}}`)
	if in.Tag != "a" {
		t.Fatalf("tag %q, want a", in.Tag)
	}
	in, _ = parseJSON(t, `{"json":{"username":"Some User!","user":"raw Name"}}`)
	if in.Username != "some_user" || in.User != "raw Name" || in.creatorName() != "some_user" {
		t.Fatalf("username %q user %q creator %q", in.Username, in.User, in.creatorName())
	}
	in, _ = parseJSON(t, `{"json":{"username":"!!!","user":"raw"}}`)
	if in.Username != "" || in.creatorName() != "raw" {
		t.Fatalf("a name that slugifies to nothing: username %q creator %q", in.Username, in.creatorName())
	}
}

func TestPostgresSlugify(t *testing.T) {
	for in, want := range map[string]string{
		"":             "",
		"Some User":    "some_user",
		"a b c":        "a_bc", // only the first space becomes `_`
		"Ünï-cødé_9":   "ncd_9",
		"Already_Fine": "already_fine",
	} {
		if got := PostgresSlugify(in); got != want {
			t.Errorf("PostgresSlugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseOneOrMany(t *testing.T) {
	in, _ := parseJSON(t, `{"json":{"types":"LORA","baseModels":"Pony"}}`)
	if !reflect.DeepEqual(in.Types, []string{"LORA"}) || !reflect.DeepEqual(in.BaseModels, []string{"Pony"}) {
		t.Fatalf("types %v baseModels %v", in.Types, in.BaseModels)
	}
	// An empty array is kept (Node's post-filter then keeps no version); an empty string is absent.
	in, _ = parseJSON(t, `{"json":{"baseModels":[]}}`)
	if in.BaseModels == nil || len(in.BaseModels) != 0 {
		t.Fatalf("baseModels [] = %#v, want an empty non-nil list", in.BaseModels)
	}
	in, _ = parseJSON(t, `{"json":{"baseModels":""}}`)
	if in.BaseModels != nil {
		t.Fatalf("baseModels \"\" = %#v, want nil", in.BaseModels)
	}
}

func TestBooleanString(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want bool
	}{
		{`{"json":{"archived":true}}`, true},
		{`{"json":{"archived":"yes"}}`, true},
		{`{"json":{"archived":"OFF"}}`, false},
		{`{"json":{"archived":1}}`, true},
		{`{"json":{"archived":2}}`, false},
	} {
		in, err := parseJSON(t, c.raw)
		if err != nil {
			t.Fatalf("%s: %v", c.raw, err)
		}
		if in.Archived != c.want {
			t.Errorf("%s: archived %v, want %v", c.raw, in.Archived, c.want)
		}
	}
}

// An `undefined` annotation removes the key (superjson writes undefined as null + annotation).
func TestParseUndefinedAnnotation(t *testing.T) {
	in, err := parseJSON(t, `{"json":{"disableMinor":null,"cursor":null},"meta":{"values":{"disableMinor":["undefined"],"cursor":["undefined"]}}}`)
	if err != nil {
		t.Fatal(err)
	}
	if in.DisableMinor || in.Cursor != "" {
		t.Fatalf("%+v", in)
	}
}
