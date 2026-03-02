---
description: Обновление build-номера и коммит изменений в AIDA
---

# Bump Build & Commit

// turbo-all

1. Инкремент build-номера:
```bash
bash /Users/MyFolders/aida/scripts/bump-build.sh
```

2. Обновить `_build` в харвестерах (grep и заменить на новый номер из manifest.json):
```bash
VERSION=$(grep '"version"' /Users/MyFolders/aida/manifest.json | sed 's/.*"\([0-9.]*\)".*/\1/')
sed -i '' "s/var _build = '[0-9.]*'/var _build = '${VERSION}'/" /Users/MyFolders/aida/harvesters/harvester-truckerpath.js
sed -i '' "s/var _build = '[0-9.]*'/var _build = '${VERSION}'/" /Users/MyFolders/aida/harvesters/harvester-dat.js 2>/dev/null || true
sed -i '' "s/var _build = '[0-9.]*'/var _build = '${VERSION}'/" /Users/MyFolders/aida/harvesters/harvester-truckstop.js 2>/dev/null || true
echo "Harvesters updated to build ${VERSION}"
```

3. Git add + commit (сообщение подставить вручную):
```bash
cd /Users/MyFolders/aida && git add -A
```
