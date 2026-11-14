package feed

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Expected values below are the ones src/shared/utils/__tests__/promotion.test.ts and
// src/server/services/__tests__/promotion.service.test.ts pin for the Node functions.

func TestSponsoredSlotIndex(t *testing.T) {
	cases := []struct{ pinned, length, want int }{{3, 10, 3}, {0, 10, 1}, {0, 0, 0}}
	for _, c := range cases {
		if got := SponsoredSlotIndex(c.pinned, c.length); got != c.want {
			t.Errorf("SponsoredSlotIndex(%d, %d) = %d, want %d", c.pinned, c.length, got, c.want)
		}
	}
}

func TestSponsoredBrowsingLevel(t *testing.T) {
	// PG viewer level, PG|R|X before the gallery's cap, a run servable at PG|R: PG|R (5).
	preCap := 1 | 4 | 8
	if got := SponsoredBrowsingLevel(1, &preCap, 1|4); got != 5 {
		t.Fatalf("with a pre-cap level = %d, want 5", got)
	}
	// No pre-cap level: the capped level (PG) held to everything is PG.
	if got := SponsoredBrowsingLevel(1, nil, 31); got != 1 {
		t.Fatalf("without a pre-cap level = %d, want 1", got)
	}
}

func TestIsPromotionLive(t *testing.T) {
	acceptedAt := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	at := func(s string) time.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	ends := at("2026-10-01T12:00:00Z")
	cases := []struct {
		endsAt *time.Time
		now    string
		want   bool
	}{
		// A 1-day run with no frozen end: live from accept until accept + 1 day.
		{nil, "2026-10-01T23:59:59Z", true},
		{nil, "2026-10-02T00:00:00Z", false},
		{nil, "2026-09-30T23:59:59Z", false},
		// The end frozen at accept wins over accept + days.
		{&ends, "2026-10-01T11:59:59Z", true},
		{&ends, "2026-10-01T12:00:00Z", false},
	}
	for _, c := range cases {
		if got := IsPromotionLive(acceptedAt, 1, c.endsAt, at(c.now)); got != c.want {
			t.Errorf("live at %s (endsAt %v) = %v, want %v", c.now, c.endsAt, got, c.want)
		}
	}
}

func TestParseGalleryPromotion(t *testing.T) {
	ok, err := ParseGalleryPromotion(json.RawMessage(`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[11,12]}`))
	if err != nil || ok == nil {
		t.Fatalf("well-formed payload: %v %v", ok, err)
	}
	if want := (GalleryPromotion{PostID: 5, Days: 3, ModelVersionIDs: []int{9}, ImageIDs: []int{11, 12}}); !reflect.DeepEqual(*ok, want) {
		t.Fatalf("parsed = %+v, want %+v", *ok, want)
	}
	accepted, err := ParseGalleryPromotion(json.RawMessage(`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":3,"endsAt":"2026-10-04T00:00:00.000Z"}`))
	if err != nil || accepted == nil || accepted.AcceptedLevel != 3 || !accepted.EndsAt.Equal(time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("accepted payload: %+v %v", accepted, err)
	}

	refused := []string{
		`{"postId":5,"days":2,"modelVersionIds":[9],"imageIds":[11]}`,   // not a run length
		`{"postId":5,"days":3,"modelVersionIds":[],"imageIds":[11]}`,    // no versions
		`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[]}`,     // no approved images
		`{"postId":"5","days":3,"modelVersionIds":[9],"imageIds":[11]}`, // a string is not an integer
		`{"postId":5.5,"days":3,"modelVersionIds":[9],"imageIds":[11]}`, // nor is a fraction
		`{"postId":0,"days":3,"modelVersionIds":[9],"imageIds":[11]}`,
		`{"postId":5,"days":3,"modelVersionIds":[9,-1],"imageIds":[11]}`,
		`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":3}`,                  // half an acceptance
		`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":null,"endsAt":null}`, // null is not undefined
		`[1,2]`,
		`null`,
	}
	for _, raw := range refused {
		if p, err := ParseGalleryPromotion(json.RawMessage(raw)); p != nil || err != nil {
			t.Errorf("%s: got %+v %v, want refused", raw, p, err)
		}
	}
	// An endsAt Date.parse might read but that is not ISO: not reproduced, so it falls back.
	_, err = ParseGalleryPromotion(json.RawMessage(`{"postId":5,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":3,"endsAt":"soon"}`))
	if fallback.Reason(err) != "sponsored-data" {
		t.Fatalf("non-ISO endsAt: err %v", err)
	}
}

func TestPromotionServingLevel(t *testing.T) {
	cases := []struct {
		name     string
		m        PromotionModel
		accepted int
		want     int
	}{
		// The frozen accept cap wins over a gallery lowered to PG since.
		{"frozen cap", PromotionModel{GalleryLevel: json.RawMessage(`1`)}, 1 | 4, 5},
		// The minor lock set after accept still applies: everything & SFW.
		{"minor after accept", PromotionModel{Minor: true}, 31, 3},
		{"sfw only after accept", PromotionModel{SfwOnly: true}, 1 | 4, 1},
		// No acceptance: hostPromotionLevel.
		{"host level", PromotionModel{GalleryLevel: json.RawMessage(`5`)}, 0, 5},
		{"host level above every level", PromotionModel{GalleryLevel: json.RawMessage(`63`)}, 0, 31},
		{"host level absent", PromotionModel{}, 0, 31},
		{"host level null", PromotionModel{GalleryLevel: json.RawMessage(`null`)}, 0, 31},
		{"host level 0", PromotionModel{GalleryLevel: json.RawMessage(`0`)}, 0, 31},
		{"minor host", PromotionModel{Minor: true, GalleryLevel: json.RawMessage(`31`)}, 0, 3},
	}
	for _, c := range cases {
		got, err := PromotionServingLevel(&c.m, c.accepted)
		if err != nil || got != c.want {
			t.Errorf("%s: %d %v, want %d", c.name, got, err, c.want)
		}
	}
	if _, err := PromotionServingLevel(&PromotionModel{GalleryLevel: json.RawMessage(`"4"`)}, 0); fallback.Reason(err) != "sponsored-data" {
		t.Fatalf("a string level: err %v", err)
	}
}

func TestPromotionAudience(t *testing.T) {
	mod := &Viewer{ID: 5, IsModerator: true}
	user := &Viewer{ID: 6}
	type res struct{ on, known bool }
	cases := []struct {
		env    string
		viewer *Viewer
		want   res
	}{
		{"false", nil, res{false, true}},
		{"false", mod, res{false, true}},
		{"", user, res{false, false}}, // unset: the fail-safe
		{"true", mod, res{false, false}},
		{"yes-please", nil, res{false, false}},
		{"mods-testers", nil, res{false, true}},
		{"mods-testers", mod, res{true, true}},
		{"mods-testers", user, res{false, false}}, // may be on a tester list
		{"MODS-TESTERS", mod, res{true, true}},
		{"everyone", nil, res{true, true}},
		{"everyone", user, res{true, true}},
	}
	for _, c := range cases {
		on, known := ParsePromotionAudience(c.env).For(c.viewer)
		if (res{on, known}) != c.want {
			t.Errorf("%q / %+v: on=%v known=%v, want %+v", c.env, c.viewer, on, known, c.want)
		}
	}
}

// fakePromotions is a PromotionStore with canned rows.
type fakePromotions struct {
	rows       []PromotionRow
	model      *PromotionModel
	err        error
	since      []time.Time
	modelReads int
}

func (f *fakePromotions) LiveGalleryPromotions(_ context.Context, _ int, since time.Time) ([]PromotionRow, error) {
	f.since = append(f.since, since)
	return f.rows, f.err
}

func (f *fakePromotions) PromotionModel(context.Context, int) (*PromotionModel, error) {
	f.modelReads++
	return f.model, nil
}

func TestSponsoredGalleryPost(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	resolved := now.Add(-time.Minute)
	row := func(id int, data string) PromotionRow {
		return PromotionRow{ID: id, ResolvedAt: &resolved, Data: json.RawMessage(data)}
	}
	live := `{"postId":40,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":5,"endsAt":"2026-11-14T12:01:00.000Z"}`

	s := &fakePromotions{rows: []PromotionRow{row(1, live)}, model: &PromotionModel{GalleryLevel: json.RawMessage(`1`)}}
	got, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now)
	if err != nil {
		t.Fatal(err)
	}
	if want := (&SponsoredPick{PlacementID: 1, PostID: 40, ImageIDs: []int{11}, ServingLevel: 5}); !reflect.DeepEqual(got, want) {
		t.Fatalf("pick = %+v, want %+v", got, want)
	}
	// The window read is the longest run (7 days) back from now.
	if !s.since[0].Equal(time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("since = %v", s.since[0])
	}

	// Another version's gallery, an ended run, a refused payload, an unresolved row: nothing, and
	// the model is not read.
	ended := `{"postId":40,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":5,"endsAt":"2026-11-14T11:59:59.999Z"}`
	for name, rows := range map[string][]PromotionRow{
		"other version": {row(1, live)},
		"ended":         {row(1, ended)},
		"refused":       {row(1, `{"postId":40,"days":2,"modelVersionIds":[9],"imageIds":[11]}`)},
		"unresolved":    {{ID: 1, Data: json.RawMessage(live)}},
	} {
		s := &fakePromotions{rows: rows, model: &PromotionModel{}}
		version := 9
		if name == "other version" {
			version = 10
		}
		got, err := SponsoredGalleryPost(context.Background(), s, 7, version, now)
		if err != nil || got != nil || s.modelReads != 0 {
			t.Errorf("%s: %+v %v (model reads %d)", name, got, err, s.modelReads)
		}
	}

	// The host page is gone, or it may not be served at any level: nothing.
	s = &fakePromotions{rows: []PromotionRow{row(1, live)}}
	if got, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now); got != nil || err != nil {
		t.Fatalf("no model: %+v %v", got, err)
	}
	s = &fakePromotions{rows: []PromotionRow{row(1, `{"postId":40,"days":3,"modelVersionIds":[9],"imageIds":[11],"acceptedLevel":4,"endsAt":"2026-11-14T12:01:00.000Z"}`)}, model: &PromotionModel{SfwOnly: true}}
	if got, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now); got != nil || err != nil {
		t.Fatalf("serving level 0: %+v %v", got, err)
	}

	// Two live runs: Node picks one at random per request, which is not reproduced.
	s = &fakePromotions{rows: []PromotionRow{row(1, live), row(2, live)}, model: &PromotionModel{}}
	if _, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now); fallback.Reason(err) != "sponsored-rotation" {
		t.Fatalf("two live runs: err %v", err)
	}
	// One live run beside a refused one is not a rotation.
	s = &fakePromotions{rows: []PromotionRow{row(1, live), row(2, ended)}, model: &PromotionModel{}}
	if got, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now); err != nil || got == nil || got.PlacementID != 1 {
		t.Fatalf("one live of two: %+v %v", got, err)
	}

	// A read error is returned as is (the caller decides).
	s = &fakePromotions{err: errors.New("boom")}
	if _, err := SponsoredGalleryPost(context.Background(), s, 7, 9, now); err == nil || fallback.Reason(err) != "" {
		t.Fatalf("read error: %v", err)
	}
}
