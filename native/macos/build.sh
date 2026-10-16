#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
# Command Line Tools ship arm64-only back-deploy shims; the helper uses no Swift concurrency, so neither slice needs them.
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -runtime-compatibility-version none -framework AppKit -framework ApplicationServices WindowHelper.swift -o "bin/TravelMerchant.WindowHelper-$arch"
done
lipo -create bin/TravelMerchant.WindowHelper-arm64 bin/TravelMerchant.WindowHelper-x86_64 -output bin/TravelMerchant.WindowHelper
rm -f bin/TravelMerchant.WindowHelper-arm64 bin/TravelMerchant.WindowHelper-x86_64
codesign --force -s - --identifier TravelMerchant.WindowHelper bin/TravelMerchant.WindowHelper
printf 'Built universal (arm64+x86_64) ad-hoc signed macOS helper: %s\n' "$PWD/bin/TravelMerchant.WindowHelper"
