# omp-ketch-tools

Native [Oh My Pi (OMP)](https://oh-my-pi.dev) tools for the [`ketch`](https://github.com/1broseidon/ketch)
CLI: public open-source code search, library docs, bounded site crawl, and
rank-fused deep web search — exposed as first-class OMP tools the agent can
call on its own.

It is **not** a fork of the `pi-ketch` package. That package fails to load on
OMP (its barrel import of `@earendil-works/pi-coding-agent` pulls in
`withFileMutationQueue`, which OMP's legacy compat bundle does not re-export).
This is an independent single-file extension written against OMP's own
`@oh-my-pi/pi-coding-agent` API. It shells out to the same `ketch` binary, so
the search engine underneath is identical.

## What it adds

OMP already has strong local search (`grep`, `glob`, LSP) and its own
`web_search` / `read`. This extension deliberately adds only the surfaces OMP
lacks, and steers the agent to keep everyday web search and single-page reads
on OMP's native tools.

| Tool | Use it for |
| --- | --- |
| `ketch_code` | Real-world usage examples in **public** third-party repos (grep.app, Sourcegraph, GitHub). Not the local checkout — that's `grep`/`read`. |
| `ketch_docs` | Curated library/API documentation via Context7. Needs a Context7 key configured in ketch. |
| `ketch_deep_search` | Federated web search across every usable ketch backend, fused with Reciprocal Rank Fusion. For contested/multi-part research only; routine search stays on OMP's `web_search`. |
| `ketch_crawl` | Bounded, same-host breadth-first crawl from a seed URL, clean markdown per page. For a single page use OMP's `read`. |

## Prerequisites

1. **OMP** installed (`omp`).
2. **The `ketch` binary** on your `PATH`:

   ```sh
   brew install 1broseidon/tap/ketch
   ```

   Or point the extension at any location with the `KETCH_BIN` environment
   variable.

## Install

Drop the single file into your OMP extensions directory and reload:

```sh
mkdir -p ~/.omp/agent/extensions
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch-tools/main/ketch-tools.ts \
  -o ~/.omp/agent/extensions/ketch-tools.ts
```

Then run `/reload` in an OMP session, or restart OMP. Extensions in that
directory are auto-discovered at session start — no config entry required.

`install.sh` does the same, and checks for the `ketch` binary:

```sh
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch-tools/main/install.sh | sh
```

## Verify

**The binary and backend** (no OMP, no model):

```sh
ketch code -b sourcegraph --lang go -l 2 -- "errgroup.WithContext"
```

**End-to-end through OMP** (invokes a model, which chooses the tool):

```sh
omp -p --no-session --mode json --auto-approve \
  'Call ketch_code with backend sourcegraph, lang go, limit 2, query "errgroup.WithContext". Return only the tool result.' \
  | jq -c 'select(.type=="tool_execution_end") | {toolName, isError, text: .result.content[0].text}'
```

OMP surfaces extension tools as `xd://<tool>` devices, so the event's
`toolName` is `write` with `path: "xd://ketch_code"`. **Either** a
ketch-formatted result **or** a propagated ketch backend error (e.g. grep.app
returning a 504) proves the tool loaded and reached the binary.

## How the agent decides to call it

The model picks a tool from its name, description, parameter schema, and the
surrounding conversation, weighed against every other available tool — so
selection is a probabilistic judgment, not a keyword match. The descriptions in
`ketch-tools.ts` are the main routing hint; each one also says what the tool is
*not* for, to keep local-code and routine-web questions on OMP's native tools.
To force a specific tool, name it explicitly in your prompt.

## Configuration

- `KETCH_BIN` — absolute path to the `ketch` binary if it is not on `PATH`.
- Backends and API keys (Context7, Exa, Firecrawl, Brave, SearXNG, …) are
  configured in **ketch itself**, e.g. `ketch config set context7_api_key <key>`.
  See the [ketch docs](https://github.com/1broseidon/ketch).

The default code backend is grep.app (ketch's own default). To default to
Sourcegraph instead, change `ketch_code` to send `-b sourcegraph` when no
`backend` is supplied, or set the default in ketch.

## Uninstall

Delete `~/.omp/agent/extensions/ketch-tools.ts` (or add
`extension-module:ketch-tools` to `disabledExtensions` in your OMP config) and
reload.

## License

MIT — see [LICENSE](LICENSE).
