package v1models

import (
	"net/http"
	"testing"
)

// Fresh against fresh's own rules (next/dist/compiled/fresh/index.js, Next 16.4.5), each case a
// literal request and ETag with the verdict that source gives.
func TestFreshIsNextsFresh(t *testing.T) {
	const etag = `"vi1v4hbjily"`
	for _, c := range []struct {
		name    string
		headers map[string]string
		etag    string
		want    bool
	}{
		{"no conditional header", nil, etag, false},
		{"exact match", map[string]string{"If-None-Match": `"vi1v4hbjily"`}, etag, true},
		{"weak request token", map[string]string{"If-None-Match": `W/"vi1v4hbjily"`}, etag, true},
		{"weak ETag, strong token", map[string]string{"If-None-Match": `"vi1v4hbjily"`}, `W/"vi1v4hbjily"`, true},
		{"star", map[string]string{"If-None-Match": "*"}, etag, true},
		{"star with no ETag", map[string]string{"If-None-Match": "*"}, "", true},
		{"a token in a list", map[string]string{"If-None-Match": `"x" ,  "vi1v4hbjily"`}, etag, true},
		{"an empty token first", map[string]string{"If-None-Match": `,"vi1v4hbjily"`}, etag, true},
		{"mismatch", map[string]string{"If-None-Match": `"vi1v4hbjilz"`}, etag, false},
		{"unquoted", map[string]string{"If-None-Match": `vi1v4hbjily`}, etag, false},
		{"case differs", map[string]string{"If-None-Match": `"VI1V4HBJILY"`}, etag, false},
		{"star inside a list is a token", map[string]string{"If-None-Match": `"x", *`}, etag, false},
		{"no ETag", map[string]string{"If-None-Match": `"vi1v4hbjily"`}, "", false},
		{"If-Modified-Since alone", map[string]string{"If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT"}, etag, false},
		{"If-Modified-Since in the future", map[string]string{"If-Modified-Since": "Fri, 01 Jan 2100 00:00:00 GMT"}, etag, false},
		{"both, matching If-None-Match", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT"}, etag, false},
		{"both, star", map[string]string{"If-None-Match": "*", "If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT"}, etag, false},
		{"no-cache", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": "no-cache"}, etag, false},
		{"no-cache in a list", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": "max-age=0, no-cache"}, etag, false},
		{"no-cache before a comma", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": "no-cache ,max-age=0"}, etag, false},
		{"no-cache with a value is not no-cache", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": `no-cache="set-cookie"`}, etag, true},
		{"No-Cache: the test is case-sensitive", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": "No-Cache"}, etag, true},
		{"max-age=0 only", map[string]string{"If-None-Match": `"vi1v4hbjily"`, "Cache-Control": "max-age=0"}, etag, true},
		{"no-cache, nothing conditional", map[string]string{"Cache-Control": "no-cache"}, etag, false},
	} {
		h := http.Header{}
		for k, v := range c.headers {
			h.Set(k, v)
		}
		if got := Fresh(h, c.etag); got != c.want {
			t.Errorf("%s: Fresh = %v, want %v", c.name, got, c.want)
		}
	}
	// An empty value is absent (`!modifiedSince && !noneMatch`).
	h := http.Header{"If-None-Match": {""}, "If-Modified-Since": {""}}
	if Fresh(h, etag) {
		t.Error("empty If-None-Match and If-Modified-Since: fresh")
	}
	h = http.Header{"If-None-Match": {`"vi1v4hbjily"`}, "If-Modified-Since": {""}}
	if !Fresh(h, etag) {
		t.Error("a matching If-None-Match with an empty If-Modified-Since: not fresh")
	}
}

func TestParseTokenListIsFreshs(t *testing.T) {
	for in, want := range map[string][]string{
		`"a"`:              {`"a"`},
		` "a" , "b",,"c" `: {`"a"`, `"b"`, ``, `"c"`},
		`a b`:              {`a b`},
		``:                 {``},
	} {
		got := parseTokenList(in)
		if len(got) != len(want) {
			t.Errorf("%q: %q, want %q", in, got, want)
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%q: %q, want %q", in, got, want)
				break
			}
		}
	}
}

// The conditional requests Fresh does not decide as Next does: repeated lines or non-ASCII bytes in a
// header fresh reads, on a request that is conditional at all.
func TestConditionalUnsupported(t *testing.T) {
	for _, c := range []struct {
		name string
		h    http.Header
		want bool
	}{
		{"not conditional", http.Header{}, false},
		{"not conditional, non-ASCII Cache-Control", http.Header{"Cache-Control": {"max-age=0, \xe9"}}, false},
		{"one ASCII If-None-Match", http.Header{"If-None-Match": {`"a"`}}, false},
		{"one ASCII line of each", http.Header{"If-None-Match": {`"a"`}, "If-Modified-Since": {"Sat, 21 Nov 2026 00:00:00 GMT"}, "Cache-Control": {"no-cache"}}, false},
		{"an empty If-None-Match", http.Header{"If-None-Match": {""}}, false},
		{"non-ASCII If-None-Match", http.Header{"If-None-Match": {"\"\xc3\xa9\""}}, true},
		{"non-ASCII If-Modified-Since", http.Header{"If-Modified-Since": {"Sat, 21 Nov 2026 00:00:00 GMT\xa0"}}, true},
		{"non-ASCII Cache-Control on a conditional request", http.Header{"If-None-Match": {`"a"`}, "Cache-Control": {"no-cache\xa0"}}, true},
		{"two If-None-Match lines", http.Header{"If-None-Match": {`"a"`, `"b"`}}, true},
		{"two If-Modified-Since lines", http.Header{"If-Modified-Since": {"a", "b"}}, true},
		{"two Cache-Control lines on a conditional request", http.Header{"If-None-Match": {`"a"`}, "Cache-Control": {"max-age=0", "no-cache"}}, true},
	} {
		if got := ConditionalUnsupported(c.h); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
