#!/bin/sh
set -eu

compiler="${EMCC:-emcc}"
linker="${WASM_LD:-wasm-ld}"
PNG_BLUR_EM_CACHE="${PNG_BLUR_EM_CACHE:-/tmp/raicho-pngblur-emcache}"
export EM_CACHE="$PNG_BLUR_EM_CACHE"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

"$compiler" -O3 -ffreestanding -fno-builtin -c gaussian_blur.c \
  -o "$temporary_directory/gaussian_blur.o"
"$linker" "$temporary_directory/gaussian_blur.o" \
  --no-entry \
  --export=blur_rgba \
  --export-memory \
  --export=__heap_base \
  --initial-memory=16777216 \
  --max-memory=536870912 \
  --strip-all \
  -o gaussian_blur.wasm
