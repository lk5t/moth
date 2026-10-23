#!/usr/bin/env bash
# Runs a CI command; on failure, publishes the last lines of its output as a GitHub annotation
# (so errors are visible even where raw logs are not accessible).
title="$1"; shift
log="$(mktemp)"
set -o pipefail
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  msg=$(grep -vE '^\s*$' "$log" | tail -n 70 | sed -e 's/%/%25/g' -e 's/\r//g' | awk 'BEGIN{ORS="%0A"}{print}')
  echo "::error title=${title}::${msg}"
  grep -E 'error(\[E[0-9]+\])?:|error TS|Error:' "$log" | head -n 9 | while IFS= read -r line; do echo "::error title=${title} (match)::${line//%/%25}"; done
fi
exit "$code"
