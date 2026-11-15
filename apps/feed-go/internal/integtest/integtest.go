//go:build integration

// Package integtest holds the shared helpers of the `-tags integration` tests: clients for the real
// Redis Cluster and Postgres the CI job starts (.github/workflows/feed-go.yml), and a msgpack encoder
// that writes the bytes Node's msgpackr `pack` writes.
//
// The build tag keeps this package (and every test that imports it) out of the plain, hermetic unit
// run. Under the tag a missing service is a FAILURE, never a skip: a skipped integration tier reads as
// a green one.
package integtest

import (
	"context"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	// EnvRedisCluster is a comma-separated list of the cluster's seed addresses.
	EnvRedisCluster = "FEED_GO_TEST_REDIS_CLUSTER"
	// EnvPostgresURL is the Postgres connection URL; the database holds testdata/integration/schema.sql.
	EnvPostgresURL = "FEED_GO_TEST_PG_URL"
)

func env(t *testing.T, name string) string {
	t.Helper()
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		t.Fatalf("%s is not set: the integration tests need a real service (see .github/workflows/feed-go.yml)", name)
	}
	return v
}

// Ctx returns a context bounded well under the job timeout, cancelled when the test ends.
func Ctx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// Cluster returns a client of the real Redis Cluster, closed when the test ends. It fails the test
// unless the cluster answers and reports cluster_state:ok with at least two masters.
func Cluster(t *testing.T) *redis.ClusterClient {
	t.Helper()
	var addrs []string
	for _, a := range strings.Split(env(t, EnvRedisCluster), ",") {
		if a = strings.TrimSpace(a); a != "" {
			addrs = append(addrs, a)
		}
	}
	c := redis.NewClusterClient(&redis.ClusterOptions{Addrs: addrs})
	t.Cleanup(func() { _ = c.Close() })
	ctx := Ctx(t)
	info, err := c.ClusterInfo(ctx).Result()
	if err != nil {
		t.Fatalf("CLUSTER INFO: %v", err)
	}
	if !strings.Contains(info, "cluster_state:ok") {
		t.Fatalf("cluster not ready:\n%s", info)
	}
	if err := c.ForEachMaster(ctx, func(ctx context.Context, m *redis.Client) error {
		return m.Ping(ctx).Err()
	}); err != nil {
		t.Fatalf("ping masters: %v", err)
	}
	slots, err := c.ClusterSlots(ctx).Result()
	if err != nil {
		t.Fatalf("CLUSTER SLOTS: %v", err)
	}
	if len(slots) < 2 {
		t.Fatalf("want a cluster of >= 2 masters, CLUSTER SLOTS lists %d ranges", len(slots))
	}
	return c
}

// MasterOf returns the address of the master serving key.
func MasterOf(t *testing.T, c *redis.ClusterClient, key string) string {
	t.Helper()
	m, err := c.MasterForKey(Ctx(t), key)
	if err != nil {
		t.Fatalf("master for %q: %v", key, err)
	}
	return m.Options().Addr
}

// Postgres returns a pool on the real database, closed when the test ends.
func Postgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := Ctx(t)
	pool, err := pgxpool.New(ctx, env(t, EnvPostgresURL))
	if err != nil {
		t.Fatalf("postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("postgres ping: %v", err)
	}
	return pool
}

// Exec runs one statement, failing the test on error.
func Exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(Ctx(t), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

var unsafeKeyChars = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// Prefix returns a key prefix unique to this test run, so tests (and packages running in parallel)
// never read each other's keys.
func Prefix(t *testing.T) string {
	t.Helper()
	return "integ-" + unsafeKeyChars.ReplaceAllString(t.Name(), "_") + "-" + strconv.FormatInt(time.Now().UnixNano(), 36) + ":"
}

// Del removes keys when the test ends (for keys a test cannot prefix).
func Del(t *testing.T, c redis.UniversalClient, keys ...string) {
	t.Helper()
	del := func() {
		for _, k := range keys {
			_ = c.Del(context.Background(), k).Err()
		}
	}
	del()
	t.Cleanup(del)
}
