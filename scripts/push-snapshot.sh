#!/usr/bin/env bash
# Commits the sync's data files and pushes them to main, surviving main having
# moved while the sync ran.
#
# Why this exists: the sync runs a minute or two, and anything merged to main in
# that window (a PR, an Admin-tab save of config/leagues.json) made the plain
# `git push` fail with "fetch first". The run went red and that sync's data was
# thrown away. Seen once, when a PR merged mid-sync.
#
# Why not `git pull --rebase`: the checkout is shallow (fetch-depth 1), so the
# local history is one commit with no common ancestor with the new tip, and a
# rebase would try to replay that root commit as a full-tree diff. These files
# are the only ones the sync commits, and writes to them are already serialized
# by the rosters-data-write concurrency group, so the safe move on a rejected
# push is to take the new tip as it is and put this run's files back on top.
#
# The files are the page's snapshot and the sync's own league-meta cache
# (scripts/lib/league-meta.mjs). A listed file that does not exist is skipped,
# which is the normal case for the cache on the very first run and for the
# workflows that only write the snapshot.
#
# Expects git user.name/user.email to be configured by the caller. Pinned by
# scripts/test-push-snapshot.mjs, which builds real shallow clones and races them.

set -euo pipefail

FILES="${SNAPSHOT_FILES:-data/rosters.json data/mfl-league-meta.json}"
BRANCH="${SNAPSHOT_BRANCH:-main}"
ATTEMPTS="${SNAPSHOT_PUSH_ATTEMPTS:-3}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

stage() {
  for f in $FILES; do
    if [ -e "$f" ]; then git add "$f"; fi
  done
}

stage
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi
git commit -q -m "Update MFL rosters data"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if [ "$attempt" -gt 1 ]; then
    echo "Push rejected (origin/$BRANCH moved during the run) — re-applying $FILES onto the new tip, attempt $attempt of $ATTEMPTS"
    for f in $FILES; do
      if [ -e "$f" ]; then
        mkdir -p "$SCRATCH/$(dirname "$f")"
        cp "$f" "$SCRATCH/$f"
      fi
    done
    git fetch --no-tags --depth=1 origin "$BRANCH"
    git reset -q --hard "origin/$BRANCH"
    for f in $FILES; do
      if [ -e "$SCRATCH/$f" ]; then
        mkdir -p "$(dirname "$f")"
        cp "$SCRATCH/$f" "$f"
      fi
    done
    stage
    if git diff --cached --quiet; then
      echo "The new tip already carries this snapshot; nothing to push."
      exit 0
    fi
    git commit -q -m "Update MFL rosters data"
  fi
  if git push origin "HEAD:$BRANCH"; then
    exit 0
  fi
done

echo "::error::Could not push $FILES to $BRANCH after $ATTEMPTS attempts"
exit 1
