#!/usr/bin/env bash
# Build conduit-connector.jar (combined Paper + Velocity) without Gradle — just javac + jar.
# Downloads the handful of compile-only API jars into ./lib, compiles all sources against
# them, and packages classes + resources (plugin.yml + velocity-plugin.json) into one jar.
# Gson/Guice/Adventure are provided by the platforms at runtime (not shaded).
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://repo.papermc.io/repository/maven-public"
MAVEN="https://repo1.maven.org/maven2"
PAPER_VER="1.20.4-R0.1-20241030.192207-176"
VELO_VER="3.4.0"

mkdir -p lib out
fetch() { # url dest
  [ -f "lib/$2" ] && return 0
  echo "  fetch $2"; curl -fsSL -o "lib/$2" "$1"
}

echo "==> downloading compile deps"
fetch "$REPO/io/papermc/paper/paper-api/1.20.4-R0.1-SNAPSHOT/paper-api-$PAPER_VER.jar" paper-api.jar
fetch "$REPO/com/velocitypowered/velocity-api/$VELO_VER/velocity-api-$VELO_VER.jar" velocity-api.jar
fetch "$MAVEN/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar" gson.jar
fetch "$MAVEN/com/google/inject/guice/5.1.0/guice-5.1.0.jar" guice.jar
fetch "$MAVEN/net/kyori/adventure-api/4.14.0/adventure-api-4.14.0.jar" adventure-api.jar
fetch "$MAVEN/net/kyori/adventure-key/4.14.0/adventure-key-4.14.0.jar" adventure-key.jar
fetch "$MAVEN/net/kyori/examination-api/1.3.0/examination-api-1.3.0.jar" examination-api.jar
fetch "$MAVEN/com/google/guava/guava/32.1.3-jre/guava-32.1.3-jre.jar" guava.jar
fetch "$MAVEN/net/kyori/adventure-text-serializer-legacy/4.14.0/adventure-text-serializer-legacy-4.14.0.jar" adventure-legacy.jar
fetch "$MAVEN/org/jetbrains/annotations/24.0.1/annotations-24.0.1.jar" jb-annotations.jar
fetch "https://libraries.minecraft.net/com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar" brigadier.jar

CP=$(printf "lib/%s:" paper-api.jar velocity-api.jar gson.jar guice.jar adventure-api.jar adventure-key.jar examination-api.jar guava.jar adventure-legacy.jar jb-annotations.jar brigadier.jar)

echo "==> compiling"
rm -rf out; mkdir -p out
find src/main/java -name '*.java' > out/sources.txt
# Target Java 17 bytecode — Paper 1.20.4 / Velocity run on JRE 17 (class file v61).
# velocity-api bundles the @Plugin annotation processor, which emits velocity-plugin.json
# into the output dir (proper main + auto event registration). -proc:full keeps AP on
# (JDK 23+ disables implicit AP by default).
javac --release 17 -proc:full -nowarn -Xlint:none -cp "$CP" -s out -d out @out/sources.txt

echo "==> packaging"
cp -r src/main/resources/* out/ 2>/dev/null || true
( cd out && jar cf ../conduit-connector.jar . )
echo "==> built $(pwd)/conduit-connector.jar ($(du -h conduit-connector.jar | cut -f1))"
