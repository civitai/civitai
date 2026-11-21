package shadow

import "testing"

func TestClassifyArray(t *testing.T) {
	node := []byte(`{"json":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}`)
	for _, c := range []struct{ goEnv, want string }{
		{`{"json":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}`, "match"},
		{`{"json":[{"id":1,"name":"a"},{"id":2,"name":"c"}]}`, "fields"},
		{`{"json":[{"id":2,"name":"b"},{"id":1,"name":"a"}]}`, "order"},
		{`{"json":[{"id":1,"name":"a"},{"id":3,"name":"b"}]}`, "membership"},
		{`{"json":[{"id":1,"name":"a"}]}`, "membership"},
		{`{"json":{"items":[]}}`, "fields"},
	} {
		r, err := Compare([]byte(c.goEnv), node)
		if err != nil {
			t.Fatal(err)
		}
		if got := ClassifyArray(r, []byte(c.goEnv), node); got != c.want {
			t.Errorf("%s: %s, want %s", c.goEnv, got, c.want)
		}
	}
}
