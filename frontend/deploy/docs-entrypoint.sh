#!/bin/sh
# =============================================================================
# docs-entrypoint.sh - Soteria Frontend entrypoint wrapper
# =============================================================================
# Generates the documentation site (/docs/) from the LaTeX manual mounted at
# /docs-src, keeps it fresh with a 30 s change watcher, then hands off to the
# stock nginx entrypoint (which envsubsts the conf template and runs nginx).
# When /docs-src is not mounted the frontend simply serves the SPA without
# documentation - no error, no dependency.
# =============================================================================
set -e

SRC=/docs-src
OUT=/usr/share/nginx/html/docs
STAMP=/tmp/.docs-stamp

build_docs() {
    python3 /opt/docsgen/build.py "$SRC" "$OUT" && touch "$STAMP"
}

if [ -f "$SRC/main.tex" ]; then
    build_docs || echo "docs: initial build FAILED - serving SPA without /docs"
    (
        while sleep 30; do
            CHANGED=$(find "$SRC" -type f \( -name '*.tex' -o -path '*/images/*' \) \
                      -newer "$STAMP" 2>/dev/null | head -1)
            if [ -n "$CHANGED" ]; then
                echo "docs: change detected ($CHANGED), regenerating"
                build_docs || echo "docs: regeneration failed, keeping previous site"
            fi
        done
    ) &
else
    echo "docs: /docs-src not mounted, skipping documentation build"
fi

exec /docker-entrypoint.sh nginx -g 'daemon off;'
