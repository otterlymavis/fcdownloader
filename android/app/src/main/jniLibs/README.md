# aria2c Native Binaries

This directory holds the optional aria2c binaries used by the `AndroidAria2Transport`
layer for large direct file downloads.

aria2c is **completely optional** — the app falls back to expo-file-system if the
binaries are not present. Do NOT commit binaries to git; distribute them via a
separate asset delivery mechanism (e.g. Gradle asset packs, OTA update, or
on-demand download).

## Required files

Place statically-linked aria2c binaries here:

```
arm64-v8a/libaria2c.so    ← 64-bit ARM (most modern phones)
armeabi-v7a/libaria2c.so  ← 32-bit ARM (older phones)
x86_64/libaria2c.so       ← x86_64 (emulators, some Chromebooks)
```

**Important**: Android's `NativeLibraryLoader` only loads `.so` files. The binary
must be renamed to `libaria2c.so` regardless of its original filename.

## Building aria2c

Pre-built statically-linked aria2c binaries for Android are available at:
  https://github.com/P3TERX/Aria2-Pro-Core/releases

Or build from source with the Android NDK:

```bash
# Install NDK toolchain
export ANDROID_NDK_HOME=/path/to/ndk
./configure --host=aarch64-linux-android \
            CC=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android33-clang \
            --without-libgmp --without-libuv --without-libssh2 \
            --disable-shared --enable-static
make -j$(nproc)
```

## How it's used

The `FcAria2` native module (in `java/com/fcdownloader/aria2/`) starts aria2c
with `--enable-rpc --rpc-listen-port=6800 --rpc-listen-all=false` and exposes
`addUri`, `getStatus`, `removeDownload` methods to the React Native JS layer
via the `aria2Transport.ts` bridge.

aria2c is ONLY used for large direct MP4/WebM downloads. HLS and DASH downloads
use their own dedicated assemblers (hlsDownloader.ts, dashDownloader.ts) and
are NOT affected by this binary.
