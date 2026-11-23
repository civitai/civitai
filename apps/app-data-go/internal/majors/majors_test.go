package majors

import (
	"strconv"
	"sync"
	"testing"
)

func TestTheBookKeepsTheHighestMajorPerCollection(t *testing.T) {
	var b Book
	if _, ok := b.Current("model-benchmarking", "records"); ok {
		t.Fatal("an empty book knows a major")
	}
	b.Observe([]string{
		"urn:schema:apps.civitai.com:model-benchmarking/records@v2",
		"urn:schema:apps.civitai.com:model-benchmarking/records@v1", // lower: never lowers the book
		"urn:schema:apps.civitai.com:model-benchmarking/kv@v3",
		"urn:schema:apps.civitai.com:model-benchmarking/records.viewer@v9", // not a collection schema
		"urn:schema:other.example:model-benchmarking/records@v7",           // another namespace
		"not a urn",
	})
	b.Observe([]string{"urn:schema:apps.civitai.com:todo-app/records@v5"})
	for _, tc := range []struct {
		slug, name string
		want       int
	}{
		{"model-benchmarking", "records", 2},
		{"model-benchmarking", "kv", 3},
		{"todo-app", "records", 5},
	} {
		if got, ok := b.Current(tc.slug, tc.name); !ok || got != tc.want {
			t.Errorf("%s/%s: %d, %v; want %d", tc.slug, tc.name, got, ok, tc.want)
		}
	}
	if _, ok := b.Current("todo-app", "kv"); ok {
		t.Fatal("a collection never seen is known")
	}
	b.Observe([]string{"urn:schema:apps.civitai.com:model-benchmarking/records@v4"})
	if got, _ := b.Current("model-benchmarking", "records"); got != 4 {
		t.Fatalf("a higher major did not raise the book: %d", got)
	}
}

func TestTheBookIsSafeForConcurrentUse(t *testing.T) {
	var b Book
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.Observe([]string{"urn:schema:apps.civitai.com:model-benchmarking/records@v" + strconv.Itoa(i+1)})
			b.Current("model-benchmarking", "records")
		}()
	}
	wg.Wait()
	if got, _ := b.Current("model-benchmarking", "records"); got != 8 {
		t.Fatalf("got %d, want 8", got)
	}
}
