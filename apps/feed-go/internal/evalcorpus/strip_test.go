package evalcorpus

import (
	"encoding/json"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

// browserHeaders are the headers a signed-in browser request arrives with at the service (synthetic
// values), secret marking every value that must not be stored.
func browserHeaders(secret string) map[string]string {
	return map[string]string{
		"Host":                   "blue.example.test",
		"Cookie":                 "theme=dark; __Secure-civ-token=" + secret + "; ref=" + secret,
		"cookie":                 "__Host-civ-token=" + secret,
		"Authorization":          "Bearer " + secret,
		"X-Feed-Go-Credential":   "key:" + secret,
		"User-Agent":             "Mozilla/5.0 " + secret,
		"X-Forwarded-For":        "198.51.100.7, " + secret,
		"CF-Connecting-IP":       secret,
		"True-Client-IP":         secret,
		"X-Real-IP":              secret,
		"Referer":                "https://blue.example.test/user/" + secret,
		"CF-IPCountry":           "US",
		"cf-region-code":         "CA",
		"X-Civitai-Verified-Bot": "",
	}
}

func TestStripRealisticRequest(t *testing.T) {
	const secret = "s3cr3t-Value-0001"
	c := capture(t, Request{
		Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/5001",
		Query:   "token=" + secret + "&limit=1&Token=" + secret + "&a=1;token=" + secret + "&%74oken=" + secret + "&apiKey=" + secret,
		Headers: browserHeaders(secret),
	}, anon)
	wantHeaders := map[string]string{"host": "blue.example.test", "cf-ipcountry": "US", "cf-region-code": "CA", "x-civitai-verified-bot": ""}
	if !reflect.DeepEqual(c.Headers, wantHeaders) {
		t.Errorf("headers %v, want %v", c.Headers, wantHeaders)
	}
	if c.Query != "limit=1" {
		t.Errorf("query %q, want %q", c.Query, "limit=1")
	}
	if c.Credential != "header+query+session" {
		t.Errorf("credential %q, want header+query+session", c.Credential)
	}
	got := inputShape(t, c)
	want := map[string]any{"$id": "id", "$credential-param": "present", "q:limit": "str:digits", "q:a": "nonempty"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("shape input %v, want %v", got, want)
	}
	b, _ := json.Marshal(c)
	if strings.Contains(string(b), secret) {
		t.Errorf("the case holds the secret: %s", b)
	}

	// The credential classes one at a time, as the server reads them.
	for _, cc := range []struct {
		headers map[string]string
		query   string
		want    string
	}{
		{map[string]string{"host": "blue.example.test"}, "", CredentialNone},
		{map[string]string{"authorization": "Bearer k"}, "", CredentialHeader},
		{map[string]string{"authorization": "  "}, "", CredentialHeader}, // truthy in Node too
		{map[string]string{SampleCredentialHeader: "dotted"}, "", CredentialHeader},
		{nil, "token=k", CredentialQuery},
		{nil, "token=", CredentialNone},
		{map[string]string{"cookie": "theme=dark; civitai-token=x"}, "", CredentialSession},
		{map[string]string{"cookie": "theme=dark"}, "", CredentialNone},
	} {
		got := capture(t, Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/1", Query: cc.query, Headers: cc.headers}, anon).Credential
		if got != cc.want {
			t.Errorf("%v %q: credential %q, want %q", cc.headers, cc.query, got, cc.want)
		}
	}

	// A tRPC input key named like a credential is not stored (the shape records the key).
	tc := capture(t, Request{Endpoint: EndpointInfinite, Input: `{"json":{"limit":5,"token":"` + secret + `","apiKey":"` + secret + `"},"meta":{"values":{"token":["undefined"],"apiKey.x":["Date"]}}}`, Headers: browserHeaders(secret)}, anon)
	if tc.Input != `{"json":{"limit":5},"meta":{"values":{}}}` {
		t.Errorf("tRPC input stored as %q", tc.Input)
	}
	if b, _ := json.Marshal(tc); strings.Contains(string(b), secret) {
		t.Errorf("the tRPC case holds the secret: %s", b)
	}
}

func TestInvalidPathSegmentNotStored(t *testing.T) {
	c := capture(t, Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/some token here"}, anon)
	if c.Path != "/api/v1/models/$invalid" {
		t.Errorf("path %q", c.Path)
	}
	if got := inputShape(t, c)["$id"]; got != "invalid" {
		t.Errorf("$id %v, want invalid", got)
	}
	c = capture(t, Request{Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/abc"}, anon)
	if c.Path != "/api/v1/models/abc" {
		t.Errorf("a plain non-id segment: path %q, want it kept", c.Path)
	}
}

// FuzzStrip: whatever a credential holds, it reaches no stored case — not as written, not
// percent-encoded, not JSON-escaped. Every credential slot of a realistic request carries it: the
// session cookies, Authorization, the sampler's credential header, the client address and agent
// headers, a `token` query value (in several spellings) and a credential-named tRPC input key.
func FuzzStrip(f *testing.F) {
	for _, s := range []string{"s3cr3t-Value-0001", "eyJhbGciOiJFUzI1NiJ9.payload.sig", "a&b=c;token=d", "ünïcødé-tøken", `quote"back\slash`, "provider:abc123"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, secret string) {
		if len(secret) < 6 {
			t.Skip("too short to be told apart from the rest of a case")
		}
		build := func(s string) []string {
			esc := url.QueryEscape(s)
			jsonStr, _ := json.Marshal(s)
			v1 := capture(t, Request{
				Endpoint: EndpointV1ModelsID, Path: "/api/v1/models/5001",
				Query:   "limit=1&token=" + esc + "&TOKEN=" + esc + "&x=1;token=" + esc + "&%74oken=" + esc,
				Headers: browserHeaders(s),
			}, anon)
			tr := capture(t, Request{
				Endpoint: EndpointAsPosts, Input: `{"json":{"limit":5,"token":` + string(jsonStr) + `}}`,
				Headers: browserHeaders(s),
			}, anon)
			out := make([]string, 0, 2)
			for _, c := range []*Case{v1, tr} {
				cc := *c
				cc.Signature = "" // hex digits that could spell a short secret by chance
				b, err := json.Marshal(cc)
				if err != nil {
					t.Fatal(err)
				}
				out = append(out, string(b))
			}
			return out
		}
		forms := []string{secret, url.QueryEscape(secret), url.PathEscape(secret)}
		if b, err := json.Marshal(secret); err == nil {
			forms = append(forms, strings.Trim(string(b), `"`))
		}
		// A form that the case holds with a placeholder in the secret's place is text the case has
		// anyway (the host, a class name): it cannot tell a leak apart.
		baseline := strings.Join(build("PLACEHOLDER-zz9"), "\n")
		for _, out := range build(secret) {
			for _, form := range forms {
				if len(form) < 6 || strings.Contains(baseline, form) {
					continue
				}
				if strings.Contains(out, form) {
					t.Fatalf("a credential survived stripping (%q): %s", form, out)
				}
			}
		}
	})
}
