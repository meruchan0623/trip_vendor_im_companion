#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -framework AppKit -framework ApplicationServices WindowHelper.swift -o bin/TravelMerchant.WindowHelper
printf 'Built macOS helper; real-client AX/window/permission acceptance remains required.\n'
