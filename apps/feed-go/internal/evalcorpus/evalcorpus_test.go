package evalcorpus

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func capture(t *testing.T, req Request, v Viewer) *Case {
	t.Helper()
	c, err := Capture(req, v, testEnv, Extra{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func trpc(endpoint, input string) Request {
	return Request{Endpoint: endpoint, Input: input, Headers: map[string]string{"host": "green.example.test"}}
}

var anon = Viewer{Class: ViewerAnon}

// inputShape is the `input` member of a case's shape.
func inputShape(t *testing.T, c *Case) map[string]any {
	t.Helper()
	var s struct {
		Input map[string]any `json:"input"`
	}
	if err := json.Unmarshal([]byte(c.Shape), &s); err != nil {
		t.Fatal(err)
	}
	return s.Input
}

func TestIDValuesShareASignatureSortsDoNot(t *testing.T) {
	sig := func(endpoint, input string) string { return capture(t, trpc(endpoint, input), anon).Signature }
	same := []struct{ endpoint, a, b string }{
		{EndpointInfinite, `{"json":{"modelId":5001,"sort":"Newest"}}`, `{"json":{"modelId":5002,"sort":"Newest"}}`},
		{EndpointAsPosts, `{"json":{"modelVersionId":6001,"limit":20}}`, `{"json":{"modelVersionId":6999,"limit":20}}`},
		{EndpointInfinite, `{"json":{"postIds":[7001,7002,7003]}}`, `{"json":{"postIds":[7101,7102]}}`},
		{EndpointInfinite, `{"json":{"cursor":"feed:1718000000000:8005"}}`, `{"json":{"cursor":"feed:1717000000000:8999"}}`},
		{EndpointInfinite, `{"json":{"username":"artist_one"}}`, `{"json":{"username":"artist_two"}}`},
		{EndpointModelGetAll, `{"json":{"cursor":"2026-06-11 10:00:00.125|5002"}}`, `{"json":{"cursor":"2025-01-02 00:00:00|9"}}`},
		{EndpointModelGetAll, `{"json":{"query":"lora"}}`, `{"json":{"query":"style"}}`},
	}
	for _, c := range same {
		if a, b := sig(c.endpoint, c.a), sig(c.endpoint, c.b); a != b {
			t.Errorf("%s: %s and %s differ only in values the classes abstract, signatures %s / %s", c.endpoint, c.a, c.b, a, b)
		}
	}
	differ := []struct{ endpoint, a, b string }{
		{EndpointInfinite, `{"json":{"modelId":5001,"sort":"Newest"}}`, `{"json":{"modelId":5001,"sort":"Most Reactions"}}`},
		{EndpointModelGetAll, `{"json":{"sort":"Newest"}}`, `{"json":{"sort":"Oldest"}}`},
		{EndpointInfinite, `{"json":{"postIds":[7001]}}`, `{"json":{"postIds":[7001,7002]}}`},
		{EndpointInfinite, `{"json":{"cursor":"feed:1718000000000:8005"}}`, `{"json":{"cursor":"200|1718000012345"}}`},
		{EndpointInfinite, `{"json":{"modelId":5001}}`, `{"json":{"modelId":5001.5}}`},
		{EndpointInfinite, `{"json":{"limit":20}}`, `{"json":{"limit":24}}`},
		{EndpointInfinite, `{"json":{"withMeta":true}}`, `{"json":{"withMeta":false}}`},
		{EndpointInfinite, `{"json":{"types":["image"]}}`, `{"json":{"types":["video"]}}`},
		{EndpointInfinite, `{"json":{"prioritizedUserIds":[-1]}}`, `{"json":{"prioritizedUserIds":[1001]}}`},
		{EndpointModelGetAll, `{"json":{"sort":"Hot","baseModels":["Pony"]}}`, `{"json":{"sort":"Hot"}}`},
		{EndpointAsPosts, `{"json":{"limit":5}}`, `{"json":{"limit":5,"someNewKey":true}}`},
	}
	for _, c := range differ {
		if a, b := sig(c.endpoint, c.a), sig(c.endpoint, c.b); a == b {
			t.Errorf("%s: %s and %s take different paths, same signature %s", c.endpoint, c.a, c.b, a)
		}
	}
	// The endpoint, viewer, host, region and the caller's answer classes are dimensions too.
	base := trpc(EndpointInfinite, `{"json":{"limit":5}}`)
	if capture(t, base, anon).Signature == capture(t, trpc(EndpointAsPosts, base.Input), anon).Signature {
		t.Error("the endpoint is not part of the signature")
	}
	if capture(t, base, anon).Signature == capture(t, base, Viewer{Class: ViewerUser}).Signature {
		t.Error("the viewer class is not part of the signature")
	}
	blue := base
	blue.Headers = map[string]string{"host": "blue.example.test"}
	if capture(t, base, anon).Signature == capture(t, blue, anon).Signature {
		t.Error("the host class is not part of the signature")
	}
	a, _ := Capture(base, anon, testEnv, Extra{Response: "200", Outcome: "served"})
	b, _ := Capture(base, anon, testEnv, Extra{Response: "200", Outcome: "fallback:input-unknown-key"})
	if a.Signature == b.Signature {
		t.Error("the outcome class is not part of the signature")
	}
}

func TestValueClasses(t *testing.T) {
	cases := []struct {
		endpoint, input string
		want            map[string]any
	}{
		{EndpointInfinite, `{"json":{"limit":7,"browsingLevel":28,"sort":"Newest","period":"Week","withMeta":false,"types":["video","image"],"include":["tags","cosmetics"]}}`,
			map[string]any{"limit": "7", "browsingLevel": "28", "sort": "Newest", "period": "Week", "withMeta": "false", "types": "[image,video]", "include": "[cosmetics,tags]"}},
		{EndpointInfinite, `{"json":{"limit":13}}`, map[string]any{"limit": "11-49"}},
		{EndpointInfinite, `{"json":{"limit":500}}`, map[string]any{"limit": "200+"}},
		{EndpointInfinite, `{"json":{"limit":"5"}}`, map[string]any{"limit": "str:digits"}},
		{EndpointInfinite, `{"json":{"modelId":0,"postId":-3,"userId":"1001","hubId":1.5}}`,
			map[string]any{"modelId": "id:zero", "postId": "id:neg", "userId": "id:str", "hubId": "id:nonint"}},
		{EndpointInfinite, `{"json":{"ids":[],"postIds":[7001],"tags":[1,2,3],"tools":[41,1.5],"baseModels":["SDXL 1.0",""],"hubExcludedSources":[{"type":"Tag","targetId":533}]}}`,
			map[string]any{"ids": "0", "postIds": "1:int", "tags": "2+:int", "tools": "2+:num", "baseModels": "2+:str-empty", "hubExcludedSources": "1:obj"}},
		{EndpointInfinite, `{"json":{"followed":"true","newCreators":null,"reactions":["Like","Laugh"]}}`,
			map[string]any{"followed": "str:true", "newCreators": "null", "reactions": "[Laugh,Like]"}},
		{EndpointInfinite, `{"json":{"prioritizedUserIds":[-1]}}`, map[string]any{"prioritizedUserIds": "[-1]"}},
		{EndpointInfinite, `{"json":{"prioritizedUserIds":[1001,1002]}}`, map[string]any{"prioritizedUserIds": "2+:int"}},
		{EndpointInfinite, `{"json":{"someNewFilter":true,"search":"golden fox","a b":1}}`,
			map[string]any{"unknown:someNewFilter": "true", "unknown:search": "nonempty", "unknown:?": "num"}},
		{EndpointInfinite, `{"json":{"authed":true,"direction":"forward"}}`, map[string]any{"authed": "true", "direction": "forward"}},
		{EndpointInfinite, `{"json":{"sort":"<script>alert(1)</script>"}}`, map[string]any{"sort": "other"}},
		{EndpointInfinite, `{"json":{"cursor":"2026-01-01T00:00:00.000Z"},"meta":{"values":{"cursor":["Date"]}}}`, map[string]any{"cursor": "meta:Date"}},
		{EndpointInfinite, `{"json":{"limit":5},"meta":{"values":{"cursor":["undefined"]}}}`, map[string]any{"limit": "5"}},
		{EndpointModelGetAll, `{"json":{"types":["LORA","Checkpoint"],"baseModels":["Pony"],"page":2,"query":" ","tag":"anime","hidePaid":true}}`,
			map[string]any{"types": "2+:str", "baseModels": "1:str", "page": "2+", "query": "blank", "tag": "nonempty", "hidePaid": "true", "$paging": "page", "$pin": "none"}},
		{EndpointModelGetAll, `{"json":{"sort":"Hot","baseModels":["Pony"]}}`,
			map[string]any{"sort": "Hot", "baseModels": "1:str", "$paging": "none", "$pin": "first-page"}},
		{EndpointModelGetAll, `{"json":{"page":1,"cursor":"90|100|5001"}}`,
			map[string]any{"page": "1", "cursor": "entry:n|n|n", "$paging": "both", "$pin": "none"}},
		{EndpointModelGetAll, `{"json":{"checkpointType":"Trained"}}`,
			map[string]any{"checkpointType": "Trained", "$checkpointFilter": "only", "$paging": "none", "$pin": "none"}},
		{EndpointModelGetAll, `{"json":{"checkpointType":"Trained","types":["Checkpoint"]}}`,
			map[string]any{"checkpointType": "Trained", "types": "1:str", "$checkpointFilter": "only", "$paging": "none", "$pin": "none"}},
		{EndpointModelGetAll, `{"json":{"checkpointType":"Trained","types":["LORA"]}}`,
			map[string]any{"checkpointType": "Trained", "types": "1:str", "$checkpointFilter": "inert", "$paging": "none", "$pin": "none"}},
		{EndpointModelGetAll, `{"json":{"checkpointType":"Merge","types":["LORA","Checkpoint"]}}`,
			map[string]any{"checkpointType": "Merge", "types": "2+:str", "$checkpointFilter": "mixed", "$paging": "none", "$pin": "none"}},
		{EndpointInfinite, `{"json":{"tags":[1,null]},"meta":{"values":{"tags.1":["undefined"],"tags.0":["Date"]}}}`,
			map[string]any{"tags": "2+:mixed"}},
		{EndpointAsPosts, ``, map[string]any{"$envelope": "none"}},
		{EndpointAsPosts, `{"json":`, map[string]any{"$envelope": "invalid"}},
		{EndpointAsPosts, `{"json":null}`, map[string]any{}},
	}
	for _, c := range cases {
		got := inputShape(t, capture(t, trpc(c.endpoint, c.input), anon))
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(c.want)
		if string(gb) != string(wb) {
			t.Errorf("%s %s:\n got  %s\n want %s", c.endpoint, c.input, gb, wb)
		}
	}
}

func TestCursorClasses(t *testing.T) {
	image := map[string]string{
		`5`: "numeric", `0`: "absent", `null`: "absent", `""`: "absent", `"40"`: "numeric-str",
		`"feed:1718000000000:8005"`: "feed", `"200|1718000012345"`: "offset",
		`"494867:588720858:8003"`: "random-seed", `"494868:x:8007"`: "random-bad", `"not-a-cursor"`: "other",
		`-2`: "invalid", `true`: "invalid",
	}
	for raw, want := range image {
		got := inputShape(t, capture(t, trpc(EndpointInfinite, `{"json":{"cursor":`+raw+`}}`), anon))["cursor"]
		if got != want {
			t.Errorf("image cursor %s: %v, want %s", raw, got, want)
		}
	}
	model := map[string]string{
		`5`: "numeric", `""`: "absent", `"2026-06-11 10:00:00.125|5002"`: "entry:t|n", `"500|5007"`: "entry:n|n",
		`"|5"`: "entry:e|n", `"abc"`: "entry:x", `"1|2|3|4|5"`: "entry:many", `"-5|7"`: "entry:n|n",
	}
	for raw, want := range model {
		got := inputShape(t, capture(t, trpc(EndpointModelGetAll, `{"json":{"cursor":`+raw+`}}`), anon))["cursor"]
		if got != want {
			t.Errorf("model cursor %s: %v, want %s", raw, got, want)
		}
	}
}

func TestHostAndRegionClasses(t *testing.T) {
	cases := []struct {
		headers      map[string]string
		host, region string
	}{
		{map[string]string{"Host": "GREEN.example.test:443"}, "green", "none"},
		{map[string]string{"host": "mirror.red.example.test", "cf-ipcountry": "US"}, "red", "open"},
		{map[string]string{"host": "elsewhere.example.test", "cf-ipcountry": "GB"}, "other", "restricted"},
		{map[string]string{"host": "blue.example.test", "cf-ipcountry": "US", "x-isuk": "true"}, "blue", "restricted"},
		{map[string]string{"host": "blue.example.test", "cf-ipcountry": "XB"}, "blue", "blocked"},
	}
	for _, c := range cases {
		cs, err := Capture(Request{Endpoint: EndpointAsPosts, Headers: c.headers}, anon, testEnv, Extra{})
		if err != nil {
			t.Fatal(err)
		}
		var s struct{ Host, Region string }
		_ = json.Unmarshal([]byte(cs.Shape), &s)
		if s.Host != c.host || s.Region != c.region {
			t.Errorf("%v: host %q region %q, want %q %q", c.headers, s.Host, s.Region, c.host, c.region)
		}
	}
	cs, _ := Capture(Request{Endpoint: EndpointAsPosts, Headers: map[string]string{"host": "green.example.test"}}, anon, Env{}, Extra{})
	if !strings.Contains(cs.Shape, `"host":"unmapped"`) {
		t.Errorf("no host colors: %s, want host unmapped", cs.Shape)
	}
}

func TestUnsupportedEndpoint(t *testing.T) {
	for _, e := range []string{"", "v1-images", "v1-models", "site-search"} {
		if _, err := Capture(Request{Endpoint: e}, anon, testEnv, Extra{}); !errors.Is(err, ErrUnsupportedEndpoint) {
			t.Errorf("%q: %v, want ErrUnsupportedEndpoint", e, err)
		}
	}
	for _, e := range Endpoints {
		if _, err := Capture(Request{Endpoint: e}, anon, testEnv, Extra{}); err != nil {
			t.Errorf("%q: %v", e, err)
		}
	}
}

// The viewer's own identifiers: a distinctive id and name, so a leak is findable in the stored case.
const (
	selfID   = 987654321
	selfName = "Viewer_Name"
)

var selfViewer = Viewer{Class: ViewerUser, UserID: selfID, Username: "viewer_name", CollectionIDs: []int{4242}, BrowsingLevel: 31, ShowNsfw: true, HiddenPrefs: true}

func TestSelfPlaceholders(t *testing.T) {
	cases := []struct {
		name     string
		req      Request
		stored   string // Input (tRPC) or Query (REST) as stored
		key      string // the shape key of the substituted value
		class    string
		wantSelf bool
	}{
		{"userId", trpc(EndpointInfinite, `{"json":{"userId":987654321,"limit":5}}`),
			`{"json":{"limit":5,"userId":"$self"}}`, "userId", SelfPlaceholder, true},
		{"userId with a meta annotation", trpc(EndpointInfinite, `{"json":{"userId":"987654321"},"meta":{"values":{"userId":["bigint"]}}}`),
			`{"json":{"userId":"$self"},"meta":{"values":{"userId":["bigint"]}}}`, "userId", SelfPlaceholder, true},
		{"username, another spelling", trpc(EndpointInfinite, `{"json":{"username":"Viewer_Name"}}`),
			`{"json":{"username":"$self"}}`, "username", SelfPlaceholder, true},
		{"model.getAll user", trpc(EndpointModelGetAll, `{"json":{"user":"viewer_name","sort":"Newest"}}`),
			`{"json":{"sort":"Newest","user":"$self"}}`, "user", SelfPlaceholder, true},
		{"own collection", trpc(EndpointInfinite, `{"json":{"collectionId":4242}}`),
			`{"json":{"collectionId":"$self-collection"}}`, "collectionId", SelfCollectionPlaceholder, true},
		{"excluded self", trpc(EndpointInfinite, `{"json":{"excludedUserIds":[1001,987654321]}}`),
			`{"json":{"excludedUserIds":[1001,"$self"]}}`, "excludedUserIds", "2+:int", true},
		{"another user's id is kept (re-encoded)", trpc(EndpointInfinite, `{"json":{"userId": 1001, "limit":5}}`),
			`{"json":{"limit":5,"userId":1001}}`, "userId", "id", false},
		{"a repeated key: the earlier copy naming the viewer is not kept", trpc(EndpointInfinite, `{"json":{"userId":987654321,"userId":1001}}`),
			`{"json":{"userId":1001}}`, "userId", "id", false},
		{"an undefined-annotated self key is still replaced in the stored text", trpc(EndpointInfinite, `{"json":{"userId":987654321,"limit":5},"meta":{"values":{"userId":["undefined"]}}}`),
			`{"json":{"limit":5,"userId":"$self"},"meta":{"values":{"userId":["undefined"]}}}`, "limit", "5", true},
		{"a spaced, signed id string", trpc(EndpointInfinite, `{"json":{"userId":" +987654321 "}}`),
			`{"json":{"userId":"$self"}}`, "userId", SelfPlaceholder, true},
		{"another collection is kept", trpc(EndpointInfinite, `{"json":{"collectionId":88}}`),
			`{"json":{"collectionId":88}}`, "collectionId", "id", false},
		{"REST username", Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/5001", Query: "username=viewer_name&x=1", Headers: map[string]string{"host": "site.example.test"}},
			`username=%24self&x=1`, "q:username", SelfPlaceholder, true},
		{"REST username repeated", Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/5001", Query: "username=other&username=Viewer_Name&username=viewer_name", Headers: map[string]string{"host": "site.example.test"}},
			`username=other&username=%24self&username=%24self`, "q:username", SelfPlaceholder, true},
		{"REST userId", Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/5001", Query: "userId=987654321", Headers: map[string]string{"host": "site.example.test"}},
			`userId=%24self`, "q:userId", SelfPlaceholder, true},
	}
	for _, c := range cases {
		cs := capture(t, c.req, selfViewer)
		stored := cs.Input
		if c.req.Endpoint == EndpointV1ModelsID {
			stored = cs.Query
		}
		if stored != c.stored {
			t.Errorf("%s: stored %q, want %q", c.name, stored, c.stored)
		}
		if got := inputShape(t, cs)[c.key]; got != c.class {
			t.Errorf("%s: shape %s = %v, want %s", c.name, c.key, got, c.class)
		}
		if cs.Viewer.Self != c.wantSelf {
			t.Errorf("%s: self %v, want %v", c.name, cs.Viewer.Self, c.wantSelf)
		}
		want := ViewerDescriptor{Class: ViewerUser, BrowsingLevel: 31, ShowNsfw: true, HiddenPrefs: true, Self: c.wantSelf}
		if cs.Viewer != want {
			t.Errorf("%s: viewer %+v, want %+v", c.name, cs.Viewer, want)
		}
		stripped := *cs
		stripped.Signature = "" // hex digits that could spell a short id by chance
		b, _ := json.Marshal(stripped)
		for _, leak := range []string{"987654321", "viewer_name", "Viewer_Name", "4242"} {
			if strings.Contains(string(b), leak) {
				t.Errorf("%s: the stored case holds the viewer's %q: %s", c.name, leak, b)
			}
		}
	}
}

func TestMasks(t *testing.T) {
	for _, e := range Endpoints {
		m, err := MasksFor(e)
		if err != nil {
			t.Errorf("%s: %v", e, err)
		}
		for _, p := range m {
			if !ValidMaskPath(p) {
				t.Errorf("%s: mask %q is not in the Masks format", e, p)
			}
		}
	}
	if len(Masks) != len(Endpoints) {
		t.Errorf("Masks has %d entries, want one per endpoint (%d)", len(Masks), len(Endpoints))
	}
	if _, err := MasksFor("v1-images"); err == nil {
		t.Error("MasksFor of an endpoint with no entry: want an error")
	}
	for p, want := range map[string]bool{
		"$.json.items[*].stats.viewCountAllTime": true, "$.items[*].id": true, "$[*]": true,
		"json.items": false, "$..id": false, "$.items[0]": false, "$": false, "$.a b": false,
	} {
		if ValidMaskPath(p) != want {
			t.Errorf("ValidMaskPath(%q) = %v, want %v", p, !want, want)
		}
	}
}
