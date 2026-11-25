package trpc

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The app's answer to one unbatched query whose procedure threw
// `new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Image search is temporarily overloaded — please retry.' })`
// (image.service.ts answerWithoutFeed), in a production build. Derived from the app's code, not
// captured from a running server: getErrorShape (@trpc/server 11: message, TRPC_ERROR_CODES_BY_KEY's
// -32603, data.code, data.httpStatus, data.path, no stack outside dev), errorFormatter unchanged for a
// 503, and the bodies are `JSON.stringify({ error: superjson.serialize(shape) })` and
// `JSON.stringify({ error: devalue.stringify(shape) })` run with the repo's own superjson and devalue.
const (
	appErrorSuperjsonBody = `{"error":{"json":{"message":"Image search is temporarily overloaded — please retry.","code":-32603,"data":{"code":"SERVICE_UNAVAILABLE","httpStatus":503,"path":"image.getInfinite"}}}}`
	appErrorDevalueBody   = `{"error":"[{\"message\":1,\"code\":2,\"data\":3},\"Image search is temporarily overloaded — please retry.\",-32603,{\"code\":4,\"httpStatus\":5,\"path\":6},\"SERVICE_UNAVAILABLE\",503,\"image.getInfinite\"]"}`
)

func TestWriteAppErrorServiceUnavailable(t *testing.T) {
	e := &Error{Code: "SERVICE_UNAVAILABLE", HTTPStatus: 503, Message: "Image search is temporarily overloaded — please retry."}
	for _, c := range []struct {
		name    string
		devalue bool
		body    string
	}{
		{"superjson", false, appErrorSuperjsonBody},
		{"devalue", true, appErrorDevalueBody},
	} {
		rec := httptest.NewRecorder()
		WriteAppError(rec, "image.getInfinite", e, c.devalue)
		if rec.Code != 503 {
			t.Errorf("%s: status %d, want 503", c.name, rec.Code)
		}
		if got := rec.Body.String(); got != c.body {
			t.Errorf("%s: body\n  %s\nwant\n  %s", c.name, got, c.body)
		}
		// resolveResponse's content-type and vary; applyApiRequestPolicy's private default
		// (PRIVATE_CACHE_CONTROL in src/server/middleware/middleware-utils.ts). Nothing else.
		want := map[string]string{
			"content-type":  "application/json",
			"vary":          "trpc-accept, accept",
			"cache-control": "max-age=0, private, no-cache",
		}
		got := map[string]string{}
		for k, v := range rec.Header() {
			got[strings.ToLower(k)] = strings.Join(v, ", ")
		}
		if len(got) != len(want) {
			t.Errorf("%s: headers %v, want exactly %v", c.name, got, want)
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s: %s = %q, want %q", c.name, k, got[k], v)
			}
		}
	}
}

// WriteError (the dev-only answer with no fallback configured) is unchanged by the shared shape: its
// own Cache-Control, and the INTERNAL_SERVER_ERROR code.
func TestWriteErrorKeepsItsOwnHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, "image.getInfinite", &Error{Code: "INTERNAL_SERVER_ERROR", HTTPStatus: http.StatusServiceUnavailable, Message: "unavailable"})
	want := `{"error":{"json":{"message":"unavailable","code":-32603,"data":{"code":"INTERNAL_SERVER_ERROR","httpStatus":503,"path":"image.getInfinite"}}}}`
	if rec.Body.String() != want || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("body %s cache-control %q, want %s and no-store", rec.Body.String(), rec.Header().Get("Cache-Control"), want)
	}
}
