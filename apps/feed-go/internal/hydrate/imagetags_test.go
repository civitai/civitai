package hydrate

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The votable tags as Node builds them for basePageFixture's images 11 and 13, with viewer 1001's
// votes merged: getImageTagsForImages' `{...rest, imageId, id, type, nsfwLevel, name}`, then `vote`
// (3 → 1, 0 → -1). Written out by hand from src/server/services/image.service.ts, not from the code.
const (
	wantImageTags11 = `[{"score":7,"upVotes":2,"downVotes":0,"automated":false,"needsReview":false,"concrete":true,` +
		`"lastUpvote":"2026-06-14T10:00:00.000Z","source":"User","imageId":11,"id":21,"type":"UserGenerated","nsfwLevel":1,"name":"red","vote":1},` +
		`{"score":2.5,"upVotes":0,"downVotes":1,"automated":true,"needsReview":null,"concrete":true,"lastUpvote":null,"source":"WD14",` +
		`"imageId":11,"id":22,"type":"Label","nsfwLevel":2,"name":"fox","vote":-1}]`
	// 13's vote is on tag 99, which 13 does not carry: no `vote`.
	wantImageTags13 = `[{"score":0,"upVotes":0,"downVotes":0,"automated":true,"needsReview":false,"concrete":true,"lastUpvote":null,` +
		`"source":"Rekognition","imageId":13,"id":23,"type":"Label","nsfwLevel":1,"name":"sky"}]`
)

// With the 'tags' include, Page reads imageTagsCache in its first pipeline and the viewer's votes from
// the replica: per image with tags, Node's tag objects; a notFound entry (12) and an empty list (14)
// are absent (`tags: undefined`). The per-lookup reference agrees, and the page still takes two
// pipelines.
func TestPageImageTags(t *testing.T) {
	ctx := context.Background()
	s, r, db := basePageFixture(t).load()
	got, err := s.Page(ctx, tagsPageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if r.Calls != 2 {
		t.Fatalf("%d pipelines, want 2 (the tags read joins stage 1)", r.Calls)
	}
	if keys := sortedKeys(got.Tags); !reflect.DeepEqual(keys, []int{11, 13}) {
		t.Fatalf("tags for %v, want [11 13]", keys)
	}
	if s := pagePlain(t, got.Tags[11]); s != wantImageTags11 {
		t.Fatalf("image 11 tags\n got %s\nwant %s", s, wantImageTags11)
	}
	if s := pagePlain(t, got.Tags[13]); s != wantImageTags13 {
		t.Fatalf("image 13 tags\n got %s\nwant %s", s, wantImageTags13)
	}
	votes := 0
	for _, q := range db.Calls {
		if strings.Contains(q, `FROM "TagsOnImageVote"`) {
			votes++
		}
	}
	if votes != 1 {
		t.Fatalf("%d vote queries, want 1", votes)
	}

	s, _, _ = basePageFixture(t).load()
	want, err := perLookup(ctx, s, tagsPageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Page differs from the per-lookup answer:\n got %#v\nwant %#v", got.Tags, want.Tags)
	}
}

// Signed out: the tags without any `vote`, and no vote query at all (Node: `include.includes('tags')
// && userId`).
func TestPageImageTagsSignedOut(t *testing.T) {
	s, _, db := basePageFixture(t).load()
	req := tagsPageRequest()
	req.ViewerID = 0
	got, err := s.Page(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if s := pagePlain(t, got.Tags[11]); strings.Contains(s, `"vote"`) || !strings.Contains(s, `"name":"red"`) {
		t.Fatalf("signed-out tags of 11 = %s, want them without a vote", s)
	}
	for _, q := range db.Calls {
		if strings.Contains(q, "TagsOnImageVote") {
			t.Fatalf("a signed-out page queried the votes: %s", q)
		}
	}
}

// Without the 'tags' include (the gallery, and image.getInfinite's default), imageTagsCache is not
// read and no vote is queried; with it, it is (the positive control: the ledger can see the key).
func TestPageWithoutTagsReadsNoTags(t *testing.T) {
	for _, tags := range []bool{false, true} {
		s, r, db := basePageFixture(t).load()
		keys := recordKeys(r)
		req := pageRequest()
		req.Tags = tags
		got, err := s.Page(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		read := slices.Contains(keys(), pageNS+KeyImageTags+":11")
		voted := slices.ContainsFunc(db.Calls, func(q string) bool { return strings.Contains(q, "TagsOnImageVote") })
		if read != tags || voted != tags || (len(got.Tags) > 0) != tags || got.Tags == nil {
			t.Fatalf("tags %v: cache read %v, votes queried %v, tags %v; want the read, the query and tags only with the include",
				tags, read, voted, got.Tags)
		}
	}
}

// A missing image-tags entry (no key, or a debounce marker) falls back without a computation, as every
// other computed cache does; an entry Node's `.tags.map` would throw on falls back too.
func TestImageTagsMissFallsBack(t *testing.T) {
	for name, c := range map[string]struct {
		change func(testing.TB, *pageFixture)
		reason string
	}{
		"absent":         {func(_ testing.TB, f *pageFixture) { f.del(KeyImageTags, 13) }, "image-tags-miss"},
		"debounced":      {func(tb testing.TB, f *pageFixture) { f.put(tb, KeyImageTags, 11, map[string]any{"debounce": true}) }, "image-tags-miss"},
		"no tags list":   {func(tb testing.TB, f *pageFixture) { f.put(tb, KeyImageTags, 14, map[string]any{"imageId": 14}) }, "image-tags-shape"},
		"a non-object":   {func(tb testing.TB, f *pageFixture) { f.put(tb, KeyImageTags, 14, map[string]any{"tags": []any{7}}) }, "image-tags-shape"},
		"undecodable 11": {func(_ testing.TB, f *pageFixture) { f.strings[pageNS+KeyImageTags+":11"] = []byte{0xc1} }, "image-tags-miss"},
	} {
		t.Run(name, func(t *testing.T) {
			f := basePageFixture(t)
			c.change(t, f)
			s, _, _ := f.load()
			_, err := s.Page(context.Background(), tagsPageRequest())
			if got := fallback.Reason(err); got != c.reason {
				t.Fatalf("Page err = %v (reason %q), want %q", err, got, c.reason)
			}
			// Without the include the same cache contents are never read: no fallback.
			s, _, _ = f.load()
			if _, err := s.Page(context.Background(), pageRequest()); err != nil {
				t.Fatalf("Page without the tags include: %v", err)
			}
		})
	}
}

// imageTagRowCols are sqlImageTags' columns.
var imageTagRowCols = []string{"imageId", "tagId", "tagName", "tagType", "score", "upVotes", "downVotes", "tagNsfwLevel",
	"automated", "needsReview", "concrete", "lastUpvote", "source"}

// imageTagsRoute answers sqlImageTags from rows (by image id, in the order given), recording the ids
// each query asked for; fail answers every query with errMissDB.
func imageTagsRoute(rows map[int][][]any, asked *[][]int, fail bool) testkit.Route {
	return testkit.Route{Match: `FROM "ImageTag" it WHERE it."imageId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
		ids, _ := args[0].([]int)
		*asked = append(*asked, slices.Clone(ids))
		if fail {
			return nil, errMissDB
		}
		out := testkit.NewRows(imageTagRowCols)
		for _, id := range ids {
			out.Data = append(out.Data, rows[id]...)
		}
		return out, nil
	}}
}

// An image-tags miss is the lookup's answer (listImageTagsForImages' rows, grouped by image in row
// order, the vote counts and score as numbers, the timestamp a Date), served as a hit is; an image
// with no row is a notFound marker (absent). Never written back, even with every cache listed.
func TestPageComputesImageTagsMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		f := basePageFixture(t)
		for _, id := range []int{11, 12, 13, 14} {
			f.del(KeyImageTags, id)
		}
		upvote := time.Date(2026, 6, 1, 8, 30, 0, 0, time.UTC)
		rows := map[int][][]any{
			11: {
				{int32(11), int32(31), "cat", "Label", float64(9), int64(3), int64(0), int32(1), false, false, true, upvote, "User"},
				{int32(11), int32(21), "red", "UserGenerated", float64(1.5), int64(0), int64(2), int32(4), nil, nil, true, nil, nil},
			},
			13: {{int32(13), int32(22), "fox", "Label", float64(0), int64(0), int64(0), int32(2), true, false, true, nil, "WD14"}},
		}
		var asked [][]int
		obs := &observed{}
		s, r := (&missDB{}).load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, Observe: obs.observe})
		db := s.Replica.(*pageReplica)
		db.Routes = append([]testkit.Route{imageTagsRoute(rows, &asked, false)}, db.Routes...)
		got, err := s.Page(context.Background(), tagsPageRequest())
		if err != nil {
			t.Fatalf("write-back %v: Page: %v (fallback %q)", writeBack, err, fallback.Reason(err))
		}
		want11 := `[{"score":9,"upVotes":3,"downVotes":0,"automated":false,"needsReview":false,"concrete":true,"lastUpvote":"2026-06-01T08:30:00.000Z",` +
			`"source":"User","imageId":11,"id":31,"type":"Label","nsfwLevel":1,"name":"cat"},` +
			`{"score":1.5,"upVotes":0,"downVotes":2,"automated":null,"needsReview":null,"concrete":true,"lastUpvote":null,"source":null,` +
			`"imageId":11,"id":21,"type":"UserGenerated","nsfwLevel":4,"name":"red","vote":1}]`
		if s := pagePlain(t, got.Tags[11]); s != want11 {
			t.Fatalf("write-back %v: image 11 tags\n got %s\nwant %s", writeBack, s, want11)
		}
		// 13 carries tag 22 now, and the viewer voted 99 there: no vote.
		if s := pagePlain(t, got.Tags[13]); !strings.Contains(s, `"id":22`) || strings.Contains(s, `"vote"`) {
			t.Fatalf("write-back %v: image 13 tags %s", writeBack, s)
		}
		if keys := sortedKeys(got.Tags); !reflect.DeepEqual(keys, []int{11, 13}) {
			t.Fatalf("write-back %v: tags for %v, want [11 13] (12 and 14 have no row)", writeBack, keys)
		}
		if !reflect.DeepEqual(asked, [][]int{{11, 12, 13, 14}}) {
			t.Fatalf("write-back %v: image-tags queries %v, want one for the four misses", writeBack, asked)
		}
		if o := obs.get(); o["image-tags/computed"] != 4 {
			t.Fatalf("write-back %v: observed %v, want 4 computed image-tags ids", writeBack, o)
		}
		wantAbsent(t, r, pageNS+missKey(KeyImageTags, 11), pageNS+missKey(KeyImageTags, 12), pageNS+missKey(KeyImageTags, 13),
			pageNS+missKey(KeyImageTags, 14))
	}
}

// A failed image-tags lookup is the miss's `-failed` fallback.
func TestImageTagsLookupFailure(t *testing.T) {
	f := basePageFixture(t)
	f.del(KeyImageTags, 13)
	var asked [][]int
	s, _ := (&missDB{}).load(f, &MissCompute{FrameNegative: true})
	db := s.Replica.(*pageReplica)
	db.Routes = append([]testkit.Route{imageTagsRoute(nil, &asked, true)}, db.Routes...)
	_, err := s.Page(context.Background(), tagsPageRequest())
	if got := fallback.Reason(err); got != "image-tags-miss-failed" {
		t.Fatalf("Page err = %v (reason %q), want image-tags-miss-failed", err, got)
	}
	if !reflect.DeepEqual(asked, [][]int{{13}}) {
		t.Fatalf("image-tags queries %v, want one for 13", asked)
	}
}
