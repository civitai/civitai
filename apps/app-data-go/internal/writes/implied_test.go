package writes

import (
	"testing"
)

// A write that names no major is acknowledged at the major the implied-major rule names for its app
// and collection (the one a no-major read opens: api/major.go); one that names a major, at that
// major, the rule not asked. The rule is asked with the path's own app and collection.
func TestAWriteNamingNoMajorIsAcknowledgedAtTheImpliedMajor(t *testing.T) {
	log := &ackLog{}
	var asked []string
	r := newRig(t, func(f *Forwarder) {
		f.Acked = log.add
		f.UseImpliedMajor(func(slug, collection string) int {
			asked = append(asked, slug+"/"+collection)
			return 7
		})
	})
	const tok = "civitai_implied-writer"
	r.site.set(answerWith(200, `{"key":"k-1","data":{"n":1},"version":1,"seq":91}`, map[string]string{"Content-Type": "application/json"}))
	if rec := r.do(t, call{method: "PUT", path: "/v1/apps/implied-app/collections/runs/records/k-1", body: []byte(`{"data":{"n":1}}`),
		auth: "Bearer " + tok}); rec.Code != 200 {
		t.Fatalf("no major: %d %s", rec.Code, rec.Body)
	}
	r.site.set(answerWith(200, `{"key":"k-2","data":{"n":2},"version":1,"seq":92}`, map[string]string{"Content-Type": "application/json"}))
	if rec := r.do(t, call{method: "PUT", path: "/v1/apps/implied-app/collections/runs/records/k-2?major=4", body: []byte(`{"data":{"n":2}}`),
		auth: "Bearer " + tok}); rec.Code != 200 {
		t.Fatalf("named major: %d %s", rec.Code, rec.Body)
	}
	got := log.take()
	if len(got) != 2 || got[0].schema != "urn:schema:apps.civitai.com:implied-app/runs@v7" ||
		got[1].schema != "urn:schema:apps.civitai.com:implied-app/runs@v4" {
		t.Fatalf("acked %+v; want @v7 (implied), then @v4 (named)", got)
	}
	if len(asked) != 1 || asked[0] != "implied-app/runs" {
		t.Fatalf("the rule was asked %v; want once, for implied-app/runs", asked)
	}
}
