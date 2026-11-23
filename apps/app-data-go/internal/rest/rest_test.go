package rest

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func serve(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &Client{BaseURL: srv.URL + "/", MaxRecords: 10}
}

func TestListSendsTheCallersTokenAndReadsEveryPage(t *testing.T) {
	var seen []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization")+" "+r.URL.RequestURI())
		if r.URL.Query().Get("cursor") == "" {
			_, _ = io.WriteString(w, `{"items":[{"key":"a","data":{"n":1},"version":2}],"nextCursor":"c 1"}`)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"key":"b","data":{"n":2},"version":5}],"nextCursor":null}`)
	})
	docs, err := c.List(context.Background(), "civitai_tok", "notes", "src-app", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 || docs[0].Key != "a" || docs[1].Version != 5 || string(docs[1].Data) != `{"n":2}` {
		t.Fatalf("%+v", docs)
	}
	want := []string{
		"Bearer civitai_tok /api/v1/blocks/storage/notes?from=src-app&limit=100",
		"Bearer civitai_tok /api/v1/blocks/storage/notes?cursor=c+1&from=src-app&limit=100",
	}
	if strings.Join(seen, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests:\n%s", strings.Join(seen, "\n"))
	}
}

func TestListErrors(t *testing.T) {
	c := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		_, _ = io.WriteString(w, `{"error":"import_not_granted"}`)
	})
	_, err := c.List(context.Background(), "t", "notes", "", "")
	var re *Error
	if !errors.As(err, &re) || re.Status != 403 || string(re.Body) != `{"error":"import_not_granted"}` || re.Error() != "rest: status 403" {
		t.Fatalf("%v", err)
	}

	c = serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, `<html>`)
	})
	_, err = c.List(context.Background(), "t", "notes", "", "")
	if !errors.As(err, &re) || re.Status != 500 || re.Body != nil {
		t.Fatalf("a non-JSON error body must not be passed on: %v", err)
	}

	c = &Client{BaseURL: "http://127.0.0.1:1", MaxRecords: 10}
	if _, err := c.List(context.Background(), "t", "notes", "", ""); !errors.As(err, &re) || re.Status != 0 {
		t.Fatalf("connect failure: %v", err)
	}

	block := make(chan struct{})
	defer close(block)
	c = serve(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.List(ctx, "t", "notes", "", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
}

// A redirect is never followed: it would re-send the user's token to Location.
func TestListNeverFollowsARedirect(t *testing.T) {
	var reached atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
		_, _ = io.WriteString(w, `{"items":[],"nextCursor":null}`)
	}))
	t.Cleanup(elsewhere.Close)
	for _, hc := range []*http.Client{nil, {Timeout: 5 * time.Second}} {
		c := serve(t, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, elsewhere.URL+"/api/v1/blocks/storage/notes", http.StatusFound)
		})
		c.HTTP = hc
		_, err := c.List(context.Background(), "civitai_tok", "notes", "src-app", "")
		var re *Error
		if !errors.As(err, &re) || re.Status != http.StatusFound {
			t.Fatalf("got %v, want the 302 as the answer", err)
		}
	}
	if n := reached.Load(); n != 0 {
		t.Fatalf("🔴 the redirect target was reached %d times", n)
	}
}

// A keyPrefix is sent as the store's own `keyPrefix` filter, on every page.
func TestListSendsTheKeyPrefixOnEveryPage(t *testing.T) {
	var seen []string
	c := serve(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.RequestURI())
		if r.URL.Query().Get("cursor") == "" {
			_, _ = io.WriteString(w, `{"items":[{"key":"run:a","data":{},"version":1}],"nextCursor":"c2"}`)
			return
		}
		_, _ = io.WriteString(w, `{"items":[{"key":"run:b","data":{},"version":1}],"nextCursor":null}`)
	})
	if _, err := c.List(context.Background(), "t", "notes", "src-app", "run:"); err != nil {
		t.Fatal(err)
	}
	want := "/api/v1/blocks/storage/notes?from=src-app&keyPrefix=run%3A&limit=100\n" +
		"/api/v1/blocks/storage/notes?cursor=c2&from=src-app&keyPrefix=run%3A&limit=100"
	if strings.Join(seen, "\n") != want {
		t.Fatalf("requests:\n%s", strings.Join(seen, "\n"))
	}
}
