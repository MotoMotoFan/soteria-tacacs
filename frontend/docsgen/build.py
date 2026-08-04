#!/usr/bin/env python3
"""Soteria documentation site generator.

Converts the LaTeX manual in SRC (the soteria-documentation tree) into a
static HTML site in OUT.  Purpose-built for the conventions used by this
corpus (see soteria-documentation CONVENTIONS): section/subsection files,
lstlisting + cisco listings, booktabs tables, figures with placeholder
images, \\ref/\\label cross-references.

Usage: build.py SRC OUT
"""
import hashlib
import html
import json
import os
import re
import shutil
import sys
import time

WARN = []


def warn(msg):
    WARN.append(msg)


# ---------------------------------------------------------------- low level

def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def find_braced(text, start):
    """text[start] == '{' -> (content, index_after_closing)."""
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{" and (i == 0 or text[i - 1] != "\\"):
            depth += 1
        elif c == "}" and text[i - 1] != "\\":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
    raise ValueError("unbalanced braces")


def find_bracketed(text, start):
    """text[start] == '[' -> (content, index_after_closing). Brace aware."""
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == "]" and depth == 0:
            return text[start + 1:i], i + 1
    raise ValueError("unbalanced bracket")


def find_env(text, name, pos=0):
    """Locate \\begin{name}[opts]body\\end{name} handling same-name nesting.

    Returns (start, end, opts, body) or None.
    """
    begin = "\\begin{%s}" % name
    end = "\\end{%s}" % name
    i = text.find(begin, pos)
    if i < 0:
        return None
    j = i + len(begin)
    opts = ""
    if j < len(text) and text[j] == "[":
        opts, j = find_bracketed(text, j)
    depth = 1
    k = j
    while depth:
        nb = text.find(begin, k)
        ne = text.find(end, k)
        if ne < 0:
            raise ValueError("missing \\end{%s}" % name)
        if 0 <= nb < ne:
            depth += 1
            k = nb + len(begin)
        else:
            depth -= 1
            k = ne + len(end)
            body_end = ne
    return i, k, opts, text[j:body_end]


def opt_value(opts, key):
    """Extract key={value} (brace aware) or key=value from an options string."""
    m = re.search(re.escape(key) + r"\s*=\s*", opts)
    if not m:
        return None
    i = m.end()
    if i < len(opts) and opts[i] == "{":
        val, _ = find_braced(opts, i)
        return val
    m2 = re.match(r"[^,\]]*", opts[i:])
    return m2.group(0).strip()


def strip_comments(text):
    out = []
    for line in text.split("\n"):
        res = []
        i = 0
        while i < len(line):
            c = line[i]
            if c == "%" and (i == 0 or line[i - 1] != "\\"):
                break
            res.append(c)
            i += 1
        out.append("".join(res).rstrip())
    return "\n".join(out)


# ------------------------------------------------------------ inline markup

S = {  # sentinels for escaped specials (private-use codepoints)
    "AMP": "\ue000", "PCT": "\ue001", "UND": "\ue002", "HASH": "\ue003",
    "DOLLAR": "\ue004", "LB": "\ue005", "RB": "\ue006", "BS": "\ue007",
    "TILDE": "\ue008", "DASH": "\ue009", "LT": "\ue00a", "GT": "\ue00b",
    "QUOT": "\ue00c",
}


def protect_specials(t):
    t = t.replace("\\%", S["PCT"]).replace("\\_", S["UND"])
    t = t.replace("\\&", S["AMP"]).replace("\\#", S["HASH"])
    t = t.replace("\\$", S["DOLLAR"])
    t = t.replace("\\{", S["LB"]).replace("\\}", S["RB"])
    t = t.replace("\\textbackslash{}", S["BS"]).replace("\\textbackslash", S["BS"])
    t = t.replace("\\textasciitilde{}", S["TILDE"]).replace("\\textasciitilde", S["TILDE"])
    t = t.replace("\\ldots", "\u2026").replace("\\dots", "\u2026")
    return t


def restore_specials(t):
    t = t.replace(S["AMP"], "&amp;").replace(S["PCT"], "%")
    t = t.replace(S["UND"], "_").replace(S["HASH"], "#")
    t = t.replace(S["DOLLAR"], "$").replace(S["LB"], "{").replace(S["RB"], "}")
    t = t.replace(S["BS"], "\\").replace(S["TILDE"], "~")
    t = t.replace(S["DASH"], "-").replace(S["LT"], "&lt;").replace(S["GT"], "&gt;")
    t = t.replace(S["QUOT"], "&quot;")
    return t


INLINE_CMDS = {
    "texttt": ("code", True),
    "textbf": ("strong", False),
    "emph": ("em", False),
    "textit": ("em", False),
    "textsc": ("span", False),
}


def inline(t, labels):
    """Convert an inline LaTeX fragment to HTML."""
    if t is None:
        return ""
    t = protect_specials(t)
    t = html.escape(t, quote=False)
    # math: only arrows appear in prose
    t = re.sub(r"(\$|\\\()\s*\\[Rr]ightarrow\s*(\$|\\\))", "\u2192", t)
    t = re.sub(r"(\$|\\\()\s*\\[Ll]eftarrow\s*(\$|\\\))", "\u2190", t)
    t = t.replace("\\Rightarrow", "\u21d2").replace("\\rightarrow", "\u2192")
    t = t.replace("\\Leftarrow", "\u21d0").replace("\\leftarrow", "\u2190")
    t = t.replace("~", "\u00a0")
    t = t.replace("{}", "")                      # ligature breakers: -{}-
    t = re.sub(r"\\phantom\{[^{}]*\}", "", t)    # alignment padding
    t = re.sub(r"\\addlinespace(\[[^\]]*\])?", "", t)
    t = t.replace("\\newline", "<br>")

    # nested inline commands, innermost first
    names = "|".join(INLINE_CMDS)
    pat = re.compile(r"\\(" + names + r")\{([^{}]*)\}")

    def repl(m):
        tag, is_code = INLINE_CMDS[m.group(1)]
        body = m.group(2)
        if is_code:
            # keep literal dashes/quotes inside code
            body = body.replace("-", S["DASH"])
            body = body.replace("``", S["QUOT"]).replace("''", S["QUOT"])
            body = body.replace("&lt;", S["LT"]).replace("&gt;", S["GT"])
        return "<%s>%s</%s>" % (tag, body, tag)

    prev = None
    while prev != t:
        prev = t
        t = pat.sub(repl, t)

    # fallback for inline commands whose body contains raw (unescaped) braces,
    # e.g. \texttt{\${VAR:-default}:80}: resolve with balanced-brace scanning
    fb = re.compile(r"\\(" + names + r")\{")
    while True:
        m = fb.search(t)
        if not m:
            break
        try:
            body, after = find_braced(t, m.end() - 1)
        except ValueError:
            t = t[:m.start()] + t[m.end():]
            continue
        tag, is_code = INLINE_CMDS[m.group(1)]
        body = body.replace("{", S["LB"]).replace("}", S["RB"])
        if is_code:
            body = body.replace("-", S["DASH"])
            body = body.replace("&lt;", S["LT"]).replace("&gt;", S["GT"])
        t = t[:m.start()] + "<%s>%s</%s>" % (tag, body, tag) + t[after:]

    # cross references
    def ref(m):
        lab = m.group(1)
        info = labels.get(lab)
        if not info:
            warn("unresolved \\ref{%s}" % lab)
            return "<a class='xref broken' title='%s'>?</a>" % html.escape(lab)
        return "<a class='xref' href='%s#%s'>%s</a>" % (
            info["page"], html.escape(lab, quote=True), info["num"])

    t = re.sub(r"\\ref\{([^}]*)\}", ref, t)

    # typography
    t = t.replace("``", "\u201c").replace("''", "\u201d")
    t = t.replace("---", "\u2014").replace("--", "\u2013")
    t = t.replace("\\\\", "<br>")
    t = re.sub(r"\\(newpage|noindent|centering|small|footnotesize|clearpage)\b", "", t)

    # leftover commands: keep the argument, drop the command
    def leftover(m):
        warn("dropped \\%s{...}" % m.group(1))
        return m.group(2)

    t = re.sub(r"\\([A-Za-z]+)\{([^{}]*)\}", leftover, t)
    t = re.sub(r"\\([A-Za-z]+)\s*", lambda m: (warn("dropped \\" + m.group(1)) or ""), t)
    t = t.replace("{", "").replace("}", "")
    return restore_specials(t).strip()


def plain_text(html_frag):
    return re.sub(r"<[^>]+>", "", html_frag)


# ------------------------------------------------------------------ parsing

class Doc:
    def __init__(self):
        self.chapters = []      # {num, title, slug, page, intro:[nodes], subs:[...]}
        self.labels = {}        # label -> {kind, num, page}
        self.counters = {"figure": 0, "table": 0, "listing": 0}


def preprocess(text, blocks):
    """Pull verbatim + float environments out into the blocks list."""
    # verbatim listings first: their bodies must survive untouched
    for env, kind in (("lstlisting", "code"), ("cisco", "cisco")):
        while True:
            hit = find_env(text, env)
            if not hit:
                break
            s, e, opts, body = hit
            blocks.append({
                "type": kind,
                "caption": opt_value(opts, "caption"),
                "label": opt_value(opts, "label"),
                "code": body.strip("\n"),
            })
            text = text[:s] + "\n@@BLK%d@@\n" % (len(blocks) - 1) + text[e:]

    text = strip_comments(text)

    while True:
        hit = find_env(text, "figure")
        if not hit:
            break
        s, e, _o, body = hit
        m = re.search(r"\\includegraphics(\[[^\]]*\])?\{([^}]*)\}", body)
        cap = re.search(r"\\caption", body)
        caption = None
        if cap:
            caption, _ = find_braced(body, body.index("{", cap.end()))
        lab = re.search(r"\\label\{([^}]*)\}", body)
        blocks.append({
            "type": "figure",
            "image": m.group(2) if m else None,
            "caption": caption,
            "label": lab.group(1) if lab else None,
        })
        text = text[:s] + "\n@@BLK%d@@\n" % (len(blocks) - 1) + text[e:]

    while True:
        hit = find_env(text, "table")
        if not hit:
            break
        s, e, _o, body = hit
        cap = re.search(r"\\caption", body)
        caption = None
        if cap:
            caption, _ = find_braced(body, body.index("{", cap.end()))
        lab = re.search(r"\\label\{([^}]*)\}", body)
        tab = find_env(body, "tabular")
        spec, rows_head, rows_body = "", [], []
        if tab:
            _s, _e, _o2, tbody = tab
            m = re.match(r"\s*\{", tbody)
            if m:
                spec, rest_i = find_braced(tbody, tbody.index("{"))
                tbody = tbody[rest_i:]
            else:
                # spec came through find_env opts-less: tabular{spec} pattern
                pass
            head = True
            for raw_row in re.split(r"\\\\", tbody):
                r = raw_row.strip()
                if not r:
                    continue
                if "\\midrule" in r:
                    head = False
                r = re.sub(r"\\(toprule|midrule|bottomrule|hline)", "", r)
                r = re.sub(r"\\addlinespace(\[[^\]]*\])?", "", r).strip()
                if not r:
                    continue
                cells = [c.strip() for c in re.split(r"(?<!\\)&", r)]
                (rows_head if head else rows_body).append(cells)
        if rows_head and not rows_body:      # table without midrule
            rows_body, rows_head = rows_head, []
        blocks.append({
            "type": "table",
            "caption": caption,
            "label": lab.group(1) if lab else None,
            "spec": re.sub(r"[^lcrp]", "", spec),
            "head": rows_head,
            "rows": rows_body,
        })
        text = text[:s] + "\n@@BLK%d@@\n" % (len(blocks) - 1) + text[e:]

    # vendor tab groups: \begin{vendortabs} \begin{vendortab}{Title} ... per
    # vendor. Listings inside were already tokenised above, so each tab body
    # is prose + @@BLKn@@ placeholders, parsed lazily at render time.
    while True:
        hit = find_env(text, "vendortabs")
        if not hit:
            break
        s, e, _o, body = hit
        tabs = []
        pos = 0
        while True:
            th = find_env(body, "vendortab", pos)
            if not th:
                break
            _ts, te, _to, tbody = th
            title, rest_i = find_braced(tbody, tbody.index("{"))
            tabs.append({"title": title.strip(), "text": tbody[rest_i:]})
            pos = te
        blocks.append({"type": "vendortabs", "tabs": tabs})
        text = text[:s] + "\n@@BLK%d@@\n" % (len(blocks) - 1) + text[e:]

    return text, blocks


LIST_ENVS = ("itemize", "enumerate", "description")


def parse_body(text, blocks):
    """Parse a preprocessed fragment into a node list."""
    nodes = []
    pos = 0
    while True:
        first = None
        for env in LIST_ENVS:
            hit = find_env(text, env, pos)
            if hit and (first is None or hit[0] < first[1][0]):
                first = (env, hit)
        if not first:
            nodes += parse_flow(text[pos:], blocks)
            break
        env, (s, e, _o, body) = first
        nodes += parse_flow(text[pos:s], blocks)
        nodes.append(parse_list(env, body, blocks))
        pos = e
    return nodes


def parse_list(env, body, blocks):
    items = []
    # split on top-level \item, tracking nested environment depth
    depth = 0
    parts = []
    cur = []
    i = 0
    tok = re.compile(r"\\begin\{[a-z]+\}|\\end\{[a-z]+\}|\\item(\[[^\]]*\])?")
    last = 0
    for m in tok.finditer(body):
        if m.group(0).startswith("\\begin"):
            depth += 1
        elif m.group(0).startswith("\\end"):
            depth -= 1
        elif depth == 0:  # \item at top level
            parts.append((body[last:m.start()], m.group(1)))
            last = m.end()
    parts.append((body[last:], None))
    # parts[0][0] is pre-item junk; each item i>0 content is parts[i][0]... rebuild:
    terms = []
    for idx in range(1, len(parts)):
        content = parts[idx][0]
        term = parts[idx - 1][1]  # the bracket captured when this item started
        items.append(parse_body(content.strip(), blocks))
        terms.append(term[1:-1] if term else None)
    return {"kind": "list", "env": env, "items": items, "terms": terms}


HEADING_RE = re.compile(r"\\(subsubsection|subsection|paragraph)\*?\{")


def parse_flow(text, blocks):
    nodes = []
    buf = []

    def flush():
        chunk = "\n".join(buf).strip()
        buf.clear()
        if chunk:
            for para in re.split(r"\n\s*\n", chunk):
                para = para.strip()
                if para:
                    nodes.append({"kind": "para", "text": para})

    for line in text.split("\n"):
        stripped = line.strip()
        m = re.match(r"@@BLK(\d+)@@$", stripped)
        if m:
            flush()
            nodes.append({"kind": "block", "id": int(m.group(1))})
            continue
        h = HEADING_RE.match(stripped)
        if h:
            flush()
            title, after = find_braced(stripped, stripped.index("{", h.start()))
            node = {"kind": h.group(1), "title": title, "label": None}
            rest = stripped[after:].strip()
            lm = re.match(r"\\label\{([^}]*)\}", rest)
            if lm:
                node["label"] = lm.group(1)
                rest = rest[lm.end():].strip()
            nodes.append(node)
            if rest:
                buf.append(rest)
            continue
        lm = re.match(r"\\label\{([^}]*)\}$", stripped)
        if lm and nodes and nodes[-1].get("kind") in ("subsection", "subsubsection", "paragraph") \
                and not buf and nodes[-1]["label"] is None:
            nodes[-1]["label"] = lm.group(1)
            continue
        if not stripped:
            flush()
            continue
        buf.append(line)
    flush()
    return nodes


# ------------------------------------------------------------------- passes

def collect_labels(doc):
    """Walk parsed chapters assigning numbers and filling doc.labels."""
    for ch in doc.chapters:
        sec_n = 0
        for sub in ch["subs"]:
            sec_n += 1
            sub["num"] = "%d.%d" % (ch["num"], sec_n)
            if sub.get("label"):
                doc.labels[sub["label"]] = {"kind": "sec", "num": sub["num"], "page": ch["page"]}
            sss = 0
            for node, blocks in iter_nodes(sub["nodes"], sub["blocks"]):
                if isinstance(node, dict) and node.get("kind") == "subsubsection":
                    sss += 1
                    node["num"] = "%s.%d" % (sub["num"], sss)
                    node.setdefault("label", None)
                    if node["label"]:
                        doc.labels[node["label"]] = {
                            "kind": "sec", "num": node["num"], "page": ch["page"]}
        # floats: numbered in document order, globally (article-class style)
        for blk in ch["all_blocks"]:
            kindmap = {"figure": "figure", "table": "table",
                       "code": "listing", "cisco": "listing"}
            counter = kindmap.get(blk["type"])
            if not counter:        # vendortabs and other unnumbered containers
                continue
            doc.counters[counter] += 1
            blk["num"] = doc.counters[counter]
            if blk.get("label"):
                doc.labels[blk["label"]] = {
                    "kind": counter, "num": str(blk["num"]), "page": ch["page"]}


def iter_nodes(nodes, blocks):
    for n in nodes:
        yield n, blocks
        if n.get("kind") == "list":
            for item in n["items"]:
                yield from iter_nodes(item, blocks)


# ----------------------------------------------------------------- rendering

CALLOUT = re.compile(r"^<p[^>]*><strong>(Warning|Note|Important|Caveat|Symptom|Cause|Fix[^<]*)</strong>")

# build-time syntax highlighting for the VS Code-style listing blocks:
# tk-c comment, tk-s string, tk-v variable/placeholder, tk-k command, tk-n number
_TK = {
    "bash": re.compile(
        r"(?P<s>\"(?:\\.|[^\"\\])*\"|'[^']*')"
        r"|(?P<v>\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[A-Z][A-Z0-9_]*>)"
        r"|(?P<c>\s#.*$|^#.*$)"
        r"|(?P<n>\b\d{1,3}(?:\.\d{1,3}){3}(?:/\d+)?\b|\b\d+\b)"),
    "cli": re.compile(
        r"(?P<s>\"(?:\\.|[^\"\\])*\"|'[^']*')"
        r"|(?P<v><[A-Z][A-Z0-9_]*>)"
        r"|(?P<n>\b\d{1,3}(?:\.\d{1,3}){3}(?:/\d+)?\b|\b\d+\b)"),
}


def _hl_line(line, kind):
    ls = line.lstrip()
    if (kind == "cli" and ls[:1] in ("!", "#")) or (kind == "bash" and ls[:1] == "#"):
        return "<span class='tk-c'>%s</span>" % html.escape(line, quote=False)
    out = []
    pos = 0
    lead = re.match(r"(\s*)([A-Za-z][\w.+-]*)", line)
    if lead:
        out.append(html.escape(lead.group(1)))
        out.append("<span class='tk-k'>%s</span>" % html.escape(lead.group(2), quote=False))
        pos = lead.end()
        if kind == "bash" and lead.group(2) == "sudo":
            nxt = re.match(r"(\s+)([\w./-]+)", line[pos:])
            if nxt:
                out.append(html.escape(nxt.group(1)))
                out.append("<span class='tk-k'>%s</span>" % html.escape(nxt.group(2), quote=False))
                pos += nxt.end()
    for m in _TK[kind].finditer(line, pos):
        out.append(html.escape(line[pos:m.start()], quote=False))
        out.append("<span class='tk-%s'>%s</span>" %
                   (m.lastgroup, html.escape(m.group(0), quote=False)))
        pos = m.end()
    out.append(html.escape(line[pos:], quote=False))
    return "".join(out)


def highlight(code, kind):
    """Per-line tokenised HTML; each line wrapped for CSS line-number counters."""
    return "".join("<span class='cl'>%s</span>" % _hl_line(l, kind)
                   for l in code.split("\n"))


def render_nodes(nodes, blocks, labels, out, src_images, out_dir, page):
    parts = []
    for n in nodes:
        k = n["kind"]
        if k == "para":
            body = inline(n["text"], labels)
            if not body:
                continue
            p = "<p>%s</p>" % body
            m = CALLOUT.match(p)
            if m:
                cls = "note" if m.group(1) in ("Note",) else \
                      "warn" if m.group(1) in ("Warning", "Important", "Caveat") else "ts"
                p = p.replace("<p>", "<p class='callout %s'>" % cls, 1)
            parts.append(p)
        elif k == "subsubsection":
            anchor = n.get("label") or ("sec-" + slug(n["title"]))
            parts.append("<h3 id='%s'><span class='secno'>%s</span> %s</h3>" %
                         (html.escape(anchor, quote=True), n.get("num", ""), inline(n["title"], labels)))
        elif k == "paragraph":
            parts.append("<h4 class='runin'>%s</h4>" % inline(n["title"], labels))
        elif k == "list":
            parts.append(render_list(n, blocks, labels, src_images, out_dir, page))
        elif k == "block":
            parts.append(render_block(blocks[n["id"]], blocks, labels, src_images, out_dir, page))
    return "\n".join(parts)


def render_list(n, blocks, labels, src_images, out_dir, page):
    if n["env"] == "description":
        out = ["<dl>"]
        for term, item in zip(n["terms"], n["items"]):
            out.append("<dt>%s</dt>" % inline(term or "", labels))
            out.append("<dd>%s</dd>" %
                       render_nodes(item, blocks, labels, None, src_images, out_dir, page))
        out.append("</dl>")
        return "\n".join(out)
    tag = "ol" if n["env"] == "enumerate" else "ul"
    out = ["<%s>" % tag]
    for item in n["items"]:
        body = render_nodes(item, blocks, labels, None, src_images, out_dir, page)
        # single naked paragraph -> unwrap for tighter lists
        if body.count("<p>") == 1 and body.startswith("<p>") and body.endswith("</p>"):
            body = body[3:-4]
        out.append("<li>%s</li>" % body)
    out.append("</%s>" % tag)
    return "\n".join(out)


def render_block(blk, blocks, labels, src_images, out_dir, page):
    t = blk["type"]
    anchor = (" id='%s'" % html.escape(blk["label"], quote=True)) if blk.get("label") else ""
    if t in ("code", "cisco"):
        kind = "cli" if t == "cisco" else "bash"
        langlabel = "network cli" if t == "cisco" else "bash"
        if blk.get("caption"):
            tab = "<span class='floatno'>Listing %d</span> %s" % (
                blk["num"], inline(blk["caption"], labels))
        else:
            tab = langlabel
        cls = "listing cisco" if t == "cisco" else "listing"
        return ("<figure class='%s'%s><div class='editor'>"
                "<div class='ed-head'><span class='dots'><i></i><i></i><i></i></span>"
                "<span class='ed-tab'>%s</span><span class='ed-lang'>%s</span>"
                "<button class='copy' type='button' title='Copy'>copy</button></div>"
                "<pre><code>%s</code></pre>"
                "</div></figure>" % (cls, anchor, tab, langlabel,
                                     highlight(blk["code"], kind)))
    if t == "vendortabs":
        bar, panels = [], []
        for i, tabd in enumerate(blk["tabs"]):
            act = " active" if i == 0 else ""
            bar.append("<button type='button' class='vt-btn%s'>%s</button>" %
                       (act, html.escape(tabd["title"])))
            tnodes = parse_body(tabd["text"], blocks)
            panels.append("<div class='vt-panel%s'>%s</div>" % (
                act, render_nodes(tnodes, blocks, labels, None, src_images, out_dir, page)))
        return ("<div class='vtabs'><div class='vt-bar' role='tablist'>%s</div>%s</div>" %
                ("".join(bar), "".join(panels)))
    if t == "figure":
        capside = ""
        if blk.get("caption"):
            capside = "<figcaption><span class='floatno'>Figure %d</span> %s</figcaption>" % (
                blk["num"], inline(blk["caption"], labels))
        img = blk.get("image") or ""
        src_path = os.path.join(os.path.dirname(src_images), img)
        if img and os.path.exists(src_path):
            dest = os.path.join(out_dir, img)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(src_path, dest)
            body = "<img src='%s' alt='%s' loading='lazy'>" % (
                html.escape(BASE + img, quote=True), html.escape(img, quote=True))
        else:
            body = ("<div class='imgpending'><code>%s</code>"
                    "<span>image to be added</span></div>" % html.escape(img))
        return "<figure class='docfig'%s>%s%s</figure>" % (anchor, body, capside)
    if t == "table":
        out = ["<figure class='tablewrap'%s>" % anchor]
        if blk.get("caption"):
            out.append("<figcaption><span class='floatno'>Table %d</span> %s</figcaption>" % (
                blk["num"], inline(blk["caption"], labels)))
        out.append("<div class='scroll'><table>")
        if blk["head"]:
            out.append("<thead>")
            for row in blk["head"]:
                out.append("<tr>%s</tr>" % "".join(
                    "<th>%s</th>" % inline(c, labels) for c in row))
            out.append("</thead>")
        out.append("<tbody>")
        for row in blk["rows"]:
            out.append("<tr>%s</tr>" % "".join(
                "<td>%s</td>" % inline(c, labels) for c in row))
        out.append("</tbody></table></div></figure>")
        return "\n".join(out)
    return ""


def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")


# --------------------------------------------------------------------- main

def parse_main(src):
    text = strip_comments(read(os.path.join(src, "main.tex")))
    title = re.search(r"\\title\{", text)
    tval, _ = find_braced(text, text.index("{", title.start()))
    tparts = [p.strip() for p in re.split(r"\\\\", tval)]
    version = re.search(r"\\version\{([^}]*)\}", text)
    author = re.search(r"\\author\{", text)
    aval, _ = find_braced(text, text.index("{", author.start()))
    aparts = [p.strip() for p in re.split(r"\\\\", aval)]
    inputs = re.findall(r"\\input\{(chapters/[^}]*)\}", text)
    return {
        "title": tparts[0],
        "subtitle": tparts[1] if len(tparts) > 1 else "",
        "version": version.group(1) if version else "",
        "author": " · ".join(aparts),
        "inputs": inputs,
    }


def parse_chapter(src, path, num, doc):
    text = read(os.path.join(src, path if path.endswith(".tex") else path + ".tex"))
    text = strip_comments(text)
    sec = re.search(r"\\section\{", text)
    title, after = find_braced(text, text.index("{", sec.start()))
    body = text[after:]
    slug_name = os.path.basename(os.path.dirname(path)) or slug(title)
    # clean URL: chapters/002_architecture/... -> /docs/architecture/
    subdir = re.sub(r"^\d+_", "", slug_name).replace("_", "-")
    page = BASE + subdir + "/"

    subs = []
    intro_src = body
    sub_inputs = re.findall(r"\\input\{(chapters/[^}]*)\}", body)
    intro_src = re.sub(r"\\input\{[^}]*\}", "", intro_src)

    intro_blocks = []
    pre, intro_blocks = preprocess(intro_src, intro_blocks)
    intro_nodes = parse_body(pre, intro_blocks)

    all_blocks = list(intro_blocks)
    for spath in sub_inputs:
        f = os.path.join(src, spath if spath.endswith(".tex") else spath + ".tex")
        try:
            stext = read(f)
        except OSError:
            warn("missing input %s" % spath)
            continue
        stext = re.sub(r"\\newpage\s*$", "", stext.strip())
        m = re.search(r"\\subsection\{", stext)
        stitle, safter = find_braced(stext, stext.index("{", m.start()))
        srest = stext[safter:]
        lm = re.match(r"\s*\\label\{([^}]*)\}", srest)
        slabel = lm.group(1) if lm else None
        if lm:
            srest = srest[lm.end():]
        sblocks = []
        try:
            pre, sblocks = preprocess(srest, sblocks)
            snodes = parse_body(pre, sblocks)
        except Exception as exc:  # degrade gracefully, never break the site
            warn("FAILED to parse %s: %s" % (spath, exc))
            snodes = [{"kind": "block", "id": 0}]
            sblocks = [{"type": "code", "caption": "unparsed source of " + spath,
                        "label": None, "code": srest}]
        subs.append({"title": stitle, "label": slabel,
                     "nodes": snodes, "blocks": sblocks})
        all_blocks += sblocks

    doc.chapters.append({
        "num": num, "title": title, "slug": slug_name, "page": page, "dir": subdir,
        "intro_nodes": intro_nodes, "intro_blocks": intro_blocks,
        "subs": subs, "all_blocks": all_blocks,
    })


# site root as served by nginx (both direct :8090 and behind the TLS proxy);
# absolute URLs keep every page depth-independent
BASE = "/docs/"

# client-side login gate (see DOCS_REQUIRE_LOGIN): reads the same Supabase
# session the SPA stores under localStorage `soteria-auth`. This is a UX-level
# gate, not hard security - the docs contain no secrets by design.
GATE_JS = ("(function(){try{var s=JSON.parse(localStorage.getItem('soteria-auth')||'null');"
           "if(!s||!s.user){location.replace('/login');}}"
           "catch(e){location.replace('/login');}})();")

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script>(function(){{var t=localStorage.getItem('soteria-theme');document.documentElement.classList.add(t==='light'?'light':'dark');}})();{gate}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{base}style.css?v={cssv}">
<link rel="icon" href="{base}pathfinder-badge.png">
</head>
<body>
<header class="top">
  <button id="navtoggle" aria-label="Menu">&#9776;</button>
  <a class="brand" href="{base}"><img src="{base}pathfinder-badge.png" alt="Pathfinder Insights"> <span class="brand-name">Soteria TACACS+</span> <span class="chip">Docs</span></a>
  <div class="search"><input id="q" type="search" placeholder="Search the manual&hellip;" autocomplete="off">
    <div id="results" hidden></div></div>
  <div class="topctl">
    <button id="themebtn" type="button" title="Toggle theme" aria-label="Toggle theme">
      <svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <span id="session"></span>
    <a class="appbtn" href="/">Open App</a>
  </div>
</header>
<div class="shell">
<nav id="sidebar">{sidebar}</nav>
<main>
{body}
<footer class="pager">{pager}</footer>
<footer class="site-footer">
  <span>Soteria TACACS+ Management &middot; &copy; {year} Pathfinder Insights</span>
  <nav>
    <a href="{base}">Docs</a>
    <a href="/api-docs">API</a>
    <a href="https://github.com/MotoMotoFan/soteria-tacacs" target="_blank" rel="noreferrer">GitHub</a>
    <a href="https://github.com/MotoMotoFan/soteria-tacacs/issues" target="_blank" rel="noreferrer">Issues</a>
  </nav>
</footer>
</main>
</div>
<script src="{base}app.js?v={jsv}" defer></script>
</body>
</html>
"""


def sidebar_html(doc, current):
    out = ["<p class='navhead'><a href='%s'>Contents</a></p><ul class='chapters'>" % BASE]
    for ch in doc.chapters:
        cls = " class='current'" if ch["page"] == current else ""
        out.append("<li%s><a href='%s'><span class='secno'>%d</span> %s</a>" %
                   (cls, ch["page"], ch["num"], html.escape(plain_text(inline(ch["title"], doc.labels)))))
        if ch["page"] == current:
            out.append("<ul>")
            for sub in ch["subs"]:
                anchor = sub.get("label") or ("sec-" + slug(sub["title"]))
                out.append("<li><a href='%s#%s'><span class='secno'>%s</span> %s</a></li>" % (
                    ch["page"], html.escape(anchor, quote=True), sub["num"],
                    html.escape(plain_text(inline(sub["title"], doc.labels)))))
            out.append("</ul>")
        out.append("</li>")
    out.append("</ul>")
    return "".join(out)


def build(src, out):
    t0 = time.time()
    WARN.clear()
    meta = parse_main(src)
    doc = Doc()
    for i, path in enumerate(meta["inputs"], 1):
        parse_chapter(src, path, i, doc)
    collect_labels(doc)

    os.makedirs(out, exist_ok=True)
    os.makedirs(os.path.join(out, "images"), exist_ok=True)
    # drop pages from earlier layouts (flat NNN_slug.html files at the root)
    for stale in os.listdir(out):
        if stale.endswith(".html") and stale != "index.html":
            os.remove(os.path.join(out, stale))

    # brand art (Pathfinder Insights, same assets as the Soteria web UI) ships
    # with the generator and is copied to the site root by the assets loop
    assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
    for a in os.listdir(assets):
        shutil.copy2(os.path.join(assets, a), os.path.join(out, a))

    # content-hash version tags so browsers drop cached css/js on every change
    def fhash(name):
        with open(os.path.join(assets, name), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:8]
    cssv, jsv = fhash("style.css"), fhash("app.js")
    gate = GATE_JS if os.environ.get("DOCS_REQUIRE_LOGIN", "").lower() in ("1", "true", "yes") else ""
    year = time.strftime("%Y")

    search = []
    src_images_marker = os.path.join(src, "images", "x")  # dirname -> src/images

    for idx, ch in enumerate(doc.chapters):
        body = ["<article>"]
        body.append("<h1 id='top'><span class='secno'>%d</span> %s</h1>" %
                    (ch["num"], inline(ch["title"], doc.labels)))
        body.append(render_nodes(ch["intro_nodes"], ch["intro_blocks"], doc.labels,
                                 None, src_images_marker, out, ch["page"]))
        for sub in ch["subs"]:
            anchor = sub.get("label") or ("sec-" + slug(sub["title"]))
            body.append("<h2 id='%s'><span class='secno'>%s</span> %s</h2>" %
                        (html.escape(anchor, quote=True), sub["num"],
                         inline(sub["title"], doc.labels)))
            rendered = render_nodes(sub["nodes"], sub["blocks"], doc.labels,
                                    None, src_images_marker, out, ch["page"])
            body.append(rendered)
            search.append({
                "t": "%s %s" % (sub["num"], plain_text(inline(sub["title"], doc.labels))),
                "p": ch["page"], "a": anchor,
                "c": "%d %s" % (ch["num"], plain_text(inline(ch["title"], doc.labels))),
                "b": plain_text(rendered).lower(),
            })
        body.append("</article>")

        pager = []
        if idx > 0:
            prev = doc.chapters[idx - 1]
            pager.append("<a class='prev' href='%s'>&larr; %d. %s</a>" %
                         (prev["page"], prev["num"], html.escape(plain_text(inline(prev["title"], doc.labels)))))
        pager.append("<span></span>")
        if idx < len(doc.chapters) - 1:
            nxt = doc.chapters[idx + 1]
            pager.append("<a class='next' href='%s'>%d. %s &rarr;</a>" %
                         (nxt["page"], nxt["num"], html.escape(plain_text(inline(nxt["title"], doc.labels)))))

        page_html = PAGE.format(
            base=BASE, cssv=cssv, jsv=jsv, gate=gate, year=year,
            title="%d. %s — Soteria TACACS+ Manual" % (
                ch["num"], plain_text(inline(ch["title"], doc.labels))),
            sidebar=sidebar_html(doc, ch["page"]),
            body="\n".join(body),
            pager="".join(pager),
        )
        page_dir = os.path.join(out, ch["dir"])
        os.makedirs(page_dir, exist_ok=True)
        with open(os.path.join(page_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(page_html)

    # ---- index / cover page
    toc = ["<article class='cover'>"]
    toc.append("<img class='coverlogo' src='pathfinder-logotype.png' alt='Pathfinder Insights'>")
    toc.append("<h1>%s</h1>" % html.escape(meta["title"]))
    if meta["subtitle"]:
        toc.append("<p class='subtitle'>%s</p>" % html.escape(meta["subtitle"]))
    toc.append("<p class='meta'><span class='pill'>v%s</span><span>%s</span>"
               "<span class='gen'>updated %s</span></p>" % (
        html.escape(meta["version"]), html.escape(meta["author"]),
        time.strftime("%Y-%m-%d")))
    toc.append("<h2>Table of contents</h2><ol class='toc'>")
    for ch in doc.chapters:
        toc.append("<li><a href='%s'>%s</a><ol>" % (
            ch["page"], html.escape(plain_text(inline(ch["title"], doc.labels)))))
        for sub in ch["subs"]:
            anchor = sub.get("label") or ("sec-" + slug(sub["title"]))
            toc.append("<li><a href='%s#%s'>%s</a></li>" % (
                ch["page"], html.escape(anchor, quote=True),
                html.escape(plain_text(inline(sub["title"], doc.labels)))))
        toc.append("</ol></li>")
    toc.append("</ol></article>")
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(PAGE.format(base=BASE, cssv=cssv, jsv=jsv, gate=gate, year=year, title="Soteria TACACS+ Manual",
                            sidebar=sidebar_html(doc, BASE),
                            body="\n".join(toc), pager=""))

    with open(os.path.join(out, "search-index.json"), "w", encoding="utf-8") as f:
        json.dump(search, f, ensure_ascii=False)

    uniq = sorted(set(WARN))
    print("docs-site: %d chapters, %d sections, %d figures, %d tables, %d listings "
          "-> %s (%.1fs)" % (
              len(doc.chapters), sum(len(c["subs"]) for c in doc.chapters),
              doc.counters["figure"], doc.counters["table"], doc.counters["listing"],
              out, time.time() - t0))
    for w in uniq[:40]:
        print("  warn: %s (x%d)" % (w, WARN.count(w)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build.py SRC OUT", file=sys.stderr)
        sys.exit(2)
    sys.exit(build(sys.argv[1], sys.argv[2]))
