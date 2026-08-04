/* Soteria docs: sidebar toggle, copy buttons, client-side search */
(function () {
  "use strict";

  var toggle = document.getElementById("navtoggle");
  if (toggle) toggle.addEventListener("click", function () {
    document.body.classList.toggle("nav-open");
  });

  document.querySelectorAll("button.copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.closest(".editor").querySelector("pre code");
      navigator.clipboard.writeText(code.innerText).then(function () {
        btn.textContent = "copied";
        btn.classList.add("ok");
        setTimeout(function () { btn.textContent = "copy"; btn.classList.remove("ok"); }, 1400);
      });
    });
  });

  /* vendor config tabs */
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest(".vt-btn");
    if (!b) return;
    var w = b.closest(".vtabs");
    var btns = [].slice.call(w.querySelectorAll(":scope > .vt-bar > .vt-btn"));
    var panels = [].slice.call(w.querySelectorAll(":scope > .vt-panel"));
    var i = btns.indexOf(b);
    btns.forEach(function (x, j) { x.classList.toggle("active", j === i); });
    panels.forEach(function (p, j) { p.classList.toggle("active", j === i); });
  });

  /* theme toggle: same localStorage key + <html> class as the app */
  var tb = document.getElementById("themebtn");
  if (tb) tb.addEventListener("click", function () {
    var root = document.documentElement;
    var light = !root.classList.contains("light");
    root.classList.toggle("light", light);
    root.classList.toggle("dark", !light);
    localStorage.setItem("soteria-theme", light ? "light" : "dark");
  });

  /* signed-in indicator: reads the SPA's Supabase session (same origin) */
  var sess = document.getElementById("session");
  if (sess) {
    var who = null;
    try {
      var s = JSON.parse(localStorage.getItem("soteria-auth") || "null");
      if (s && s.user && s.user.email) who = s.user.email;
    } catch (e) { /* not signed in */ }
    if (who) {
      sess.innerHTML = "<span class='dot'></span>" +
        who.replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
      sess.title = "Signed in as " + who;
    } else {
      sess.innerHTML = "<a href='/login'>Sign in</a>";
    }
  }

  /* ---------------- search ---------------- */
  var q = document.getElementById("q");
  var box = document.getElementById("results");
  if (!q) return;
  var index = null, sel = -1;

  function load() {
    if (index) return Promise.resolve(index);
    return fetch("/docs/search-index.json").then(function (r) { return r.json(); })
      .then(function (d) { index = d; return d; });
  }

  function snippet(body, term) {
    var i = body.indexOf(term);
    if (i < 0) return "";
    var s = Math.max(0, i - 45), e = Math.min(body.length, i + term.length + 65);
    var frag = (s > 0 ? "…" : "") + body.slice(s, e) + (e < body.length ? "…" : "");
    return frag.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      function (m) { return "<mark>" + m + "</mark>"; });
  }

  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function run() {
    var term = q.value.trim().toLowerCase();
    sel = -1;
    if (term.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
    load().then(function (idx) {
      var hits = [];
      idx.forEach(function (e) {
        var tHit = e.t.toLowerCase().indexOf(term) >= 0;
        var bHit = e.b.indexOf(term) >= 0;
        if (tHit || bHit) hits.push({ e: e, score: tHit ? 0 : 1 });
      });
      hits.sort(function (a, b) { return a.score - b.score; });
      hits = hits.slice(0, 12);
      if (!hits.length) {
        box.innerHTML = "<div class='none'>No matches.</div>";
        box.hidden = false; return;
      }
      box.innerHTML = hits.map(function (h) {
        return "<a href='" + h.e.p + "#" + h.e.a + "'>" +
          "<span class='rt'>" + esc(h.e.t) + "</span> " +
          "<span class='rc'>" + esc(h.e.c) + "</span>" +
          "<span class='rs'>" + snippet(esc(h.e.b), esc(term)) + "</span></a>";
      }).join("");
      box.hidden = false;
    });
  }

  q.addEventListener("input", run);
  q.addEventListener("focus", function () { load(); if (box.innerHTML) box.hidden = false; });
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest(".search")) box.hidden = true;
  });
  q.addEventListener("keydown", function (ev) {
    var items = box.querySelectorAll("a");
    if (ev.key === "Escape") { box.hidden = true; q.blur(); return; }
    if (!items.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      sel = (sel + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach(function (a, i) { a.classList.toggle("sel", i === sel); });
      items[sel].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && sel >= 0) {
      ev.preventDefault();
      window.location.href = items[sel].href;
    }
  });

  /* "/" focuses search */
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && document.activeElement !== q &&
        !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      ev.preventDefault(); q.focus();
    }
  });
})();
