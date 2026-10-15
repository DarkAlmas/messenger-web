#!/bin/sh
# Публикация: build.js получает хэш последнего коммита с кодом (виден внизу «Настроек»)
set -e; cd "$(dirname "$0")"
G="git -c user.name=DarkAlmas -c user.email=DarkAlmas@users.noreply.github.com"
H=$(git rev-parse --short HEAD); D=$(TZ=Europe/Moscow date '+%d.%m.%Y %H:%M МСК')
printf "window.BUILD = { commit: '%s', date: '%s' };\n" "$H" "$D" > build.js
sed -i "s|build.js?v=[0-9a-z]*|build.js?v=$H|" index.html
[ -f version.json ] && python3 -m json.tool version.json >/dev/null; $G add build.js index.html $( [ -f version.json ] && echo version.json ) && $G commit -qm "build $H" && git push -q && echo "code $H, build $(git rev-parse --short HEAD)"
