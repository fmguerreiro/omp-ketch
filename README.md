# omp-ketch

Native [Oh My Pi (OMP)](https://oh-my-pi.dev) tools for the [`ketch`](https://github.com/1broseidon/ketch)
CLI: public open-source code search, library docs, bounded site crawl, and
rank-fused deep web search. The agent can call each tool on its own.

It is **not** a fork of the `pi-ketch` package. That package fails to load on
OMP (its barrel import of `@earendil-works/pi-coding-agent` pulls in
`withFileMutationQueue`, which OMP's legacy compat bundle does not re-export).
This is an independent single-file extension written against OMP's own
`@oh-my-pi/pi-coding-agent` API. It shells out to the same `ketch` binary, so
the search engine underneath is identical.

## What it adds

OMP already has strong local search (`grep`, `glob`, LSP) and its own
`web_search` / `read`. This extension adds only the surfaces OMP lacks and
steers the agent to keep everyday web search and single-page reads on OMP's
native tools.

| Tool | Use it for |
| --- | --- |
| `ketch_code` | Real-world usage examples in **public** third-party repos (grep.app, Sourcegraph, GitHub). For the local checkout, use `grep`/`read`. |
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

Install the package directly from GitHub:

```sh
omp install github:fmguerreiro/omp-ketch
```

Restart OMP to load the new tools. To install the standalone extension file
instead:

```sh
mkdir -p ~/.omp/agent/extensions
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch/main/ketch-tools.ts \
  -o ~/.omp/agent/extensions/ketch-tools.ts
```

The standalone file is auto-discovered at session start; no config entry is
required. `install.sh` downloads it and checks for the `ketch` binary:

```sh
curl -fsSL https://raw.githubusercontent.com/fmguerreiro/omp-ketch/main/install.sh | sh
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
  < /dev/null \
  | jq -c 'select(.type=="tool_execution_end") | {toolName, isError, text: .result.content[0].text}'
```

The `< /dev/null` is required. With any stdin still open — a pipe, a parent
shell, another agent — `omp -p` blocks in its `readPipedInput` startup phase
and never runs the prompt. Startup also takes ~90 s when nested, so allow for
that before assuming it hung.

OMP surfaces extension tools as `xd://<tool>` devices, so the event's
`toolName` is `write` with `path: "xd://ketch_code"`. **Either** a
ketch-formatted result **or** a propagated ketch backend error (e.g. grep.app
returning a 504) proves the tool loaded and reached the binary.

## Measured behaviour

Run 2026-09-17 with ketch v0.16.1, OMP v18.2.2, model `claude-opus-5`.

**Surfaces reached the backend** (`ketch` alone, no OMP, no model):

| Command | Result |
| --- | --- |
| `ketch code -l 2 -- "errgroup.WithContext"` | 2 hits with `file:line` and URL, 1.5 s (grep.app) |
| `ketch code -b sourcegraph --lang go -l 2 -- …` | 2 hits, 23.8 s |
| `ketch crawl "https://bun.sh/docs/cli/test" --depth 1 --json` | seed page as markdown, 2168 words, 1.3 s |
| `ketch search --multi=all -l 3 -- …` | 3 fused results from exa, keenable, parallel; ddg and searxng unreachable, 1.9 s |
| `ketch docs -l 2 -- "tenacity retry"` | fails: `context7: API key not set` |

`ketch_docs` therefore does nothing until a Context7 key is set, and
`ketch_deep_search` only fuses the backends your ketch install can actually
reach. Omitting `backends` is the safe call: naming an explicit set fails the
whole search if any one of them is unconfigured — `--multi=parallel,tavily`
returns `tavily: API key not set` and no results, rather than falling back to
`parallel` alone.

**The agent selects the tools unprompted.** Each prompt was a plain question
that never named a tool, run through `omp -p --no-session --auto-approve`:

| Prompt | Tool chosen |
| --- | --- |
| Real-world public-repo examples of Go calling `errgroup.WithContext` | `ketch_code` (3 of 3 runs) |
| Bun test-runner docs from `bun.sh/docs/cli/test` and its linked pages | `ketch_crawl` (2 of 2 runs) |
| Latest stable PostgreSQL version | OMP's `web_search`, no ketch call |
| Which file in this repo registers the tools | `glob` + `grep`, no ketch call |

The last two matter as much as the first two: the descriptions do not pull
routine web search or local-code questions away from OMP's native tools.

**It is not cheaper than an agent that improvises.** Same code-search prompt,
three runs per arm, in an empty directory so the disabled arm could not find
this repo. Without the extension the agent fell back to `gh search code` and
`gh api`; medians:

| Arm | Tool calls | Tokens | Cost | Wall |
| --- | --- | --- | --- | --- |
| With `omp-ketch` | 7 | 236k | $0.34 | 77 s |
| `--no-extensions` | 8 | 252k | $0.40 | 72 s |

That is noise at this sample size, and the single crawl comparison went the
other way (11 calls / $0.78 with the extension against 14 calls / $0.63
without). Every source link both arms cited resolved with HTTP 200. Install it
for the coverage — grep.app and Sourcegraph index code that `gh` cannot see,
and neither needs GitHub auth — not for a token saving.

**Backends fail in the open.** One `ketch_code` call in these runs returned
`code search failed: grep.app search failed` (exit 4); the agent read the error
and retried on Sourcegraph, which succeeded. Expect transient backend errors to
surface as tool errors rather than empty results.

## How the agent decides to call it

The model picks a tool from its name, description, parameter schema, and the
surrounding conversation, weighed against every other available tool. Selection
is a probabilistic judgment, not a keyword match. The descriptions in
`ketch-tools.ts` are the main routing hint; each one also says what the tool is
*not* for, to keep local-code and routine-web questions on OMP's native tools.
To force a specific tool, name it explicitly in your prompt.

## Configuration

- `KETCH_BIN`: absolute path to the `ketch` binary if it is not on `PATH`.
- Backends and API keys (Context7, Exa, Firecrawl, Brave, SearXNG, and others)
  are configured in **ketch itself**, e.g. `ketch config set context7_api_key <key>`.
  See the [ketch docs](https://github.com/1broseidon/ketch).

The default code backend is grep.app (ketch's own default). To default to
Sourcegraph instead, change `ketch_code` to send `-b sourcegraph` when no
`backend` is supplied, or set the default in ketch.

## Uninstall

Delete `~/.omp/agent/extensions/ketch-tools.ts` (or add
`extension-module:ketch-tools` to `disabledExtensions` in your OMP config) and
reload.

## License

MIT. See [LICENSE](LICENSE).
