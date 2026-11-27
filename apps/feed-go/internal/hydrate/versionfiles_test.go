package hydrate

import (
	"context"
	"encoding/hex"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// What filesForModelVersionCache's fetch writes on these misses, packed by msgpackr's module-level
// `pack` (testdata/golden/pack.mjs's importDep('msgpackr'), `pack({...}).toString('hex')`), cachedAt
// filesNow, from the rows filesDB answers: version 6001's two files as fetchModelFilesForCache hands
// them over (the select's keys, the jsonb metadata parsed in jsonb's key order and moved last; one
// sizeKB fractional, one integral), and version 6002's notFound marker.
const (
	nodeVersionFiles6001 = "de0003ae6d6f64656c56657273696f6e4964cd1771a566696c657392de000fa26964cd1b59a375726cd92168747470733a2f2f73746f726167652e6578616d706c652e746573742f37303031a673697a654b42cb3ff8000000000000a46e616d65ad612e7361666574656e736f7273ac6f766572726964654e616d65c0a474797065a54d6f64656caa7669736962696c697479a65075626c6963b07069636b6c655363616e526573756c74a753756363657373b17069636b6c655363616e4d657373616765c0af76697275735363616e526573756c74a753756363657373b076697275735363616e4d657373616765c0a97363616e6e65644174d6ff6a1ccb80ae6d6f64656c56657273696f6e4964cd1771a668617368657392de0002a474797065a6534841323536a468617368a3414243de0002a474797065a64175746f5632a468617368a3444546a86d65746164617461de0003a26670a466703136a473697a65a67072756e6564a6666f726d6174aa5361666554656e736f72de000fa26964cd1b5aa375726cd92168747470733a2f2f73746f726167652e6578616d706c652e746573742f37303032a673697a654b42cd0400a46e616d65a5622e7a6970ac6f766572726964654e616d65a444617461a474797065ad547261696e696e672044617461aa7669736962696c697479a750726976617465b07069636b6c655363616e526573756c74a750656e64696e67b17069636b6c655363616e4d657373616765a6717565756564af76697275735363616e526573756c74a750656e64696e67b076697275735363616e4d657373616765c0a97363616e6e65644174c0ae6d6f64656c56657273696f6e4964cd1771a668617368657390a86d65746164617461c0a86361636865644174d6ff6a2fe940"
	nodeVersionFiles6002 = "de0003ae6d6f64656c56657273696f6e4964cd1772a86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
)

var filesNow = time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

// filesDB answers the two lookup queries with version 6001's files (6002 has none), counting the
// file reads.
func filesDB(reads *int) *testkit.DB {
	cols := []string{"id", "url", "sizeKB", "name", "overrideName", "type", "visibility", "pickleScanResult",
		"pickleScanMessage", "virusScanResult", "virusScanMessage", "scannedAt", "modelVersionId", "metadata"}
	return &testkit.DB{Routes: []testkit.Route{
		{Match: `FROM "ModelFile"` + "\n" + `WHERE "modelVersionId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			*reads++
			var rows [][]any
			for _, id := range args[0].([]int) {
				if id == 6001 {
					rows = append(rows,
						[]any{int32(7001), "https://storage.example.test/7001", 1.5, "a.safetensors", nil, "Model", "Public",
							"Success", nil, "Success", nil, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), int32(6001),
							`{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}`},
						[]any{int32(7002), "https://storage.example.test/7002", 1024.0, "b.zip", "Data", "Training Data", "Private",
							"Pending", "queued", "Pending", nil, nil, int32(6001), nil})
				}
			}
			return testkit.NewRows(cols, rows...), nil
		}},
		{Match: `FROM "ModelFileHash" WHERE "fileId" = ANY`, Rows: func(args []any) (*testkit.Rows, error) {
			var rows [][]any
			for _, id := range args[0].([]int) {
				if id == 7001 {
					rows = append(rows, []any{int32(7001), "SHA256", "ABC"}, []any{int32(7001), "AutoV2", "DEF"})
				}
			}
			return testkit.NewRows([]string{"fileId", "type", "hash"}, rows...), nil
		}},
	}}
}

func filesSources(r *testkit.Redis, db *testkit.DB, writeBack WriteSet) *Sources {
	return &Sources{
		Packed:  &PackedReader{Redis: r, Now: func() time.Time { return filesNow }},
		Replica: db,
		Compute: &MissCompute{Now: func() time.Time { return filesNow }, WriteBack: writeBack},
	}
}

const (
	files6001Key  = KeyVersionFiles + ":6001"
	files6002Key  = KeyVersionFiles + ":6002"
	files6001Lock = "cache-lock:" + KeyVersionFiles + ":6001"
)

// A public request's misses, with version-files written back, are written byte for byte as Node's
// fetch writes them (the record, and the marker for a version with no file), each with the cache's
// two-day EX; the answer is the record in its own key order.
func TestComputeVersionFilesWritesNodesBytes(t *testing.T) {
	r := testkit.NewRedis()
	reads := 0
	s := filesSources(r, filesDB(&reads), WriteSet{MissVersionFiles: true})
	got, ok, err := s.ComputeVersionFiles(context.Background(), []int{6001, 6002}, nil, map[int]bool{6001: true, 6002: true}, true)
	if err != nil || !ok || reads != 1 {
		t.Fatalf("ok %v, %v, %d file reads", ok, err, reads)
	}
	for key, want := range map[string]string{files6001Key: nodeVersionFiles6001, files6002Key: nodeVersionFiles6002} {
		b, _ := r.String(key)
		if hex.EncodeToString(b) != want {
			t.Errorf("%s written %x\n want Node's %s", key, b, want)
		}
		if ex := r.Expiry(key); ex != 48*time.Hour {
			t.Errorf("%s EX %v, want 48h", key, ex)
		}
	}
	if !got[6002].NotFound || got[6001].NotFound {
		t.Fatalf("answers %+v", got)
	}
	files, _ := got[6001].Value.Get("files")
	if list, _ := files.([]any); len(list) != 2 {
		t.Fatalf("6001 files %v", files)
	}
	if first := got[6001].Value[0].Key; first != "modelVersionId" {
		t.Errorf("record key order starts %q, want modelVersionId", first)
	}
}

// Node's fetch writes nothing for a miss it does not own: a debounce marker or a failed GET
// (writable false), and a shadow sample (write false) writes nothing at all; each is still looked up.
func TestComputeVersionFilesWritesOnlyWhatNodeWould(t *testing.T) {
	for _, c := range []struct {
		name     string
		writable map[int]bool
		write    bool
		set      WriteSet
	}{
		{"not writable", nil, true, WriteSet{MissVersionFiles: true}},
		{"a shadow sample", map[int]bool{6001: true}, false, WriteSet{MissVersionFiles: true}},
		{"version-files not written back", map[int]bool{6001: true}, true, WriteSet{MissModelData: true}},
	} {
		r := testkit.NewRedis()
		reads := 0
		s := filesSources(r, filesDB(&reads), c.set)
		got, _, err := s.ComputeVersionFiles(context.Background(), []int{6001}, nil, c.writable, c.write)
		if err != nil || reads != 1 || got[6001].NotFound || got[6001].Value == nil {
			t.Errorf("%s: %v, %d reads, %+v", c.name, err, reads, got)
		}
		if r.Has(files6001Key) {
			t.Errorf("%s: the entry was written", c.name)
		}
	}
}

// A stale entry is revalidated as Node's fetch revalidates it: written back, the reader takes the
// cache-lock (SET NX EX 10), looks the version up, overwrites the entry (SET, not NX: Node's refill
// replaces it) and releases the lock; with the lock held elsewhere it neither reads nor writes and
// answers nothing for it (the caller serves the stale entry, as Node's lock loser does). Not written
// back, every stale entry is looked up and nothing is written or locked.
func TestComputeVersionFilesRevalidatesStale(t *testing.T) {
	old := []byte("stale entry bytes")
	for _, c := range []struct {
		name      string
		set       WriteSet
		held      bool
		reads     int
		written   bool
		answered  bool
		lockAfter bool
	}{
		{"lock free: looked up and overwritten", WriteSet{MissVersionFiles: true}, false, 1, true, true, false},
		{"lock held: served stale", WriteSet{MissVersionFiles: true}, true, 0, false, false, true},
		{"not written back: looked up, nothing written", nil, false, 1, false, true, false},
	} {
		r := testkit.NewRedis()
		r.SetString(files6001Key, old)
		if c.held {
			r.SetString(files6001Lock, []byte("1"))
		}
		reads := 0
		s := filesSources(r, filesDB(&reads), c.set)
		got, _, err := s.ComputeVersionFiles(context.Background(), nil, []int{6001}, nil, true)
		if err != nil || reads != c.reads {
			t.Errorf("%s: %v, %d reads, want %d", c.name, err, reads, c.reads)
		}
		b, _ := r.String(files6001Key)
		if written := hex.EncodeToString(b) == nodeVersionFiles6001; written != c.written {
			t.Errorf("%s: entry %q, overwritten with Node's bytes %v, want %v", c.name, b, written, c.written)
		}
		if _, answered := got[6001]; answered != c.answered {
			t.Errorf("%s: answered %v, want %v", c.name, answered, c.answered)
		}
		if r.Has(files6001Lock) != c.lockAfter {
			t.Errorf("%s: lock held after %v, want %v", c.name, r.Has(files6001Lock), c.lockAfter)
		}
	}
}
