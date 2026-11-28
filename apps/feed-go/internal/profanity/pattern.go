package profanity

import (
	"errors"
	"regexp"
	"strings"
)

// obscenity 0.4.5's pattern language (src/pattern/Parser.ts, Util.ts), for ASCII patterns: a literal
// (`\` escapes `\ [ ] ? |`), an optional `[x]` (a literal or a wildcard, not nested), a wildcard `?`,
// and a word-boundary `|` at the start or end only. compilePatternToRegExp writes `\b`, each literal
// escaped, `(?:x)?` and `.`, with flags `gs`. Go's regexp agrees with that JavaScript regexp on ASCII
// text: `\b` is the ASCII word boundary in both (JavaScript without `u`), `(?s).` is any byte, which is
// one character there, and Go's leftmost-first matching picks the match a backtracking engine picks, so
// every match JavaScript's matchAll reports (non-overlapping, left to right) Go's FindAll reports.

var errPattern = errors.New("profanity: pattern the obscenity parser refuses")

type nodeKind int

const (
	nodeLiteral nodeKind = iota
	nodeOptional
	nodeWildcard
	nodeBoundary
)

type patternNode struct {
	kind  nodeKind
	chars string       // nodeLiteral
	child *patternNode // nodeOptional
}

type parsed struct {
	boundaryStart, boundaryEnd bool
	nodes                      []patternNode
}

type patternParser struct {
	in  string
	pos int
}

func (p *patternParser) done() bool { return p.pos >= len(p.in) }

func (p *patternParser) peek() int {
	if p.done() {
		return -1
	}
	return int(p.in[p.pos])
}

// parsePattern is Parser.parse.
func parsePattern(in string) (parsed, error) {
	if !isASCII(in) {
		return parsed{}, errPattern
	}
	p := &patternParser{in: in}
	var out parsed
	first, err := p.next()
	if err != nil {
		return out, err
	}
	if first != nil {
		if first.kind == nodeBoundary {
			out.boundaryStart = true
		} else {
			out.nodes = append(out.nodes, *first)
		}
	}
	for !p.done() {
		n, err := p.next()
		if err != nil {
			return out, err
		}
		if n.kind != nodeBoundary {
			out.nodes = append(out.nodes, *n)
			continue
		}
		if !p.done() {
			return out, errPattern // a boundary only at the start or the end
		}
		out.boundaryEnd = true
	}
	return out, nil
}

// next is Parser.nextNode: nil at the end of the input.
func (p *patternParser) next() (*patternNode, error) {
	switch p.peek() {
	case -1:
		return nil, nil
	case '[':
		p.pos++
		if p.done() || p.peek() == '[' {
			return nil, errPattern // unclosed, or nested
		}
		child, err := p.next()
		if err != nil {
			return nil, err
		}
		if child == nil || child.kind == nodeBoundary {
			return nil, errPattern
		}
		if p.peek() != ']' {
			return nil, errPattern
		}
		p.pos++
		return &patternNode{kind: nodeOptional, child: child}, nil
	case ']':
		return nil, errPattern
	case '?':
		p.pos++
		return &patternNode{kind: nodeWildcard}, nil
	case '|':
		p.pos++
		return &patternNode{kind: nodeBoundary}, nil
	}
	var b strings.Builder
	for !p.done() {
		c := p.in[p.pos]
		if c == '[' || c == ']' || c == '?' || c == '|' {
			break
		}
		p.pos++
		if c == '\\' {
			if p.done() {
				return nil, errPattern // trailing backslash
			}
			e := p.in[p.pos]
			if e != '\\' && e != '[' && e != ']' && e != '?' && e != '|' {
				return nil, errPattern
			}
			p.pos++
			c = e
		}
		b.WriteByte(c)
	}
	return &patternNode{kind: nodeLiteral, chars: b.String()}, nil
}

// compilePattern is compilePatternToRegExp, after RegExpMatcher's refusal of a pattern that could
// match the empty string (every node optional, or none).
func compilePattern(pt parsed) (*regexp.Regexp, error) {
	allOptional := true
	for _, n := range pt.nodes {
		if n.kind != nodeOptional {
			allOptional = false
		}
	}
	if allOptional {
		return nil, errPattern
	}
	var b strings.Builder
	b.WriteString("(?s)")
	if pt.boundaryStart {
		b.WriteString(`\b`)
	}
	for i := range pt.nodes {
		writeNode(&b, &pt.nodes[i])
	}
	if pt.boundaryEnd {
		b.WriteString(`\b`)
	}
	return regexp.Compile(b.String())
}

func writeNode(b *strings.Builder, n *patternNode) {
	switch n.kind {
	case nodeLiteral:
		b.WriteString(regexp.QuoteMeta(n.chars))
	case nodeOptional:
		b.WriteString("(?:")
		writeNode(b, n.child)
		b.WriteString(")?")
	case nodeWildcard:
		b.WriteString(".")
	}
}
