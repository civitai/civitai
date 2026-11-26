package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClickHouse answers every GET with rows (JSONEachRow) and accepts every INSERT, recording the
// INSERT queries.
func fakeClickHouse(t *testing.T, rows string) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var inserts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = io.Copy(io.Discard, r.Body)
			mu.Lock()
			inserts = append(inserts, r.URL.Query().Get("query"))
			mu.Unlock()
			return
		}
		_, _ = io.WriteString(w, rows)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), inserts...)
	}
}

func setCH(t *testing.T, url string) {
	t.Helper()
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", url+"/evaldb")
	t.Setenv("FEED_EVAL_CLICKHOUSE_USER", "eval-user")
	t.Setenv("FEED_EVAL_CLICKHOUSE_PASSWORD", "eval-pass")
}

// writeAccountsFile writes an accounts file with one member account whose token expires far ahead.
func writeAccountsFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	claims, _ := json.Marshal(map[string]any{"exp": time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC).Unix()})
	tok := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + ".c2ln"
	tf := filepath.Join(dir, "t")
	if err := os.WriteFile(tf, []byte(tok), 0o600); err != nil {
		t.Fatal(err)
	}
	f := `{"accounts":[{"role":"member-default","sessionTokenFile":"` + tf + `","userId":7101,"username":"evaldefault"}]}`
	path := filepath.Join(dir, "accounts.json")
	if err := os.WriteFile(path, []byte(f), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunCmdErrors(t *testing.T) {
	healthFile := filepath.Join(t.TempDir(), "health.json")
	if err := os.WriteFile(healthFile, []byte(`[{"name":"load","query":"up","max":1}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FEED_EVAL_ACCOUNTS_FILE", "")
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--bogus"}, "flag provided but not defined"},
		{[]string{"extra"}, `unexpected argument "extra"`},
		{[]string{"--window", "3-8"}, "window"},
		{[]string{"--health", "load=up"}, "health: want"},
		{[]string{"--health-file", filepath.Join(t.TempDir(), "absent.json")}, "health file"},
		{[]string{"--health", "load=up;max=1", "--health-file", healthFile, "--endpoints", "as-posts"}, "FEED_EVAL_ACCOUNTS_FILE is required"},
	}
	for _, c := range cases {
		if err := runCmd(c.args, io.Discard); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v, want %q", c.args, err, c.want)
		}
	}
	t.Setenv("FEED_EVAL_ACCOUNTS_FILE", filepath.Join(t.TempDir(), "absent.json"))
	if err := runCmd(nil, io.Discard); err == nil || !strings.Contains(err.Error(), "accounts file") {
		t.Errorf("absent accounts file: %v", err)
	}
	t.Setenv("FEED_EVAL_ACCOUNTS_FILE", writeAccountsFile(t))
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", "")
	if err := runCmd(nil, io.Discard); err == nil || !strings.Contains(err.Error(), "FEED_EVAL_CLICKHOUSE_URL, _USER and _PASSWORD are all required") {
		t.Errorf("no clickhouse: %v", err)
	}
}

func TestRunCmdRuns(t *testing.T) {
	t.Setenv("NODE_URL", "")
	t.Setenv("GO_URL", "")
	ch, inserts := fakeClickHouse(t, "") // no case selected
	setCH(t, ch.URL)
	t.Setenv("FEED_EVAL_ACCOUNTS_FILE", writeAccountsFile(t))
	var stderr bytes.Buffer
	args := []string{"run", "--node-url", "http://127.0.0.1:9", "--go-url", "http://127.0.0.1:9", "--force-window", "--allow-no-health",
		"--endpoints", "v1-models-id"}
	if code := run(args, nil, io.Discard, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if got := inserts(); len(got) != 1 || got[0] != "INSERT INTO runs FORMAT JSONEachRow" {
		t.Fatalf("inserts %v", got)
	}
	if !strings.Contains(stderr.String(), "0 cases selected") || !strings.Contains(stderr.String(), "ended (done)") {
		t.Errorf("log %q", stderr.String())
	}
	// A config the run refuses is exit 1.
	if code := run([]string{"run", "--allow-no-health", "--force-window"}, nil, io.Discard, &stderr); code != 1 {
		t.Errorf("no URLs: exit %d", code)
	}
}

// publishRows is one run and nothing else: every page renders empty.
const publishRows = `{"run_id":"live-20261126T030000Z-aa11bb","started_ms":1764126000000,"from_ms":1761534000000,"to_ms":1764126000000,"settings":"{\"end_reason\":\"done\"}"}` + "\n"

func TestPublishCmd(t *testing.T) {
	ch, _ := fakeClickHouse(t, publishRows)
	t.Setenv("HQ_TOKEN", "")
	t.Setenv("HQ_TOKEN_FILE", "")
	t.Setenv("HQ_URL", "")
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", "")
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--bogus"}, "flag provided but not defined"},
		{[]string{"extra"}, `unexpected argument "extra"`},
		{nil, "HQ_TOKEN or HQ_TOKEN_FILE is required"},
		{[]string{"--dry-run", t.TempDir()}, "FEED_EVAL_CLICKHOUSE_URL, _USER and _PASSWORD are all required"},
	}
	for _, c := range cases {
		if err := publishCmd(c.args, io.Discard); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v, want %q", c.args, err, c.want)
		}
	}
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty")
	if err := os.WriteFile(empty, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HQ_TOKEN_FILE", empty)
	if err := publishCmd(nil, io.Discard); err == nil || !strings.Contains(err.Error(), "HQ_TOKEN_FILE is empty") {
		t.Errorf("empty token file: %v", err)
	}
	t.Setenv("HQ_TOKEN_FILE", filepath.Join(dir, "absent"))
	if err := publishCmd(nil, io.Discard); err == nil || !strings.Contains(err.Error(), "HQ_TOKEN_FILE") {
		t.Errorf("absent token file: %v", err)
	}
	tokenFile := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenFile, []byte("hq-file-token-77\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HQ_TOKEN_FILE", tokenFile)
	if err := publishCmd(nil, io.Discard); err == nil || !strings.Contains(err.Error(), "HQ_URL") {
		t.Errorf("no HQ_URL: %v", err)
	}

	setCH(t, ch.URL)
	// Dry run: files, no PUT.
	out := t.TempDir()
	var stdout bytes.Buffer
	if code := run([]string{"publish", "--dry-run", out, "--endpoints", "as-posts,v1-models-id"}, nil, &stdout, io.Discard); code != 0 {
		t.Fatalf("dry run: exit %d", code)
	}
	if stdout.String() != "published: feed-eval feed-eval-as-posts feed-eval-v1-models-id\n" {
		t.Errorf("stdout %q", stdout.String())
	}
	for _, id := range []string{"feed-eval", "feed-eval-as-posts", "feed-eval-v1-models-id"} {
		if _, err := os.Stat(filepath.Join(out, id+".html")); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
	// PUT, with the token file's token and the viewers.
	var mu sync.Mutex
	var auths, paths []string
	hq := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		auths = append(auths, r.Header.Get("Authorization"))
		paths = append(paths, r.Method+" "+r.URL.Path)
	}))
	defer hq.Close()
	t.Setenv("HQ_URL", hq.URL)
	if err := publishCmd([]string{"--prefix", "evp", "--endpoints", "as-posts", "--viewers", "a, b"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(paths, ",") != "PUT /api/v1/pages/evp,PUT /api/v1/pages/evp-as-posts" ||
		strings.Join(auths, ",") != "Bearer hq-file-token-77,Bearer hq-file-token-77" {
		t.Errorf("puts %v %v", paths, auths)
	}
	// HQ_TOKEN wins over the file.
	t.Setenv("HQ_TOKEN", "hq-env-token-88")
	if tok, err := hqToken(); err != nil || tok != "hq-env-token-88" {
		t.Errorf("token %q %v", tok, err)
	}
	// A failed publish is exit 1.
	if code := run([]string{"publish", "--prefix", "Bad"}, nil, io.Discard, io.Discard); code != 1 {
		t.Errorf("bad prefix: exit %d", code)
	}
}

// TestRunCmdFailsOnLostRows: a ClickHouse refusing every INSERT makes `feed-eval run` exit 1 and say
// how many rows were lost.
func TestRunCmdFailsOnLostRows(t *testing.T) {
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = io.Copy(io.Discard, r.Body)
			http.Error(w, "Code: 497. Not enough privileges", http.StatusForbidden)
		}
	}))
	defer ch.Close()
	setCH(t, ch.URL)
	t.Setenv("FEED_EVAL_ACCOUNTS_FILE", writeAccountsFile(t))
	var stderr bytes.Buffer
	args := []string{"run", "--node-url", "http://127.0.0.1:9", "--go-url", "http://127.0.0.1:9", "--force-window", "--allow-no-health",
		"--endpoints", "v1-models-id"}
	if code := run(args, nil, io.Discard, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "0 of 0 results rows and 1 of 1 runs rows were not written") {
		t.Errorf("stderr %q", stderr.String())
	}
}

// TestReconcileCmd: the command end to end over a ClickHouse holding one live run and nothing else:
// one summary row written, none in a dry run (which prints the summary), and bad flags refused.
func TestReconcileCmd(t *testing.T) {
	ch, inserts := fakeClickHouse(t, publishRows)
	setCH(t, ch.URL)
	var stdout, stderr bytes.Buffer
	if code := run([]string{"reconcile"}, nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if got := inserts(); len(got) != 1 || got[0] != "INSERT INTO runs FORMAT JSONEachRow" {
		t.Fatalf("inserts %v", got)
	}
	if !strings.Contains(stderr.String(), "feed-eval reconcile of live-20261126T030000Z-aa11bb: 0 blind spots") {
		t.Errorf("log %q", stderr.String())
	}
	stdout.Reset()
	if code := run([]string{"reconcile", "--dry-run"}, nil, &stdout, io.Discard); code != 0 {
		t.Fatalf("dry run: exit %d", code)
	}
	if len(inserts()) != 1 || !strings.Contains(stdout.String(), `"reconciled_run": "live-20261126T030000Z-aa11bb"`) ||
		!strings.Contains(stdout.String(), `"dry_run": true`) {
		t.Errorf("dry run: %d inserts, stdout %q", len(inserts()), stdout.String())
	}
	if code := run([]string{"reconcile", "--min-mismatch-share", "2"}, nil, io.Discard, io.Discard); code != 1 {
		t.Errorf("a share over 1: exit %d", code)
	}
	t.Setenv("FEED_EVAL_CLICKHOUSE_URL", "")
	if code := run([]string{"reconcile"}, nil, io.Discard, io.Discard); code != 1 {
		t.Errorf("no clickhouse: exit %d", code)
	}
}
