#!/usr/bin/env bash
# Starts or stops an Extension Development Host with this extension, a throwaway profile and a CDP
# port, so drive.mjs can control it.
#   launch.sh start [file.pdf]   build, launch, open the PDF (default: a generated test PDF)
#   launch.sh stop               quit that VS Code instance
set -euo pipefail
cd "$(dirname "$0")/../../.."                      # the repository root
SKILL=.claude/skills/run-vscode-pdf-viewer
DIR=${PDFV_DIR:-/tmp/pdfv}                        # short on purpose: see Gotchas in SKILL.md
PORT=${PDFV_PORT:-9333}
CODE_BIN=${CODE_BIN:-"/Applications/Visual Studio Code.app/Contents/MacOS/Code"}
CODE_CLI=${CODE_CLI:-"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"}

stop() {
  # -9: a window with unsaved editors would otherwise wait on a "save changes?" prompt.
  pkill -9 -f -- "--user-data-dir=$DIR/u" || true
}

case "${1:-}" in
  stop) stop; echo "stopped"; exit 0 ;;
  start) ;;
  *) echo "usage: $0 start [file.pdf] | stop" >&2; exit 2 ;;
esac

stop
npm run build --silent
# A fresh profile each time: VS Code would otherwise restore the last run's tabs.
rm -rf "$DIR/u"
mkdir -p "$DIR/u/User" "$DIR/ext" "$DIR/ws" "$DIR/shots"
cat > "$DIR/u/User/settings.json" <<'JSON'
{
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false,
  "window.restoreWindows": "none",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "chat.disableAIFeatures": true
}
JSON

PDF=${2:-}
if [ -z "$PDF" ]; then
  PDF="$DIR/ws/paper.pdf"
  node "$SKILL/disk.mjs" fixture "$PDF"
fi
PDF=$(cd "$(dirname "$PDF")" && pwd)/$(basename "$PDF")

# Run from inside VS Code (e.g. Claude Code's extension), the shell inherits ELECTRON_RUN_AS_NODE
# and VSCODE_* variables, which make Code start as plain Node or hand off to the outer instance.
UNSET=()
for v in $(env | grep -oE '^(ELECTRON_RUN_AS_NODE|VSCODE_[A-Z_]+)=' | tr -d =); do UNSET+=(-u "$v"); done

nohup env "${UNSET[@]}" "$CODE_BIN" \
  --user-data-dir="$DIR/u" --extensions-dir="$DIR/ext" \
  --extensionDevelopmentPath="$PWD" --enable-proposed-api anton.vscode-pdf-viewer \
  --disable-workspace-trust --skip-welcome --skip-release-notes \
  --remote-debugging-port="$PORT" --new-window "$(dirname "$PDF")" \
  > "$DIR/code.log" 2>&1 &

# Open the PDF only once the window is up. Passed at launch, it can open before the extension's
# editor is registered, and then shows as plain text.
for _ in $(seq 1 60); do
  node "$SKILL/drive.mjs" wb-eval "return !!document.querySelector('.monaco-workbench .part.editor')" 2>/dev/null | grep -q true && break
  sleep 1
done
sleep 3
env "${UNSET[@]}" "$CODE_CLI" --user-data-dir="$DIR/u" --reuse-window "$PDF" >> "$DIR/code.log" 2>&1

# Ready when the viewer's webview exists and has loaded the PDF.
for _ in $(seq 1 60); do
  if node "$SKILL/drive.mjs" ready >/dev/null 2>&1; then
    echo "ready: $PDF (CDP port $PORT, log $DIR/code.log)"
    exit 0
  fi
  sleep 1
done
echo "timed out; see $DIR/code.log" >&2
exit 1
