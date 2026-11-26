package evalharness

import (
	"bytes"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

func restCase(credential string) Case {
	return Case{ID: 0x3301, Endpoint: evalcorpus.EndpointV1ModelsID, Request: evalcapture.StoredRequest{
		Path: "/api/v1/models/3301", Query: "nsfw=false&username=%24self",
		Headers: map[string]string{"host": testHost, "x-isuk": "1"}, Credential: credential,
		Viewer: evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerUser},
	}}
}

// TestPrepareAPIKeyCredentials: the stored credential class decides how the read-only key is
// presented: `header` as Authorization: Bearer, `query` as an escaped `token` pair after the stored
// query, the owner's cookie only when the class also holds `session`.
func TestPrepareAPIKeyCredentials(t *testing.T) {
	a, err := LoadAccounts(writeAccounts(t, nil, RoleFiltered), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		credential, wantAuth, wantQuery string
		wantCookie                      bool
	}{
		{"header", "Bearer " + testAPIKey, "nsfw=false&username=evalfiltered", false},
		{"query", "", "nsfw=false&username=evalfiltered&token=apikey%2Bsec%2F9931%3D", false},                            // gitleaks:allow synthetic test key
		{"header+query", "Bearer " + testAPIKey, "nsfw=false&username=evalfiltered&token=apikey%2Bsec%2F9931%3D", false}, // gitleaks:allow synthetic test key
		{"header+session", "Bearer " + testAPIKey, "nsfw=false&username=evalfiltered", true},
		{"session", "", "nsfw=false&username=evalfiltered", true},
	}
	for _, c := range cases {
		cs := restCase(c.credential)
		if c.credential == "session" {
			cs.Request.Viewer.HiddenPrefs = true // member-filtered, the key's own account: the same username
		}
		creds, why := a.Resolve(MapViewer(cs.Request.Viewer, cs.Request.Credential))
		if why != "" {
			t.Fatalf("%s: %s", c.credential, why)
		}
		p, why := Prepare(cs, creds)
		if why != "" {
			t.Fatalf("%s: %s", c.credential, why)
		}
		if got := p.Header.Get("Authorization"); got != c.wantAuth {
			t.Errorf("%s: Authorization %q, want %q", c.credential, got, c.wantAuth)
		}
		if p.RawQuery != c.wantQuery {
			t.Errorf("%s: query %q, want %q", c.credential, p.RawQuery, c.wantQuery)
		}
		if got := p.Header.Get("Cookie") != ""; got != c.wantCookie {
			t.Errorf("%s: cookie %v, want %v", c.credential, got, c.wantCookie)
		}
		if p.Host != testHost || p.Header.Get("X-Isuk") != "1" || p.Header.Get("Referer") != "https://"+testHost+"/" {
			t.Errorf("%s: host/headers %q %v", c.credential, p.Host, p.Header)
		}
	}
	// A query credential with no stored query: the pair alone.
	cs := restCase("query")
	cs.Request.Query = ""
	creds, _ := a.Resolve(MapViewer(cs.Request.Viewer, "query"))
	if p, _ := Prepare(cs, creds); p.RawQuery != "token=apikey%2Bsec%2F9931%3D" { // gitleaks:allow synthetic test key
		t.Errorf("bare token pair %q", p.RawQuery)
	}
}

func TestPrepareNotReplayable(t *testing.T) {
	anon := Credentials{ViewerUsed: ViewerAnon}
	for _, c := range []struct {
		cs   Case
		want string
	}{
		{Case{Endpoint: "v1-images"}, "endpoint"},
		{Case{Endpoint: evalcorpus.EndpointAsPosts, SigText: `{"input":{"$envelope":"invalid"}}`}, "input-not-stored"},
		{Case{Endpoint: evalcorpus.EndpointAsPosts, Request: evalcapture.StoredRequest{Input: `{"json":{"userId":"$self"}}`}}, "placeholder-unfilled"},
		{Case{Endpoint: evalcorpus.EndpointAsPosts, Request: evalcapture.StoredRequest{Input: `{"json":"$self`}}, "input-invalid"},
		{Case{Endpoint: evalcorpus.EndpointV1ModelsID}, "path-not-stored"},
		{Case{Endpoint: evalcorpus.EndpointV1ModelsID, Request: evalcapture.StoredRequest{Path: "/api/v1/models/1", Query: "userId=%24self"}}, "placeholder-unfilled"},
	} {
		if _, why := Prepare(c.cs, anon); why != c.want {
			t.Errorf("%+v: %q, want %q", c.cs, why, c.want)
		}
	}
	// A tRPC case with no input at all is sent with none.
	p, why := Prepare(Case{Endpoint: evalcorpus.EndpointInfinite, Request: evalcapture.StoredRequest{Headers: map[string]string{}}}, anon)
	if why != "" || p.Path != "/api/trpc/image.getInfinite" || p.RawQuery != "" || len(p.Header) != 0 {
		t.Errorf("no input: %+v %q", p, why)
	}
}
