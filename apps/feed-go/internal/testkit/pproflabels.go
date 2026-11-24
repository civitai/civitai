package testkit

import (
	"bytes"
	"regexp"
	"runtime/pprof"
	"strconv"
	"strings"
)

// labelPair is one `"key":"value"` of a goroutine profile's `# labels:` line (Go-quoted strings).
var labelPair = regexp.MustCompile(`("(?:[^"\\]|\\.)*"):("(?:[^"\\]|\\.)*")`)

// GoroutineLabels is the calling goroutine's pprof labels: the labels a CPU profile records for the
// work that goroutine does (pprof.SetGoroutineLabels, pprof.Do), which pprof.Label(ctx) cannot see
// (it reads a context's labels, not the goroutine's). Empty for none. Read from the goroutine profile
// at debug level 1: the record whose stack holds this function is the caller's own goroutine,
// and its `# labels:` line is that goroutine's labels. ok false when no such record is found (the
// profile's format changed): a caller must fail then, never read it as "no labels".
//
//go:noinline
func GoroutineLabels() (labels map[string]string, ok bool) {
	var buf bytes.Buffer
	if err := pprof.Lookup("goroutine").WriteTo(&buf, 1); err != nil {
		return nil, false
	}
	// Records start with "<count> @ <pcs>", then an optional "# labels: {…}" line, then "#\t…" stack
	// lines.
	var record []string
	flush := func() (map[string]string, bool) {
		mine := false
		for _, l := range record {
			if strings.Contains(l, "testkit.GoroutineLabels") {
				mine = true
				break
			}
		}
		if !mine {
			return nil, false
		}
		out := map[string]string{}
		for _, l := range record {
			rest, isLabels := strings.CutPrefix(l, "# labels: ")
			if !isLabels {
				continue
			}
			for _, m := range labelPair.FindAllStringSubmatch(rest, -1) {
				k, err1 := strconv.Unquote(m[1])
				v, err2 := strconv.Unquote(m[2])
				if err1 != nil || err2 != nil {
					return nil, false
				}
				out[k] = v
			}
		}
		return out, true
	}
	for _, line := range strings.Split(buf.String(), "\n") {
		if isRecordStart(line) {
			if out, found := flush(); found {
				return out, true
			}
			record = record[:0]
		}
		record = append(record, line)
	}
	return flush()
}

// isRecordStart reports a "<count> @ …" record header line.
func isRecordStart(line string) bool {
	n, rest, found := strings.Cut(line, " @")
	if !found || n == "" {
		return false
	}
	_, err := strconv.Atoi(n)
	return err == nil && (rest == "" || rest[0] == ' ')
}
