#!/bin/sh
# The only command the review workflow's SSH key may run on the server
# (.github/workflows/review-reports.yml): "export" prints the open reports, "import" records the
# decisions read from standard input. Install it, e.g. as /usr/local/bin/bibliotheca-reports, and
# limit the key to it in ~/.ssh/authorized_keys:
#
#   command="/usr/local/bin/bibliotheca-reports",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA… review-reports
#
# The user needs to be allowed to run `docker exec` (be in the docker group).
set -eu
CONTAINER="${BIBLIOTHECA_CONTAINER:-bibliotheca-api}"
case "${SSH_ORIGINAL_COMMAND:-}" in
  export) exec docker exec "$CONTAINER" node server/reports-cli.mjs export ;;
  import) exec docker exec -i "$CONTAINER" node server/reports-cli.mjs import ;;
  *) echo "Only 'export' and 'import' are allowed." >&2; exit 1 ;;
esac
