package tracker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
)

// The insert is the Node client's: `INSERT INTO <table> FORMAT JSONEachRow` with the shared async
// settings, the rows as the body, basic auth; one attempt whatever the answer.
func TestClickHouseInsert(t *testing.T) {
	var n atomic.Int32
	var gotPath, gotQuery, gotUser, gotPass, gotType, gotBody string
	var gotAuth bool
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		b, _ := io.ReadAll(r.Body)
		gotPath, gotQuery, gotType, gotBody = r.URL.Path, r.URL.RawQuery, r.Header.Get("Content-Type"), string(b)
		gotUser, gotPass, gotAuth = r.BasicAuth()
		w.WriteHeader(status)
	}))
	defer srv.Close()
	cl := NewClickHouse(srv.URL+"/", "u", "p", srv.Client())
	body := "{\"userId\":0,\"entityType\":\"Post\",\"entityId\":1,\"sessionKey\":\"k\",\"surface\":\"home\"}\n{\"userId\":0,\"entityType\":\"Post\",\"entityId\":2,\"sessionKey\":\"k\",\"surface\":\"home\"}"
	if got := cl.Send(context.Background(), beacon.Write{Table: "impressions", Body: []byte(body)}); got != ResultOK {
		t.Fatalf("result %s", got)
	}
	const wantQuery = "async_insert=1&output_format_json_quote_64bit_integers=0&query=INSERT+INTO+impressions+FORMAT+JSONEachRow&wait_for_async_insert=0"
	if gotPath != "/" || gotQuery != wantQuery || !gotAuth || gotUser != "u" || gotPass != "p" || gotType != "text/plain" || gotBody != body {
		t.Fatalf("POST %s?%s auth %v %q/%q type %q body %q", gotPath, gotQuery, gotAuth, gotUser, gotPass, gotType, gotBody)
	}
	for _, c := range []struct {
		status int
		result string
	}{{500, ResultFailed}, {400, ResultRejected}} {
		status = c.status
		before := n.Load()
		if got := cl.Send(context.Background(), beacon.Write{Table: "impressions", Body: []byte(body)}); got != c.result || n.Load()-before != 1 {
			t.Fatalf("status %d: %s after %d attempts", c.status, got, n.Load()-before)
		}
	}
}
