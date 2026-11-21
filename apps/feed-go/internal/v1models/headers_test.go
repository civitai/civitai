package v1models

import (
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Each value is what Next 16's generateETag (next/dist/server/lib/etag.js, the function res.json's
// sendData calls) returned for the string, run with node on 2026-11-21. The inputs are chosen to reach
// every branch of the UTF-16 read: ASCII, a 2-byte UTF-8 rune, a rune past U+FFFF (a surrogate pair:
// two code units, length 2), U+2028, and a long string that moves every one of the four 16-bit lanes.
func TestETagIsNextsGenerateETag(t *testing.T) {
	// The node run's string: String.fromCharCode(32 + (i*7919) % 95) for i in [0, 5000).
	printable := make([]byte, 0, 95)
	for c := byte(' '); c <= '~'; c++ {
		printable = append(printable, c)
	}
	var big strings.Builder
	for i := range 5000 {
		big.WriteByte(printable[(i*7919)%95])
	}
	for _, c := range []struct{ in, want string }{
		{"", `"78p3gz236i0"`},
		{"{}", `"bwc9mymkdm2"`},
		{`{"id":1}`, `"ut3gym2a4q8"`},
		{"a", `"ap6mcnqid61"`},
		{"héllo", `"g5ozp0czrh5"`},
		{"😀", `"c26v2dkjuu2"`},
		{"x\u2028y", `"lbg1zl91cm3"`},
		{`{"items":[],"metadata":{}}`, `"15xnb4t0xydq"`},
		{big.String(), `"zpgy3ne4kj3uw"`},
	} {
		if got := ETag([]byte(c.in)); got != c.want {
			t.Errorf("ETag(%.40q) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestNodeBody(t *testing.T) {
	for _, c := range []struct {
		name, in, want string
		ok             bool
	}{
		{"no escape", `{"a":"b"}`, `{"a":"b"}`, true},
		{"line separator written raw", `{"a":"x\u2028y"}`, "{\"a\":\"x\u2028y\"}", true},
		{"paragraph separator written raw", `{"a":"\u2029"}`, "{\"a\":\"\u2029\"}", true},
		{"both, between other text", `["\u2028","q","\u2029z"]`, "[\"\u2028\",\"q\",\"\u2029z\"]", true},
		// An escaped backslash followed by the letters: a literal `\u2028` text, not the character.
		{"escaped backslash", `{"a":"\\u2028"}`, `{"a":"\\u2028"}`, true},
		{"other \\u escapes kept", `{"a":"\u0001\n\"\\"}`, `{"a":"\u0001\n\"\\"}`, true},
		{"an invalid byte the writer replaced", `{"a":"\ufffd"}`, "", false},
	} {
		got, ok := NodeBody([]byte(c.in))
		if ok != c.ok || (ok && string(got) != c.want) {
			t.Errorf("%s: NodeBody(%s) = %q, %v; want %q, %v", c.name, c.in, got, ok, c.want, c.ok)
		}
	}
	// The plain writer's own output for the characters: NodeBody turns it into JSON.stringify's,
	// which writes U+2028 and U+2029 unescaped, and a raw U+FFFD as it is.
	plain, err := superjson.Plain(superjson.Object{{Key: "s", Val: "a\u2028b\u2029c\ufffdd"}})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := NodeBody(plain); !ok || string(got) != "{\"s\":\"a\u2028b\u2029c\ufffdd\"}" {
		t.Fatalf("NodeBody(Plain) = %q, %v", got, ok)
	}
	plain, err = superjson.Plain(superjson.Object{{Key: "s", Val: "a\xffb"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := NodeBody(plain); ok {
		t.Fatalf("an invalid UTF-8 byte (%s) has no JSON.stringify form here, want ok false", plain)
	}
}

// The literal header sets Node sends with a 200 on each arm (endpoint-helpers.ts and the handlers;
// configheaders.json first). Each arm is a case a guard in ResponseHeaders must reach: the credential
// Vary, the private default for a credential or a crawler, the list's nsfw and `[id]`'s no-store.
func TestResponseHeadersArms(t *testing.T) {
	const (
		public  = "public, s-maxage=300, stale-while-revalidate=150"
		private = "max-age=0, private, no-cache"
		noStore = "private, no-store"
	)
	body := []byte(`{"items":[],"metadata":{}}`)
	headers := func(vary, cc string) map[string]string {
		return map[string]string{
			"x-frame-options":              "DENY",
			"vary":                         vary,
			"access-control-allow-origin":  "*",
			"access-control-allow-headers": "Authorization, Content-Type, *",
			"access-control-allow-methods": "GET",
			"cache-control":                cc,
			"etag":                         `"15xnb4t0xydq"`,
		}
	}
	for _, c := range []struct {
		name string
		in   HeaderInput
		want map[string]string
	}{
		{"list, anonymous", HeaderInput{}, headers("Authorization", public)},
		{"list, nsfw", HeaderInput{Nsfw: true}, headers("Authorization", noStore)},
		{"list, credential", HeaderInput{Credentialed: true}, headers("Authorization, Cookie", private)},
		{"list, verified crawler", HeaderInput{VerifiedCrawler: true}, headers("Authorization", private)},
		{"list, credential and nsfw", HeaderInput{Credentialed: true, Nsfw: true}, headers("Authorization, Cookie", noStore)},
		{"[id], anonymous", HeaderInput{Detail: true}, headers("Authorization", noStore)},
		{"[id], credential", HeaderInput{Detail: true, Credentialed: true}, headers("Authorization, Cookie", noStore)},
		{"[id], verified crawler", HeaderInput{Detail: true, VerifiedCrawler: true}, headers("Authorization", noStore)},
	} {
		hs := ResponseHeaders(c.in, body)
		if got := HeaderMap(hs); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got  %v\n want %v", c.name, got, c.want)
		}
		if len(hs) != len(c.want) {
			t.Errorf("%s: %d headers, want %d (a name set twice)", c.name, len(hs), len(c.want))
		}
	}
	// The ETag is the body's, not a constant: another body moves it.
	if got := HeaderMap(ResponseHeaders(HeaderInput{}, []byte(`{}`)))["etag"]; got != `"bwc9mymkdm2"` {
		t.Fatalf("etag of {} = %s", got)
	}
}

func TestCarriesCallerCredentials(t *testing.T) {
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i+1 < len(kv); i += 2 {
			out.Add(kv[i], kv[i+1])
		}
		return out
	}
	for _, c := range []struct {
		name  string
		h     http.Header
		query string
		want  bool
	}{
		{"nothing", h(), "", false},
		{"an unrelated cookie", h("Cookie", "theme=dark; _ga=1"), "", false},
		{"a cookie whose name only contains a session name", h("Cookie", "x__Secure-civ-token=1"), "", false},
		{"__Host-civ-token", h("Cookie", "__Host-civ-token=t"), "", true},
		{"__Secure-civ-token", h("Cookie", "a=1; __Secure-civ-token=t"), "", true},
		{"civ-token", h("Cookie", "civ-token=t"), "", true},
		{"__Secure-civitai-token (legacy)", h("Cookie", "__Secure-civitai-token=t"), "", true},
		{"civitai-token (legacy)", h("Cookie", "civitai-token=t"), "", true},
		{"an empty session value still counts (the raw arm reads the name)", h("Cookie", "civ-token="), "", true},
		{"a bare name with no =", h("Cookie", "a=1;  civ-token "), "", true},
		{"on a second Cookie line", h("Cookie", "a=1", "Cookie", "__Secure-civ-token=t"), "", true},
		{"an Authorization header", h("Authorization", "Bearer k"), "", true},
		{"an empty Authorization header", h("Authorization", ""), "", false},
		{"a token query value", h(), "limit=1&token=k", true},
		{"an empty token query value", h(), "token=", false},
		{"a later non-empty token value", h(), "token=&token=k", true},
	} {
		if got := CarriesCallerCredentials(c.h, c.query); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if HasSessionCookie(h("Cookie", "theme=dark")) || !HasSessionCookie(h("Cookie", "__Host-civ-token=t")) {
		t.Fatal("HasSessionCookie disagrees with the session cookie names")
	}
}

// configheaders.json is read at init; its one entry today is next.config's X-Frame-Options, which
// src/server/__tests__/feed-go-v1-models-config-headers.test.ts holds to the real config.
func TestConfigHeadersLoaded(t *testing.T) {
	if want := []Header{{"X-Frame-Options", "DENY"}}; !reflect.DeepEqual(configHeaders, want) {
		t.Fatalf("configHeaders = %v, want %v", configHeaders, want)
	}
}
