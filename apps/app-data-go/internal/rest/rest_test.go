package rest

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	docs, err := c.List(context.Background(), "civitai_tok", "notes", "src-app")
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
	_, err := c.List(context.Background(), "t", "notes", "")
	var re *Error
	if !errors.As(err, &re) || re.Status != 403 || string(re.Body) != `{"error":"import_not_granted"}` || re.Error() != "rest: status 403" {
		t.Fatalf("%v", err)
	}

	c = serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, `<html>`)
	})
	_, err = c.List(context.Background(), "t", "notes", "")
	if !errors.As(err, &re) || re.Status != 500 || re.Body != nil {
		t.Fatalf("a non-JSON error body must not be passed on: %v", err)
	}

	c = &Client{BaseURL: "http://127.0.0.1:1", MaxRecords: 10}
	if _, err := c.List(context.Background(), "t", "notes", ""); !errors.As(err, &re) || re.Status != 0 {
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
	if _, err := c.List(ctx, "t", "notes", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
}
