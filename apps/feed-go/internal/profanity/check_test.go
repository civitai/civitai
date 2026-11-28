package profanity

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// parseRow reads a BlocklistDTO as the list service does (`data ?? []`; a row is one with an `id`),
// and refuses any value whose reading is not that plain shape.
func TestParseRow(t *testing.T) {
	for _, c := range []struct {
		raw   string
		want  []string // nil: no moderator row
		shape bool     // errShape
	}{
		{raw: `{"id":1,"type":"ProfanityWord","data":["a","b"]}`, want: []string{"a", "b"}},
		{raw: `{"id":0,"data":[]}`, want: []string{}},
		{raw: `{"id":1}`, want: []string{}},
		{raw: `{"id":1,"data":null}`, want: []string{}},
		{raw: `{"type":"ProfanityWord","data":["a"]}`},
		{raw: `{"id":null,"data":["a"]}`},
		{raw: `{"id":1,"data":["a",1]}`, shape: true},
		{raw: `{"id":1,"data":"a"}`, shape: true},
		{raw: `{"id":1,"data":[null]}`, shape: true},
		{raw: `["a"]`, shape: true},
		{raw: `null`, shape: true},
		{raw: `{"id":1,"data":[]} x`, shape: true},
		{raw: `{"id":1,"data":[],"data":["a"]}`, shape: true},
		{raw: `{"id":1,`, shape: true},
	} {
		got, err := parseRow(c.raw)
		if c.shape {
			if !errors.Is(err, errShape) {
				t.Errorf("%s: %v %v, want errShape", c.raw, got, err)
			}
			continue
		}
		if err != nil || (got == nil) != (c.want == nil) || !slices.Equal(got, c.want) {
			t.Errorf("%s: %q %v, want %q", c.raw, got, err, c.want)
		}
	}
}

type countingCache struct {
	rows  map[string]string
	err   error
	reads int
}

func (c *countingCache) Get(_ context.Context, key string) *redis.StringCmd {
	c.reads++
	if c.err != nil {
		return redis.NewStringResult("", c.err)
	}
	if v, ok := c.rows[key]; ok {
		return redis.NewStringResult(v, nil)
	}
	return redis.NewStringResult("", redis.Nil)
}

// One read of the rows serves ShareInterval, as Node shares one; a flip of the flag reads the rows
// that state names; a failed read is Unproven, never the shipped list.
func TestCheckerReads(t *testing.T) {
	d, err := Shipped()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_000_000, 0)
	cache := &countingCache{rows: map[string]string{KeyPrefix + TypeBenign: `{"data":[]}`}}
	flag := &fakeFlag{off: true}
	ck := &Checker{Data: d, Redis: cache, Flag: flag, Now: func() time.Time { return now }}
	check := func(q string) Result { return ck.Check(context.Background(), []string{q}) }

	if r := check("cat"); r.Verdict != Clean || cache.reads != 1 {
		t.Fatalf("first: %+v after %d reads", r, cache.reads)
	}
	if r := check("ass"); r.Verdict != Profane || cache.reads != 1 {
		t.Fatalf("shared: %+v after %d reads, want no second read", r, cache.reads)
	}
	now = now.Add(ShareInterval)
	if r := check("cat"); r.Verdict != Clean || cache.reads != 2 {
		t.Fatalf("after the share: %+v after %d reads", r, cache.reads)
	}
	// Flag on: both rows; the ProfanityWord key is absent, which Node would read from the database.
	*flag = fakeFlag{on: true}
	if r := check("cat"); r.Verdict != Unproven || r.Reason != ReasonListMiss {
		t.Fatalf("flag on, no ProfanityWord key: %+v", r)
	}
	*flag = fakeFlag{}
	if r := check("cat"); r.Verdict != Unproven || r.Reason != ReasonFlag {
		t.Fatalf("flag unknown: %+v", r)
	}
	*flag = fakeFlag{off: true}
	now = now.Add(ShareInterval)
	cache.err = errors.New("cache down")
	if r := check("cat"); r.Verdict != Unproven || r.Reason != ReasonListRead {
		t.Fatalf("cache down: %+v", r)
	}
	cache.err = nil
	cache.rows[KeyPrefix+TypeBenign] = ""
	now = now.Add(ShareInterval)
	if r := check("cat"); r.Verdict != Unproven || r.Reason != ReasonListMiss {
		t.Fatalf("empty value (falsy to Node): %+v", r)
	}
	// No text: clean, and nothing read.
	reads := cache.reads
	if r := ck.Check(context.Background(), []string{"", " \t\v\f\r\n"}); r.Verdict != Clean || cache.reads != reads {
		t.Fatalf("no text: %+v after %d more reads", r, cache.reads-reads)
	}
	var nilChecker *Checker
	if r := nilChecker.Check(context.Background(), []string{"cat"}); r.Verdict != Unproven || r.Reason != ReasonUnconfigured {
		t.Fatalf("nil checker: %+v", r)
	}
}

// The parser refuses what obscenity's refuses, and the compiled regexp is compilePatternToRegExp's.
func TestPatterns(t *testing.T) {
	for raw, want := range map[string]string{
		"porn":       "(?s)porn",
		"|ass":       `(?s)\bass`,
		"oanal|":     `(?s)oanal\b`,
		"|prick[s]|": `(?s)\bprick(?:s)?\b`,
		"f[?]ck":     `(?s)f(?:.)?ck`,
		"[or]gasm":   `(?s)(?:or)?gasm`,
		"who're":     `(?s)who're`,
		`a\?b`:       `(?s)a\?b`,
		"a-b c":      `(?s)a-b c`,
	} {
		pt, err := parsePattern(raw)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		re, err := compilePattern(pt)
		if err != nil || re.String() != want {
			t.Errorf("%s: %v %v, want %s", raw, re, err, want)
		}
	}
	for _, raw := range []string{"", "|", "||", "[a]", "a|b", "[|a]", "[[a]]", "a]", "[a", `a\`, `a\b`, "[a][b]", "café"} {
		pt, err := parsePattern(raw)
		if err == nil {
			_, err = compilePattern(pt)
		}
		if err == nil {
			t.Errorf("%q: accepted", raw)
		}
	}
}
