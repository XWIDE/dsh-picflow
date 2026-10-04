#!/bin/sh
# dsh-picflow installer.
#
#   curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-picflow/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-picflow/main/install.sh | sh -s -- desktop
#
# The first positional argument (or $DSH_PROFILE) picks the profile; it defaults to `web`.
# dsh-picflow registers host routes at startup, so the app has to restart once afterwards.

set -eu

PROFILE="${1:-${DSH_PROFILE:-web}}"
REPO="git+https://github.com/XWIDE/dsh-picflow.git"

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh: command not found — install DeepSeek Harness first, or run 'dsh plugin --profile ${PROFILE} add ${REPO}' with the full path to dsh." >&2
  exit 1
fi

echo "Installing dsh-picflow into profile '${PROFILE}' ..."
dsh plugin --profile "${PROFILE}" add "${REPO}"

cat <<EOF

Installed. dsh-picflow registers the routes /plugins/dsh-picflow/* when the host starts,
so restart the app once:

  - DSH desktop app : restart DSH NEXT  (its title-bar restart menu also has "Reload interface",
                                        but that only reloads the browser half)
  - dsh web         : restart the dsh process, then refresh the page

Then Ctrl+V a screenshot into the composer: it is stored in the attachment library, gets its
number (图片N) and — with auto-insert on, which is the default — lands in your text at the caret.
EOF
