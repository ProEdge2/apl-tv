#!/usr/bin/env bash
# APL TV's Simkl sync, end to end in the PC preview (README.md): the stand-in for api.simkl.com and the test playlist
# on :8090, the app on :8080, then the Playwright checks. Needs node, python3 and Playwright (npm install playwright).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
node "$here/mock-simkl.js" > /dev/null 2>&1 & mock=$!
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$root/app" > /dev/null 2>&1 & web=$!
trap 'kill $mock $web 2> /dev/null || true' EXIT
sleep 1.5
node "$here/run.js"
