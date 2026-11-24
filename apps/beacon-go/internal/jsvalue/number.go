package jsvalue

import (
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// IsJSWhitespace is ECMAScript's WhiteSpace or LineTerminator: what String.prototype.trim removes and
// what Number(string) ignores around its literal.
func IsJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return r > 0xFF && unicode.Is(unicode.Zs, r)
}

// Trim is String.prototype.trim on a WTF-8 string.
func Trim(s string) string {
	start := 0
	for start < len(s) {
		r, size := DecodeWTF8(s[start:])
		if !IsJSWhitespace(r) {
			break
		}
		start += size
	}
	end := len(s)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(s[start:end])
		if r == utf8.RuneError || !IsJSWhitespace(r) {
			break
		}
		end -= size
	}
	return s[start:end]
}

// decimalLiteral is StrUnsignedDecimalLiteral with an optional sign (no Infinity, no separators).
var decimalLiteral = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// StringToNumber is Number(s) for a string: the trimmed text as a StringNumericLiteral (decimal with
// optional sign and exponent, `Infinity`, or an unsigned 0x/0o/0b integer), the empty string as 0,
// anything else NaN.
func StringToNumber(s string) float64 {
	t := Trim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, ok := new(big.Int).SetString(t[2:], base)
			if !ok || strings.ContainsAny(t[2:], "_+-") {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	if !decimalLiteral.MatchString(t) {
		return math.NaN()
	}
	// Out of range keeps ParseFloat's correctly rounded result (±Inf, or ±0 below the subnormals).
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// FormatNumber is Number::toString(x) (radix 10): the shortest round-tripping digits, in fixed
// notation for decimal exponents in [-6, 21) and exponential notation otherwise.
func FormatNumber(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x < 0:
		return "-" + FormatNumber(-x)
	}
	e := strconv.FormatFloat(x, 'e', -1, 64) // d[.ddd]e±XX
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	e10, _ := strconv.Atoi(exp)
	k := len(digits)
	n := e10 + 1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return digits + "e" + sign + strconv.Itoa(abs)
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(abs)
}
