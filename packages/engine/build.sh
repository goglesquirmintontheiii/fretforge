#!/usr/bin/env bash
# Builds forge-dsp for the browser (WASM + SIMD) and natively for tests.
# Needs clang 18+, wasm-ld and a wasm32-wasi sysroot with libc++
#   (Ubuntu/Debian: apt install clang lld wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32)
set -euo pipefail
cd "$(dirname "$0")"
OUT_WASM=../web/public/engine/forge-dsp.wasm
SRC="src/alloc.cpp src/api.cpp src/nam.cpp src/convolver.cpp src/rig.cpp"
INC="-Isrc -Ivendor/signalsmith-stretch -Ivendor/signalsmith-linear/include"
CXX=${CXX:-clang++}
mkdir -p build "$(dirname "$OUT_WASM")"
if [[ "${1:-}" != "native" ]]; then
  $CXX --target=wasm32-wasi --sysroot=${WASI_SYSROOT:-/usr} -std=c++20 -O3 -msimd128 -fno-math-errno \
    -fno-exceptions -fno-rtti -DNDEBUG $INC -nostartfiles \
    -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=8388608 \
    -o "$OUT_WASM" $SRC
  echo "wrote $OUT_WASM ($(stat -c %s "$OUT_WASM") bytes)"
fi
$CXX -std=c++20 -O3 -fno-exceptions -fPIC -DNDEBUG $INC -o build/forge-test test/forge-test.cpp $SRC -lm
echo "wrote build/forge-test"
