#!/bin/bash
# Удаляет дублирующийся файл .cursor/rules/aida.mdc
# Инструкции теперь только в docs/COPILOT_INSTRUCTIONS.md

rm -f "$(dirname "$0")/../.cursor/rules/aida.mdc"

if [ $? -eq 0 ]; then
  echo "✓ Файл .cursor/rules/aida.mdc удалён"
else
  echo "✗ Ошибка при удалении файла"
  exit 1
fi
