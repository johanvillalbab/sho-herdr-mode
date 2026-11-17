#!/usr/bin/env bash
# Installs the sho-herdr-mode layout into your Herdr app home, without overwriting anything of yours.
#
#   ./install.sh                 install; if something of yours would be overwritten, stop and list it
#   ./install.sh --replace       move those files to a backup folder first, then install
#   ./install.sh --plan-estado   also install tools/plan-estado into ~/.local/bin (for the Plans panel)
#   ./install.sh --dry-run       only print what it would do
#
# HERDR_APP_HOME picks another Herdr home (default ~/.config/herdr-app).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
BIN="$HOME/.local/bin"
REPLACE=0 PLAN=0 DRY=0
for a in "$@"; do
  case "$a" in
    --replace) REPLACE=1 ;;
    --plan-estado) PLAN=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
[ -d "$DEST" ] || { say "There is no Herdr app home at $DEST. Open Herdr once (or set HERDR_APP_HOME), then run this again."; exit 1; }
command -v python3 >/dev/null 2>&1 || { say "python3 is needed (to merge keys.json)."; exit 1; }

MODS="craft-tabs craft-spaces craft-repos craft-local craft-issues craft-notes craft-plans git-graph tab-guard pane-guard"
ITEMS="layouts/main-craft.json layouts/main-craft.png themes/craft-light.json themes/craft-dark.json"
for m in $MODS; do ITEMS="$ITEMS mods/$m"; done

# Identical to this repo's copy, ignoring the files Herdr writes and your own config.json.
same() { diff -rq -x gpui-kit.d.ts -x jsconfig.json -x config.json -x .DS_Store "$SRC/$1" "$2" >/dev/null 2>&1; }

NEW="" SKIP="" CLASH=""
for it in $ITEMS; do
  if [ ! -e "$DEST/$it" ]; then NEW="$NEW $it"
  elif same "$it" "$DEST/$it"; then SKIP="$SKIP $it"
  else CLASH="$CLASH $it"; fi
done
TOOL=""
if [ $PLAN -eq 1 ]; then
  if [ ! -e "$BIN/plan-estado" ]; then TOOL=new
  elif same tools/plan-estado "$BIN/plan-estado"; then TOOL=same
  else TOOL=clash; fi
fi

# keys.json: add this layout's keys. Herdr's own cmd-w / cmd-shift-w (tab.close, pane.close) are
# replaced by the close confirmations; any other key you already use is a clash.
KEYS_PLAN="$(python3 - "$SRC/keys.json" "$DEST/keys.json" "$REPLACE" <<'PY'
import json, sys
ours_path, theirs_path, replace = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
DEFAULTS = {("global", "cmd-w"): "tab.close", ("global", "cmd-shift-w"): "pane.close"}
try:
    theirs = json.load(open(theirs_path, encoding="utf-8"))
except FileNotFoundError:
    print("missing"); sys.exit(0)
ours = json.load(open(ours_path, encoding="utf-8"))
for section, keys in ours.items():
    for key, action in keys.items():
        old = theirs.get(section, {}).get(key)
        if old is None: print("add\t%s\t%s\t%s" % (section, key, json.dumps(action)))
        elif old == action: print("same\t%s\t%s\t" % (section, key))
        elif DEFAULTS.get((section, key)) == old: print("default\t%s\t%s\t%s" % (section, key, json.dumps(old)))
        else: print("clash\t%s\t%s\t%s" % (section, key, json.dumps(old)))
PY
)"
KEY_CLASH="$(printf '%s\n' "$KEYS_PLAN" | grep '^clash' || true)"

say "Herdr home: $DEST"
for it in $NEW; do say "  add      $it"; done
for it in $SKIP; do say "  same     $it"; done
for it in $CLASH; do say "  CLASH    $it"; done
case "$TOOL" in new) say "  add      $BIN/plan-estado" ;; same) say "  same     $BIN/plan-estado" ;; clash) say "  CLASH    $BIN/plan-estado" ;; esac
if [ "$KEYS_PLAN" = missing ]; then
  say "  keys.json not found: open Herdr once so it writes it, then run this again for the keys."
else
  printf '%s\n' "$KEYS_PLAN" | while IFS="$(printf '\t')" read -r what section key old; do
    case "$what" in
      add) say "  add key  $section  $key" ;;
      default) say "  set key  $section  $key  (was Herdr's $old)" ;;
      clash) say "  CLASH    key $section  $key  (yours: $old)" ;;
    esac
  done
fi

if [ $REPLACE -eq 0 ] && { [ -n "$CLASH" ] || [ "$TOOL" = clash ] || [ -n "$KEY_CLASH" ]; }; then
  say ""
  say "Nothing was changed: the CLASH lines above are yours and differ from this repo."
  say "Run again with --replace to move them to a backup folder first."
  exit 1
fi
[ $DRY -eq 1 ] && { say ""; say "Dry run: nothing was changed."; exit 0; }

BACKUP="$DEST/backup-sho-herdr-mode-$(date +%Y%m%d-%H%M%S)"
backup() { mkdir -p "$BACKUP/$(dirname "$1")"; mv "$2" "$BACKUP/$1"; }

for it in $CLASH; do backup "$it" "$DEST/$it"; done
for it in $NEW $CLASH; do
  mkdir -p "$DEST/$(dirname "$it")"
  cp -R "$SRC/$it" "$DEST/$it"
  # A replaced mod keeps your settings.
  if [ -f "$BACKUP/$it/config.json" ]; then cp "$BACKUP/$it/config.json" "$DEST/$it/config.json"; fi
done

if [ "$TOOL" = clash ]; then backup tools/plan-estado "$BIN/plan-estado"; fi
if [ "$TOOL" = new ] || [ "$TOOL" = clash ]; then
  mkdir -p "$BIN"; cp "$SRC/tools/plan-estado" "$BIN/plan-estado"; chmod +x "$BIN/plan-estado"
fi

if [ "$KEYS_PLAN" != missing ] && printf '%s\n' "$KEYS_PLAN" | grep -qv '^same'; then
  mkdir -p "$BACKUP"; cp "$DEST/keys.json" "$BACKUP/keys.json"
  python3 - "$SRC/keys.json" "$DEST/keys.json" <<'PY'
import json, os, sys, tempfile
ours_path, theirs_path = sys.argv[1], sys.argv[2]
theirs = json.load(open(theirs_path, encoding="utf-8"))
for section, keys in json.load(open(ours_path, encoding="utf-8")).items():
    theirs.setdefault(section, {}).update(keys)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(theirs_path), prefix=".keys-", suffix=".json")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(theirs, f, indent=2, ensure_ascii=False); f.write("\n")
os.replace(tmp, theirs_path)
PY
fi

say ""
[ -d "$BACKUP" ] && say "Your previous files are in $BACKUP"
if command -v herdr-app >/dev/null 2>&1; then
  failed=0
  for m in $MODS; do herdr-app check "$DEST/mods/$m" >/dev/null 2>&1 || { say "herdr-app check failed for mods/$m: run it to see why."; failed=1; }; done
  [ $failed -eq 0 ] && say "Every mod passed herdr-app check."
  if [ -z "${HERDR_APP_HOME:-}" ] && herdr-app status >/dev/null 2>&1; then
    herdr-app do layout.switch --name main-craft >/dev/null 2>&1 && say "Switched Herdr to the main-craft layout (layout.switch goes back)."
  fi
fi
say ""
say "Installed. Optional panels have their settings in config.example.json: copy it to config.json in"
say "  $DEST/mods/craft-local   the CI row (a Lima VM running a GitHub Actions runner)"
say "  $DEST/mods/craft-repos   where new clones go"
say "  $DEST/mods/craft-plans   the plans folder, a second machine, the GitHub repo"
