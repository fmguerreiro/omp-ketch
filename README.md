# omp-ketch

Native [Oh My Pi (OMP)](https://oh-my-pi.dev) tools for the
[`ketch`](https://github.com/1broseidon/ketch) CLI: public open-source code
search, library docs, bounded site crawl, rank-fused deep web search.

Not a fork of `pi-ketch`, which fails to load on OMP: its barrel import of
`@earendil-works/pi-coding-agent` pulls in `withFileMutationQueue`, which OMP's
legacy compat bundle does not re-export. This is an independent single-file
extension against OMP's own `@oh-my-pi/pi-coding-agent` API, shelling out to the
same `ketch` binary.

## What it adds

OMP already has local search (`grep`, `glob`, LSP) and its own `web_search` /
`read`, so these four tools cover only the gaps. Each description also says what
it is *not* for, keeping routine web search and local-code questions on OMP's
native tools. Tool choice is the model's probabilistic judgment over name,
description and schema, not a keyword match — name a tool to force it.

| Tool | Use it for | Instead use |
| --- | --- | --- |
| `ketch_code` | Real-world usage examples in **public** third-party repos (grep.app, Sourcegraph, GitHub) | `grep`/`read` for the local checkout |
| `ketch_docs` | Curated library/API documentation via Context7 (needs a Context7 key in ketch) | — |
| `ketch_deep_search` | Contested or multi-part research: every usable ketch backend, fused with Reciprocal Rank Fusion | `web_search` for routine search |
| `ketch_crawl` | Bounded, same-host breadth-first crawl from a seed URL, clean markdown per page | `read` for a single page |

## Install

Needs OMP (`omp`) and the `ketch` binary on `PATH` (`brew install ketch`), or
`KETCH_BIN` pointing at it.

```sh
omp install github:fmguerreiro/omp-ketch
```

Restart OMP to load the tools. For the standalone extension file instead:

```sh
mkdir -p ~/.omp/agent/extensions
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch/main/ketch-tools.ts \
  -o ~/.omp/agent/extensions/ketch-tools.ts
```

It is auto-discovered at session start; no config entry required. `install.sh`
does the same download plus a check for the `ketch` binary:

```sh
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch/main/install.sh | sh
```

## Verify

The binary and backend (no OMP, no model):

```sh
ketch code -b sourcegraph --lang go -l 2 -- "errgroup.WithContext"
```

End-to-end through OMP (invokes a model, which chooses the tool):

```sh
omp -p --no-session --mode json --auto-approve \
  'Call ketch_code with backend sourcegraph, lang go, limit 2, query "errgroup.WithContext". Return only the tool result.' \
  < /dev/null \
  | jq -c 'select(.type=="tool_execution_end") | {toolName, isError, text: .result.content[0].text}'
```

Redirect stdin when launching `omp -p` from another process: OMP skips the read
when stdin is a terminal, but an inherited pipe that never closes waits in
`readPipedInput` for an EOF that never comes, and the prompt never runs. Startup
takes tens of seconds; OMP names the phase it waits in every 10 s, so read
stderr before assuming it hung.

Extension tools surface as `xd://<tool>` devices, so the event's `toolName` is
`write` with `path: "xd://ketch_code"`. **Either** a ketch-formatted result
**or** a propagated ketch backend error (e.g. grep.app returning a 504) proves
the tool loaded and reached the binary.

## Configuration

- `KETCH_BIN`: absolute path to the `ketch` binary if it is not on `PATH`.
- Backends and API keys live in **ketch itself**, e.g.
  `ketch config set context7_api_key <key>`. `ketch doctor` lists every backend
  with its state, the authoritative answer to what you can reach. See the
  [ketch docs](https://github.com/1broseidon/ketch).
- The code backend defaults to whatever ketch is configured to use, grep.app if
  unset. For Sourcegraph by default, set it in ketch or change `ketch_code` to
  send `-b sourcegraph` when no `backend` is supplied.

## Uninstall

Delete `~/.omp/agent/extensions/ketch-tools.ts` (or add
`extension-module:ketch-tools` to `disabledExtensions` in your OMP config) and
reload.

## License

MIT. See [LICENSE](LICENSE).
