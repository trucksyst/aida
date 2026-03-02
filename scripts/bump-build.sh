#!/bin/bash
# Автоинкремент build-номера в manifest.json
# Формат версии: 0.1.BUILD (например 0.1.42)
# Использование: bash scripts/bump-build.sh

MANIFEST="$(dirname "$0")/../manifest.json"

# Текущая версия
CURRENT=$(grep '"version"' "$MANIFEST" | sed 's/.*"\([0-9.]*\)".*/\1/')
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
BUILD=$(echo "$CURRENT" | cut -d. -f3)

# Инкремент
NEW_BUILD=$((BUILD + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_BUILD}"

# Замена в manifest.json
sed -i '' "s/\"version\": \"${CURRENT}\"/\"version\": \"${NEW_VERSION}\"/" "$MANIFEST"

echo "Build: ${CURRENT} → ${NEW_VERSION}"
