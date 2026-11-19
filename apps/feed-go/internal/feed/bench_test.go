package feed

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// benchPage is a 50-image page with every hydration joined in: users with cosmetics and profile
// pictures, metrics, tag ids, a frame on every fifth image, a video thumbnail on every tenth.
func benchPage() ([]RawImage, *Hydrated, time.Time) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	hy := &Hydrated{
		Basic: map[int]hydrate.BasicUser{}, UserCosmetics: map[int][]any{}, ProfilePics: map[int]superjson.Object{},
		Frames: map[int]superjson.Object{}, Thumbs: map[int]hydrate.Thumbnail{}, Metrics: map[int]hydrate.Metrics{},
		TagIDs: map[int]any{}, Decorations: map[int]superjson.Object{}, Reactions: map[int][]any{}, VisibleModel3D: map[int]bool{},
	}
	rows := make([]RawImage, 50)
	for i := range rows {
		id, user := 8000+i, 1000+i%7
		name, url, hash, mime := "image name", "a1b2c3d4-e5f6-7890.jpeg", "UGF4mDof00of~qayM{j[00ay-;j[", "image/jpeg"
		w, h, idx, mv := 832, 1216, i%4, 6001
		pub := now.Add(-time.Duration(i) * time.Hour)
		onSite := i%2 == 0
		typ := "image"
		if i%10 == 0 {
			typ = "video"
			hy.Thumbs[id] = hydrate.Thumbnail{URL: "thumb.jpeg", NsfwLevel: 1, Width: int64(450), Height: int64(800)}
		}
		rows[i] = RawImage{
			ID: id, Name: &name, URL: &url, NsfwLevel: 1, Width: &w, Height: &h, Hash: &hash, HasMeta: true,
			HasPositivePrompt: true, OnSite: &onSite, CreatedAt: pub, SortAt: pub, MimeType: &mime, Type: typ,
			Metadata:  json.RawMessage(`{"size":123456,"width":832,"height":1216,"hash":"UGF4mDof00of"}`),
			Ingestion: "Scanned", UserID: user, PostID: 7000 + i/3, Index: &idx, PublishedAt: &pub,
			ModelVersionID: &mv, Availability: "Public", CursorID: id,
		}
		hy.Basic[user] = hydrate.BasicUser{ID: user, Username: "someone", Image: "avatar.jpeg"}
		hy.UserCosmetics[user] = []any{superjson.Object{{Key: "data", Val: json.RawMessage(`{"url":"badge.png"}`)}, {Key: "cosmetic", Val: superjson.Object{{Key: "type", Val: "Badge"}}}}}
		hy.ProfilePics[user] = superjson.Object{{Key: "id", Val: int64(user)}, {Key: "url", Val: "pp.jpeg"}, {Key: "nsfwLevel", Val: int64(1)}}
		hy.Metrics[id] = hydrate.Metrics{"ReactionLike": 17, "ReactionHeart": 3, "Comment": 2, "Collection": 1}
		hy.TagIDs[id] = []any{int64(501), int64(520), int64(533)}
		if i%5 == 0 {
			hy.Frames[id] = superjson.Object{{Key: "id", Val: int64(9)}, {Key: "data", Val: json.RawMessage(`{"cssFrame":"x"}`)}}
		}
	}
	return rows, hy, now
}

// BenchmarkBuildImages is the per-image build of a page: the published filter and the wire object
// of every image, joined with its hydration.
func BenchmarkBuildImages(b *testing.B) {
	rows, hy, now := benchPage()
	viewer := Viewer{ID: 1003}
	b.ReportAllocs()
	for b.Loop() {
		if got := BuildImages(rows, hy, viewer, now); len(got) != len(rows) {
			b.Fatalf("built %d of %d images", len(got), len(rows))
		}
	}
}
