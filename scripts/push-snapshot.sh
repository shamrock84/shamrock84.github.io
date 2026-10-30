#!/usr/bin/env bash
# Commits data/rosters.json and pushes it to main, surviving main having moved
# while the sync ran.
#
# Why this exists: the sync runs a minute or two, and anything merged to main in
# that window (a PR, an Admin-tab save of config/leagues.json) made the plain
# `git push` fail with "fetch first". The run went red and that sync's data was
# thrown away. Seen once, when a PR merged mid-sync.
#
# Why not `git pull --rebase`: the checkout is shallow (fetch-depth 1), so the
# local history is one commit with no common ancestor with the new tip, and a
# rebase would try to replay that root commit as a full-tree diff. This
# snapshot is the only file the sync commits, and writes to it are already
# serialized by the rosters-data-write concurrency group, so the safe move on a
# rejected push is to take the new tip as it is and put this run's file back on
# top of it.
#
# Expects git user.name/user.email to be configured by the caller. Pinned by
# scripts/test-push-snapshot.mjs, which builds real shallow clones and races them.

set -euo pipefail

FILE="${SNAPSHOT_FILE:-data/rosters.json}"
BRANCH="${SNAPSHOT_BRANCH:-main}"
ATTEMPTS="${SNAPSHOT_PUSH_ATTEMPTS:-3}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

git add "$FILE"
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi
git commit -q -m "Update MFL rosters data"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if [ "$attempt" -gt 1 ]; then
    echo "Push rejected (origin/$BRANCH moved during the run) — re-applying $FILE onto the new tip, attempt $attempt of $ATTEMPTS"
    cp "$FILE" "$SCRATCH/snapshot"
    git fetch --no-tags --depth=1 origin "$BRANCH"
    git reset -q --hard "origin/$BRANCH"
    cp "$SCRATCH/snapshot" "$FILE"
    git add "$FILE"
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

echo "::error::Could not push $FILE to $BRANCH after $ATTEMPTS attempts"
exit 1
