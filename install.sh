#!/bin/sh
# dsh-draft-keeper installer.
#
#   curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-draft-keeper/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-draft-keeper/main/install.sh | sh -s -- desktop
#
# The first positional argument (or $DSH_PROFILE) picks the profile; it defaults to `web`.
# The plugin has to be in the host's module graph, so the app restarts once afterwards.

set -eu

PROFILE="${1:-${DSH_PROFILE:-web}}"
REPO="git+https://github.com/XWIDE/dsh-draft-keeper.git"

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh: command not found — install DeepSeek Harness first, or run 'dsh plugin --profile ${PROFILE} add ${REPO}' with the full path to dsh." >&2
  exit 1
fi

echo "Installing dsh-draft-keeper into profile '${PROFILE}' ..."
dsh plugin --profile "${PROFILE}" add "${REPO}"

cat <<EOF

Installed. Restart the app once so the bundle joins the module graph:

  - DSH desktop app : restart DSH NEXT  (its title-bar restart menu also has "Reload interface",
                                        which is enough for the browser half afterwards)
  - dsh web         : restart the dsh process, then refresh the page

There is no UI and nothing to configure: paste an image, switch to another conversation,
come back — the image is still in the box.
EOF
