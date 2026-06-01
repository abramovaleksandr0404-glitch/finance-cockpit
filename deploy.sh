#!/bin/bash
# Finance Cockpit — автодеплой
# Использование: ./deploy.sh  (или перетащи в Terminal + Enter)

set -e

REPO="$HOME/finance-cockpit-repo"
REMOTE="https://github.com/abramovaleksandr0404-glitch/finance-cockpit.git"

echo "🚀 Начинаю деплой Finance Cockpit..."

# 1. Разархивировать новую версию в Downloads
cd /Users/mac/Downloads
unzip -o finance-cockpit.zip > /dev/null 2>&1
echo "✅ Архив распакован"

# 2. Создать постоянный репозиторий если его нет
if [ ! -d "$REPO/.git" ]; then
  echo "📁 Создаю постоянный репозиторий..."
  mkdir -p "$REPO"
  cd "$REPO"
  git init
  git remote add origin "$REMOTE"
  git branch -M main
fi

# 3. Копировать новые файлы в репозиторий (rsync встроен в macOS)
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  /Users/mac/Downloads/finance-cockpit/ \
  "$REPO/"

echo "✅ Файлы скопированы"

# 4. Коммит и пуш
cd "$REPO"
git add -A
git diff --cached --quiet && echo "⚠️  Нет изменений" && exit 0
git commit -m "update $(date '+%Y-%m-%d %H:%M')" --quiet
git push -u origin main --force-with-lease 2>/dev/null || git push -u origin main --force
echo "✅ Отправлено на GitHub"
echo "⏳ Vercel деплоит автоматически (~40 сек)"
echo "🌐 https://finance-cockpit-teal.vercel.app"
