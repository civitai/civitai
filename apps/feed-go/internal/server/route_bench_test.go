package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/devalue"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// End-to-end route benchmarks: one served request per op, from the request's input through the feed
// query, the hydration (the in-memory Redis and Postgres fakes of the golden harness, loaded with a
// golden fixture's world) and the answer, to the devalue bytes the public route writes (a signed-in
// web client on a pool with TRPC_WRITE_DEVALUE on: trpc.WithDevalueWrite). Every world is a served,
// signed-in golden fixture, so the answer is the private devalue one; TestRouteBenchWorlds checks
// that, and the page size, in the unit run.
//
//   - as-posts: as-posts/version-signed-in-blue-newest (6 posts, 7 images) scaled to routeBenchPosts
//     posts on a `limit: 50` page (scaleImageWorld).
//   - infinite: infinite/global-signed-in-blue-newest (6 images) scaled to routeBenchImages images on
//     a `limit: 100` page.
//   - model-getall: model-getall/base-models-multi-signed-in (3 models) scaled to routeBenchModels
//     models on a `limit: 100` page (scaleModelWorld).
//
// A scaled world is the fixture's page copied k times under shifted ids (the copies' own rows and
// cache entries; users, cosmetics, tags, models of an image stay shared, as on a real page), so the
// per-item work is real while the fakes still answer every query the way they answer the fixture's.

// The page sizes: copies of each base fixture's served page.
const (
	routeBenchPostCopies  = 7
	routeBenchPosts       = 6 * routeBenchPostCopies
	routeBenchImageCopies = 16
	routeBenchImages      = 6 * routeBenchImageCopies
	routeBenchModelCopies = 33
	routeBenchModels      = 3 * routeBenchModelCopies
)

// routeWorld is one benchmark world: run computes the request once; reset puts the fakes back to
// their state before a run (the model page fake counts the pages it served).
type routeWorld struct {
	run   func(ctx context.Context) (*computed, error)
	reset func()
}

type routeBenchCase struct {
	name string
	// items is the number of items the answer holds (TestRouteBenchWorlds).
	items int
	world func(tb testing.TB) routeWorld
}

var routeBenchCases = []routeBenchCase{
	{"as-posts", routeBenchPosts, func(tb testing.TB) routeWorld {
		fx := scaleImageWorld(tb, filepath.Join(goldenDir, "as-posts", "version-signed-in-blue-newest.json"), routeBenchPostCopies, 50)
		env := goldenSetupMode(tb, fx, false)
		r := routeBenchRequest(tb, SyntheticRequest, fx, env)
		return routeWorld{run: func(ctx context.Context) (*computed, error) { return env.server.compute(ctx, r) }, reset: func() {}}
	}},
	{"infinite", routeBenchImages, func(tb testing.TB) routeWorld {
		fx := scaleImageWorld(tb, filepath.Join(goldenDir, "infinite", "global-signed-in-blue-newest.json"), routeBenchImageCopies, 100)
		env := goldenSetupMode(tb, fx, false)
		r := routeBenchRequest(tb, SyntheticInfiniteRequest, fx, env)
		return routeWorld{run: func(ctx context.Context) (*computed, error) { return env.server.computeInfinite(ctx, r) }, reset: func() {}}
	}},
	{"model-getall", routeBenchModels, func(tb testing.TB) routeWorld {
		fx := scaleModelWorld(tb, filepath.Join(goldenDir, "model-getall", "base-models-multi-signed-in.json"), routeBenchModelCopies, 100)
		env := goldenSetupModelsMode(tb, fx, false)
		r := routeBenchRequest(tb, SyntheticModelGetAllRequest, fx, env)
		db, ok := env.server.Models.DB.(*goldenModelPG)
		if !ok {
			tb.Fatalf("model DB is %T, want the golden model fake", env.server.Models.DB)
		}
		return routeWorld{
			run: func(ctx context.Context) (*computed, error) { return env.server.computeModelGetAll(ctx, r) },
			reset: func() {
				db.mu.Lock()
				db.pages = 0
				db.mu.Unlock()
			},
		}
	}},
}

func routeBenchRequest(tb testing.TB, build func(context.Context, ShadowRequest) (*http.Request, error), fx *goldenFixture, env *goldenEnv) *http.Request {
	tb.Helper()
	r, err := build(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		tb.Fatal(err)
	}
	return r
}

// answerItems is the length of the answer's `items`.
func answerItems(tb testing.TB, c *computed) int {
	tb.Helper()
	obj, ok := c.value.(superjson.Object)
	if !ok {
		tb.Fatalf("answer value is %T, want a superjson.Object", c.value)
	}
	items, _ := obj.Get("items")
	list, ok := items.([]any)
	if !ok {
		tb.Fatalf("answer items are %T, want a list", items)
	}
	return len(list)
}

// Each benchmark world serves: a private devalue answer, byte-identical on a second run after reset
// (so every benchmark op does the same work), with the page size the benchmark claims.
func TestRouteBenchWorlds(t *testing.T) {
	for _, bc := range routeBenchCases {
		t.Run(bc.name, func(t *testing.T) {
			w := bc.world(t)
			ctx := trpc.WithDevalueWrite(context.Background())
			var first []byte
			for i := range 2 {
				w.reset()
				c, err := w.run(ctx)
				if err != nil {
					t.Fatalf("run %d: %v", i, err)
				}
				if !c.devalue || c.ttl != nil {
					t.Fatalf("run %d: devalue %v, ttl %v: want a private devalue answer", i, c.devalue, c.ttl)
				}
				if n := answerItems(t, c); n != bc.items {
					t.Fatalf("run %d: %d items, want %d", i, n, bc.items)
				}
				if i == 0 {
					first = bytes.Clone(c.payload)
				} else if !bytes.Equal(first, c.payload) {
					t.Fatalf("the second run's payload differs from the first's: the world does not reset")
				}
				c.release()
			}
		})
	}
}

// BenchmarkRoute is one served request per op, input to devalue bytes (see the file comment).
func BenchmarkRoute(b *testing.B) {
	for _, bc := range routeBenchCases {
		b.Run(bc.name, func(b *testing.B) {
			w := bc.world(b)
			ctx := trpc.WithDevalueWrite(context.Background())
			var out int
			b.ReportAllocs()
			for b.Loop() {
				w.reset()
				c, err := w.run(ctx)
				if err != nil {
					b.Fatal(err)
				}
				if !c.devalue {
					b.Fatal("not a devalue answer")
				}
				out = len(c.payload)
				c.release()
			}
			b.ReportMetric(float64(out), "out-bytes")
		})
	}
}

// BenchmarkDevaluePayload is the devalue writer alone over each route's real answer value (computed
// once): what devalue.PayloadBuffer costs per served request.
func BenchmarkDevaluePayload(b *testing.B) {
	for _, bc := range routeBenchCases {
		b.Run(bc.name, func(b *testing.B) {
			w := bc.world(b)
			c, err := w.run(trpc.WithDevalueWrite(context.Background()))
			if err != nil {
				b.Fatal(err)
			}
			defer c.release()
			value := c.value
			var out int
			b.ReportAllocs()
			for b.Loop() {
				buf, err := devalue.PayloadBuffer(value)
				if err != nil {
					b.Fatal(err)
				}
				out = len(buf.Bytes())
				buf.Release()
			}
			b.ReportMetric(float64(out), "out-bytes")
		})
	}
}

// --- scaling a model.getAll world -----------------------------------------------------------------

// scaleModelWorld is a model.getAll golden fixture whose one page of models is copied `copies` times
// (the original first), each copy under ids shifted by k*modelIDShift: the page rows, their paid
// access and cover-image rows, and every cache entry keyed by a model, version or image id (the
// entry's own id members shifted the same way, re-packed as msgpackr writes it: jspack). Users,
// cosmetics and tags stay shared, as on a real page. The request asks for `limit` models.
func scaleModelWorld(tb testing.TB, path string, copies, limit int) *goldenFixture {
	tb.Helper()
	return scaleWorld(tb, path, limit, func(fx map[string]any, _ int) error {
		if err := scaleModelDB(fx, copies); err != nil {
			return err
		}
		return scaleRedis(fx, copies, modelScopedFamilies, modelPageIDs(fx))
	})
}

// scaleImageWorld is scaleModelWorld for an image feed (as-posts, image.getInfinite) on the index
// feed: the fixture's images and their posts copied under shifted ids (image and post ids; an image's
// resources, user and model stay shared), the viewer's reactions to them, the feed service's answer
// listing every copy (its query's limit scaled as the request's), and every cache entry keyed by an
// image id.
func scaleImageWorld(tb testing.TB, path string, copies, limit int) *goldenFixture {
	tb.Helper()
	return scaleWorld(tb, path, limit, func(fx map[string]any, origLimit int) error {
		db := fx["db"].(map[string]any)
		shared := map[string]bool{"modelVersions": true, "models": true, "reviews": true, "placements": true, "users": true,
			"userCosmetics": true, "cosmetics": true, "cosmeticShopItems": true, "usernames": true}
		images := map[string]bool{}
		for k, v := range db {
			list, _ := v.([]any)
			switch {
			case k == "images":
				for _, r := range list {
					images[string(r.(map[string]any)["id"].(json.Number))] = true
				}
				db[k] = copyRows(list, copies, func(row map[string]any, off int64) {
					row["id"], row["postId"] = shiftNumber(row["id"], off), shiftNumber(row["postId"], off)
				})
			case k == "posts":
				db[k] = copyRows(list, copies, func(row map[string]any, off int64) { row["id"] = shiftNumber(row["id"], off) })
			case k == "reactions":
				db[k] = copyRows(list, copies, func(row map[string]any, off int64) { row["imageId"] = shiftNumber(row["imageId"], off) })
			case shared[k] || len(list) == 0:
			default:
				return fmt.Errorf("db.%s has rows the scaler does not copy", k)
			}
		}
		feeds, _ := fx["feed"].([]any)
		if len(feeds) != 1 {
			return fmt.Errorf("%d feed replies, want 1 (an index-feed fixture)", len(feeds))
		}
		reply := feeds[0].(map[string]any)
		q, err := scaleFeedLimit(reply["query"].(string), origLimit, limit)
		if err != nil {
			return err
		}
		reply["query"] = q
		body := reply["body"].(map[string]any)
		items, _ := body["items"].([]any)
		out := append([]any(nil), items...)
		for k := 1; k < copies; k++ {
			for _, id := range items {
				out = append(out, shiftNumber(id, int64(k)*modelIDShift))
			}
		}
		body["items"] = out
		return scaleRedis(fx, copies, imageScopedFamilies, images)
	})
}

// scaleFeedLimit is the feed service query with its `limit` moved as the request's moved (the
// service is asked for a multiple of the page).
func scaleFeedLimit(q string, from, to int) (string, error) {
	parts := strings.Split(q, "&")
	for i, p := range parts {
		if v, ok := strings.CutPrefix(p, "limit="); ok {
			n, err := strconv.Atoi(v)
			if err != nil || n%from != 0 {
				return "", fmt.Errorf("feed query limit %q is not a multiple of the request's %d", v, from)
			}
			parts[i] = "limit=" + strconv.Itoa(n/from*to)
			return strings.Join(parts, "&"), nil
		}
	}
	return "", fmt.Errorf("feed query %q has no limit", q)
}

// scaleWorld loads a fixture as JSON, lets scale copy its page, and sets the request's limit.
func scaleWorld(tb testing.TB, path string, limit int, scale func(fx map[string]any, origLimit int) error) *goldenFixture {
	tb.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // G304: a testdata path
	if err != nil {
		tb.Fatal(err)
	}
	var fx map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&fx); err != nil {
		tb.Fatal(err)
	}
	req := fx["request"].(map[string]any)
	var in map[string]map[string]any
	if err := json.Unmarshal([]byte(req["input"].(string)), &in); err != nil {
		tb.Fatal(err)
	}
	origLimit, _ := in["json"]["limit"].(float64)
	if origLimit <= 0 {
		tb.Fatalf("%s: the request has no limit", path)
	}
	if err := scale(fx, int(origLimit)); err != nil {
		tb.Fatalf("%s: %v", path, err)
	}
	in["json"]["limit"] = limit
	input, err := json.Marshal(in)
	if err != nil {
		tb.Fatal(err)
	}
	req["input"] = string(input)
	out, err := json.Marshal(fx)
	if err != nil {
		tb.Fatal(err)
	}
	scaled := &goldenFixture{}
	if err := json.Unmarshal(out, scaled); err != nil {
		tb.Fatal(err)
	}
	return scaled
}

// modelIDShift is the id distance between copies: above every id a golden fixture uses.
const modelIDShift = 1_000_000

// scaleModelDB copies the fixture's one model page and the rows keyed by its models.
func scaleModelDB(fx map[string]any, copies int) error {
	db := fx["db"].(map[string]any)
	for k, v := range db {
		switch k {
		case "modelPages", "paidAccess", "coverImages":
		default:
			if list, ok := v.([]any); ok && len(list) > 0 {
				return fmt.Errorf("db.%s has rows the scaler does not copy", k)
			}
		}
	}
	pages, _ := db["modelPages"].([]any)
	if len(pages) != 1 {
		return fmt.Errorf("%d model pages, want 1", len(pages))
	}
	page := pages[0].(map[string]any)
	if page["cursor"] != nil {
		return errors.New("the page has a cursor")
	}
	page["rows"] = copyRows(page["rows"].([]any), copies, func(row map[string]any, off int64) {
		for _, f := range []string{"id", "coverImageId", "sfwCoverImageId"} {
			row[f] = shiftNumber(row[f], off)
		}
		if cur, ok := row["cursorId"].(string); ok {
			if i := strings.LastIndexByte(cur, '|'); i >= 0 {
				row["cursorId"] = cur[:i+1] + string(row["id"].(json.Number))
			}
		}
	})
	if rows, ok := db["paidAccess"].([]any); ok {
		db["paidAccess"] = copyRows(rows, copies, func(row map[string]any, off int64) { row["modelId"] = shiftNumber(row["modelId"], off) })
	}
	if rows, ok := db["coverImages"].([]any); ok {
		db["coverImages"] = copyRows(rows, copies, func(row map[string]any, off int64) {
			for _, f := range []string{"id", "modelVersionId", "modelId"} {
				row[f] = shiftNumber(row[f], off)
			}
		})
	}
	return nil
}

// copyRows is rows followed by copies-1 copies of them, copy k shifted by k*modelIDShift.
func copyRows(rows []any, copies int, shift func(row map[string]any, off int64)) []any {
	out := append([]any(nil), rows...)
	for k := 1; k < copies; k++ {
		for _, r := range rows {
			c := deepCopyJSON(r).(map[string]any)
			shift(c, int64(k)*modelIDShift)
			out = append(out, c)
		}
	}
	return out
}

// modelScopedFamilies are the cache key families keyed by a model, version or image id.
var modelScopedFamilies = []string{
	"packed:caches:cosmetics2:Model:",
	"packed:caches:data-for-model-2:",
	"packed:caches:model-tags:",
	"packed:caches:images-for-model-version-2:",
	"packed:caches:tag-ids-for-images:",
	"model:gallery-settings:",
}

// imageScopedFamilies are the cache key families keyed by an image id.
var imageScopedFamilies = []string{
	"packed:caches:cosmetics2:Image:",
	"packed:caches:cosmetics2:event:v2:Image:",
	"packed:caches:tag-ids-for-images:",
	"packed:caches:thumbnails:",
	"metrics:Image:",
}

// shiftedMembers are the record members holding a model, version or image id (a thumbnail's
// parentId is its image's).
var shiftedMembers = map[string]bool{"id": true, "modelId": true, "modelVersionId": true, "imageId": true, "equippedToId": true, "parentId": true}

// modelPageIDs are the ids of the fixture's (unscaled) page of models.
func modelPageIDs(fx map[string]any) map[string]bool {
	ids := map[string]bool{}
	for _, r := range fx["db"].(map[string]any)["modelPages"].([]any)[0].(map[string]any)["rows"].([]any) {
		ids[string(r.(map[string]any)["id"].(json.Number))] = true
	}
	return ids
}

// scaleRedis copies every cache entry of families to each copy's ids. A key outside families that is
// keyed by one of the page's own ids (pageIDs) is an error: it would be left shared.
func scaleRedis(fx map[string]any, copies int, families []string, pageIDs map[string]bool) error {
	redis := fx["redis"].(map[string]any)
	added := map[string]any{}
	for key, v := range redis {
		family, id, ok := scopedKey(families, key)
		if !ok {
			if i := strings.LastIndexByte(key, ':'); i >= 0 && pageIDs[key[i+1:]] {
				return fmt.Errorf("redis %s is keyed by a page id the scaler does not copy", key)
			}
			continue
		}
		entry := v.(map[string]any)
		for k := 1; k < copies; k++ {
			off := int64(k) * modelIDShift
			c := deepCopyJSON(entry).(map[string]any)
			if p, ok := entry["packed"].(string); ok && p != "" {
				b, err := base64.StdEncoding.DecodeString(p)
				if err != nil {
					return fmt.Errorf("redis %s: %w", key, err)
				}
				val, err := jspack.Decode(b)
				if err != nil {
					return fmt.Errorf("redis %s: %w", key, err)
				}
				if !bytes.Equal(jspack.Pack(val), b) {
					return fmt.Errorf("redis %s: jspack does not re-pack the entry byte for byte", key)
				}
				c["packed"] = base64.StdEncoding.EncodeToString(jspack.Pack(shiftPacked(val, float64(off))))
				delete(c, "value") // the readable copy would no longer match
			}
			added[family+strconv.FormatInt(id+off, 10)] = c
		}
	}
	for k, v := range added {
		redis[k] = v
	}
	return nil
}

func scopedKey(families []string, key string) (family string, id int64, ok bool) {
	for _, f := range families {
		if rest, found := strings.CutPrefix(key, f); found {
			n, err := strconv.ParseInt(rest, 10, 64)
			return f, n, err == nil
		}
	}
	return "", 0, false
}

// shiftPacked is a decoded cache record with every id member (shiftedMembers) moved by off.
func shiftPacked(v any, off float64) any {
	switch t := v.(type) {
	case jspack.Obj:
		out := make(jspack.Obj, len(t))
		for i, kv := range t {
			if n, ok := kv.V.(float64); ok && shiftedMembers[kv.K] {
				out[i] = jspack.KV{K: kv.K, V: n + off}
				continue
			}
			out[i] = jspack.KV{K: kv.K, V: shiftPacked(kv.V, off)}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = shiftPacked(e, off)
		}
		return out
	}
	return v
}

// shiftNumber is a JSON integer moved by off (nil stays nil).
func shiftNumber(v any, off int64) any {
	n, ok := v.(json.Number)
	if !ok {
		return v
	}
	i, err := n.Int64()
	if err != nil {
		return v
	}
	return json.Number(strconv.FormatInt(i+off, 10))
}

func deepCopyJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = deepCopyJSON(e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = deepCopyJSON(e)
		}
		return out
	}
	return v
}
