#!/bin/sh
# Maintainer script (M3 W5): regenerate toolchain/sandbox/rubocop/Gemfile.lock WITH per-gem
# sha256 CHECKSUMS, inside the pinned ruby sandbox base image (network). The stack image build
# installs with BUNDLE_FROZEN, so bundler verifies every gem against these checksums.
set -eu
cd "$(dirname "$0")/../toolchain/sandbox/rubocop"
REF=$(grep -A1 '^  ruby:' ../../sandbox-images.yml | awk '/ref:/ {print $2}')
RT=${RADR_CONTAINER_RUNTIME:-podman}
rm -f Gemfile.lock
"$RT" run --rm -v "$PWD:/w" -w /w -e HOME=/tmp "$REF" sh -c \
  'bundle config set --local lockfile_checksums true && bundle lock --add-platform ruby x86_64-linux aarch64-linux && rm -rf .bundle'
