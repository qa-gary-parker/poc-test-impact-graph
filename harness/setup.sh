#!/usr/bin/env bash
# Clone hono at the measured commit, install it, and build the code-review-graph index.
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=a8ae5b1d6e8502ce61cd9e7b853d8107e377fc7b
mkdir -p work
if [ ! -d work/hono ]; then
  git clone -q --depth 300 https://github.com/honojs/hono.git work/hono
fi
cd work/hono
git checkout -q "$SHA"
npx -y pnpm@12.6.0 install --frozen-lockfile
uvx --python 3.12 code-review-graph@2.4.0 build
