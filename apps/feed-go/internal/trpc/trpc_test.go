package trpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestParseInputSuperjson(t *testing.T) {
	// What the web client sends for a model gallery page with an undefined cursor.
	in := `{"json":{"modelId":7,"modelVersionId":9,"limit":50,"sort":"Newest","browsingLevel":31,"cursor":null},` +
		`"meta":{"values":{"cursor":["undefined"]},"v":1}}`
	r := httptest.NewRequest(http.MethodGet, "/api/trpc/image.getImagesAsPostsInfinite?input="+url.QueryEscape(in), nil)
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
	r := httptest.NewRequest(http.MethodGet, "/api/trpc/a,b?batch=1&input=%7B%7D", nil)
	if _, err := ParseInput(r); err != ErrBatched {
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
