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
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
)

const (
	// EnvRedisCluster is a comma-separated list of the cluster's seed addresses.
	EnvRedisCluster = "FEED_GO_TEST_REDIS_CLUSTER"
	// EnvPostgresURL is the Postgres connection URL; the database holds testdata/integration/schema.sql.
	EnvPostgresURL = "FEED_GO_TEST_PG_URL"
	// EnvClickHouseURL is the ClickHouse HTTP endpoint; EnvClickHouseUser / EnvClickHousePassword its
	// account (the job's container user).
	EnvClickHouseURL      = "FEED_GO_TEST_CLICKHOUSE_URL"
	EnvClickHouseUser     = "FEED_GO_TEST_CLICKHOUSE_USER"
	EnvClickHousePassword = "FEED_GO_TEST_CLICKHOUSE_PASSWORD" //nolint:gosec // the variable's name, not a credential
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
	shards, err := c.ClusterShards(ctx).Result()
	if err != nil {
		t.Fatalf("CLUSTER SHARDS: %v", err)
	}
	if len(shards) < 2 {
		t.Fatalf("want a cluster of >= 2 masters, CLUSTER SHARDS lists %d shards", len(shards))
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

// ClickHouse returns the service's read-only client of the real ClickHouse (at most maxInFlight
// reads at once). It fails the test unless the server answers.
func ClickHouse(t *testing.T, maxInFlight int) *chread.Client {
	t.Helper()
	c, err := chread.New(chread.Config{URL: env(t, EnvClickHouseURL), Username: env(t, EnvClickHouseUser),
		Password: os.Getenv(EnvClickHousePassword), MaxInFlight: maxInFlight})
	if err != nil {
		t.Fatalf("clickhouse: %v", err)
	}
	if _, err := c.Query(Ctx(t), "SELECT 1 AS one", nil); err != nil {
		t.Fatalf("clickhouse SELECT 1: %v", err)
	}
	return c
}

// ClickHouseExec runs one statement that writes (DDL, INSERT) as a POST, which the read-only client
// cannot send, failing the test on error.
func ClickHouseExec(t *testing.T, sql string) {
	t.Helper()
	u, err := url.Parse(env(t, EnvClickHouseURL))
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(Ctx(t), http.MethodPost, u.String(), strings.NewReader(sql))
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth(env(t, EnvClickHouseUser), os.Getenv(EnvClickHousePassword))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("clickhouse exec: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		t.Fatalf("clickhouse exec %q: %d %s", sql, resp.StatusCode, body)
	}
}

// ClickHouseRaw sends sql as a GET with the given settings, as the read client sends it, and returns
// the raw response: its status, headers, and as much of its body as could be read (with the read
// error, e.g. the broken chunked stream after a mid-response exception).
func ClickHouseRaw(t *testing.T, sql string, settings []chread.Setting) (int, http.Header, []byte, error) {
	t.Helper()
	u, err := url.Parse(env(t, EnvClickHouseURL))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("query", chread.WireQuery(sql))
	for _, s := range settings {
		q.Set(s.Name, s.Value)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(Ctx(t), http.MethodGet, u.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth(env(t, EnvClickHouseUser), os.Getenv(EnvClickHousePassword))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("clickhouse get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, body, readErr
}
