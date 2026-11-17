//go:build integration

package hydrate

// Sources.Page against the real Redis Cluster and Postgres: it must answer exactly what the
// per-lookup methods answer (perLookup, page_test.go), in one cluster pipeline per dependency stage.
// Ids live in 1_113_000..1_113_999.

import (
	"context"
	"net"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// pipelineCounter is a go-redis hook counting pipelines: on the cluster client one per Pipelined
// call, on a node client one per run of that node client's pipeline hook chain. The node count is not
// one per node a pipeline touches: every newly dialed connection first runs a CLIENT SETINFO pipeline
// (library name and version, go-redis initConn), and the node's hook counts that too.
type pipelineCounter struct{ n atomic.Int64 }

func (*pipelineCounter) DialHook(next redis.DialHook) redis.DialHook          { return next }
func (*pipelineCounter) ProcessHook(next redis.ProcessHook) redis.ProcessHook { return next }
func (c *pipelineCounter) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		c.n.Add(1)
		return next(ctx, cmds)
	}
}

const (
	ipU1, ipU2, ipU3       = 1113001, 1113002, 1113003
	ipI1, ipI2, ipI3, ipI4 = 1113101, 1113102, 1113103, 1113104
	ipC1, ipC2, ipC3       = 1113201, 1113202, 1113203
	ipC4, ipC5             = 1113204, 1113205
)

// integPage seeds one page: images I1, I2 (users U1, U2) and videos I3, I4 (users U3, U1), with, per
// lookup, cache hits on several shards, a key absent (answered by Postgres), a debounce marker, a
// notFound marker and a stale entry:
//
//   - basic users: U1 hit, U2 debounce (Postgres), U3 stale (served)
//   - user cosmetics: U1 [C1, C2], U2 [C3], U3 notFound; cosmetics C1 hit, C2 absent (Postgres), C3 stale
//   - profile pictures: U1 hit, U2 absent (Postgres), U3 notFound
//   - frames: I1 -> C4 (hit), I2 -> C5 (absent, Postgres), I3 and I4 notFound
//   - thumbnails: I3 hit, I4 absent (Postgres); tag ids and decorations: hits and notFound
//   - metrics: every image, I2 a notFound hash; reactions: the viewer U1's on I1
func integPage(t *testing.T, e *integEnv) (PageRequest, []string) {
	t.Helper()
	integtest.Exec(t, e.pool, `DELETE FROM "User" WHERE id BETWEEN 1113000 AND 1113999;
		DELETE FROM "Image" WHERE id BETWEEN 1113000 AND 1113999;
		DELETE FROM "Cosmetic" WHERE id BETWEEN 1113000 AND 1113999;
		DELETE FROM "ImageReaction" WHERE id BETWEEN 1113000 AND 1113999;
		INSERT INTO "Image" (id, name, url, "userId", "nsfwLevel", hash, ingestion, type, width, height, metadata, "needsReview") VALUES
		  (1113104, 'integ-page-video-4', 'integ-page-video-4-url', 1113001, 1, NULL, 'Scanned', 'video', 1920, 1080, '{"thumbnailId": 1113114}', NULL),
		  (1113114, 'integ-page-thumb', 'integ-page-thumb-db', 1113001, 2, NULL, 'Scanned', 'image', 640, 360, '{"parentId": 1113104}', NULL),
		  (1113122, 'integ-page-pp', 'integ-page-pp-url', 1113002, 1, NULL, 'Scanned', 'image', 50, 51, '{}', NULL);
		INSERT INTO "User" (id, username, image, "deletedAt", "profilePictureId") VALUES
		  (1113002, 'integ-page-db-user', 'integ-page-db-avatar', NULL, 1113122);
		INSERT INTO "Cosmetic" (id, name, type, source, data, flags) VALUES
		  (1113202, 'integ-page-c2', 'NamePlate', 'Purchase', '{"url": "integ-c2"}', 5),
		  (1113205, 'integ-page-c5', 'ContentDecoration', 'Purchase', '{"url": "integ-c5"}', 0);
		INSERT INTO "ImageReaction" (id, "imageId", "userId", reaction) VALUES
		  (1113301, 1113101, 1113001, 'Like'), (1113302, 1113102, 1113003, 'Cry');`)
	now := time.Now()
	old := now.Add(-30 * 24 * time.Hour)
	nf := integtest.O("notFound", true)
	var keys []string
	put := func(key string, id int, v integtest.Obj) {
		e.put(t, key, id, v)
		keys = append(keys, e.prefix+key+":"+strconv.Itoa(id))
	}
	put(KeyBasicUsers, ipU1, integtest.O("id", ipU1, "username", "integ-page-u1", "image", "integ-u1.jpeg", "deletedAt", nil, "cachedAt", now))
	put(KeyBasicUsers, ipU2, integtest.O("debounce", true))
	put(KeyBasicUsers, ipU3, integtest.O("id", ipU3, "username", "integ-page-stale", "image", nil, "deletedAt", nil, "cachedAt", old))
	put(KeyUserCosmetics, ipU1, integtest.O("cosmetics", []any{
		integtest.O("cosmeticId", ipC1, "data", integtest.O("color", "integ-red")),
		integtest.O("cosmeticId", ipC2, "data", nil),
	}))
	put(KeyUserCosmetics, ipU2, integtest.O("cosmetics", []any{integtest.O("cosmeticId", ipC3, "data", nil)}))
	put(KeyUserCosmetics, ipU3, nf)
	put(KeyCosmetics, ipC1, integtest.O("id", ipC1, "name", "integ-page-c1", "type", "Badge", "data", integtest.O("url", "integ-c1"), "source", "Trophy", "cachedAt", now))
	put(KeyCosmetics, ipC3, integtest.O("id", ipC3, "name", "integ-page-c3", "type", "Badge", "data", integtest.O(), "source", "Claim", "flags", 3, "cachedAt", old))
	put(KeyCosmetics, ipC4, integtest.O("id", ipC4, "name", "integ-page-c4", "type", "ContentDecoration", "data", integtest.O("url", "integ-c4"), "source", "Purchase"))
	put(KeyProfilePictures, ipU1, integtest.O("id", 1113121, "name", "integ-page-pp1", "url", "integ-pp1-url", "nsfwLevel", 1, "hash", nil, "userId", ipU1,
		"ingestion", "Scanned", "type", "image", "width", 10, "height", 11, "metadata", integtest.O("hash", "integ-blur")))
	put(KeyProfilePictures, ipU3, nf)
	put(KeyImageFrames, ipI1, integtest.O("cosmeticId", ipC4, "equippedToId", ipI1, "userData", nil))
	put(KeyImageFrames, ipI2, integtest.O("cosmeticId", ipC5, "equippedToId", ipI2, "userData", nil))
	put(KeyImageFrames, ipI3, nf)
	put(KeyImageFrames, ipI4, nf)
	put(KeyThumbnails, ipI3, integtest.O("url", "integ-page-thumb-hit", "nsfwLevel", 4, "width", 320, "height", 180, "cachedAt", now))
	put(KeyTagIDs, ipI1, integtest.O("tags", []any{11, 22}))
	put(KeyTagIDs, ipI2, nf)
	put(KeyTagIDs, ipI3, integtest.O("tags", []any{33}))
	put(KeyTagIDs, ipI4, integtest.O("tags", []any{}))
	put(KeyImageEvents, ipI1, integtest.O("id", 1113401, "name", "integ-page-deco", "type", "ContentDecoration", "source", "Event",
		"data", integtest.O("event", "integ-page-event", "url", "integ-deco"), "equippedToId", ipI1, "equippedToType", "Image", "userId", 9))
	for _, id := range []int{ipI2, ipI3, ipI4} {
		put(KeyImageEvents, id, nf)
	}
	ctx := integtest.Ctx(t)
	hashes := map[int][]any{ipI1: {"Like", "3"}, ipI2: {"notFound", "1"}, ipI3: {"Heart", "5"}, ipI4: {"Cry", "7", "_populatedAt", "1700000000000"}}
	for id, fields := range hashes {
		k := metricHashKey(id)
		integtest.Del(t, e.c, k)
		if err := e.c.HSet(ctx, k, fields...).Err(); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, k)
	}
	return PageRequest{
		UserIDs: []int{ipU1, ipU2, ipU3, ipU1}, ImageIDs: []int{ipI1, ipI2, ipI3, ipI4}, VideoIDs: []int{ipI3, ipI4},
		VisibleEvents: map[string]bool{"integ-page-event": true}, ViewerID: ipU1,
	}, keys
}

// countPipelines installs a counter on the cluster client and one on every master node client.
func countPipelines(t *testing.T, c *redis.ClusterClient) (cluster, nodes *pipelineCounter, masters int64) {
	t.Helper()
	cluster, nodes = &pipelineCounter{}, &pipelineCounter{}
	c.AddHook(cluster)
	var n atomic.Int64
	if err := c.ForEachMaster(integtest.Ctx(t), func(_ context.Context, m *redis.Client) error {
		m.AddHook(nodes)
		n.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return cluster, nodes, n.Load()
}

func TestIntegrationPageMatchesPerLookupInTwoPipelines(t *testing.T) {
	e := integSetup(t, true)
	req, keys := integPage(t, e)
	masters := map[string]bool{}
	for _, k := range keys {
		masters[integtest.MasterOf(t, e.c, k)] = true
	}
	if len(masters) < 2 {
		t.Fatalf("the page's %d keys landed on %d master(s); the test needs >= 2 for a cross-shard pipeline", len(keys), len(masters))
	}
	// The profile-picture key of U2 is absent: its id is answered by Postgres while the hits around it
	// come from other shards. Name the shard it would live on, so a failure says which.
	absent := e.prefix + KeyProfilePictures + ":" + strconv.Itoa(ipU2)
	absentMaster := integtest.MasterOf(t, e.c, absent)
	otherShard := false
	for _, k := range keys {
		if integtest.MasterOf(t, e.c, k) != absentMaster {
			otherShard = true
		}
	}
	if !otherShard {
		t.Fatalf("every key is on %s with the absent one; need a hit on another shard", absentMaster)
	}

	cluster, nodes, shardCount := countPipelines(t, e.c)
	ctx := integtest.Ctx(t)
	got, err := e.src.Page(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	pagePipelines, pageNodeTrips := cluster.n.Load(), nodes.n.Load()
	cluster.n.Store(0)
	nodes.n.Store(0)
	want, err := perLookup(ctx, e.src, req)
	if err != nil {
		t.Fatal(err)
	}
	lookupPipelines, lookupNodeTrips := cluster.n.Load(), nodes.n.Load()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Page differs from the per-lookup answer:\n got %#v\nwant %#v", got, want)
	}
	t.Logf("pipelines: Page %d (%d node hook calls), per-lookup %d (%d node hook calls), %d masters",
		pagePipelines, pageNodeTrips, lookupPipelines, lookupNodeTrips, shardCount)
	if pagePipelines != 2 || lookupPipelines != 10 {
		t.Fatalf("cluster pipelines: Page %d, per-lookup %d; want 2 and 10", pagePipelines, lookupPipelines)
	}
	// The node-level total depends on how many connections a run opens (see pipelineCounter), so only
	// the relation is asserted: fewer for Page, and at least one per stage.
	if pageNodeTrips < 2 || lookupNodeTrips <= pageNodeTrips {
		t.Fatalf("node pipeline hook calls: Page %d (want >= 2), per-lookup %d (want more than Page)", pageNodeTrips, lookupNodeTrips)
	}

	if u := got.Basic[ipU2]; u.Username != "integ-page-db-user" || u.Image != "integ-page-db-avatar" {
		t.Fatalf("debounced user = %+v, want the Postgres row", u)
	}
	if u := got.Basic[ipU3]; u.Username != "integ-page-stale" {
		t.Fatalf("stale user = %+v, want the stale entry served", u)
	}
	if s, want := integPlain(t, got.UserCosmetics[ipU1]),
		`[{"cosmeticId":1113201,"data":{"color":"integ-red"},"cosmetic":{"id":1113201,"name":"integ-page-c1","type":"Badge","data":{"url":"integ-c1"},"source":"Trophy"}},`+
			`{"cosmeticId":1113202,"data":null,"cosmetic":{"id":1113202,"name":"integ-page-c2","type":"NamePlate","data":{"url":"integ-c2"},"source":"Purchase","flags":5}}]`; s != want {
		t.Fatalf("U1 cosmetics:\n got %s\nwant %s", s, want)
	}
	if s, want := integPlain(t, got.UserCosmetics[ipU2]), `[{"cosmeticId":1113203,"data":null,"cosmetic":{"id":1113203,"name":"integ-page-c3","type":"Badge","data":{},"source":"Claim","flags":3}}]`; s != want {
		t.Fatalf("U2 cosmetics (stale record served):\n got %s\nwant %s", s, want)
	}
	if s, want := integPlain(t, got.Frames[ipI2]), `{"equippedToId":1113102,"userData":null,"id":1113205,"data":{"url":"integ-c5"}}`; s != want {
		t.Fatalf("I2 frame (cosmetic from Postgres):\n got %s\nwant %s", s, want)
	}
	if ids := integKeys(got.Frames); !reflect.DeepEqual(ids, []int{ipI1, ipI2}) {
		t.Fatalf("frames = %v", ids)
	}
	if pp, ok := got.ProfilePics[ipU2]; !ok || integPlain(t, pp) != `{"id":1113122,"name":"integ-page-pp","url":"integ-page-pp-url","nsfwLevel":1,"hash":null,"userId":1113002,"ingestion":"Scanned","type":"image","width":50,"height":51,"metadata":{}}` {
		t.Fatalf("U2 profile picture (Postgres) = %#v", pp)
	}
	if ids := integKeys(got.ProfilePics); !reflect.DeepEqual(ids, []int{ipU1, ipU2}) {
		t.Fatalf("profile pictures = %v", ids)
	}
	if th := got.Thumbs[ipI4]; th.URL != "integ-page-thumb-db" || th.NsfwLevel != 2 {
		t.Fatalf("I4 thumbnail (Postgres) = %+v", th)
	}
	if th := got.Thumbs[ipI3]; th.URL != "integ-page-thumb-hit" || th.NsfwLevel != 4 {
		t.Fatalf("I3 thumbnail (hit) = %+v", th)
	}
	if want := map[int]Metrics{ipI1: {"Like": 3}, ipI2: {}, ipI3: {"Heart": 5}, ipI4: {"Cry": 7}}; !reflect.DeepEqual(got.Metrics, want) {
		t.Fatalf("metrics = %v, want %v", got.Metrics, want)
	}
	if ids := integKeys(got.TagIDs); !reflect.DeepEqual(ids, []int{ipI1, ipI3, ipI4}) {
		t.Fatalf("tag ids = %v", ids)
	}
	if ids := integKeys(got.Decorations); !reflect.DeepEqual(ids, []int{ipI1}) {
		t.Fatalf("decorations = %v", ids)
	}
	if ids := integKeys(got.Reactions); !reflect.DeepEqual(ids, []int{ipI1}) {
		t.Fatalf("reactions = %v, want only the viewer's", ids)
	}
}

// A key missing on one shard of the cluster is the same fallback through Page as through the
// per-lookup methods, whichever lookup it belongs to.
func TestIntegrationPageFallbacksMatchPerLookup(t *testing.T) {
	cases := []struct {
		name   string
		key    string // removed after seeding (packed keys get the test prefix)
		packed bool
		reason string
	}{
		{"user cosmetics", KeyUserCosmetics + ":" + strconv.Itoa(ipU2), true, "user-cosmetics-miss"},
		{"frame", KeyImageFrames + ":" + strconv.Itoa(ipI3), true, "image-frame-miss"},
		{"tag ids", KeyTagIDs + ":" + strconv.Itoa(ipI4), true, "tag-ids-miss"},
		{"event decoration", KeyImageEvents + ":" + strconv.Itoa(ipI2), true, "event-decoration-miss"},
		{"metric hash", metricHashKey(ipI3), false, "metrics-miss"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := integSetup(t, true)
			req, _ := integPage(t, e)
			key := c.key
			if c.packed {
				key = e.prefix + key
			}
			ctx := integtest.Ctx(t)
			if err := e.c.Del(ctx, key).Err(); err != nil {
				t.Fatal(err)
			}
			t.Logf("removed %s (on %s)", key, integtest.MasterOf(t, e.c, key))
			_, err := e.src.Page(ctx, req)
			integWantReason(t, err, c.reason)
			_, err = perLookup(ctx, e.src, req)
			integWantReason(t, err, c.reason)
		})
	}
}

// deadSlotClient is a cluster client of the real cluster in which the one slot holding key is served
// by a node nobody listens on: every command on that slot fails with a dial error, as when a shard is
// down, while every other slot answers. The topology comes from ClusterSlots, so no real node is
// touched (pausing a master instead would stall the other package's integration tests, which share
// the cluster and run in parallel).
func deadSlotClient(t *testing.T, e *integEnv, key string, others []string) *redis.ClusterClient {
	t.Helper()
	ctx := integtest.Ctx(t)
	slot, err := e.c.ClusterKeySlot(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range others {
		if k == key {
			continue
		}
		if s, err := e.c.ClusterKeySlot(ctx, k).Result(); err != nil || s == slot {
			t.Fatalf("key %s shares slot %d with %s (err %v); the test needs the dead slot to hold one key", k, slot, key, err)
		}
	}
	shards, err := e.c.ClusterShards(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	dead := []redis.ClusterNode{{ID: "integ-dead-node", Addr: "127.0.0.1:1"}}
	var slots []redis.ClusterSlot
	add := func(start, end int64, nodes []redis.ClusterNode) {
		if start <= end {
			slots = append(slots, redis.ClusterSlot{Start: int(start), End: int(end), Nodes: nodes})
		}
	}
	for _, sh := range shards {
		var nodes []redis.ClusterNode
		for _, n := range sh.Nodes {
			if n.Role != "master" {
				continue
			}
			host := n.Endpoint
			if host == "" || host == "?" {
				host = n.IP
			}
			nodes = append(nodes, redis.ClusterNode{ID: n.ID, Addr: net.JoinHostPort(host, strconv.FormatInt(n.Port, 10))})
		}
		if len(nodes) == 0 {
			t.Fatalf("shard %+v has no master", sh)
		}
		for _, r := range sh.Slots {
			if r.Start > slot || r.End < slot {
				add(r.Start, r.End, nodes)
				continue
			}
			add(r.Start, slot-1, nodes)
			add(slot, slot, dead)
			add(slot+1, r.End, nodes)
		}
	}
	c := redis.NewClusterClient(&redis.ClusterOptions{
		ClusterSlots: func(context.Context) ([]redis.ClusterSlot, error) { return slots, nil },
		DialTimeout:  time.Second,
	})
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// One shard down inside the page's shared pipeline (a real cluster, the dead slot holding exactly
// one key): only that key's lookup notices. A fail-open lookup reads the id from Postgres and the
// page equals the healthy page but for that id; a lookup with no miss path falls back with its usual
// reason.
func TestIntegrationPageOneDeadShard(t *testing.T) {
	cases := []struct {
		name   string
		key    func(e *integEnv) string
		reason string // "" = the page is served
	}{
		{"basic user (fail-open)", func(e *integEnv) string { return e.prefix + KeyBasicUsers + ":" + strconv.Itoa(ipU1) }, ""},
		{"tag ids (falls back)", func(e *integEnv) string { return e.prefix + KeyTagIDs + ":" + strconv.Itoa(ipI1) }, "tag-ids-miss"},
		{"metric hash (falls back)", func(*integEnv) string { return metricHashKey(ipI3) }, "metrics-read-failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := integSetup(t, true)
			req, keys := integPage(t, e)
			integtest.Exec(t, e.pool, `INSERT INTO "User" (id, username, image) VALUES (1113001, 'integ-page-db-u1', 'integ-page-db-u1.jpeg');`)
			ctx := integtest.Ctx(t)
			healthy, err := e.src.Page(ctx, req)
			if err != nil {
				t.Fatal(err)
			}
			key := c.key(e)
			dc := deadSlotClient(t, e, key, keys)
			src := &Sources{Packed: &PackedReader{Redis: dc, Prefix: e.prefix}, Cache: dc, Replica: e.pool}
			got, err := src.Page(ctx, req)
			if c.reason != "" {
				integWantReason(t, err, c.reason)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if u := got.Basic[ipU1]; u.Username != "integ-page-db-u1" {
				t.Fatalf("U1 on the dead shard = %+v, want the Postgres row", u)
			}
			want := *healthy
			want.Basic = map[int]BasicUser{}
			for id, u := range healthy.Basic {
				want.Basic[id] = u
			}
			want.Basic[ipU1] = got.Basic[ipU1]
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("a lookup on a healthy shard changed:\n got %#v\nwant %#v", *got, want)
			}
		})
	}
}
