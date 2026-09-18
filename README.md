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

## Measured behaviour

Run 2026-09-17, ketch v0.16.1, OMP v18.2.2, model `claude-opus-5`, where
`ketch doctor` reported 3 of 10 search backends usable: exa, keenable and
parallel keyed; brave/firecrawl/tavily/serpbase keyless; degoog without a URL;
ddg rate-limiting; searxng on its default localhost. Your numbers depend on your
keys.

Every surface reached its backend (`ketch` alone, no OMP, no model):

| Command | Result |
| --- | --- |
| `ketch code -l 2 -- "errgroup.WithContext"` | 2 hits with `file:line` and URL (grep.app) |
| `ketch code -b sourcegraph --lang go -l 2 -- …` | 2 hits, tens of seconds — Sourcegraph can eat half the tool's 45 s timeout |
| `ketch crawl "https://bun.sh/docs/cli/test" --depth 1 --json` | seed page as markdown, 2168 words |
| `ketch search --multi=all -l 3 -- …` | 3 fused results, one per usable backend |
| `ketch docs -l 2 -- "tenacity retry"` | fails: `context7: API key not set` |

Omitting `backends` is the safe call: `--multi=all` skips a backend it cannot
reach, but an explicit set fails the whole search if any member is
unconfigured — `--multi=parallel,tavily` returns `tavily: API key not set` and
no results rather than falling back to `parallel`.

The agent picks the tools unprompted. Spot checks, not a benchmark: plain
questions naming no tool, through the same `omp -p` command as above.

| Prompt | Tool chosen |
| --- | --- |
| Real-world public-repo examples of Go calling `errgroup.WithContext` | `ketch_code` (3 of 3 runs) |
| Bun test-runner docs from `bun.sh/docs/cli/test` and its linked pages | `ketch_crawl` (2 of 2 runs) |
| Latest stable PostgreSQL version | OMP's `web_search`, no ketch call |
| Which file in this repo registers the tools | `glob` + `grep`, no ketch call |

The last two rows matter as much as the first two.

Not cheaper than an agent that improvises. Same code-search prompt, three runs
per arm, in an empty directory so the disabled arm could not find this repo;
without the extension it fell back to `gh search code` and `gh api`. Medians:

| Arm | Tool calls | Tokens | Cost | Wall |
| --- | --- | --- | --- | --- |
| With `omp-ketch` | 7 | 236k | $0.34 | 77 s |
| `--no-extensions` | 8 | 252k | $0.40 | 72 s |

Noise at this sample size, the crawl comparison went the other way (11 calls /
$0.78 with the extension against 14 calls / $0.63 without), and
`--no-extensions` disables every extension rather than this one, so the arms
differ by more than the thing under test. Install it for the coverage —
grep.app and Sourcegraph index code `gh` cannot see, and neither needs GitHub
auth — not for a token saving.

A backend failure propagates as a tool error carrying ketch's own message, never
an empty result, so the model can retry elsewhere: one `grep.app search failed`
here was retried on Sourcegraph and succeeded.

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
