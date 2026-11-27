package feed

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// With the JudgeScore port on, a collection page answers each item's parseJudgeScore: the judged
// item its score, the unjudged one null. A score the port does not rebuild still falls back; off, any
// score does (as before the port).
func TestServeInfiniteJudgeScorePort(t *testing.T) {
	serve := func(on bool, rows []RawImage) (map[string]any, error) {
		t.Helper()
		f := newInfFixture(t)
		f.deps.Ports.JudgeScore = on
		f.deps.Sources.(*fakeV1Sources).collections = map[int]hydrate.CollectionPermission{9103: {Read: "Public", OwnerID: 7}}
		f.rows = rows
		j, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9103")}, InfiniteRequest{Cap: 1})
		return j, err
	}
	judged := []RawImage{
		withItem(infRow(31, 100), "ACCEPTED", nil, nil),
		withItem(infRow(32, 100), "ACCEPTED", nil, strp(`{"score":{"theme":7,"wittiness":5.5},"summary":"s"}`)),
		withItem(infRow(33, 100), "ACCEPTED", nil, strp(`{"comment":"no score"}`)),
	}
	j, err := serve(true, judged)
	if err != nil {
		t.Fatalf("port on: %v", err)
	}
	var scores []any
	for _, it := range j["items"].([]any) {
		item := it.(map[string]any)
		v, present := item["judgeScore"]
		if !present {
			t.Fatalf("item %v: no judgeScore key", item["id"])
		}
		scores = append(scores, v)
	}
	want := []any{nil, map[string]any{"theme": 7.0, "wittiness": 5.5}, nil}
	if !reflect.DeepEqual(scores, want) {
		t.Fatalf("judgeScores = %#v, want %#v", scores, want)
	}
	if _, err := serve(false, judged); fallback.Reason(err) != "collection-judge-score" {
		t.Fatalf("port off: %v, want collection-judge-score", err)
	}
	unmodelled := []RawImage{withItem(infRow(31, 100), "ACCEPTED", nil, strp(`{"score":{"theme":-0}}`))}
	if _, err := serve(true, unmodelled); fallback.Reason(err) != "collection-judge-score" {
		t.Fatalf("an unmodelled score with the port on: %v, want collection-judge-score", err)
	}
	// Off, a page with no score is still answered (null).
	if _, err := serve(false, judged[:1]); err != nil {
		t.Fatalf("port off, no score: %v", err)
	}
}

// The Hat Turf keys are validated as getInfiniteImagesSchema does whatever the switch (a rejected value
// is the BAD_REQUEST); off, a truthy one still falls back as before; on, it is read into Hat.
func TestParseInfiniteHatTurf(t *testing.T) {
	on := InfinitePorts{HatTurfIgnored: true}
	teams := func(s string, n int) string {
		return `[` + strings.TrimSuffix(strings.Repeat(`"`+s+`",`, n), ",") + `]`
	}
	for input, want := range map[string]string{
		`{"hatSort":"most"}`:                               "infinite-hat-turf",
		`{"hideWornHats":true}`:                            "infinite-hat-turf",
		`{"hatSort":""}`:                                   "input-invalid",
		`{"hatTurfMine":null}`:                             "input-invalid",
		`{"hideTurfHats":0}`:                               "infinite-hat-turf", // non-empty to the off check, as before
		`{"hatTeams":"red"}`:                               "input-invalid",
		`{"hatTeams":[1]}`:                                 "input-invalid",
		`{"hatTeams":null}`:                                "input-invalid",
		`{"hatTeams":` + teams("a", 9) + `}`:               "input-invalid",
		`{"hatTeams":["` + strings.Repeat("a", 33) + `"]}`: "input-invalid",
		`{"hatTeams":["` + strings.Repeat("\U0001F600", 17) + `"]}`: "input-invalid",
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{}); fallback.Reason(err) != want {
			t.Errorf("off %s: %v, want %s", input, err, want)
		}
	}
	for input, want := range map[string]string{
		`{"hatSort":"bogus"}`: "input-invalid",
		`{"hatSort":"Most"}`:  "input-invalid",
		`{"hatTurfMine":"1"}`: "input-invalid",
		`{"hatSort":null}`:    "input-invalid",
		`{"hatTeams":[null]}`: "input-invalid",
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), on); fallback.Reason(err) != want {
			t.Errorf("on %s: %v, want %s", input, err, want)
		}
	}
	for input, hat := range map[string]bool{
		`{"hatSort":"most"}`:                                        true,
		`{"hatSort":"fewest","hatTeams":["red"]}`:                   true,
		`{"hatTurfMine":true}`:                                      true,
		`{"hatTurfExpired":true}`:                                   true,
		`{"hideTurfHats":true}`:                                     true,
		`{"hideWornHats":true}`:                                     true,
		`{"hatTurfMine":false,"hideWornHats":false}`:                false,
		`{"hatTeams":` + teams("a", 8) + `}`:                        false,
		`{"hatTeams":["` + strings.Repeat("a", 32) + `"]}`:          false,
		`{"hatTeams":["` + strings.Repeat("é", 32) + `"]}`:          false,
		`{"hatTeams":["` + strings.Repeat("\U0001F600", 16) + `"]}`: false,
		`{"limit":2}`: false,
	} {
		in, err := ParseInfiniteWith(parseObj(t, input), on)
		if err != nil {
			t.Errorf("on %s: %v", input, err)
			continue
		}
		if in.Hat != hat || in.ViewerScoped() != hat {
			t.Errorf("on %s: Hat %v ViewerScoped %v, want %v", input, in.Hat, in.ViewerScoped(), hat)
		}
	}
	// Valid falsy values, off: no hat, served as before.
	if in, err := ParseInfiniteWith(parseObj(t, `{"hatTurfMine":false,"hatTeams":["red"]}`), InfinitePorts{}); err != nil || in.Hat {
		t.Fatalf("off, falsy hats: %+v %v", in, err)
	}
}

// With the port on, a hat key is answered as the feed without it where Node never asks whether the
// viewer plays (signed out, or a scoped feed), and falls back on a signed-in viewer's main feed.
func TestServeInfiniteHatTurfIgnored(t *testing.T) {
	serve := func(m map[string]any, req InfiniteRequest) ([]string, error) {
		t.Helper()
		f := newInfFixture(t)
		in, err := ParseInfiniteWith(m, InfinitePorts{HatTurfIgnored: true})
		if err != nil {
			t.Fatalf("parse %v: %v", m, err)
		}
		req.Input = in
		_, err = ServeInfinite(context.Background(), f.deps, req)
		return f.feed.queries, err
	}
	with := func(base map[string]any, k string, v any) map[string]any {
		out := map[string]any{k: v}
		for kk, vv := range base {
			out[kk] = vv
		}
		return out
	}
	signedIn := InfiniteRequest{Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"}
	for _, c := range []struct {
		name string
		base map[string]any
		req  InfiniteRequest
	}{
		{"signed out, main feed", map[string]any{"limit": num("3")}, InfiniteRequest{Cap: 1}},
		{"signed in, a creator", map[string]any{"userId": num("5"), "limit": num("3")}, signedIn},
		{"signed in, a username", map[string]any{"username": "alice", "limit": num("3")}, signedIn},
		{"signed in, a Model3D", map[string]any{"model3dId": num("4"), "limit": num("3")}, signedIn},
	} {
		plain, err := serve(c.base, c.req)
		if err != nil || len(plain) != 1 {
			t.Fatalf("%s without hats: queries %v err %v", c.name, plain, err)
		}
		for k, v := range map[string]any{"hatSort": "most", "hatTurfMine": true, "hatTurfExpired": true, "hideTurfHats": true, "hideWornHats": true} {
			got, err := serve(with(with(c.base, k, v), "hatTeams", []any{"red"}), c.req)
			if err != nil || !reflect.DeepEqual(got, plain) {
				t.Errorf("%s, %s: queries %v err %v; want %v as without it", c.name, k, got, err, plain)
			}
		}
	}
	for k, v := range map[string]any{"hatSort": "fewest", "hatTurfMine": true, "hideWornHats": true} {
		got, err := serve(map[string]any{k: v, "limit": num("3")}, signedIn)
		if fallback.Reason(err) != "infinite-hat-turf" || len(got) != 0 {
			t.Errorf("signed in, main feed, %s: queries %v err %v; want infinite-hat-turf before the feed", k, got, err)
		}
	}
	// Falsy hat values alone are no hat: a signed-in main feed is served.
	if got, err := serve(map[string]any{"hatTurfMine": false, "hatTeams": []any{"red"}, "limit": num("3")}, signedIn); err != nil || len(got) != 1 {
		t.Fatalf("signed in, falsy hats: queries %v err %v", got, err)
	}
}
