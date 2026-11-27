package cache

import (
	"bufio"
	"bytes"
	"testing"
)

// FuzzReadReply feeds the RESP reply parser arbitrary bytes, as a broken or hostile server could
// send: it must never panic or allocate past its bounds, and every reply it reads must be within
// them (a bulk at most maxBulk, an array at most maxArray elements, at most maxDepth deep).
func FuzzReadReply(f *testing.F) {
	for _, seed := range []string{
		"+OK\r\n", "-ERR x\r\n", ":7\r\n", "$-1\r\n", "$3\r\nabc\r\n", "$0\r\n\r\n", "*-1\r\n",
		"*2\r\n$1\r\na\r\n:1\r\n", "*1\r\n-ERR inner\r\n", "*1\r\n*1\r\n*1\r\n*1\r\n*1\r\n+x\r\n",
		"$999999999999\r\n", "$5\r\nab", "*3\r\n", "?\r\n", "\r\n", "", "+OK\n",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		rd := bufio.NewReader(bytes.NewReader(data))
		for range 64 {
			rep, err := readReply(rd, 0)
			if err != nil {
				return
			}
			check(t, rep, 0)
		}
	})
}

func check(t *testing.T, rep reply, depth int) {
	t.Helper()
	switch {
	case depth > maxDepth:
		t.Fatalf("a reply %d deep", depth)
	case len(rep.bulk) > maxBulk:
		t.Fatalf("a bulk of %d bytes", len(rep.bulk))
	case len(rep.arr) > maxArray:
		t.Fatalf("an array of %d", len(rep.arr))
	case rep.null && (rep.bulk != nil || rep.arr != nil):
		t.Fatal("a null reply with content")
	}
	for _, el := range rep.arr {
		check(t, el, depth+1)
	}
}
