#!/usr/bin/env python3
# ============================================================================
# domsurgery.py — mechanical, verifiable surgery on a REAL captured DOM.
#
# 🔴 WHY IT IS HERE AND NOT IN evidence.py. Several gates need an app screen the
# corpus does not contain — an EMPTY list, a grid whose items REPEAT — and the
# one thing they may not do is build it with the parser under test: a fixture
# emitted by the analyser makes every case valid by construction, which is
# exactly how this skill's P2/P3 gates once let the killing mutation through.
#
# So this is an INDEPENDENT instrument: a naive tag-depth scanner over the raw
# bytes, sharing no code with evidence.py's tree builder. It edits a real capture
# and nothing else — it never invents markup that was not already in the file
# (`duplicate` re-inserts a subtree the app really rendered; `cut` removes one).
#
# Every operation asserts its own preconditions and REFUSES rather than guessing:
#   * the opening tag must occur EXACTLY ONCE (a count=1 replace that lands on an
#     occurrence you did not picture makes a guard look real when it is not —
#     that has already happened in this skill's mutation battery)
#   * the extracted span must be TAG-BALANCED and end with its own close tag
# ============================================================================
import re


class SurgeryError(Exception):
    pass


def _tag_of(opening):
    m = re.match(r"<([A-Za-z][A-Za-z0-9]*)", opening)
    if not m:
        raise SurgeryError("not an opening tag: %r" % opening[:40])
    return m.group(1).lower()


def span(html, opening):
    """(start, end) of the element that begins at `opening`, close tag included."""
    n = html.count(opening)
    if n != 1:
        raise SurgeryError("opening %r occurs %d times, must be exactly 1"
                           % (opening[:60], n))
    tag = _tag_of(opening)
    start = html.index(opening)
    gt = html.index(">", start)
    depth, i = 1, gt + 1
    open_re = re.compile(r"<%s(?=[\s>/])" % re.escape(tag), re.I)
    close = "</%s>" % tag
    while depth > 0:
        nxt_o = open_re.search(html, i)
        nxt_c = html.find(close, i)
        if nxt_c < 0:
            raise SurgeryError("unbalanced <%s>: no closing tag after offset %d" % (tag, i))
        if nxt_o and nxt_o.start() < nxt_c:
            depth += 1
            i = nxt_o.end()
            continue
        depth -= 1
        i = nxt_c + len(close)
    end = i
    sub = html[start:end]
    if not sub.endswith(close):
        raise SurgeryError("extracted span does not end with %r" % close)
    if len(open_re.findall(sub)) != sub.count(close):
        raise SurgeryError("extracted span is not tag-balanced")
    return start, end


def subtree(html, opening):
    a, b = span(html, opening)
    return html[a:b]


def cut(html, opening):
    """The real DOM with that element removed. Returns (html, removed)."""
    a, b = span(html, opening)
    return html[:a] + html[b:], html[a:b]


def duplicate(html, opening, times=1):
    """The real DOM with that element repeated — the app's own item markup, more
    of it. Occurrence counts move; the id SET does not, which is the blindness
    the per-id diff exists to close."""
    a, b = span(html, opening)
    sub = html[a:b]
    return html[:b] + sub * times + html[b:]
