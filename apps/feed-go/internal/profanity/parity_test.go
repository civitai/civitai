package profanity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/redis/go-redis/v9"
)

// The parity fixture, apps/feed-go/testdata/profanity/parity.json, is shared with
// src/server/__tests__/feed-go-site-search-profanity.test.ts, which runs Node's real
// profaneSearchCheck over every case and the real SimpleProfanityFilter over the corpus and holds
// each `node` verdict to it. Its verdicts are Node's, written from that test's output, never from
// this package's.

const parityFixture = "../../testdata/profanity/parity.json"

type fixtureRow struct {
	Raw       *string  `json:"raw"`
	ID        *int     `json:"id"`
	Data      []string `json:"data"`
	Synthetic int      `json:"synthetic"`
}

type fixtureCase struct {
	Name    string                `json:"name"`
	Flag    string                `json:"flag"`
	Rows    map[string]fixtureRow `json:"rows"`
	Queries []string              `json:"queries"`
	Node    *string               `json:"node"`
	Go      string                `json:"go"`
}

type fixture struct {
	Cases  []fixtureCase `json:"cases"`
	Corpus struct {
		Count    int               `json:"count"`
		SHA256   string            `json:"sha256"`
		Verdicts map[string]string `json:"verdicts"`
	} `json:"corpus"`
}

func loadFixture(t *testing.T) (*Data, *fixture) {
	t.Helper()
	d, err := Shipped()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(parityFixture)
	if err != nil {
		t.Fatal(err)
	}
	var fx fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 50 || fx.Corpus.Count < 5000 {
		t.Fatalf("fixture holds %d cases and a corpus of %d: not the parity fixture", len(fx.Cases), fx.Corpus.Count)
	}
	return d, &fx
}

// synthetic is the fixture's `synthetic(n)` (src/__tests__/feed-go-profanity-corpus.ts).
func synthetic(n int) []string {
	out := make([]string, n)
	for i := range out {
		b := []byte(strconv.FormatInt(int64(i), 26))
		for j, c := range b {
			v, _ := strconv.ParseInt(string(c), 26, 64)
			b[j] = byte('a' + v)
		}
		out[i] = "zqvox" + string(b)
	}
	return out
}

func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'a' <= c && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}

// corpus is corpusInputs (src/__tests__/feed-go-profanity-corpus.ts): keep the two in step; the
// fixture's sha256 says when they are not.
func corpus(t *testing.T, d *Data) []string {
	var bases []string
	for _, w := range d.BlockedWords {
		if isValidWord(w) {
			bases = append(bases, strings.ReplaceAll(cleanWord(w), "|", ""))
		}
	}
	for _, p := range d.English {
		bases = append(bases, p.Word)
		bases = append(bases, p.WhitelistedTerms...)
	}
	bases = append(bases, d.WhitelistWords...)
	leet := strings.NewReplacer("a", "4", "e", "3", "i", "1", "o", "0", "s", "5")
	out := make([]string, 0, 10*len(bases))
	for _, b := range bases {
		if !isASCII(b) {
			t.Fatalf("corpus base %q is not ASCII: the two generators would split it differently", b)
		}
		var doubled strings.Builder
		for i := 0; i < len(b); i++ {
			doubled.WriteByte(b[i])
			doubled.WriteByte(b[i])
		}
		out = append(out,
			b,
			asciiUpper(b),
			"x"+b,
			b+"s",
			"a "+b+" b",
			leet.Replace(b),
			doubled.String(),
			strings.Join(strings.Split(b, ""), "."),
			strings.ReplaceAll(b, "l", "|"),
			"1girl, "+b+", solo",
		)
	}
	return out
}

// TestCorpusParity: on every corpus input (each list word, dataset word and whitelisted term in ten
// spellings), each filter answers exactly Node's verdict under the same lists: the shipped ones, the
// shipped block list with an emptied allow list, and the shipped words as a managed list.
func TestCorpusParity(t *testing.T) {
	d, fx := loadFixture(t)
	inputs := corpus(t, d)
	sum := sha256.Sum256([]byte(strings.Join(inputs, "\n")))
	if len(inputs) != fx.Corpus.Count || hex.EncodeToString(sum[:]) != fx.Corpus.SHA256 {
		t.Fatalf("corpus: %d inputs (sha256 %x), fixture %d (%s): the generators differ",
			len(inputs), sum, fx.Corpus.Count, fx.Corpus.SHA256)
	}
	usable, enforced := d.rules.managed(d.BlockedWords)
	if !enforced {
		t.Fatal("the shipped list is below the managed floor")
	}
	configs := map[string]struct{ blocked, allowed []string }{
		"shipped":        {nil, nil},
		"emptyAllow":     {nil, []string{}},
		"managedShipped": {usable, nil},
	}
	if len(fx.Corpus.Verdicts) != len(configs) {
		t.Fatalf("fixture has %d corpus configurations, want %d", len(fx.Corpus.Verdicts), len(configs))
	}
	for name, cfg := range configs {
		want := fx.Corpus.Verdicts[name]
		if len(want) != len(inputs) {
			t.Fatalf("%s: %d verdicts for %d inputs", name, len(want), len(inputs))
		}
		f, err := Build(d, cfg.blocked, cfg.allowed)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		profane, missed, extra := 0, 0, 0
		for i, in := range inputs {
			got, err := f.Profane(in)
			if err != nil {
				t.Fatalf("%s: input %d: %v", name, i, err)
			}
			nodeProfane := want[i] == '1'
			if nodeProfane {
				profane++
			}
			if got == nodeProfane {
				continue
			}
			if nodeProfane {
				missed++
				t.Errorf("%s: input %d (%q): Go clean, Node profane", name, i, in)
			} else {
				extra++
				t.Errorf("%s: input %d (%q): Go profane, Node clean", name, i, in)
			}
		}
		// The positive control: a corpus where Node finds nothing could not catch a Go filter that
		// finds nothing either.
		if profane < len(inputs)/10 || profane == len(inputs) {
			t.Errorf("%s: Node profane on %d of %d: the fixture cannot tell a filter from a constant", name, profane, len(inputs))
		}
		t.Logf("%s: %d inputs, Node profane on %d; Go missed %d, refused %d more", name, len(inputs), profane, missed, extra)
	}
}

type fakeFlag struct{ on, off bool }

func (f fakeFlag) On() bool  { return f.on }
func (f fakeFlag) Off() bool { return f.off }

type fakeCache map[string]string

func (c fakeCache) Get(ctx context.Context, key string) *redis.StringCmd {
	v, ok := c[key]
	if !ok {
		return redis.NewStringResult("", redis.Nil)
	}
	return redis.NewStringResult(v, nil)
}

func rowValue(t *testing.T, typ string, r fixtureRow) string {
	if r.Raw != nil {
		return *r.Raw
	}
	dto := map[string]any{"type": typ, "data": append(synthetic(r.Synthetic), r.Data...)}
	if r.ID != nil {
		dto["id"] = *r.ID
	}
	b, err := json.Marshal(dto)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestCaseParity runs Check over each literal case with its flag state and cached rows. The safety
// invariant first: Go never answers clean where Node answers profane. Then each case's own Go
// verdict, which is Node's wherever the port claims an answer, and a hand-back where it does not.
func TestCaseParity(t *testing.T) {
	d, fx := loadFixture(t)
	verdicts := map[string]int{}
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			cache := fakeCache{}
			for typ, r := range c.Rows {
				cache["ns:"+KeyPrefix+typ] = rowValue(t, typ, r)
			}
			var flag fakeFlag
			switch c.Flag {
			case "on":
				flag.on = true
			case "off":
				flag.off = true
			case "unknown":
			default:
				t.Fatalf("flag %q", c.Flag)
			}
			ck := &Checker{Data: d, Redis: cache, Prefix: "ns:", Flag: flag}
			res := ck.Check(context.Background(), c.Queries)
			got := string(res.Verdict)
			if res.Verdict == Unproven {
				got = "handback"
			}
			verdicts[got]++
			if c.Node != nil && *c.Node == "profane" && res.Verdict == Clean {
				t.Fatalf("SAFETY: Node refuses %q and Go calls it clean", c.Queries)
			}
			if c.Node != nil && *c.Node == "profane" && c.Go == "clean" {
				t.Fatalf("fixture: Node profane, Go expected clean")
			}
			if got != c.Go {
				t.Fatalf("Go %s (%s), want %s (Node: %v)", got, res.Reason, c.Go, deref(c.Node))
			}
		})
	}
	for _, v := range []string{"clean", "profane", "handback"} {
		if verdicts[v] < 3 {
			t.Errorf("only %d cases answer %s: the fixture does not exercise it", verdicts[v], v)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "not run"
	}
	return *s
}
