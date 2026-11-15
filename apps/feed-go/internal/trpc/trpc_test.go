package trpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestParseInputSuperjson(t *testing.T) {
	// What the web client sends for a model gallery page with an undefined cursor.
	in := `{"json":{"modelId":7,"modelVersionId":9,"limit":50,"sort":"Newest","browsingLevel":31,"cursor":null},` +
		`"meta":{"values":{"cursor":["undefined"]},"v":1}}`
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/image.getImagesAsPostsInfinite?input="+url.QueryEscape(in), nil)
	got, err := ParseInput(r)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["cursor"]; ok {
		t.Fatalf("an undefined-annotated key must be removed, got %v", got["cursor"])
	}
	if n, _ := got["modelId"].(json.Number).Int64(); n != 7 {
		t.Fatalf("modelId = %v", got["modelId"])
	}
	if got["sort"] != "Newest" {
		t.Fatalf("sort = %v", got["sort"])
	}
}

func TestParseInputRefusesBatchAndBadEnvelope(t *testing.T) {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/a,b?batch=1&input=%7B%7D", nil)
	if _, err := ParseInput(r); !errors.Is(err, ErrBatched) {
		t.Fatalf("batched: err = %v, want ErrBatched", err)
	}
	if _, err := DecodeEnvelope([]byte(`"devalue-string"`)); err == nil {
		t.Fatal("a non-object envelope must be refused")
	}
	if _, err := DecodeEnvelope([]byte(`{"json":{"a":1},"meta":{"values":{"a":["Map"]}}}`)); err == nil {
		t.Fatal("an unsupported annotation must be refused")
	}
}

func TestWriteResultEnvelopeAndCacheHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteResult(rec, []byte(`{"json":{"items":[]}}`), &SignedOutTTL)
	if got := rec.Body.String(); got != `{"result":{"data":{"json":{"items":[]}}}}` {
		t.Fatalf("body = %s", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=60, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("signed-out Cache-Control = %q", got)
	}
	rec = httptest.NewRecorder()
	WriteResult(rec, []byte(`{"json":null}`), nil)
	if got := rec.Header().Get("Cache-Control"); got != "max-age=0, private, no-cache" {
		t.Fatalf("signed-in Cache-Control = %q", got)
	}
}

func TestWriteErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, "image.getImagesAsPostsInfinite", &Error{Code: "BAD_REQUEST", HTTPStatus: 400, Message: "bad"})
	if rec.Code != 400 {
		t.Fatalf("status = %d", rec.Code)
	}
	want := `{"error":{"json":{"message":"bad","code":-32600,"data":{"code":"BAD_REQUEST","httpStatus":400,"path":"image.getImagesAsPostsInfinite"}}}}`
	if got := rec.Body.String(); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// A pooled payload released right after WriteResult (what the server does) is never read again: each
// response, read back after every owner has released and the pool has been reused, is its own. One
// run writes to recorders, the other through a real net/http server (whose ResponseWriter is what must
// not keep the slice). Both run under -race in CI.
func TestWriteResultThenReleaseConcurrent(t *testing.T) {
	payload := func(n int) superjson.Object {
		return superjson.Object{{Key: "n", Val: n}, {Key: "pad", Val: strings.Repeat("p", (n*53)%4096)}}
	}
	want := func(n int) string {
		return `{"result":{"data":{"json":{"n":` + strconv.Itoa(n) + `,"pad":"` + strings.Repeat("p", (n*53)%4096) + `"}}}}`
	}
	write := func(w http.ResponseWriter, n int) {
		buf, err := superjson.SerializeBuffer(payload(n))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		WriteResult(w, buf.Bytes(), nil)
		buf.Release()
	}

	const owners = 200
	recs := make([]*httptest.ResponseRecorder, owners)
	var wg sync.WaitGroup
	for n := range owners {
		recs[n] = httptest.NewRecorder()
		wg.Add(1)
		go func() {
			defer wg.Done()
			write(recs[n], n)
		}()
	}
	wg.Wait()
	for n, rec := range recs {
		if got := rec.Body.String(); got != want(n) {
			t.Fatalf("recorder %d after release: %.80s…", n, got)
		}
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		write(w, n)
	}))
	defer srv.Close()
	bodies := make([]string, owners)
	errs := make([]error, owners)
	for n := range owners {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+"/?n="+strconv.Itoa(n), nil)
			if err != nil {
				errs[n] = err
				return
			}
			resp, err := srv.Client().Do(req)
			if err != nil {
				errs[n] = err
				return
			}
			defer func() { _ = resp.Body.Close() }()
			b, err := io.ReadAll(resp.Body)
			bodies[n], errs[n] = string(b), err
		}()
	}
	wg.Wait()
	for n := range owners {
		if errs[n] != nil {
			t.Fatalf("request %d: %v", n, errs[n])
		}
		if bodies[n] != want(n) {
			t.Fatalf("response %d: %.80s…", n, bodies[n])
		}
	}
}
