package feed

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// FuzzParse feeds Parse what the handler feeds it: a tRPC input envelope decoded by
// trpc.DecodeEnvelope. Parse never panics; it refuses only with a fallback (the request is then
// answered by the Node app, never with a Go error page); and an accepted input stays inside the
// schema's bounds (limit 0..200, a non-negative cursor, a known sort/period/periodMode), with the
// cursor accessors and ApplyDomainCap safe on it. Seed corpus: testdata/fuzz/FuzzParse.
func FuzzParse(f *testing.F) {
	f.Add([]byte(`{"json":{"modelId":5001,"modelVersionId":6001,"sort":"Newest","period":"AllTime","browsingLevel":31,"limit":10}}`))
	f.Add([]byte(`{"json":{"cursor":"feed:1:2","include":["cosmetics","meta"],"excludedTagIds":[1,2]}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		m, err := trpc.DecodeEnvelope(raw)
		if err != nil {
			return
		}
		in, err := Parse(m)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("Parse(%s) refused with a non-fallback error: %v", raw, err)
			}
			return
		}
		if in.Limit < 0 || in.Limit > 200 || in.Cursor < 0 {
			t.Fatalf("Parse(%s): limit %d cursor %d out of bounds", raw, in.Limit, in.Cursor)
		}
		if !knownSorts[in.Sort] || !knownPeriods[in.Period] || (in.PeriodMode != "published" && in.PeriodMode != "stats") {
			t.Fatalf("Parse(%s): sort %q period %q periodMode %q", raw, in.Sort, in.Period, in.PeriodMode)
		}
		for _, lv := range []*int{in.BrowsingLevel, in.PreCapBrowsingLevel} {
			if lv != nil && *lv < 0 {
				t.Fatalf("Parse(%s): negative browsing level %d", raw, *lv)
			}
		}
		_ = in.NumericCursor()
		for _, domainCap := range []int{0, 1, 31} {
			cp := *in
			_, _ = cp.ApplyDomainCap(domainCap, false)
		}
	})
}

// FuzzParseInfinite is FuzzParse for image.getInfinite's parser: it never panics, refuses only with a
// fallback, and an accepted input keeps the gallery bounds plus its own: a positive creator id or
// none, a username inside usernameSchema, a non-negative post id, and no Hat Turf key. Seed corpus:
// testdata/fuzz/FuzzParseInfinite.
func FuzzParseInfinite(f *testing.F) {
	f.Add([]byte(`{"json":{"userId":5,"tags":[1,-2],"postId":7,"sort":"Newest","limit":10}}`))
	f.Add([]byte(`{"json":{"username":"a_b","include":["cosmetics","profilePictures"],"cursor":"feed:1:2"}}`))
	f.Add([]byte(`{"json":{"hatSort":"most","hatTeams":["x"]}}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		m, err := trpc.DecodeEnvelope(raw)
		if err != nil {
			return
		}
		in, err := ParseInfinite(m)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("ParseInfinite(%s) refused with a non-fallback error: %v", raw, err)
			}
			return
		}
		if in.Limit < 0 || in.Limit > 200 || in.Cursor < 0 || in.UserID < 0 || in.PostID < 0 {
			t.Fatalf("ParseInfinite(%s): limit %d cursor %d userId %d postId %d out of bounds", raw, in.Limit, in.Cursor, in.UserID, in.PostID)
		}
		if !usernameRE.MatchString(in.Username) {
			t.Fatalf("ParseInfinite(%s): username %q outside the schema", raw, in.Username)
		}
		for _, k := range hatKeys {
			if v, ok := m[k]; ok && !isEmpty(v) {
				t.Fatalf("ParseInfinite(%s): accepted a Hat Turf key %s", raw, k)
			}
		}
		_ = in.dbPath()
		_ = in.ownScoped(in.UserID, in.Username)
		for _, domainCap := range []int{0, 1, 31} {
			cp := *in
			_, _ = cp.ApplyDomainCap(domainCap, false)
		}
	})
}
