#!/bin/sh
set -eu

RAW_URL="https://raw.githubusercontent.com/fmguerreiro/omp-ketch-tools/main/ketch-tools.ts"
DEST_DIR="${HOME}/.omp/agent/extensions"
DEST="${DEST_DIR}/ketch-tools.ts"

if ! command -v ketch >/dev/null 2>&1 && [ -z "${KETCH_BIN:-}" ]; then
	echo "warning: the 'ketch' binary is not on PATH." >&2
	echo "         Install it with: brew install 1broseidon/tap/ketch" >&2
	echo "         (or set KETCH_BIN to its absolute path)." >&2
fi

mkdir -p "${DEST_DIR}"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL "${RAW_URL}" -o "${DEST}"
elif command -v wget >/dev/null 2>&1; then
	wget -qO "${DEST}" "${RAW_URL}"
else
	echo "error: need curl or wget to download the extension." >&2
	exit 1
fi

echo "Installed ketch-tools to ${DEST}"
echo "Run /reload in an OMP session, or restart OMP, to load it."
