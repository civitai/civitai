package feed

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// v1ItemIDs is the `items[].id` of an /api/v1/images body, in order.
func v1ItemIDs(t *testing.T, body string) []int {
	t.Helper()
	var b struct {
		Items []struct {
			ID int `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &b); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	ids := make([]int, 0, len(b.Items))
	for _, it := range b.Items {
		ids = append(ids, it.ID)
	}
	return ids
}

// serveV1Key is ServeV1 for a request whose views are viewer (credentialViews applied: nil for a
// scoped key) and whose session user is sessionUserID.
func serveV1Key(t *testing.T, f *v1Fixture, query string, viewer *Viewer, sessionUserID int) []int {
	t.Helper()
	in, err := ParseV1With(query, f.deps.Ports)
	if err != nil {
		t.Fatalf("parse %q: %v", query, err)
	}
	ans, err := ServeV1(context.Background(), f.deps, V1Request{
		Input: in, Viewer: viewer, SessionUserID: sessionUserID, Host: "civitai.example", Path: "/api/v1/images",
	})
	if err != nil {
		t.Fatalf("serve %q: %v", query, err)
	}
	b, err := superjson.Plain(ans.Body)
	if err != nil {
		t.Fatal(err)
	}
	return v1ItemIDs(t, string(b))
}

// runImageSearch's credentialViews on the feed path (getImagesFromFeedServiceForRest): a full-scope key
// reads its user's own gallery as the owner (their unpublished image 11 shown, the addon tag
// exclusions off for their own feed); a scoped key of the same user (Viewer nil, the session user 5)
// reads it as anyone does (11 dropped by the publish filter, the exclusions kept), while the feed
// query's viewer is still that user (`currentUserId: user?.id`, viewerId=5). Literal expectations. On
// the pre-change code a scoped key had no reading at all (computeV1 fell back `bearer-token`), and with
// Viewer nil the feed query carried no viewerId: the scoped case's `viewerId=5` is what that code
// cannot produce.
func TestServeV1ScopedKeyIsNotTheOwnerOnTheFeedPath(t *testing.T) {
	unpublished := row(11, 101, "image", "b", 1, "")
	unpublished.PublishedAt = nil // the owner's unpublished post
	rows := []RawImage{unpublished, row(10, 100, "image", "a", 1, "")}

	full := newV1Fixture(rows)
	full.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11, 10}}
	if got := serveV1Key(t, full, "userId=5", &Viewer{ID: 5}, 5); !reflect.DeepEqual(got, []int{11, 10}) {
		t.Fatalf("full-scope key: items %v, want [11 10] (the owner sees their unpublished image)", got)
	}
	if q := full.feed.queries[0]; q != "levels=1&userIds=5&excludeMinor=1&excludePoi=1&viewerId=5&sort=reactions&limit=100" {
		t.Fatalf("full-scope key feed query = %s", q)
	}
	if h := full.hq[0]; h.ViewerID != 5 || h.SessionUserID != 5 || h.ExcludedTagIDs != nil {
		t.Fatalf("full-scope key hydrate viewer %d session %d excluded %v, want 5 5 []", h.ViewerID, h.SessionUserID, h.ExcludedTagIDs)
	}

	scoped := newV1Fixture(rows)
	scoped.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11, 10}}
	if got := serveV1Key(t, scoped, "userId=5", nil, 5); !reflect.DeepEqual(got, []int{10}) {
		t.Fatalf("scoped key: items %v, want [10] (not the owner: the unpublished image is withheld)", got)
	}
	if q := scoped.feed.queries[0]; q != "levels=1&excludedTags=5&userIds=5&excludeMinor=1&excludePoi=1&viewerId=5&sort=reactions&limit=100" {
		t.Fatalf("scoped key feed query = %s, want the exclusions kept and viewerId=5", q)
	}
	if h := scoped.hq[0]; h.ViewerID != 0 || h.SessionUserID != 5 || !reflect.DeepEqual(h.ExcludedTagIDs, []int{5}) {
		t.Fatalf("scoped key hydrate viewer %d session %d excluded %v, want 0 5 [5]", h.ViewerID, h.SessionUserID, h.ExcludedTagIDs)
	}

	// Control: signed out reads as the scoped key does, but with no feed viewer.
	anon := newV1Fixture(rows)
	anon.feed.ans = feedsvc.Answer{Status: 200, IDs: []int{11, 10}}
	if got := serveV1Key(t, anon, "userId=5", nil, 0); !reflect.DeepEqual(got, []int{10}) {
		t.Fatalf("signed out: items %v, want [10]", got)
	}
	if q := anon.feed.queries[0]; q != "levels=1&excludedTags=5&userIds=5&excludeMinor=1&excludePoi=1&sort=reactions&limit=100" {
		t.Fatalf("signed-out feed query = %s, want no viewerId", q)
	}
}

// The legacy path (getAllImages: an `ids` batch) reads the same views: the scoped key's own
// unpublished image is withheld there too, and the page is still its user's own (personalizedPage:
// SessionUserID, so a statement timeout is a fallback, as Node errors).
func TestServeV1ScopedKeyIsNotTheOwnerOnTheLegacyPath(t *testing.T) {
	unpublished := legacyRow(11, 101, 11)
	unpublished.PublishedAt = nil
	rows := []RawImage{unpublished, legacyRow(10, 100, 10)}

	full := newV1Fixture(rows)
	if got := serveV1Key(t, full, "ids=11,10&userId=5", &Viewer{ID: 5}, 5); !reflect.DeepEqual(got, []int{11, 10}) {
		t.Fatalf("full-scope key: items %v, want [11 10]", got)
	}
	scoped := newV1Fixture(rows)
	if got := serveV1Key(t, scoped, "ids=11,10&userId=5", nil, 5); !reflect.DeepEqual(got, []int{10}) {
		t.Fatalf("scoped key: items %v, want [10]", got)
	}
	h := scoped.hq[0]
	if h.ViewerID != 0 || h.SessionUserID != 5 || h.TargetUserID != 5 {
		t.Fatalf("scoped key legacy query viewer %d session %d target %d, want 0 5 5", h.ViewerID, h.SessionUserID, h.TargetUserID)
	}
	if b := h.Build(); b.PersonalizedViewerID != 5 {
		t.Fatalf("scoped key's own page: PersonalizedViewerID %d, want 5 (Node's personalizedPage reads userId)", b.PersonalizedViewerID)
	}
}

// personalizedPage is `!!userId && (reactions || targetUserId === userId)` with userId the SESSION
// user (SessionUserID, else ViewerID), not the owner view. Literal cases; the scoped-key one (ViewerID
// 0, SessionUserID 5, target 5) is 0 under the pre-change rule, which read ViewerID alone.
func TestImagesQueryPersonalizedViewerIsTheSessionUser(t *testing.T) {
	for _, c := range []struct {
		name string
		q    ImagesQuery
		want int
	}{
		{"a cookie session's own page", ImagesQuery{Limit: 5, ViewerID: 5, TargetUserID: 5}, 5},
		{"a scoped key's own page", ImagesQuery{Limit: 5, SessionUserID: 5, TargetUserID: 5}, 5},
		{"a scoped key on another's page", ImagesQuery{Limit: 5, SessionUserID: 6, TargetUserID: 5}, 0},
		{"signed out", ImagesQuery{Limit: 5, TargetUserID: 5}, 0},
		{"no target", ImagesQuery{Limit: 5, SessionUserID: 5}, 0},
	} {
		if got := c.q.Build().PersonalizedViewerID; got != c.want {
			t.Errorf("%s: PersonalizedViewerID %d, want %d", c.name, got, c.want)
		}
	}
}
