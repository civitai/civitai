//go:build integration

package hydrate

// imageMetaCache (meta.go) against the real Redis Cluster and Postgres: hits read off the cluster
// (compressed and plain), misses computed with the lookup's own SQL. Ids live in 1_160_000..1_160_999.

import (
	"bytes"
	"strconv"
	"testing"

	"github.com/andybalholm/brotli"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

func TestIntegrationImageMeta(t *testing.T) {
	e := integSetup(t, true)
	e.src.Compute = &MissCompute{}
	// The jsonb literal is written in an order Postgres does not keep: the lookup must hand over the
	// order Postgres prints (key length, then bytes), which JSON.parse then reorders ("10" first).
	integtest.Exec(t, e.pool, `DELETE FROM "Image" WHERE id BETWEEN 1160000 AND 1160999;
		INSERT INTO "Image" (id, url, "userId", meta, "hideMeta") VALUES
		  (1160001, 'integ-m1', 1160900, '{"prompt": "integ one", "a": 1, "10": [2.5, null]}', false),
		  (1160002, 'integ-m2', 1160900, '{"prompt": "integ hidden"}', true),
		  (1160003, 'integ-m3', 1160900, NULL, false);`)
	// 1160004: a plain entry; 1160005: a compressed one (the sentinel, then brotli of the msgpack bytes).
	e.put(t, KeyImageMeta, 1160004, integtest.O("id", 1160004, "meta", integtest.O("steps", 4), "cachedAt", integMissNow))
	var buf bytes.Buffer
	buf.WriteByte(packedBrotliSentinel)
	w := brotli.NewWriter(&buf)
	if _, err := w.Write(integtest.Pack(integtest.O("id", 1160005, "meta", integtest.O("seed", 5, "x", "y"), "cachedAt", integMissNow))); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	full := e.prefix + KeyImageMeta + ":" + strconv.Itoa(1160005)
	integtest.Del(t, e.c, full) // now and when the test ends
	if err := e.c.Set(integtest.Ctx(t), full, buf.Bytes(), 0).Err(); err != nil {
		t.Fatal(err)
	}

	page, err := e.src.V1Page(integtest.Ctx(t), V1PageRequest{MetaIDs: []int{1160001, 1160002, 1160003, 1160004, 1160005, 1160006}})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]string{
		1160001: `{"10":[2.5,null],"a":1,"prompt":"integ one"}`,
		1160002: `null`, // hidden
		1160003: `null`, // NULL
		1160004: `{"steps":4}`,
		1160005: `{"seed":5,"x":"y"}`,
		1160006: `null`, // no row
	}
	if len(page.Meta) != len(want) {
		t.Fatalf("meta ids %v, want %d", integKeys(page.Meta), len(want))
	}
	for id, w := range want {
		if got := integPlain(t, page.Meta[id]); got != w {
			t.Errorf("%d: %s, want %s", id, got, w)
		}
	}
	// Nothing is written back for the misses.
	for _, id := range []int{1160001, 1160002, 1160003, 1160006} {
		if n := e.c.Exists(integtest.Ctx(t), e.prefix+KeyImageMeta+":"+strconv.Itoa(id)).Val(); n != 0 {
			t.Errorf("%d: written back", id)
		}
	}
}
