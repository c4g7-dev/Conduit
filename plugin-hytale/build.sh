#!/usr/bin/env bash
# Build conduit-hytale.jar — runs ON a Proxmox node (the 123MB HytaleServer.jar is on the
# shared store there and too big to pull locally). Compiles against it with javac, packages
# manifest.json at the jar root + the compiled classes. Output → the shared connector store.
set -euo pipefail
SRC="${1:-/var/lib/conduit/build/hytale}"
HYJAR=/var/lib/conduit/assets/hytale/HytaleServer.jar
OUT=/var/lib/conduit/connector/conduit-hytale.jar

# Hytale's classes are Java 25 (class file v69), so we need a JDK >= 25 to compile against
# them. Nodes lack one — fetch a Temurin 25 JDK once into /opt/conduit-jdk25.
JDKDIR=/opt/conduit-jdk25
if [ ! -x "$JDKDIR/bin/javac" ]; then
  echo "fetching Temurin JDK 25…"
  mkdir -p "$JDKDIR"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" \
    | tar xz -C "$JDKDIR" --strip-components=1
fi
JAVAC="$JDKDIR/bin/javac"; JAR="$JDKDIR/bin/jar"

rm -rf "$SRC/out"; mkdir -p "$SRC/out"
find "$SRC/src" -name '*.java' > "$SRC/sources.txt"
"$JAVAC" --release 25 -nowarn -cp "$HYJAR" -d "$SRC/out" @"$SRC/sources.txt"
cp "$SRC/manifest.json" "$SRC/out/manifest.json"
( cd "$SRC/out" && "$JAR" cf "$OUT" . )
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
