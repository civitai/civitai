package registry

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A request's Headers go on the subscription (the viewer's region headers), and never replace the
// ones the client sets itself: Accept, Authorization, User-Agent.
func TestARequestsHeadersAreSentButNeverReplaceTheClients(t *testing.T) {
	got := make(chan http.Header, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: end\ndata: {}\n\n")
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "app-data-go"}
	st, err := c.Subscribe(context.Background(), Request{Schema: "s", Token: "tok-9e1", Headers: map[string]string{
		"cf-ipcountry": "CA", "cf-region-code": "QC",
		"authorization": "Bearer forged", "Accept": "text/html", "user-agent": "forged",
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	h := <-got
	if h.Get("Cf-Ipcountry") != "CA" || h.Get("Cf-Region-Code") != "QC" {
		t.Fatalf("region headers: %v", h)
	}
	if h.Get("Authorization") != "Bearer tok-9e1" || h.Get("Accept") != "text/event-stream" || h.Get("User-Agent") != "app-data-go" ||
		len(h.Values("Authorization")) != 1 {
		t.Fatalf("🔴 a request header replaced the client's own: %v", h)
	}
}
