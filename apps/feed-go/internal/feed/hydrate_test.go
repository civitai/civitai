package feed

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// recordingHydrator answers Page with a fixed page and records what Hydrate asked.
type recordingHydrator struct {
	page     *hydrate.Page
	pageErr  error
	model3d  map[int]bool
	m3dErr   error
	req      hydrate.PageRequest
	m3dCalls [][]int
	m3dMod   bool
	m3dUser  int
}

func (h *recordingHydrator) Page(_ context.Context, req hydrate.PageRequest) (*hydrate.Page, error) {
	h.req = req
	return h.page, h.pageErr
}

func (h *recordingHydrator) VisibleModel3DIDs(_ context.Context, ids []int, viewerID int, isModerator bool) (map[int]bool, error) {
	h.m3dCalls = append(h.m3dCalls, ids)
	h.m3dUser, h.m3dMod = viewerID, isModerator
	return h.model3d, h.m3dErr
}

func TestHydrateAsksForThePageAndJoinsModel3D(t *testing.T) {
	m3d := 77
	rows := []RawImage{
		{ID: 1, UserID: 10, Type: "image"},
		{ID: 2, UserID: 10, Type: "video", Model3DID: &m3d},
		{ID: 3, UserID: 20, Type: "video"},
	}
	page := &hydrate.Page{
		Basic:         map[int]hydrate.BasicUser{10: {ID: 10, Username: "u10"}},
		UserCosmetics: map[int][]any{10: {}},
		ProfilePics:   map[int]superjson.Object{20: {{Key: "id", Val: int64(5)}}},
		Frames:        map[int]superjson.Object{1: {{Key: "id", Val: int64(6)}}},
		Thumbs:        map[int]hydrate.Thumbnail{2: {URL: "t.jpeg"}},
		Metrics:       map[int]hydrate.Metrics{1: {"Like": 1}},
		TagIDs:        map[int]any{3: []any{int64(9)}},
		Decorations:   map[int]superjson.Object{2: {{Key: "id", Val: int64(7)}}},
		Reactions:     map[int][]any{1: {"r"}},
	}
	h := &recordingHydrator{page: page, model3d: map[int]bool{77: true}}
	events := map[string]bool{"ev": true}
	got, err := Hydrate(context.Background(), h, rows, Viewer{ID: 10, IsModerator: true}, events)
	if err != nil {
		t.Fatal(err)
	}
	want := hydrate.PageRequest{UserIDs: []int{10, 10, 20}, ImageIDs: []int{1, 2, 3}, VideoIDs: []int{2, 3}, VisibleEvents: events, ViewerID: 10}
	if !reflect.DeepEqual(h.req, want) {
		t.Fatalf("page request = %+v, want %+v", h.req, want)
	}
	if !reflect.DeepEqual(h.m3dCalls, [][]int{{77}}) || h.m3dUser != 10 || !h.m3dMod {
		t.Fatalf("model3d calls = %v (viewer %d, moderator %v), want [[77]] for viewer 10 as moderator", h.m3dCalls, h.m3dUser, h.m3dMod)
	}
	wantHy := &Hydrated{
		Basic: page.Basic, UserCosmetics: page.UserCosmetics, ProfilePics: page.ProfilePics, Frames: page.Frames,
		Thumbs: page.Thumbs, Metrics: page.Metrics, TagIDs: page.TagIDs, Decorations: page.Decorations,
		Reactions: page.Reactions, VisibleModel3D: map[int]bool{77: true},
	}
	if !reflect.DeepEqual(got, wantHy) {
		t.Fatalf("hydrated = %+v, want %+v", got, wantHy)
	}

	// No linked model: no visibility read.
	h = &recordingHydrator{page: &hydrate.Page{}}
	if got, err := Hydrate(context.Background(), h, rows[:1], Viewer{}, nil); err != nil || got.VisibleModel3D != nil || len(h.m3dCalls) != 0 {
		t.Fatalf("no model3d: %+v, %v, %d visibility reads; want none", got, err, len(h.m3dCalls))
	}
}

func TestHydrateErrors(t *testing.T) {
	boom := errors.New("boom")
	if _, err := Hydrate(context.Background(), &recordingHydrator{pageErr: boom}, []RawImage{{ID: 1}}, Viewer{}, nil); !errors.Is(err, boom) {
		t.Fatalf("page error = %v, want %v", err, boom)
	}
	m3d := 5
	h := &recordingHydrator{page: &hydrate.Page{}, m3dErr: boom}
	if _, err := Hydrate(context.Background(), h, []RawImage{{ID: 1, Model3DID: &m3d}}, Viewer{}, nil); !errors.Is(err, boom) {
		t.Fatalf("model3d error = %v, want %v", err, boom)
	}
}
