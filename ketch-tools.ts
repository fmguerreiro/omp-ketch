import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// OMP's legacy compatibility bundle cannot load pi-ketch's package imports.

type KetchStatus = "ok" | "not_found" | "validation" | "upstream" | "precondition" | "cancelled" | "error";

interface KetchResult {
	stdout: string;
	stderr: string;
	code: number;
	status: KetchStatus;
}

const OUTPUT_CHAR_CAP = 16000;
const CRAWL_OUTPUT_CHAR_CAP = 40000;
const KETCH_BIN = process.env.KETCH_BIN?.trim() || "ketch";
const KETCH_ENV = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
const MISSING_BINARY_MSG =
	"ketch is not installed or not on PATH. Install it with `brew install ketch`, or set KETCH_BIN to its absolute path.";

const STATUS_BY_CODE: Record<number, KetchStatus> = { 0: "ok", 2: "validation", 3: "not_found", 4: "upstream", 5: "precondition", 6: "cancelled" };

const STATUS_LEAD: Record<KetchStatus, string> = {
	ok: "ketch completed",
	not_found: "ketch found no matching results",
	validation: "ketch rejected the request",
	upstream: "ketch's upstream backend failed",
	precondition: "ketch requires operator setup (missing API key or backend config)",
	cancelled: "ketch was cancelled",
	error: "ketch failed",
};

function failureMessage(r: KetchResult): string {
	const hint = r.stderr.trim() || r.stdout.trim();
	return `${STATUS_LEAD[r.status]} (exit ${r.code}).${hint ? `\n${hint}` : ""}`;
}

function runKetch(args: string[], opts: { cwd: string; signal?: AbortSignal; timeoutMs: number }): Promise<KetchResult> {
	const { promise, resolve, reject } = Promise.withResolvers<KetchResult>();
	if (opts.signal?.aborted) {
		reject(new Error("ketch was cancelled before it started."));
		return promise;
	}
	const child = spawn(KETCH_BIN, args, { cwd: opts.cwd, env: KETCH_ENV, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;

	const terminate = () => {
		child.kill("SIGTERM");
		const k = setTimeout(() => child.kill("SIGKILL"), 500);
		k.unref();
	};
	const onAbort = () => terminate();
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, opts.timeoutMs);
	timer.unref();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const cleanup = () => {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c: string) => {
		stdout += c;
	});
	child.stderr.on("data", (c: string) => {
		stderr += c;
	});
	child.on("error", (err: NodeJS.ErrnoException) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(new Error(err.code === "ENOENT" ? MISSING_BINARY_MSG : err.message));
	});
	child.on("close", (code) => {
		if (settled) return;
		settled = true;
		cleanup();
		const exit = opts.signal?.aborted || timedOut ? 6 : (code ?? 1);
		const result: KetchResult = { stdout, stderr, code: exit, status: STATUS_BY_CODE[exit] ?? "error" };
		if (timedOut) result.stderr = `${stderr}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]`.trim();
		resolve(result);
	});
	return promise;
}

function cap(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[output truncated at ${max} chars]`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

// `not_found` is a normal result the model can act on.
async function runSurface(
	surface: string,
	args: string[],
	query: string,
	opts: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) {
	const r = await runKetch([surface, ...args, "--", query], opts);
	if (r.status === "ok") {
		const out = r.stdout.trim();
		return textResult(out ? cap(out, OUTPUT_CHAR_CAP) : "No results found.");
	}
	if (r.status === "not_found") return textResult(r.stdout.trim() || "No results found.");
	throw new Error(failureMessage(r));
}

interface CrawlPage {
	url: string;
	title?: string;
	status?: string;
	body: string;
}

function runKetchCrawl(
	args: string[],
	opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; maxPages: number; maxChars: number },
): Promise<{ pages: CrawlPage[]; parseErrors: string[]; stderr: string; code: number; stopped?: "max_pages" | "timeout" }> {
	const { promise, resolve, reject } =
		Promise.withResolvers<{ pages: CrawlPage[]; parseErrors: string[]; stderr: string; code: number; stopped?: "max_pages" | "timeout" }>();
	if (opts.signal?.aborted) {
		reject(new Error("ketch was cancelled before it started."));
		return promise;
	}
	const child = spawn(KETCH_BIN, args, { cwd: opts.cwd, env: KETCH_ENV, stdio: ["ignore", "pipe", "pipe"] });
	const pages: CrawlPage[] = [];
	const parseErrors: string[] = [];
	let stderr = "";
	let buffered = "";
	let stopped: "max_pages" | "timeout" | undefined;
	let settled = false;

	const terminate = () => {
		child.kill("SIGTERM");
		const k = setTimeout(() => child.kill("SIGKILL"), 500);
		k.unref();
	};
	const timer = setTimeout(() => {
		stopped = "timeout";
		terminate();
	}, opts.timeoutMs);
	timer.unref();
	const onAbort = () => terminate();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const cleanup = () => {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	};

	const parseLine = (line: string) => {
		const t = line.trim();
		if (!t || pages.length >= opts.maxPages) return;
		let p: Partial<CrawlPage> & { url?: unknown; body?: unknown };
		try {
			p = JSON.parse(t);
		} catch {
			parseErrors.push(t.slice(0, 200));
			return;
		}
		if (typeof p.url !== "string" || typeof p.body !== "string") {
			parseErrors.push(t.slice(0, 200));
			return;
		}
		const body = p.body.length > opts.maxChars ? `${p.body.slice(0, opts.maxChars)}\n\n[truncated]` : p.body;
		pages.push({ url: p.url, title: typeof p.title === "string" ? p.title : undefined, status: typeof p.status === "string" ? p.status : undefined, body });
		if (pages.length >= opts.maxPages) {
			stopped = "max_pages";
			terminate();
		}
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c: string) => {
		buffered += c;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const l of lines) parseLine(l);
	});
	child.stderr.on("data", (c: string) => {
		stderr += c;
	});
	child.on("error", (err: NodeJS.ErrnoException) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(new Error(err.code === "ENOENT" ? MISSING_BINARY_MSG : err.message));
	});
	child.on("close", (code) => {
		if (settled) return;
		settled = true;
		cleanup();
		if (buffered.trim()) parseLine(buffered);
		if (opts.signal?.aborted && stopped !== "max_pages") {
			reject(new Error("ketch crawl was cancelled."));
			return;
		}
		resolve({ pages, parseErrors, stderr, code: code ?? 1, stopped });
	});
	return promise;
}

function clampInt(value: number | undefined, min: number, max: number, dflt: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ketch takes --allow/--deny as cobra string slices, which CSV-split every value.
function requireNoComma(value: string, flag: string): string {
	if (value.includes(",")) throw new Error(`${flag} entries cannot contain a comma; ketch would split "${value}" into separate filters. Pass one entry per array element.`);
	return value;
}

export default function ketchTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "ketch_code",
		label: "Ketch Code Search",
		description:
			"Search PUBLIC open-source code across grep.app, Sourcegraph, or GitHub via the ketch CLI. For real-world usage examples in third-party repositories. Not for the local checkout (use grep/read for that).",
		parameters: z.object({
			query: z.string().describe("Literal or regex code query."),
			backend: z.enum(["grepapp", "sourcegraph", "github"]).optional().describe("Code backend; omit to use ketch's configured backend, grepapp if unset."),
			lang: z.string().optional().describe("Language filter, e.g. go, typescript, python."),
			regex: z.boolean().optional().describe("Treat query as a regex (grepapp/sourcegraph only, not github)."),
			limit: z.number().optional().describe("Max results, 1-20 (default 10)."),
		}),
		approval: "exec",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.regex && params.backend === "github") throw new Error("github code search does not support regex; use grepapp or sourcegraph.");
			const args: string[] = [];
			if (params.backend) args.push("-b", params.backend);
			if (params.lang) args.push("--lang", params.lang);
			if (params.regex) args.push("--regex");
			args.push("-l", String(clampInt(params.limit, 1, 20, 10)));
			return runSurface("code", args, params.query, { cwd: ctx.cwd, signal, timeoutMs: 45000 });
		},
	});

	pi.registerTool({
		name: "ketch_docs",
		label: "Ketch Library Docs",
		description:
			"Search curated library/API documentation (Context7) via the ketch CLI. Resolve a library name with resolve:true, then query with its library ID. Requires a Context7 key configured in ketch.",
		parameters: z.object({
			query: z.string().describe("Library name to resolve, or documentation query."),
			library: z.string().optional().describe("Context7 library ID; skips name resolution."),
			resolve: z.boolean().optional().describe("Resolve a library name instead of searching docs."),
			tokens: z.number().optional().describe("Context7 token budget, 100-12000 (default 4000)."),
			limit: z.number().optional().describe("Max results, 1-20."),
		}),
		approval: "exec",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.resolve && params.library) throw new Error("resolve and library are mutually exclusive: resolve finds a library id, library queries a known one.");
			const args: string[] = [];
			if (params.resolve) args.push("--resolve");
			if (params.library) args.push("--library", params.library);
			if (!params.resolve) args.push("--tokens", String(clampInt(params.tokens, 100, 12000, 4000)));
			if (typeof params.limit === "number") args.push("-l", String(clampInt(params.limit, 1, 20, 10)));
			return runSurface("docs", args, params.query, { cwd: ctx.cwd, signal, timeoutMs: 45000 });
		},
	});

	pi.registerTool({
		name: "ketch_deep_search",
		label: "Ketch Deep Search",
		description:
			"Federated web search across every usable ketch backend, rank-fused with Reciprocal Rank Fusion. Use ONLY for contested, multi-part, or deep research where a single provider is not enough. For routine web search use OMP's built-in web_search instead.",
		parameters: z.object({
			query: z.string().describe("Search query."),
			backends: z
				.array(z.string())
				.optional()
				.describe(
					"Omit this to fuse every backend your ketch install can reach, which is the reliable choice: naming one that has no key or URL fails the whole call, and only `ketch doctor` shows which are usable. Names come from `ketch search --help`; an unknown one is rejected with the current list.",
				),
			limit: z.number().optional().describe("Max fused results, 1-20 (default 10)."),
		}),
		approval: "exec",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const multi = params.backends?.length ? params.backends.join(",") : "all";
			const args = [`--multi=${multi}`, "-l", String(clampInt(params.limit, 1, 20, 10))];
			return runSurface("search", args, params.query, { cwd: ctx.cwd, signal, timeoutMs: 60000 });
		},
	});

	pi.registerTool({
		name: "ketch_crawl",
		label: "Ketch Crawl",
		description:
			"Bounded, same-host breadth-first crawl from a seed URL, returning clean markdown per page. Use when several pages from one site are needed; for a single page use OMP's read.",
		parameters: z.object({
			url: z.string().describe("HTTP(S) seed URL."),
			depth: z.number().optional().describe("Max BFS depth, 1-5 (default 2)."),
			maxPages: z.number().optional().describe("Stop after this many pages, 1-100 (default 20)."),
			maxChars: z.number().optional().describe("Max markdown chars per page, 1-20000 (default 6000)."),
			sitemap: z.boolean().optional().describe("Treat the seed URL as a sitemap."),
			allow: z.array(z.string()).optional().describe("Path substrings; a URL must match at least one. One substring per element, no commas."),
			deny: z.array(z.string()).optional().describe("Regex patterns for URLs to skip. One pattern per element, no commas (so no {n,m} quantifiers)."),
		}),
		approval: "exec",
		async execute(_id, params, signal, _onUpdate, ctx) {
			let u: URL;
			try {
				u = new URL(params.url);
			} catch {
				throw new Error("url must be a valid absolute URL.");
			}
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("url must use http or https.");

			const maxPages = clampInt(params.maxPages, 1, 100, 20);
			const maxChars = clampInt(params.maxChars, 1, 20000, 6000);
			const args = ["crawl", params.url, "--depth", String(clampInt(params.depth, 1, 5, 2)), "--json"];
			if (params.sitemap) args.push("--sitemap");
			for (const a of params.allow ?? []) args.push("--allow", requireNoComma(a, "allow"));
			for (const d of params.deny ?? []) args.push("--deny", requireNoComma(d, "deny"));
			const { pages, parseErrors, stderr, code, stopped } = await runKetchCrawl(args, { cwd: ctx.cwd, signal, timeoutMs: 180000, maxPages, maxChars });

			if (pages.length === 0) {
				if (code !== 0 && !stopped) throw new Error(`ketch crawl failed (exit ${code}).\n${stderr.trim()}`);
				if (parseErrors.length > 0) throw new Error(`ketch crawl produced no parseable pages; ${parseErrors.length} unparseable line(s). First: ${parseErrors[0]}`);
				return textResult("No pages crawled.");
			}

			const parts: string[] = [];
			if (stopped === "max_pages") parts.push(`Note: stopped at the ${maxPages}-page limit.`);
			if (stopped === "timeout") parts.push("Note: stopped at the crawl time limit; partial results below.");
			for (const p of pages) {
				parts.push(`--- ${p.title || p.url}\nurl: ${p.url}${p.status ? ` (${p.status})` : ""}\n\n${p.body}`);
			}
			return textResult(cap(parts.join("\n\n"), CRAWL_OUTPUT_CHAR_CAP));
		},
	});

}
