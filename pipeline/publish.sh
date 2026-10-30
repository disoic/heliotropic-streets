#!/usr/bin/env bash
# Publishes out/ (the app plus the preloaded squares) as a single commit on the `site` branch,
# which GitHub Pages serves. Files that didn't change are not uploaded again.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out
cp app/index.html out/index.html
touch out/.nojekyll
if [ -f CNAME ]; then cp CNAME out/CNAME; fi
REMOTE="${PUBLISH_REMOTE:-https://x-access-token:${GITHUB_TOKEN:-}@github.com/${GITHUB_REPOSITORY:-}.git}"
cd out
rm -rf .git
git init -q
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git remote add origin "$REMOTE"
git fetch -q --depth 1 origin site 2>/dev/null || true
git checkout -q --orphan site
git add -A
git commit -qm "Site $(date -u +%Y-%m-%d)"
git push -q -f origin site
echo "Published $(git ls-files | wc -l) files to the site branch."
