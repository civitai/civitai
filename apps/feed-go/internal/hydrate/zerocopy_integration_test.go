//go:build integration

package hydrate

import (
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The cache read decodes the Redis reply string in place (msgpack.go: every decoded string is a
// substring of the reply, entryState reads cmd.Result()), which is safe only while go-redis gives each
// reply a buffer of its own. This guards that against the real client and server: on ONE connection
// (pool size 1, so the next reply is read by the same connection's reader), a string kept from the
// decode of reply A is unchanged after reply B, the same length with different bytes, is read. A
// go-redis upgrade that reused (pooled) reply buffers across commands would overwrite A's bytes and
// silently corrupt every entry an earlier read returned; this test then fails.
func TestIntegrationZeroCopyReplyStringsSurviveTheNextReply(t *testing.T) {
	cluster := integtest.Cluster(t)
	ctx := integtest.Ctx(t)
	tag := "{" + integtest.Prefix(t) + "}" // one hash slot for both keys
	keyA, keyB := tag+":a", tag+":b"
	nameA, nameB := strings.Repeat("a", 200), strings.Repeat("b", 200)
	for k, name := range map[string]string{keyA: nameA, keyB: nameB} {
		if err := cluster.Set(ctx, k, jspack.Pack(jspack.O("id", 1, "name", name)), time.Minute).Err(); err != nil {
			t.Fatalf("set %s: %v", k, err)
		}
	}
	integtest.Del(t, cluster, keyA, keyB)
	master, err := cluster.MasterForKey(ctx, keyA)
	if err != nil {
		t.Fatalf("master for %s: %v", keyA, err)
	}
	one := redis.NewClient(&redis.Options{Addr: master.Options().Addr, PoolSize: 1, MaxIdleConns: 1})
	t.Cleanup(func() { _ = one.Close() })

	replyA, err := one.Get(ctx, keyA).Result()
	if err != nil {
		t.Fatalf("get %s: %v", keyA, err)
	}
	e, st := decodeValue(replyA, 0, time.Now(), decodeOpts{})
	kept, _ := e.Value["name"].(string)
	if st != stateEntry || kept != nameA {
		t.Fatalf("decoded A: state %d, name %q", st, kept)
	}
	// Control: the kept string is a substring of the reply (no copy), so the check below can see a
	// reused buffer at all.
	start := uintptr(unsafe.Pointer(unsafe.StringData(replyA))) //nolint:gosec // G103: addresses compared, never dereferenced
	at := uintptr(unsafe.Pointer(unsafe.StringData(kept)))      //nolint:gosec // G103: as above
	if at < start || at >= start+uintptr(len(replyA)) {
		t.Fatal("the decoded string is not a substring of the reply: the zero-copy path is not under test")
	}
	for range 5 {
		replyB, err := one.Get(ctx, keyB).Result()
		if err != nil || len(replyB) != len(replyA) || replyB == replyA {
			t.Fatalf("get %s: %d bytes (A %d), err %v", keyB, len(replyB), len(replyA), err)
		}
	}
	if kept != nameA {
		t.Fatalf("a string decoded from reply A changed after reply B was read: %q", kept[:16])
	}
}
