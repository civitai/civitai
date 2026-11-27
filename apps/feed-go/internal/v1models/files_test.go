package v1models

import (
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// filesForModelVersionCache's write for version 6001 from filesRoutes' rows, packed by msgpackr's
// module-level `pack` (testdata/golden/pack.mjs's importDep('msgpackr')), cachedAt testNow:
// { modelVersionId: 6001, files: [{ id: 7001, url: 'u7001', sizeKB: 2.5, name: 'a.safetensors',
// overrideName: null, type: 'Model', visibility: 'Public', pickleScanResult: 'Success',
// pickleScanMessage: null, virusScanResult: 'Success', virusScanMessage: null, scannedAt:
// 2026-06-01, modelVersionId: 6001, hashes: [{ type: 'SHA256', hash: 'H7001' }], metadata: { format:
// 'SafeTensor' } }], cachedAt }.
const nodeVersionFiles6001 = "de0003ae6d6f64656c56657273696f6e4964cd1771a566696c657391de000fa26964cd1b59a375726ca57537303031a673697a654b42cb4004000000000000a46e616d65ad612e7361666574656e736f7273ac6f766572726964654e616d65c0a474797065a54d6f64656caa7669736962696c697479a65075626c6963b07069636b6c655363616e526573756c74a753756363657373b17069636b6c655363616e4d657373616765c0af76697275735363616e526573756c74a753756363657373b076697275735363616e4d657373616765c0a97363616e6e65644174d6ff6a1ccb80ae6d6f64656c56657273696f6e4964cd1771a668617368657391de0002a474797065a6534841323536a468617368a54837303031a86d65746164617461de0001a6666f726d6174aa5361666554656e736f72a86361636865644174d6ff6a2fe940"

// filesRoutes answer filesForModelVersionCache's lookup (hydrate's sqlVersionFiles and
// sqlVersionFileHashes) with version 6001's one file, counting the file reads. Prepended to the
// test world's routes, whose own ModelFile / ModelFileHash routes answer the VAE read.
func filesRoutes(reads *int) []testkit.Route {
	return []testkit.Route{
		{Match: `FROM "ModelFile"` + "\n" + `WHERE "modelVersionId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			*reads++
			cols := []string{"id", "url", "sizeKB", "name", "overrideName", "type", "visibility", "pickleScanResult",
				"pickleScanMessage", "virusScanResult", "virusScanMessage", "scannedAt", "modelVersionId", "metadata"}
			var rows [][]any
			for _, id := range args[0].([]int) {
				if id == 6001 {
					rows = append(rows, []any{int32(7001), "u7001", 2.5, "a.safetensors", nil, "Model", "Public", "Success", nil,
						"Success", nil, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), int32(6001), `{"format": "SafeTensor"}`})
				}
			}
			return testkit.NewRows(cols, rows...), nil
		}},
		{Match: `type::text AS type, hash::text AS hash FROM "ModelFileHash"`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, id := range args[0].([]int) {
				if id == 7001 {
					rows = append(rows, []any{int32(7001), "SHA256", "H7001"})
				}
			}
			return testkit.NewRows([]string{"fileId", "type", "hash"}, rows...), nil
		}},
	}
}

func filesEnv(t *testing.T, w *testWorld, sw func(*Config), writeBack hydrate.WriteSet) (*missEnv, *int) {
	t.Helper()
	e := newMissEnv(t, w, sw, writeBack, false)
	reads := 0
	w.db.Routes = append(filesRoutes(&reads), w.db.Routes...)
	return e, &reads
}

const files6001 = KeyFilesForVersion + ":6001"

// staleFiles backdates the test world's version-files entry past the cache's day.
func staleFiles(w *testWorld) {
	o := w.entries[files6001].(superjson.Object)
	w.entries[files6001] = append(omit(o, "cachedAt"), superjson.Field{Key: "cachedAt", Val: testNow.Add(-48 * time.Hour)})
}

// FEED_GO_V1_MODELS_SERVE_FILES_MISS: a version-files miss on a public request (either route) is
// answered with filesForModelVersionCache's lookup and, with version-files written back, written as
// Node writes it (nodeVersionFiles6001, a two-day EX); a request reading Node's bytes gives the
// computed one's body. Off, it falls back as before; a failed GET is still the read-failure reason.
func TestServeComputesVersionFilesMiss(t *testing.T) {
	on := func(c *Config) { c.ServeFilesMiss = true }
	writes := hydrate.WriteSet{hydrate.MissVersionFiles: true}
	for _, detail := range []bool{false, true} {
		serve := func(e *missEnv) (*Answer, error) {
			if detail {
				return e.detail(true)
			}
			return e.list(true)
		}
		hit := newTestWorld()
		hit.entries[files6001] = nil
		hit.raw[files6001] = nodeBytes(t, nodeVersionFiles6001)
		he, hreads := filesEnv(t, hit, on, writes)
		want, err := serve(he)
		if err != nil || *hreads != 0 {
			t.Fatalf("detail %v: Node's entry: %v (%s), %d lookups", detail, err, reason(err), *hreads)
		}
		miss := newTestWorld()
		miss.entries[files6001] = nil
		me, mreads := filesEnv(t, miss, on, writes)
		got, err := serve(me)
		if err != nil {
			t.Fatalf("detail %v: computed: %v (%s)", detail, err, reason(err))
		}
		if plain(t, got) != plain(t, want) || *mreads != 1 {
			t.Errorf("detail %v: computed (%d lookups):\n got  %s\n want %s", detail, *mreads, plain(t, got), plain(t, want))
		}
		b, _ := miss.cache.String(files6001)
		if hex.EncodeToString(b) != nodeVersionFiles6001 || miss.cache.Expiry(files6001) != 48*time.Hour {
			t.Errorf("detail %v: written %x EX %v, want Node's bytes and 48h", detail, b, miss.cache.Expiry(files6001))
		}
	}
	for _, c := range []struct {
		name   string
		edit   func(*testWorld)
		sw     func(*Config)
		reason string
		reads  int
	}{
		{"switch off", nil, nil, "v1-models-files-miss", 0},
		{"the GET fails", func(w *testWorld) { w.failKey = files6001 }, on, "v1-models-files-read-failed", 0},
	} {
		w := newTestWorld()
		w.entries[files6001] = nil
		if c.edit != nil {
			c.edit(w)
		}
		e, reads := filesEnv(t, w, c.sw, writes)
		if _, err := e.list(true); reason(err) != c.reason || *reads != c.reads {
			t.Errorf("%s: %q (%v), %d lookups; want %q, %d", c.name, reason(err), err, *reads, c.reason, c.reads)
		}
	}
}

// A stale version-files entry (past the cache's day) is revalidated as Node's fetch revalidates it:
// written back, under the revalidate lock, looked up and overwritten (then the lock released); with
// the lock held by another reader, served stale (Node's lock loser), with no lookup. Off, it falls
// back (`v1-models-files-stale`).
func TestServeVersionFilesStale(t *testing.T) {
	on := func(c *Config) { c.ServeFilesMiss = true }
	const lock = "cache-lock:" + files6001
	for _, c := range []struct {
		name          string
		sw            func(*Config)
		held          bool
		reason        string
		reads         int
		overwritten   bool
		lockRemaining bool
	}{
		{"lock free: revalidated", on, false, "", 1, true, false},
		{"lock held: served stale", on, true, "", 0, false, true},
		{"switch off", nil, false, "v1-models-files-stale", 0, false, false},
	} {
		w := newTestWorld()
		staleFiles(w)
		if c.held {
			w.raw[lock] = "1"
		}
		e, reads := filesEnv(t, w, c.sw, hydrate.WriteSet{hydrate.MissVersionFiles: true})
		ans, err := e.list(true)
		if reason(err) != c.reason || *reads != c.reads {
			t.Errorf("%s: %q (%v), %d lookups; want %q, %d", c.name, reason(err), err, *reads, c.reason, c.reads)
			continue
		}
		// Overwritten: the entry is now Node's bytes for the looked-up record.
		b, _ := w.cache.String(files6001)
		if overwritten := hex.EncodeToString(b) == nodeVersionFiles6001; overwritten != c.overwritten {
			t.Errorf("%s: entry overwritten %v, want %v", c.name, overwritten, c.overwritten)
		}
		if w.cache.Has(lock) != c.lockRemaining {
			t.Errorf("%s: lock held after %v, want %v", c.name, w.cache.Has(lock), c.lockRemaining)
		}
		if c.reason == "" && !strings.Contains(plain(t, ans), `"name":"a.safetensors"`) {
			t.Errorf("%s: the file is not served:\n%s", c.name, plain(t, ans))
		}
	}
}

// FEED_GO_V1_MODELS_SERVE_FILENAME: a generic file name over a non-ASCII model name is computed as
// Node's resolveModelFileName computes it ("cafModel_v2.safetensors", Node's answer for this model,
// version and file); off, a public request falls back (`v1-models-filename`); a shadow sample always
// computes it.
func TestServeNonASCIIFileName(t *testing.T) {
	world := func() *testWorld {
		w := newTestWorld()
		w.modelRow["name"] = "Café Model"
		rec := w.entries[KeyDataForModel+":5001"].(superjson.Object)
		vers := rec[3].Val.([]any)
		v := cloneObject(vers[0].(superjson.Object))
		v.Set("name", "CAFÉ MODEL v2")
		w.entries[KeyDataForModel+":5001"] = append(superjson.Object{rec[0], rec[1], rec[2], {Key: "versions", Val: []any{v}}}, rec[4:]...)
		w.entries[files6001] = meta("modelVersionId", int64(6001), "files", []any{
			meta("id", int64(7001), "name", "model.safetensors", "type", "Model", "visibility", "Public", "modelVersionId", int64(6001),
				"hashes", []any{}, "metadata", meta("format", "SafeTensor")),
		}, "cachedAt", testNow.Add(-time.Minute))
		return w
	}
	const want = `"name":"cafModel_v2.safetensors"`
	for _, c := range []struct {
		name            string
		sw              func(*Config)
		serving, detail bool
		reason          string
	}{
		{"list, switch on", func(c *Config) { c.ServeFilename = true }, true, false, ""},
		{"detail, switch on", func(c *Config) { c.ServeFilename = true }, true, true, ""},
		{"list, switch off", nil, true, false, "v1-models-filename"},
		{"shadow sample", nil, false, false, ""},
	} {
		e := newMissEnv(t, world(), c.sw, nil, false)
		var ans *Answer
		var err error
		if c.detail {
			ans, err = e.detail(c.serving)
		} else {
			ans, err = e.list(c.serving)
		}
		if reason(err) != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, reason(err), err, c.reason)
			continue
		}
		if c.reason == "" && !strings.Contains(plain(t, ans), want) {
			t.Errorf("%s: body lacks %s:\n%s", c.name, want, plain(t, ans))
		}
	}
}
