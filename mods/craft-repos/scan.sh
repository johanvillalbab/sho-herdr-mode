#!/bin/sh
# Every git clone under the usual folders, as "<origin url>\t<folder>".
cd "$HOME" || exit 0
for d in Desktop Developer Documents Projects code; do
  [ -d "$d" ] && /usr/bin/find "$d" -maxdepth 4 -type d -name .git -not -path '*/node_modules/*' -prune 2>/dev/null
done | while IFS= read -r g; do
  r="$HOME/${g%/.git}"
  u=$(/usr/bin/git -C "$r" config --get remote.origin.url 2>/dev/null) && printf '%s\t%s\n' "$u" "$r"
done
exit 0
