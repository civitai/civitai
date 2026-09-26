#!/usr/bin/env python3
# ============================================================================
# evidence.py — the PURE half of app-capture's MACHINE-ANALYSABLE capture.
#
#   rendered DOM + drained browser probe  ->  one per-state evidence artifact
#
# A screenshot cannot be analysed. This module turns the same states a recipe
# already drives into JSON a later pass can grep, diff and act on:
#
#   1. the app iframe's rendered DOM (pretty-printed, saved per state)
#   2. CONSOLE messages captured during the state, with level
#   3. FAILED network requests (non-2xx/3xx and outright failures) with status
#   4. an ACCESSIBILITY summary derived from the DOM (deterministic, stdlib only)
#   5. a `data-testid` INVENTORY — the anchor that resolves a DOM node back to
#      app source, because these apps ship NO source maps but DO carry testids
#
# Like plan.py, it performs no I/O beyond reading its inputs and printing JSON,
# and every refusal lives HERE where tests/run-tests-app-capture.sh can watch it
# be decided. capture.sh only executes what this and plan.py print.
#
# 🔴 FIVE FACTS MEASURED IN A LIVE APP FRAME ON 2026-08-17, EACH ENCODED BELOW
# AS CODE RATHER THAN AS ADVICE. All five were measured against
# custom-generators.civit.ai inside civitai.com/apps/run/custom-generators.
#
#  1. A FRAME-SCOPED `js` IN A CROSS-ORIGIN APP FRAME SHARES THE PAGE'S MAIN
#     WORLD. Measured: an eval set `window.__probeWorld`, an inline <script>
#     appended to that same document read it back as "string" (an isolated world
#     would have reported "undefined"). That is WHY console hooking works at all
#     — patching `console.*` from an isolated world would capture nothing the
#     page logs. It is also why the hook must be re-installed after every load.
#
#  2. THE HOOK REALLY CAPTURES PAGE-SIDE CALLS. Measured end-to-end: an injected
#     page-side `console.warn("PAGE_SIDE_WARN")` and a page-side `throw` both
#     arrived in the buffer, the throw as `uncaught: ...`. This is the single
#     highest-signal defect source available here.
#
#  3. `performance.getEntriesByType("resource")` DOES NOT SEE fetch/XHR IN THIS
#     FRAME. Measured: three separate `fetch()` calls (one 200, one hard DNS
#     failure) produced ZERO new resource-timing entries, while an <img> load DID
#     produce one. So resource timing ALONE would report "no failed requests" on
#     an app whose every API call had failed. The fetch/XHR patch is the
#     instrument; the PerformanceObserver is a SUPPLEMENT for element loads.
#
#  4. A RESOURCE-TIMING `responseStatus` OF 0 IS NOT A FAILURE. Measured 0 on a
#     load that really happened. Cross-origin entries without Timing-Allow-Origin
#     report 0 too, so scoring 0 as "failed" would flag most third-party assets
#     on every run. Only fetch/XHR — where the hook OBSERVED the rejection — may
#     read 0 as a hard failure. See `classify_network`.
#
#  5. THE APP'S OWN DOM IS 38.7 KB AND THE BRIDGE'S `html` DEFAULT CAP IS 32768.
#     A default read would have TRUNCATED it, and a truncated DOM under-reports
#     every testid and every a11y violation while looking completely normal. The
#     plan emits `--max-bytes 0`; `analyze` REFUSES a DOM carrying the bridge's
#     truncation marker. Two independent defences, because one silent one is not
#     a defence.
#
# 🔴 A ZERO IS NEVER SHIPPED WITHOUT ITS POSITIVE CONTROL. The probe emits a
# SENTINEL console line through its own hook at install time and reports whether
# it came back. "0 console errors" from a probe whose selfTest is false is
# indistinguishable from a probe wired to nothing, so `analyze` REFUSES it
# (`probe_selftest_failed`) rather than printing a reassuring zero.
#
# 🔴 A PROBE OUTLIVES A CAPTURE, AND THE ARTIFACT USED TO BE UNABLE TO SAY SO
# (measured on the first live `--evidence` run, 2026-08-18). In `--tab` attach
# mode nothing reloads the page between invocations, so `window.__APP_CAPTURE__`
# from an EARLIER run is still installed. Two consequences, both of which made an
# artifact state a number that contradicted its own contents:
#
#   (a) the drain cleared `S.console` / `S.network` and NOT `counts.networkTotal`,
#       so the COUNTER was cumulative-since-install while the ARRAY was
#       per-drain. Measured: `networkTotal` frozen at 6 while the drained arrays
#       went 2 -> 0 -> 0, under a note reading "the network hooks were installed
#       and observed ZERO requests". The note was right; the number one field
#       away contradicted it.
#   (b) the drain returns `JSON.stringify(S)`, and `S.reinstalled` was the literal
#       set at FIRST install. capture.sh only ever writes the DRAIN to
#       `<state>.probe.json`, so `meta.reinstalled` was STRUCTURALLY ALWAYS FALSE
#       — a re-used probe was indistinguishable from a fresh one, by construction.
#
# Both halves are fixed here: the drain resets every per-drain field (the ledger
# is `PER_DRAIN_RESETS`, pinned literally by the suite) and keeps a separate,
# explicitly-named cumulative counter; the re-install branch writes `reinstalled`
# and `installs` ONTO `S`, and the drain stamps `drains`. `analyze` then reports
# a `probe` block whose `reused`/`counts.agree` say which lifecycle produced the
# numbers, refuses a counter LOWER than the records it counts
# (`probe_counts_impossible`), and never emits the "observed ZERO requests" note
# for a window it cannot vouch for.
#
# Usage:
#   evidence.py analyze --dom DOM --probe PROBE --state NAME [--slug S]
#                       [--frame-host H] [--allow-unverified-probe] [--out F]
#                       [--pretty-dom F]
#   evidence.py diff BEFORE.json AFTER.json
#   evidence.py report ART.json [ART.json ...]
#   evidence.py probe-js install|drain
# Exit: 0 = ok · 1 = usage/parse error, or `diff` found differences · 2 = REFUSAL
# ============================================================================
import argparse
import hashlib
import json
import re
import sys
from html.parser import HTMLParser

SCHEMA = "app-capture/evidence@1"
PROBE_SCHEMA = "app-capture/probe@1"

# The bridge appends exactly this when `html` hits --max-bytes. Fact 5.
TRUNCATION_MARKER = "…[truncated"

# The probe emits this through its OWN console hook at install time; getting it
# back is what makes a later zero mean "nothing was logged" instead of "nothing
# was listening". It is stripped from the reported messages.
SELFTEST_SENTINEL = "__app_capture_probe_selftest__"

MAX_CONSOLE = 500
MAX_NETWORK = 500
MAX_TEXT = 2000

VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
NO_TEXT = frozenset(("script", "style", "template", "noscript", "head", "title"))

# Interactive elements that must expose an accessible NAME.
INTERACTIVE_ROLES = frozenset((
    "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "checkbox", "radio", "switch", "option", "combobox", "slider", "searchbox",
    "textbox", "spinbutton",
))
BUTTONISH_INPUT = frozenset(("button", "submit", "reset", "image"))
# Form controls that must have a LABEL (a different WCAG failure from the above).
LABELLED_INPUT_EXCLUDE = frozenset(("hidden", "button", "submit", "reset", "image"))

CHECKS = ("interactive-name", "img-alt", "control-label", "heading-order")


class Refuse(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


# ---------------------------------------------------------------- the probe --
def _one_line(js):
    """🔴 EVERY argv ELEMENT MUST BE ONE LINE.

    capture.sh reads a step's argv with `mapfile -t argv < <(... print(a) ...)`
    — one array element PER LINE. A multi-line JS argument would therefore be
    split into several argv entries, and the bridge would be handed a fragment
    of a program plus some garbage flags. The failure is not a syntax error you
    can read; it is `browser` complaining about an unknown argument that appears
    nowhere in the source. So the JS is authored readably and flattened HERE,
    and a gate asserts no planned argv element ever contains a newline.
    """
    return " ".join(ln.strip() for ln in js.strip().splitlines() if ln.strip())


# NOTE: no `//` comments anywhere in the JS below — flattening to one line would
# make a `//` swallow the remainder of the program. Every statement is
# semicolon-terminated for the same reason.
_INSTALL_SRC = """
(function(){
var W = window;
if (W.__APP_CAPTURE__ && W.__APP_CAPTURE__.installed) {
  var P = W.__APP_CAPTURE__;
  P.reinstalled = true;
  P.installs = (P.installs || 1) + 1;
  return JSON.stringify({schema:"%(schema)s", installed:true, reinstalled:true,
    installs:P.installs, drains:(P.drains || 0),
    selfTest:P.selfTest, hooks:P.hooks}); }
var S = {schema:"%(schema)s", installed:true, reinstalled:false, selfTest:false,
  sentinel:"%(sentinel)s", installs:1, drains:0,
  hooks:{console:false, errorEvents:false, fetch:false, xhr:false, perfObserver:false},
  dropped:{console:0, network:0}, console:[], network:[],
  counts:{networkTotal:0, networkSinceInstall:0}};
W.__APP_CAPTURE__ = S;
function pushC(level, text) {
  if (S.console.length >= %(maxc)d) { S.dropped.console++; return; }
  S.console.push({level:level, text:String(text).slice(0, %(maxt)d)}); }
function pushN(rec) {
  S.counts.networkTotal++;
  S.counts.networkSinceInstall++;
  if (S.network.length >= %(maxn)d) { S.dropped.network++; return; }
  S.network.push(rec); }
function fmt(args) {
  var out = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    try {
      if (typeof a === "string") { out.push(a); }
      else if (a && a.stack) { out.push(String(a.stack)); }
      else if (a && a.message) { out.push(String(a.message)); }
      else { out.push(JSON.stringify(a)); } }
    catch (e) { out.push(String(a)); } }
  return out.join(" "); }
try {
  var levels = ["log", "info", "warn", "error", "debug"];
  for (var i = 0; i < levels.length; i++) {
    (function(lv){
      var orig = console[lv];
      if (typeof orig !== "function") { return; }
      console[lv] = function(){
        try { pushC(lv, fmt(arguments)); } catch (e) {}
        return orig.apply(console, arguments); }; })(levels[i]); }
  S.hooks.console = true; } catch (e) {}
try {
  W.addEventListener("error", function(ev){
    try {
      if (ev && ev.target && ev.target !== W && ev.target.tagName) {
        pushN({url:String(ev.target.src || ev.target.href || ""), status:0,
               via:"element", error:"resource load error"}); }
      else {
        pushC("error", "uncaught: " + ((ev && ev.message) || "") + " @" +
              ((ev && ev.filename) || "") + ":" + ((ev && ev.lineno) || 0)); } }
    catch (e) {} }, true);
  W.addEventListener("unhandledrejection", function(ev){
    try { var r = ev && ev.reason;
      pushC("error", "unhandledrejection: " + ((r && r.message) || String(r))); }
    catch (e) {} });
  S.hooks.errorEvents = true; } catch (e) {}
try {
  var of = W.fetch;
  if (typeof of === "function") {
    W.fetch = function(){
      var u = "";
      try { u = (arguments[0] && arguments[0].url) ? arguments[0].url : String(arguments[0]); }
      catch (e) {}
      return of.apply(this, arguments).then(
        function(r){ pushN({url:u, status:r.status, via:"fetch"}); return r; },
        function(e){ pushN({url:u, status:0, via:"fetch",
                            error:String((e && e.message) || e)}); throw e; }); };
    S.hooks.fetch = true; } } catch (e) {}
try {
  var OX = W.XMLHttpRequest;
  if (typeof OX === "function" && OX.prototype) {
    var xo = OX.prototype.open, xs = OX.prototype.send;
    OX.prototype.open = function(m, u){
      try { this.__acUrl = String(u); } catch (e) {}
      return xo.apply(this, arguments); };
    OX.prototype.send = function(){
      var x = this;
      try { x.addEventListener("loadend", function(){
        try { pushN({url:String(x.__acUrl || ""), status:(x.status | 0), via:"xhr"}); }
        catch (e) {} }); } catch (e) {}
      return xs.apply(this, arguments); };
    S.hooks.xhr = true; } } catch (e) {}
try {
  var po = new W.PerformanceObserver(function(list){
    var es = list.getEntries();
    for (var j = 0; j < es.length; j++) {
      var e = es[j];
      pushN({url:String(e.name || ""),
             status:(typeof e.responseStatus === "number" ? e.responseStatus : -1),
             via:"resource", initiator:String(e.initiatorType || "")}); } });
  po.observe({type:"resource", buffered:true});
  S.hooks.perfObserver = true; } catch (e) {}
try { console.debug(S.sentinel); } catch (e) {}
S.selfTest = false;
for (var k = 0; k < S.console.length; k++) {
  if (S.console[k].text.indexOf(S.sentinel) >= 0) { S.selfTest = true; } }
return JSON.stringify({schema:S.schema, installed:true, reinstalled:false,
  installs:S.installs, drains:S.drains, selfTest:S.selfTest, hooks:S.hooks});
})()
""" % {"schema": PROBE_SCHEMA, "sentinel": SELFTEST_SENTINEL,
       "maxc": MAX_CONSOLE, "maxn": MAX_NETWORK, "maxt": MAX_TEXT}

_DRAIN_SRC = """
(function(){
var S = window.__APP_CAPTURE__;
if (!S) {
  return JSON.stringify({schema:"%(schema)s", installed:false, selfTest:false,
    hooks:{}, dropped:{console:0, network:0}, console:[], network:[],
    installs:0, drains:0,
    counts:{networkTotal:0, networkSinceInstall:0}, error:"probe not installed"}); }
S.drains = (S.drains || 0) + 1;
var out = JSON.stringify(S);
S.console = [];
S.network = [];
S.counts.networkTotal = 0;
S.dropped.console = 0;
S.dropped.network = 0;
return out;
})()
""" % {"schema": PROBE_SCHEMA}

# 🔴 THE PER-DRAIN LEDGER, AS DATA. Every field the drain hands back describes
# ONE window — the interval since the previous drain — so every one of them must
# be reset by the drain. `counts.networkTotal` was the one that was not, and a
# counter that keeps counting while the array beside it is emptied is how an
# artifact came to carry `networkTotal: 6` next to two records and a note saying
# ZERO. The suite pins these statements literally (they are what a mutation of
# the drain deletes), and `analyze` checks the invariant they buy:
#     counts.networkTotal == len(network) + dropped.network
# `counts.networkSinceInstall` is deliberately NOT here: it is the cumulative
# figure, and it is reported under a name that says so.
PER_DRAIN_RESETS = (
    "S.console = [];",
    "S.network = [];",
    "S.counts.networkTotal = 0;",
    "S.dropped.console = 0;",
    "S.dropped.network = 0;",
)

PROBE_INSTALL_JS = _one_line(_INSTALL_SRC)
PROBE_DRAIN_JS = _one_line(_DRAIN_SRC)

# 🔴 CAPTURE NEVER SPENDS, AND THE PROBE IS THE ONE PIECE OF THIS SKILL THAT RUNS
# THE AGENT'S OWN CODE INSIDE A LIVE, LOGGED-IN, MOD-GATED APP. It observes and
# must never actuate: no synthetic click, no form submit, no navigation, no
# window.open, and none of the spend path's own verbs. Gated structurally.
PROBE_FORBIDDEN = (".click(", ".submit(", "requestSubmit", "window.open",
                   "location.href", "location.replace", "location.assign",
                   "activate", "xdotool", "document.forms")


# ------------------------------------------------------------- the DOM tree --
class Node(object):
    __slots__ = ("tag", "attrs", "children", "parent", "text")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent
        self.text = []

    def get(self, name, default=None):
        return self.attrs.get(name, default)


class _Builder(HTMLParser):
    """Tolerant tree builder. Deliberately stdlib-only: adding a dependency to a
    skill that runs on a NixOS box with no pip is how a gate becomes unrunnable."""

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.root = Node("#document")
        self.stack = [self.root]

    def _open(self, tag, attrs, push):
        d = {}
        for k, v in attrs:
            k = k.lower()
            if k not in d:                     # first wins, as browsers do
                d[k] = v if v is not None else ""
        n = Node(tag.lower(), d, self.stack[-1])
        self.stack[-1].children.append(n)
        if push:
            self.stack.append(n)
        return n

    def handle_starttag(self, tag, attrs):
        self._open(tag, attrs, push=tag.lower() not in VOID)

    def handle_startendtag(self, tag, attrs):
        self._open(tag, attrs, push=False)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
        # unmatched close tag: ignore, exactly as a browser would

    def handle_data(self, data):
        if data.strip():
            self.stack[-1].text.append(data)


def parse_dom(html):
    b = _Builder()
    b.feed(html)
    b.close()
    return b.root


def walk(node):
    for c in node.children:
        yield c
        for g in walk(c):
            yield g


def _truthy_attr(node, name):
    v = node.get(name)
    return v is not None and str(v).lower() not in ("", "false")


def hidden(node):
    """Not exposed to assistive tech. Deterministic and deliberately shallow:
    it reads attributes and INLINE style only — no CSS cascade, no layout."""
    n = node
    while n is not None and n.tag != "#document":
        if _truthy_attr(n, "aria-hidden") and str(n.get("aria-hidden")).lower() == "true":
            return True
        if "hidden" in n.attrs:
            return True
        style = (n.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            return True
        if n.tag == "input" and (n.get("type") or "").lower() == "hidden":
            return True
        n = n.parent
    return False


def element_path(node):
    """A deterministic structural path. Diffable across runs of the same state;
    NOT a promise of stability across app versions — that is what `testid` is
    for, and why every violation carries one."""
    parts = []
    n = node
    while n is not None and n.parent is not None and n.tag != "#document":
        sibs = [c for c in n.parent.children if c.tag == n.tag]
        seg = n.tag
        if len(sibs) > 1:
            seg = "%s:nth-of-type(%d)" % (n.tag, sibs.index(n) + 1)
        tid = n.get("data-testid")
        if tid:
            seg = '%s[data-testid="%s"]' % (n.tag, tid)
        parts.append(seg)
        n = n.parent
    parts.reverse()
    if len(parts) > 6:
        return "… > " + " > ".join(parts[-6:])
    return " > ".join(parts)


def nearest_testid(node):
    """🔴 THE SOURCE ANCHOR. These apps ship NO source maps (verified: the .map
    404s and the bundle carries no sourceMappingURL), so a DOM node cannot be
    resolved to a line of app source by tooling. What they DO carry is dense
    `data-testid`s, and a testid is greppable in the app repo. Every violation
    therefore reports the nearest testid at or above it."""
    n = node
    while n is not None and n.tag != "#document":
        t = n.get("data-testid")
        if t:
            return t
        n = n.parent
    return None


def snippet(node, limit=160):
    bits = [node.tag]
    for k in sorted(node.attrs):
        if k in ("style",):
            continue
        v = node.attrs[k]
        bits.append('%s="%s"' % (k, v[:60]) if v else k)
    return ("<" + " ".join(bits) + ">")[:limit]


def _own_text(node):
    return " ".join(t.strip() for t in node.text if t.strip())


def content_name(node, depth=0):
    """Accessible name from CONTENT. An APPROXIMATION of the accname algorithm:
    no shadow DOM, no CSS-generated content, no cross-document idrefs. It is
    deliberately GENEROUS — anything it can read counts as a name — so a
    violation it reports is a strong claim and a silence is a weak one."""
    if node.tag in NO_TEXT or hidden(node):
        return ""
    lab = (node.get("aria-label") or "").strip()
    if depth and lab:
        return lab
    if node.tag == "img":
        return (node.get("alt") or "").strip()
    if node.tag == "input" and (node.get("type") or "").lower() in BUTTONISH_INPUT:
        return ((node.get("value") or node.get("alt") or "").strip())
    parts = [_own_text(node)]
    for c in node.children:
        parts.append(content_name(c, depth + 1))
    return " ".join(p for p in parts if p).strip()


def accessible_name(node, by_id):
    lab = (node.get("aria-label") or "").strip()
    if lab:
        return lab
    ref = (node.get("aria-labelledby") or "").strip()
    if ref:
        names = [content_name(by_id[i]) for i in ref.split() if i in by_id]
        joined = " ".join(n for n in names if n).strip()
        if joined:
            return joined
    c = content_name(node)
    if c:
        return c
    return (node.get("title") or "").strip()


def is_interactive(node):
    role = (node.get("role") or "").strip().lower()
    if role:
        return role in INTERACTIVE_ROLES
    if node.tag == "button":
        return True
    if node.tag == "a" and node.get("href") is not None:
        return True
    if node.tag == "input" and (node.get("type") or "").lower() in BUTTONISH_INPUT:
        return True
    if node.tag == "summary":
        return True
    return False


def needs_label(node):
    role = (node.get("role") or "").strip().lower()
    if role and role not in ("textbox", "combobox", "searchbox", "spinbutton", "listbox"):
        return False
    if node.tag in ("select", "textarea"):
        return True
    if node.tag == "input":
        return (node.get("type") or "text").lower() not in LABELLED_INPUT_EXCLUDE
    return False


# --------------------------------------------------------------- the checks --
def a11y_scan(root):
    """Four deterministic, dependency-free checks. Each returns violations that
    carry the source anchor (`testid`) rather than only a selector."""
    by_id = {}
    for n in walk(root):
        i = n.get("id")
        if i and i not in by_id:
            by_id[i] = n

    # a <label for=x> or a <label> wrapping the control
    labelled_ids = set()
    wrapped = set()
    for n in walk(root):
        if n.tag != "label":
            continue
        f = (n.get("for") or "").strip()
        if f:
            labelled_ids.add(f)
        for d in walk(n):
            wrapped.add(id(d))

    v = []

    def add(check, node, why):
        v.append({"check": check, "tag": node.tag, "why": why,
                  "path": element_path(node), "testid": nearest_testid(node),
                  "snippet": snippet(node)})

    for n in walk(root):
        if hidden(n):
            continue
        if is_interactive(n) and not accessible_name(n, by_id):
            add("interactive-name", n, "no accessible name (no text, aria-label, "
                                       "aria-labelledby or title)")
        if n.tag == "img" and "alt" not in n.attrs \
                and (n.get("role") or "").lower() != "presentation":
            add("img-alt", n, "<img> has no alt attribute (use alt=\"\" if decorative)")
        if needs_label(n):
            has = bool((n.get("aria-label") or "").strip())
            ref = (n.get("aria-labelledby") or "").strip()
            has = has or any(i in by_id for i in ref.split())
            has = has or ((n.get("id") or "") in labelled_ids and bool(n.get("id")))
            has = has or id(n) in wrapped
            has = has or bool((n.get("title") or "").strip())
            if not has:
                why = "form control has no label"
                if (n.get("placeholder") or "").strip():
                    # 🔴 A placeholder is NOT an accessible name (WCAG 2.5.3 /
                    # 4.1.2): it disappears on input and screen readers may not
                    # announce it. Reported as its own reason so the fix is
                    # obvious rather than argued about.
                    why = "form control is labelled only by a placeholder"
                add("control-label", n, why)

    # heading order: a jump of more than one level is a violation
    prev = None
    for n in walk(root):
        if n.tag in ("h1", "h2", "h3", "h4", "h5", "h6") and not hidden(n):
            lvl = int(n.tag[1])
            if prev is not None and lvl > prev + 1:
                add("heading-order", n, "heading level jumps h%d -> h%d" % (prev, lvl))
            prev = lvl

    v.sort(key=lambda r: (r["check"], r["path"], r["why"]))
    counts = dict((c, 0) for c in CHECKS)
    for r in v:
        counts[r["check"]] = counts.get(r["check"], 0) + 1
    return {"checks": list(CHECKS), "counts": counts, "total": len(v), "violations": v}


# ----------------------------------------------------- the empty-state check --
# 🔴 A POOR EMPTY STATE IS ITSELF A DEFECT, not merely a thin capture. The whole
# survey of first-party apps foundered on content (only one of seven had anything
# worth photographing), and "this screen is empty" was treated as a fact about
# the shoot rather than as a finding about the app. It is a finding: a user who
# lands on an empty surface with no next action and no named input is stuck.
#
# So this check answers three questions, structurally and with no dependency:
#   1. is the state's PRIMARY COLLECTION rendering zero items?
#   2. does that surface offer a NEXT ACTION — a named button/link/control?
#   3. WHICH INPUT is unfilled, by name — the thing the user would have to supply.
#
# What it CANNOT do is stated in the docs and repeated here so nobody re-derives
# it: it reads the rendered DOM only, so it cannot tell "no data exists" from "a
# filter matched nothing" from "the fetch failed" (the console/network sections
# are what answer that), it knows nothing about CSS or layout so "dominant" is a
# claim about item COUNT and never about pixels, and on a screen with no
# collection at all it returns `no-collection` and declines to have an opinion.
COLLECTION_TAGS = frozenset(("ul", "ol", "table", "tbody", "dl"))
COLLECTION_ROLES = frozenset(("list", "grid", "table", "listbox", "feed", "tree"))
COLLECTION_TESTID = re.compile(
    r"(^|[-_])(list|grid|results|items|feed|gallery|cards|table|rows)$")
# A placeholder/empty marker, matched on a WHOLE dash- or underscore-separated
# token so `checklist` and `emptylike` do not match.
EMPTY_TOKEN = re.compile(
    r"(^|[-_])(empty|emptystate|no-?results|noresults|placeholder|skeleton|"
    r"zero-?state|nothing)([-_]|$)")
ITEM_TAGS = frozenset(("li", "tr", "article", "option"))
MEDIA_TAGS = frozenset(("img", "canvas", "video", "svg", "picture", "iframe"))
# Deliberately SMALL and spelled — a phrase list can always be reworded around,
# so it only ever ADDS a marker; the structural item count is what decides.
EMPTY_PHRASES = ("no results", "nothing here", "nothing to show", "no items",
                 "none yet", "be the first", "no data", "nothing yet")


def _marker_token(node):
    """The empty/placeholder token this node advertises, or None."""
    for attr in ("data-testid", "class", "aria-label", "id"):
        v = (node.get(attr) or "").strip().lower()
        if not v:
            continue
        for word in v.replace("/", " ").split():
            m = EMPTY_TOKEN.search(word)
            if m:
                return m.group(2)
    t = " ".join(_own_text(node).lower().split())
    if t and len(t) <= 120:
        for p in EMPTY_PHRASES:
            if p in t:
                return p
    return None


def _has_content(node):
    if node.tag in NO_TEXT or hidden(node):
        return False
    if _own_text(node):
        return True
    if node.tag in MEDIA_TAGS:
        return True
    for c in node.children:
        if _has_content(c):
            return True
    return False


def _is_collection(node):
    if node.tag in COLLECTION_TAGS:
        return True
    if (node.get("role") or "").strip().lower() in COLLECTION_ROLES:
        return True
    t = node.get("data-testid")
    return bool(t and COLLECTION_TESTID.search(t.strip()))


def collection_items(node):
    """🔴 AN ITEM IS AN IDENTIFIED, CONTENT-BEARING DIRECT CHILD — not any child.

    Measured against the real captures: `discover-list` holds its search/sort
    TOOLBAR as its first child and the one real card as its second, so counting
    every child would report a list of one card as "2 items" and an emptied list
    as "1 item", i.e. never empty. These apps put a `data-testid` on the item and
    not on the layout wrapper, which is what makes this rule work here; `li`/`tr`/
    `article` cover the ordinary-markup case. An empty-state placeholder inside
    the container is a MARKER, never an item.
    """
    out = []
    for c in node.children:
        if hidden(c) or _marker_token(c):
            continue
        if not (c.get("data-testid") or c.tag in ITEM_TAGS):
            continue
        if not _has_content(c):
            continue
        out.append(c)
    return out


def _descendants(node):
    return sum(1 for _ in walk(node))


def _named_controls(container, by_id, limit=8):
    out = []
    for n in walk(container):
        if hidden(n) or not is_interactive(n):
            continue
        name = accessible_name(n, by_id)
        if not name:
            continue
        out.append({"tag": n.tag, "testid": n.get("data-testid"),
                    "name": " ".join(name.split())[:80]})
        if len(out) >= limit:
            break
    return out


def _unfilled_inputs(container, by_id, limit=8):
    """Form controls the user would have to supply, named. `value=""` on a real
    capture is an EMPTY input; a select with no selected option is the same."""
    out = []
    for n in walk(container):
        if hidden(n) or not needs_label(n):
            continue
        filled = False
        if n.tag == "input":
            filled = bool((n.get("value") or "").strip())
        elif n.tag == "textarea":
            filled = bool(_own_text(n))
        elif n.tag == "select":
            filled = any(c.tag == "option" and "selected" in c.attrs for c in walk(n))
        if filled:
            continue
        out.append({"tag": n.tag, "testid": n.get("data-testid"),
                    "name": " ".join((accessible_name(n, by_id) or "").split())[:80],
                    "placeholder": (n.get("placeholder") or "").strip()[:80]})
        if len(out) >= limit:
            break
    return out


def empty_state_scan(root):
    by_id = {}
    for n in walk(root):
        i = n.get("id")
        if i and i not in by_id:
            by_id[i] = n

    markers = []
    for n in walk(root):
        if hidden(n):
            continue
        tok = _marker_token(n)
        if tok:
            markers.append({"token": tok, "tag": n.tag,
                            "testid": nearest_testid(n), "path": element_path(n),
                            "text": " ".join(_own_text(n).split())[:80]})

    primary, best = None, -1
    for n in walk(root):
        if hidden(n) or not _is_collection(n):
            continue
        d = _descendants(n)
        if d > best:                       # strictly greater: first wins a tie
            primary, best = n, d

    items = collection_items(primary) if primary is not None else []
    if primary is not None:
        verdict = "empty" if not items else "populated"
    elif markers:
        verdict = "empty"
    else:
        verdict = "no-collection"

    # The surface the question is about: the collection itself, then the
    # container immediately enclosing it. Anything further away is "elsewhere on
    # the screen" and does not make THIS surface actionable.
    scope_node = primary if primary is not None else None
    if scope_node is None and markers:
        for n in walk(root):
            if element_path(n) == markers[0]["path"]:
                scope_node = n
                break
    inner = _named_controls(scope_node, by_id) if scope_node is not None else []
    section = scope_node.parent if scope_node is not None else None
    outer = _named_controls(section, by_id) if section is not None else []
    elsewhere = len(_named_controls(root, by_id, limit=200))

    if inner:
        controls, scope = inner, "in-collection"
    elif outer:
        controls, scope = outer, "in-section"
    else:
        controls, scope = [], "none"

    # Only asked on an EMPTY surface: an unfilled search box beside a full list
    # is not a "missing input", it is a search box.
    inputs = (_unfilled_inputs(section if section is not None else root, by_id)
              if verdict == "empty" else [])
    out = {
        "verdict": verdict,
        "defect": bool(verdict == "empty" and not controls),
        "primary": None if primary is None else {
            "tag": primary.tag, "testid": primary.get("data-testid"),
            "path": element_path(primary), "items": len(items),
            "descendants": best},
        "markers": markers[:8],
        "nextAction": {"present": bool(controls), "scope": scope,
                       "controls": controls, "elsewhere": elsewhere},
        "missing": {"kind": ("input" if inputs else ("data" if verdict == "empty" else None)),
                    "inputs": inputs},
    }
    if verdict == "empty" and not controls:
        out["why"] = ("the primary surface renders no items and offers no named "
                      "control of its own — a user landing here has nothing to do")
    elif verdict == "empty":
        out["why"] = ("the primary surface renders no items; the next action is "
                      "%s (%s)" % (controls[0]["name"], scope))
    elif verdict == "no-collection":
        out["why"] = ("no list/grid surface was found, so this check has no "
                      "opinion about this state")
    else:
        out["why"] = "the primary surface renders %d item(s)" % len(items)
    return out


def empty_state_defects(es):
    """The diff key set. `empty-state` alone is what makes 'the primary state
    stopped being empty' visible as a FIXED item; the no-next-action key is the
    reportable UX defect on top of it."""
    if not es or es.get("verdict") != "empty":
        return set()
    where = None
    if es.get("primary"):
        where = es["primary"].get("testid") or es["primary"].get("path")
    elif es.get("markers"):
        where = es["markers"][0].get("testid") or es["markers"][0].get("path")
    keys = {("empty-state", where or "surface")}
    if es.get("defect"):
        keys.add(("empty-state-no-next-action", where or "surface"))
    return keys


def testid_inventory(root):
    ids = {}
    for n in walk(root):
        t = n.get("data-testid")
        if t is None:
            continue
        ids[t] = ids.get(t, 0) + 1
    return {"count": sum(ids.values()), "unique": len(ids),
            "ids": sorted(ids), "byId": dict(sorted(ids.items()))}


# -------------------------------------------------------------- the network --
def classify_network(rec):
    """ok | failed | unknown.

    🔴 THE `unknown` CLASS IS LOad-BEARING (fact 4). A PerformanceObserver entry
    reports `responseStatus` 0 both for a resource that failed and for an
    ordinary cross-origin one without Timing-Allow-Origin — measured 0 on a load
    that really happened. Scoring that as failed would put a false positive on
    almost every run and train everyone to ignore the section. Only fetch/XHR,
    where the hook itself OBSERVED the rejection, may read 0 as a hard failure.
    """
    via = rec.get("via")
    st = rec.get("status")
    if via == "element":
        return "failed"
    if via in ("fetch", "xhr"):
        if not isinstance(st, int):
            return "unknown"
        if st == 0:
            return "failed"
        if st >= 400:
            return "failed"
        return "ok"
    if via == "resource":
        if not isinstance(st, int) or st <= 0:
            return "unknown"
        if st >= 400:
            return "failed"
        return "ok"
    return "unknown"


_VIA_RANK = {"fetch": 0, "xhr": 1, "element": 2, "resource": 3}


def network_summary(records):
    failed, unknown, ok = [], 0, 0
    for r in records:
        k = classify_network(r)
        if k == "failed":
            failed.append(r)
        elif k == "unknown":
            unknown += 1
        else:
            ok += 1
    # one URL failing twice through two instruments is ONE defect
    best = {}
    for r in failed:
        key = (r.get("url", ""), r.get("status"))
        cur = best.get(key)
        if cur is None or _VIA_RANK.get(r.get("via"), 9) < _VIA_RANK.get(cur.get("via"), 9):
            best[key] = r
    out = []
    for (url, st), r in best.items():
        e = {"url": url, "status": st, "via": r.get("via")}
        if r.get("error"):
            e["error"] = r["error"]
        if r.get("initiator"):
            e["initiator"] = r["initiator"]
        out.append(e)
    out.sort(key=lambda e: (e["url"], e["status"] if e["status"] is not None else -1))
    return {"counts": {"observed": len(records), "ok": ok, "failed": len(out),
                       "unknown": unknown},
            "failures": out}


# -------------------------------------------------------------- the console --
LEVELS = ("error", "warn", "log", "info", "debug")


def console_summary(records):
    msgs = []
    selftest_seen = False
    for r in records:
        text = str(r.get("text", ""))
        if SELFTEST_SENTINEL in text:
            selftest_seen = True
            continue                       # our own probe line is not app output
        lvl = r.get("level", "log")
        if lvl not in LEVELS:
            lvl = "log"
        msgs.append({"level": lvl, "text": text[:MAX_TEXT]})
    counts = dict((l, 0) for l in LEVELS)
    for m in msgs:
        counts[m["level"]] += 1
    return {"counts": counts, "total": len(msgs), "messages": msgs,
            "sentinelSeen": selftest_seen}


# ----------------------------------------------------------------- unwrapping --
def unwrap_bridge(raw, field):
    """The bridge prints `{ok, result:{data:{...}}}`; a test or a hand-run may
    hand us the inner value directly. Accept both, refuse anything else — a
    silent 'well, it was empty' here is how a whole section reads as clean.

    🔴 THE BRIDGE WRITES ADVICE TO STDERR AND capture.sh CAPTURES `2>&1`. A
    perfectly ordinary read comes back as

        browser: tab is hidden — background tabs are throttled, ...
        {"ok":true,"result":{...}}

    and a parser that only looks at the first byte then treats the WHOLE blob as
    markup: it contains `<`, so it passes every shape check, parses to a handful
    of junk nodes, and reports 0 testids and 0 a11y violations. Nothing errors.
    (This is the repo's `nix-shell --run` banner trap in a new costume: the noise
    is on the far side of the pipe you were reading.) So a JSON payload is located
    from its FIRST BRACE, and a blob that is neither markup nor locatable JSON is
    refused rather than analysed.
    """
    s = raw.strip()
    if not s:
        raise Refuse("input_empty", "the %s input is empty" % field)
    if s[0] == "<":
        return s
    brace = s.find("{")
    if brace < 0:
        raise Refuse("input_unreadable",
                     "the %s input is neither markup nor JSON (%d bytes, starts "
                     "%r)" % (field, len(s), s[:60]))
    try:
        d = json.loads(s[brace:])
    except ValueError as e:
        raise Refuse("input_unreadable",
                     "the %s input is neither JSON nor markup: %s. If it starts "
                     "with a `browser: ...` line, that is the bridge's STDERR "
                     "advice captured by `2>&1` — it is not part of the payload."
                     % (field, e))
    if isinstance(d, dict):
        inner = (d.get("result") or d)
        data = inner.get("data") if isinstance(inner, dict) else None
        if isinstance(data, dict) and field in data:
            return data[field]
        if field in d:
            return d[field]
    return d


def load_dom(raw):
    html = unwrap_bridge(raw, "html")
    if not isinstance(html, str):
        raise Refuse("dom_unreadable",
                     "the DOM input did not yield an outerHTML string. Pass the "
                     "bridge's `html` output verbatim, or a plain .html file.")
    if "<" not in html:
        raise Refuse("dom_unreadable",
                     "the DOM input contains no markup at all (%d bytes). A "
                     "frame read that returns no DOM usually means the --frame "
                     "id was stale: it changes on EVERY load." % len(html))
    if TRUNCATION_MARKER in html[-200:]:
        raise Refuse(
            "dom_truncated",
            "the DOM carries the bridge's truncation marker. The bridge's `html` "
            "default cap is 32768 bytes and a real App Block DOM measured 38,758 "
            "— so the default read SILENTLY loses the tail, under-reporting every "
            "testid and every a11y violation while looking normal. Re-read with "
            "`html --max-bytes 0`.")
    return html


def load_probe(raw):
    val = unwrap_bridge(raw, "value")
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except ValueError as e:
            raise Refuse("probe_unreadable", "the probe payload is not JSON: %s" % e)
    if not isinstance(val, dict):
        raise Refuse("probe_unreadable", "the probe payload is not an object")
    if val.get("schema") != PROBE_SCHEMA:
        raise Refuse("probe_unreadable",
                     "probe payload has schema %r, expected %r — the install and "
                     "drain halves have drifted apart"
                     % (val.get("schema"), PROBE_SCHEMA))
    return val


# ------------------------------------------------------------------ analyze --
ELIDE_TEXT = ("script", "style", "noscript", "template")


def pretty_html(html, indent=2):
    """A stable, whitespace-normalised re-serialisation, so two runs of the same
    state diff on CONTENT rather than on how the framework happened to emit it.

    Inline <script>/<style> bodies are ELIDED (their byte count is kept): a
    single autogenerated theme <style> is most of the file, so leaving it in
    buries every real change under a wall of CSS. This file is for reading and
    diffing — `<state>.dom.json` is the verbatim capture, and the artifact's
    `dom.sha256` is taken over THAT, not over this."""
    root = parse_dom(html)
    out = []

    def emit(n, d):
        pad = " " * (indent * d)
        if n.tag == "#document":
            for c in n.children:
                emit(c, d)
            return
        attrs = "".join(' %s="%s"' % (k, n.attrs[k]) for k in sorted(n.attrs))
        txt = _own_text(n)
        if n.tag in ELIDE_TEXT:
            body = " ".join(n.text)
            out.append("%s<%s%s>%s</%s>"
                       % (pad, n.tag, attrs,
                          ("…%d bytes elided…" % len(body)) if body else "", n.tag))
            return
        if n.tag in VOID:
            out.append("%s<%s%s>" % (pad, n.tag, attrs))
            return
        if not n.children and not txt:
            out.append("%s<%s%s></%s>" % (pad, n.tag, attrs, n.tag))
            return
        out.append("%s<%s%s>" % (pad, n.tag, attrs))
        if txt:
            out.append("%s%s" % (" " * (indent * (d + 1)), txt))
        for c in n.children:
            emit(c, d + 1)
        out.append("%s</%s>" % (pad, n.tag))

    emit(root, 0)
    return "\n".join(out) + "\n"


def _int_or_none(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _unknown(v):
    """A counter a payload does not carry is UNKNOWN, and must not print as a
    number-shaped word. A probe predating the lifecycle fields reports neither
    `installs` nor `drains`, and `None` in a sentence reads like a value."""
    return "?" if v is None else str(v)


def probe_lifecycle(probe, observed):
    """🔴 WHICH LIFECYCLE PRODUCED THESE NUMBERS — reported, never assumed.

    `observed` is the number of network records this drain actually carries.
    The counter beside them must describe the SAME window:

        counts.networkTotal == observed + dropped.network

    A probe installed by an earlier state (or an earlier INVOCATION — in `--tab`
    attach mode nothing reloads the page, so `window.__APP_CAPTURE__` survives)
    used to break that silently: the arrays were emptied per drain and the
    counter was not. Measured live: `networkTotal` 6 against 2 -> 0 -> 0 records,
    with `reinstalled: false` in all six artifacts because the flag was written
    at install and only the DRAIN is ever saved.

    So reuse is inferred from FOUR INDEPENDENT tells, any one of which is enough:
    `reinstalled`, an install count above 1, a drain count above 1, and — for a
    payload from a probe PREDATING this fix, which carries none of those three —
    the counter disagreement itself.

    🔴 THE COUNTER TELL IS THE ONE THAT CANNOT FIRE IN PRODUCTION, and that is by
    construction: once the drain resets its counter, a correctly-draining re-used
    probe has `agree == True`. So live detection rests ENTIRELY on the first
    three, and each of them must be exercised on its own — a fixture carrying two
    tells at once cannot tell which one is doing the work, and for a while none
    of the three was covered at all while the suite stayed green (E13 now drives
    each independently, with a consistent counter so the fourth is silent).
    """
    dropped = _int_or_none((probe.get("dropped") or {}).get("network")) or 0
    counts = probe.get("counts") if isinstance(probe.get("counts"), dict) else {}
    total = _int_or_none(counts.get("networkTotal"))
    window = observed + dropped
    agree = None if total is None else (total == window)
    installs = _int_or_none(probe.get("installs"))
    drains = _int_or_none(probe.get("drains"))
    reused = bool(probe.get("reinstalled")) \
        or (installs is not None and installs > 1) \
        or (drains is not None and drains > 1) \
        or agree is False
    if agree is False and total < window:
        # 🔴 NOT A LIFECYCLE — CORRUPTION. Cumulative drift can only make the
        # counter run AHEAD of the records it counts; a counter BEHIND them means
        # the payload is not the one this probe produced, and nothing downstream
        # can be trusted to describe the app.
        raise Refuse(
            "probe_counts_impossible",
            "the probe reports networkTotal=%d but carries %d record(s) plus %d "
            "dropped — a counter can only run AHEAD of its own array (a probe "
            "re-used across drains), never behind it. This payload does not "
            "describe the run that produced it; refusing to build an artifact "
            "from it." % (total, observed, dropped))
    if reused:
        why = ("this drain came from a probe that was ALREADY installed — in "
               "--tab attach mode nothing reloads the page, so the probe "
               "survives between states and between invocations")
    else:
        why = "a freshly installed probe: this drain is its first window"
    return {
        "installed": True,
        "selfTest": bool(probe.get("selfTest")),
        "hooks": probe.get("hooks") or {},
        "reinstalled": bool(probe.get("reinstalled")),
        "installs": installs,
        "drains": drains,
        "reused": reused,
        "fresh": not reused,
        "counts": {"networkTotal": total,
                   "networkSinceInstall": _int_or_none(counts.get("networkSinceInstall")),
                   "observedThisDrain": observed,
                   "droppedThisDrain": dropped,
                   "agree": agree},
        "why": why,
    }


def analyze(html, probe, state, slug=None, frame_host=None, allow_unverified=False):
    if not probe.get("installed"):
        raise Refuse(
            "probe_missing",
            "the probe reports it was never installed (%s). Its console and "
            "network sections would be empty for a reason that has nothing to do "
            "with the app, and an empty section reads as a clean bill of health. "
            "Install the probe in the SAME frame, right after the frame id "
            "resolves and BEFORE the state's actions run."
            % (probe.get("error") or "no reason given"))
    if not probe.get("selfTest") and not allow_unverified:
        raise Refuse(
            "probe_selftest_failed",
            "the probe's own sentinel did not come back through its console "
            "hook, so this run cannot tell 'the app logged nothing' from 'nothing "
            "was listening'. Refusing to print a reassuring zero. Re-run; if the "
            "app really does block the hook, pass --allow-unverified-probe and "
            "read the console section as UNPROVEN.")

    root = parse_dom(html)
    con = console_summary(probe.get("console") or [])
    net = network_summary(probe.get("network") or [])
    a11y = a11y_scan(root)
    tids = testid_inventory(root)
    empty = empty_state_scan(root)
    elements = sum(1 for _ in walk(root))

    life = probe_lifecycle(probe, net["counts"]["observed"])

    notes = []
    if not probe.get("selfTest"):
        notes.append("UNPROVEN: the console hook was never verified — read the "
                     "console counts as unknown, not as zero.")
    # 🔴 THE NOTE THAT WAS CONTRADICTED BY THE FIELD BESIDE IT. "observed ZERO
    # requests" is a claim about THIS state, and a probe whose counter disagrees
    # with its own records cannot support it: the zero is the array, the counter
    # is everything since an earlier install. Say which, or say neither.
    if life["reused"]:
        c = life["counts"]
        notes.append(
            "PROBE REUSED: %s (installs=%s, drain #%s). The console and network "
            "sections below cover ONLY this drain — %d request(s) — while the "
            "probe's own counter reports %s since it was installed. Nothing here "
            "is a claim about the states that came before."
            % (life["why"], _unknown(life["installs"]), _unknown(life["drains"]),
               c["observedThisDrain"],
               _unknown(c["networkSinceInstall"] if c["networkSinceInstall"] is not None
                        else c["networkTotal"])))
    if probe.get("hooks", {}).get("fetch") and net["counts"]["observed"] == 0 \
            and life["counts"]["agree"] is not False:
        notes.append("the network hooks were installed and observed ZERO requests; "
                     "either the app made none in this state or the state ended "
                     "before any completed.")
    if (probe.get("dropped") or {}).get("console"):
        notes.append("console buffer overflowed: %d message(s) dropped"
                     % probe["dropped"]["console"])
    if (probe.get("dropped") or {}).get("network"):
        notes.append("network buffer overflowed: %d record(s) dropped"
                     % probe["dropped"]["network"])

    art = {
        "schema": SCHEMA,
        "state": state,
        "slug": slug,
        "frameHost": frame_host,
        "dom": {"bytes": len(html), "elements": elements,
                "sha256": hashlib.sha256(html.encode("utf-8", "replace")).hexdigest()},
        "console": {"capture": {"installed": True,
                                "selfTest": bool(probe.get("selfTest")),
                                "hooks": probe.get("hooks") or {},
                                "sentinelSeen": con["sentinelSeen"],
                                "dropped": (probe.get("dropped") or {}).get("console", 0)},
                    "counts": con["counts"], "total": con["total"],
                    "messages": con["messages"]},
        "network": {"capture": {"hooks": probe.get("hooks") or {},
                                "dropped": (probe.get("dropped") or {}).get("network", 0)},
                    "counts": net["counts"], "failures": net["failures"]},
        "a11y": a11y,
        "testids": tids,
        "emptyState": empty,
        "probe": life,
        "notes": notes,
    }
    if empty["verdict"] == "empty":
        notes.append("EMPTY STATE: %s" % empty["why"])
    # 🔴 EVERYTHING NON-DETERMINISTIC LIVES UNDER `meta`, AND `diff` IGNORES
    # `meta`. That is the whole reason two runs can be compared at all: a
    # timestamp or a frame id in the body would make every diff non-empty and
    # the tool useless on its second day.
    # `meta.reinstalled` stays for compatibility, and is now capable of being
    # TRUE: the re-install branch writes the flag onto `S`, which is the object
    # the drain serialises. The lifecycle a reader should act on is `probe`,
    # because `reinstalled` alone cannot see a probe that outlived the whole
    # invocation without being re-installed.
    art["meta"] = {"probeSchema": probe.get("schema"),
                   "reinstalled": bool(probe.get("reinstalled"))}
    return art


DIFF_SECTIONS = ("console", "network", "a11y", "testids", "emptyState", "dom")
# The sections whose entries are DEFECTS — the ones `fixed`/`regressed` count.
# `testids` is inventory, not a defect, and stays out of those two totals.
DEFECT_NAMES = ("console", "networkFailures", "a11y", "emptyState")


def _keyset(art):
    con = set((m["level"], m["text"]) for m in art["console"]["messages"])
    net = set((f["url"], f["status"]) for f in art["network"]["failures"])
    a11 = set((v["check"], v["path"], v["why"]) for v in art["a11y"]["violations"])
    tid = set(art["testids"]["ids"])
    emp = empty_state_defects(art.get("emptyState"))
    return con, net, a11, emp, tid


def testid_counts(art):
    """🔴 OCCURRENCES, NOT MEMBERSHIP — the delta the set diff structurally cannot
    see. Measured: a grid going 24 -> 39 testid OCCURRENCES reported
    `unchanged: 15` and nothing else, because every id was already present in
    both runs. That is the exact shape of "the primary state stopped being
    empty", which is one of this mode's own definition-of-done criteria, so the
    diff has to carry per-id counts and not only the id set."""
    return dict((art.get("testids") or {}).get("byId") or {})


def diff(before, after):
    b = _keyset(before)
    a = _keyset(after)
    names = ("console", "networkFailures", "a11y", "emptyState", "testids")
    out = {"schema": "app-capture/evidence-diff@1",
           "state": after.get("state"), "slug": after.get("slug"),
           "domChanged": before["dom"]["sha256"] != after["dom"]["sha256"]}
    # 🔴 `domChanged` IS REPORTED BUT DOES NOT SET `changed`, AND THAT IS
    # MEASURED, NOT TASTE. Two independent real captures of custom-generators'
    # `discover` state, minutes apart, agreed EXACTLY on console, network, a11y
    # and all 15 testids — and differed on the DOM hash (35,556 vs 35,676 bytes),
    # because the app's content is live. Folding the hash into the verdict would
    # make `diff` exit 1 on every honest re-run, and a signal that is always red
    # is a signal everyone learns to skip. What `changed` answers is the question
    # worth asking: did a defect appear or disappear?
    changed = False
    for name, bs, as_ in zip(names, b, a):
        added = sorted(as_ - bs)
        removed = sorted(bs - as_)
        out[name] = {"added": [list(x) if isinstance(x, tuple) else x for x in added],
                     "removed": [list(x) if isinstance(x, tuple) else x for x in removed],
                     "unchanged": len(as_ & bs)}
        if added or removed:
            changed = True

    # 🔴 REPORTED, NOT FOLDED INTO `changed` — for the same measured reason as
    # `domChanged`: a live app's item counts move between two honest runs, and a
    # verdict that is always red is one everyone learns to skip. The COUNTS are
    # what a reader needs to see the grid go 24 -> 39; `changed` stays the answer
    # to "did a defect appear or disappear?".
    bc, ac = testid_counts(before), testid_counts(after)
    moved = []
    for tid in sorted(set(bc) | set(ac)):
        nb, na = bc.get(tid, 0), ac.get(tid, 0)
        if nb != na:
            moved.append({"id": tid, "before": nb, "after": na, "delta": na - nb})
    out["testidCounts"] = {
        "changed": moved,
        "totalBefore": sum(bc.values()), "totalAfter": sum(ac.values()),
        "delta": sum(ac.values()) - sum(bc.values()),
    }
    out["occurrencesChanged"] = bool(moved)

    out["changed"] = changed
    out["fixed"] = sum(len(out[n]["removed"]) for n in DEFECT_NAMES)
    out["regressed"] = sum(len(out[n]["added"]) for n in DEFECT_NAMES)
    return out


def report(arts):
    lines = []
    for a in arts:
        c, n, y, t = a["console"], a["network"], a["a11y"], a["testids"]
        lines.append("state %s (%s)" % (a.get("state"), a.get("slug") or "?"))
        lines.append("  dom       : %d bytes, %d elements" % (a["dom"]["bytes"], a["dom"]["elements"]))
        lines.append("  console   : %d error / %d warn / %d log%s"
                     % (c["counts"]["error"], c["counts"]["warn"], c["counts"]["log"],
                        "" if c["capture"]["selfTest"] else "   🔴 UNPROVEN (selfTest failed)"))
        for m in c["messages"][:5]:
            if m["level"] in ("error", "warn"):
                lines.append("      [%s] %s" % (m["level"], m["text"][:140]))
        # 🔴 THE PROBE'S OWN LIFECYCLE, IN THE HUMAN REPORT TOO. A reader who
        # cannot tell a fresh probe from one carried over from an earlier state
        # reads every count as a fact about THIS state; on the first live run
        # that produced a `networkTotal` of 6 sitting under the word ZERO.
        pr = a.get("probe")
        if pr:
            # 🔴 NOT `c` — that name is bound to a["console"] for this whole loop
            # iteration, and rebinding it here worked only because nothing read it
            # afterwards. One inserted line and the console section starts printing
            # probe counters.
            pc = pr.get("counts") or {}
            lines.append("  probe     : %s (install #%s, drain #%s) — network %d "
                         "this drain%s"
                         % ("🔴 REUSED" if pr.get("reused") else "fresh",
                            _unknown(pr.get("installs")), _unknown(pr.get("drains")),
                            pc.get("observedThisDrain", 0),
                            "" if pc.get("agree") is not False else
                            ", counter says %s SINCE INSTALL (not this state)"
                            % pc.get("networkTotal")))
        lines.append("  network   : %d failed of %d observed (%d unknown)"
                     % (n["counts"]["failed"], n["counts"]["observed"], n["counts"]["unknown"]))
        for f in n["failures"][:5]:
            lines.append("      %s %s (%s)" % (f["status"], f["url"][:110], f["via"]))
        lines.append("  a11y      : %d violation(s) — %s"
                     % (y["total"], ", ".join("%s=%d" % (k, v) for k, v in sorted(y["counts"].items()))))
        for v in y["violations"][:5]:
            lines.append("      %-16s %s [testid=%s]"
                         % (v["check"], v["why"][:60], v["testid"]))
        lines.append("  testids   : %d occurrence(s), %d unique" % (t["count"], t["unique"]))
        # 🔴 THE PER-ID COUNTS, IN THE HUMAN REPORT TOO. The set of ids is what a
        # naive diff compares, and it cannot express "the grid filled up": the
        # ids that REPEAT are the content. Printed by descending count so an
        # empty grid and a full one do not read alike.
        # descending by count, then by id — a tie broken by reverse-alphabetical
        # order drops the very id a reader is looking for out of the top slice.
        rep = sorted(((n, i) for i, n in (t.get("byId") or {}).items() if n > 1),
                     key=lambda p: (-p[0], p[1]))[:8]
        if rep:
            lines.append("    repeated: %s" % ", ".join("%s x%d" % (i, n) for n, i in rep))
        e = a.get("emptyState")
        if e:
            p = e.get("primary") or {}
            na = e.get("nextAction") or {}
            lines.append("  empty     : %s%s — %s"
                         % (e.get("verdict"),
                            "  🔴 DEFECT" if e.get("defect") else "",
                            e.get("why", "")))
            if p:
                lines.append("      primary   %s [testid=%s] %d item(s)"
                             % (p.get("tag"), p.get("testid"), p.get("items")))
            if e.get("verdict") == "empty":
                lines.append("      next action: %s%s"
                             % ("none on this surface" if not na.get("present")
                                else ", ".join(c["name"] for c in na.get("controls", [])[:3]),
                                "" if na.get("present") else
                                " (%d named control(s) elsewhere on screen)" % na.get("elsewhere", 0)))
                mi = e.get("missing") or {}
                if mi.get("inputs"):
                    lines.append("      missing input(s): %s"
                                 % ", ".join("%s [testid=%s]%s"
                                             % (i["name"] or i["tag"], i["testid"],
                                                (" placeholder=%r" % i["placeholder"]) if i["placeholder"] else "")
                                             for i in mi["inputs"][:3]))
                elif mi.get("kind") == "data":
                    lines.append("      missing: DATA — no unfilled input on this "
                                 "surface, so nothing the user can type fills it")
        for note in a.get("notes", []):
            lines.append("  note      : %s" % note)
    return "\n".join(lines)


# -------------------------------------------------------------------- main --
def main(argv=None):
    ap = argparse.ArgumentParser(prog="evidence.py")
    sub = ap.add_subparsers(dest="cmd")

    an = sub.add_parser("analyze")
    an.add_argument("--dom", required=True)
    an.add_argument("--probe", required=True)
    an.add_argument("--state", required=True)
    an.add_argument("--slug")
    an.add_argument("--frame-host")
    an.add_argument("--allow-unverified-probe", action="store_true")
    an.add_argument("--out")
    an.add_argument("--pretty-dom")

    df = sub.add_parser("diff")
    df.add_argument("before")
    df.add_argument("after")

    rp = sub.add_parser("report")
    rp.add_argument("artifacts", nargs="+")

    pj = sub.add_parser("probe-js")
    pj.add_argument("which", choices=("install", "drain"))

    a = ap.parse_args(argv)
    try:
        if a.cmd == "probe-js":
            print(PROBE_INSTALL_JS if a.which == "install" else PROBE_DRAIN_JS)
            return 0
        if a.cmd == "analyze":
            html = load_dom(open(a.dom, encoding="utf-8", errors="replace").read())
            probe = load_probe(open(a.probe, encoding="utf-8", errors="replace").read())
            art = analyze(html, probe, a.state, a.slug, a.frame_host,
                          a.allow_unverified_probe)
            blob = json.dumps(art, indent=2, sort_keys=True)
            if a.out:
                open(a.out, "w", encoding="utf-8").write(blob + "\n")
            if a.pretty_dom:
                open(a.pretty_dom, "w", encoding="utf-8").write(pretty_html(html))
            print(blob)
            return 0
        if a.cmd == "diff":
            b = json.load(open(a.before, encoding="utf-8"))
            c = json.load(open(a.after, encoding="utf-8"))
            d = diff(b, c)
            print(json.dumps(d, indent=2, sort_keys=True))
            return 1 if d["changed"] else 0
        if a.cmd == "report":
            arts = [json.load(open(p, encoding="utf-8")) for p in a.artifacts]
            print(report(arts))
            return 0
    except Refuse as e:
        sys.stderr.write("REFUSE[%s]: %s\n" % (e.code, e.msg))
        return 2
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
