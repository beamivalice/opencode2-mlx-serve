# MLX Serve Monitor

An OpenCode 2 CLI plugin that shows what a local **mlx-serve** is doing while you
use it as OpenCode's model: a live stats panel in the session sidebar, and the
turn meter in the prompt footer.

It reads, and never asks:

```
GET /metrics.json   counters, gauges, histograms        (needs the server's --metrics)
GET /props          memory headroom, n-gram warm total  (optional)
GET /v1/models      model, quantizer, MTP head          (optional)
tail  ~/.mlx-serve/logs/mlx-serve-<port>.log            [spec-stats] + per-request sampling
```

The `[spec-stats]` line is documented in `mlx-serve/src/generate.zig` as a stable
target for external tooling ("keep the format stable"), which is why MTP
acceptance is read from the log: it is the only place mlx-serve publishes it.

## Layout — fixed, on purpose

| Surface | Where | Content |
| --- | --- | --- |
| Turn meter | prompt footer, **always** | `~1,833 tok · decode ~24.0 t/s` — tokens this turn, and how fast they are landing |
| Stats panel | session sidebar | throughput, model, queue, latency, prefix cache, memory, MTP acceptance, the last request's sampling, totals since boot, and where the server log is |

There are no slash commands. OpenCode 2 `beta-19296` does not dispatch CLI-plugin
commands into the prompt: `keymap.layer` accepts the spec, but the host lists none
of the plugin's commands back, and neither `/sidebar` nor `/speed` ever fires. The
matcher in the host's own bundle explains the smaller half of that — it will not
even *look at* a command that has not declared `slash.arguments`:

```js
i.find((b) => b.slash?.arguments && (b.slash.name === a.name || …))
```

So everything that used to be a command is now either always-on behaviour or a
`cli.json` option. Nothing in this file is a promise this build cannot keep.

To hide the panel without touching config, hide the host sidebar (`<leader>b`, or
`session.sidebar: "hide"` in cli.json). Hiding it genuinely unmounts the panel —
the host builds it inside a `Show` — so its slow reads stop, and the turn meter
stays in the footer the whole time.

## The footer meter

```
prefill █████░░░░░░░░░░░░░ 12,288/~48,000 · 10.2k t/s · ~3s left   ← prefilling
~1,833 tok · decode ~24.0 t/s                                      ← decoding
~17,453 tok · decode ~24.0 t/s · 1m15s                             ← long turn
288 tok · decode 24.0 t/s · prefill 10.0k t/s                      ← settled from usage
```

Token **counts** are written out in full with thousands separators — the same way
the host's own context meter prints them — because a count is read for its value,
and `1.8k` could be anything from 1,750 to 1,849. Rates keep their compact form
(`10.2k t/s`), where magnitude is the whole point.

Prefill is a progress bar because it is the one phase with nothing else worth
watching. The denominator is the previous step's **forwarded** token count
(`prompt − cached`), not this prompt's size: mlx-serve publishes
`prefill_tokens_live` (how far along) but the total only arrives in `usage`, after
the step is over. That is why it reads `~48,000` — on a warm prefix cache a turn
forwards its new tail, so the real total is usually *smaller* than the last turn's
whole prompt. When this turn has already forwarded more than the last one, the bar
saturates and says `past last turn` rather than claiming 100%. With no previous
step, or `barCells: 0`, the line is `prefill 12,288 tok · 10.2k t/s`.

What the footer deliberately leaves out: the server's memory footprint (the panel
has a `Memory` section) and time-to-first-token. ttft left with the `Latency`
section, so it now appears nowhere in the panel; the histograms it was read from
still feed the cumulative prefill and decode rates. `~` marks counts estimated
from streamed bytes rather than reported by the server.

## What the panel shows

Only sections with data are drawn, in the order below. All are default unless
marked; `sections` trims or reorders them.

| Section | Lines |
| --- | --- |
| **Throughput** | live server decode and prefill tok/s over a trailing window, each beside its cumulative average; a 60-second sparkline; admitted req/s. |
| **Server** | what is loaded and who is using it: `model Qwen3.8-Flash-Next`, `kv-quant 8-bit`, `context 1,048,576` (exact — the width a context is sized for is a number you act on, not a magnitude), `spec mtp head · qwen4_exp`, a GPU utilisation **gauge**, and the merged queue line, `running 1 · 0 waiting`. |
| **Prefix cache** | share of billed prompt tokens restored from cache (the number that explains a slow-looking prefill), share of requests with a hit, then both KV tiers gauged against their own denominators: `hot ▮▮▮░░░░░ 33% · 9.3G/28.0G`, `ssd ▮░░░░░░░ 11% · 10.7G/100G`. |
| **Memory** | the wired-ceiling gauge rides on the section heading (`Memory ▮▮▮▮▮▮▮░░░ 79% of 117G wired`) — no footprint row when a ceiling is declared, one plain `footprint 91.7G` row when it is not. Then MLX allocator in-use vs its reclaimable pool, free system RAM + peak, ANE bytes, n-gram table size. |
| **Speculative Decoding** | per-draft acceptance as a gauge **and** a percent, accepted tokens per round over rounds attempted, verify round time vs the GPU→CPU sync inside it, and a `gate off · adaptive → serial` line when the runtime gave up on speculation mid-request. |
| **Sampling** | the params the last request actually ran with: `temp 1.00 · p 0.95 k 20`, `max out 64000 · launch default`, and `route responses` when the request did not come from `/v1/chat/completions`. |
| **Server log** | whether the server answers (`feed live`, `--metrics off`, `unreachable`, `401 unauthorized`), what it has done since boot (`tokens 347.3k in · 3.3k out`, `requests 15 ok · 0 cancelled`, `messages req 127`, `tool calls 68 · this session`), then which log file the tail reads, its size, and how long ago it was written. |
| **Turn** (opt-in) | the footer's per-turn numbers as panel rows, prefill bar included. |
| **Attach** (opt-in) | the plugin's own integration health. It appears **by itself** whenever something failed (a refused slot, a missing host API), so a half-dead panel cannot look healthy. |

The panel has **no title line**: it is already inside a sidebar that says what
session it belongs to, so a heading naming the server was one more line of
non-information. What the title used to carry — `live` / `--metrics off` /
`unreachable` / `401 unauthorized` / `connecting` — is now the `feed` row at the
top of `Server log`, in the theme's success/warning/error colour. It is also the
one row that draws even when every other section is empty, so a panel that cannot
reach the server is visibly broken rather than invisibly absent.

## One turn, or several clients at once

`generation_tokens_live` is a **server-wide** counter: it adds every client's
tokens. So the footer meter and the panel's Throughput section answer different
questions, and the plugin keeps them from being mistaken for each other:

- **One request in flight** (the normal case): the two rates are the same
  measurement. If you opt `turn` into `sections`, Throughput gives its line up to
  the number the turn meter cannot know — `decode avg 51.8 t/s · since boot`
  (matched by value within 5%, so the `~` estimate marker does not defeat it).
- **Two or more in flight**: the server-wide rate is no longer *your* turn's rate.
  The footer meter switches to the bytes this session streamed and is marked `~`,
  while Throughput keeps showing the server's combined rate. Both stay, because
  they are genuinely two different numbers.

Measured with a synthetic race — 12 t/s ours, 40 t/s theirs, counter climbing at
52: the turn meter reports ~15 t/s (its own bytes, over-reading because
`bytesPerToken` is an approximation) instead of the aggregate 52 it would have
reported before. Prefill has no per-session estimate available during the prefill
itself — nothing has streamed yet — so a concurrent prefill reads as the
machine's speed.

## Three graphics, three meanings

| Mark | Glyphs | Where | Reads as |
| --- | --- | --- | --- |
| gauge | `▮▮▮▮▮▮░░░░` | gpu, accept, hot/ssd tiers, the `Memory` heading | a level against its own limit |
| progress | `████░░░░░░` | the footer's prefill bar, `turn` section rows | filling up **in time** toward a total |
| sparkline | `▁▂▅█▆▃` | `60s` in Throughput, the footer's decode tail | a series — shape over the last N cells |

Widths are asserted in the tests: with `ratioCells: 8` every row of every section
fits 34 cells on live data. At 10 the `Memory` heading reaches 35 cells and at 12 it
reaches 37 — the sidebar truncates the end of a line, so a wide gauge on a heading
costs the ceiling figure at the back. That is why 8 is the default.

Using one mark for all three is how a static split starts looking like a trend, or
a stall looks like a rate. Everything is drawn in the row's own **value** colour
(white): gauges that faded to the theme's subdued tone read as labels, and colour is
not carrying meaning anywhere in this panel — the number is next to every mark.

## The wired ceiling, not 75% of your RAM

```
Memory ▮▮▮▮▮▮▮▮░░ 79% of 117G wired       ← iogpu.wired_limit_mb = 120000, read once
footprint 91.7G                           ← nothing declared: bytes, no gauge
```

What actually kills the server is Metal's `max_recommended_working_set_size`, which
mlx-serve reads with `getGpuWorkingSetLimit()` and never publishes over HTTP. The
obvious fallback — 75% of physical RAM, the macOS default — is wrong on any machine
whose owner raised `iogpu.wired_limit_mb`: on this box it drew 91.7 GB at **95% of
96 GB**, shouting an emergency that had already been closed by raising the limit to
~117 GB. So the plugin reads the sysctl once at load (the same once-per-process
policy as the server's own `wiredLimitBytes` — a ceiling that moved mid-turn would
make the gauge lie), and where nothing is declared it shows bytes alone rather than
inventing a denominator.

The ceiling is worth publishing from the server itself: adding
`working_set_bytes` and the computed ceiling to `renderPropsBody` in
`src/server.zig` is a few lines, `/props` already carries the rest of the memory
picture, and then the gauge reads the real device value instead of the sysctl that
approximates it.

## What the two cache denominators are

```
hot  ▮▮▮░░░░░ 33% · 9.3G/28.0G
ssd  ▮░░░░░░░ 11% · 10.7G/100G
```

Neither number is what the launch flag says, and the words explaining them were cut
before the bytes were — so they are documented here instead:

- **`hot`** is the RAM tier. Its denominator is the **budget** the cache trims
  against: `ssdFirstPrefixCacheMem` computes `ctx_kv_bytes + idle`, i.e. one session
  at the working context (18,432 MB here) plus whatever `--prefix-cache-mem` allows
  to sit idle (10,240 MB) = 28,672 MB. `--prefix-cache-mem 10GB` is *only the idle
  part* — which is why the row said 28.0G when the flag said 10G. The tier prints its
  own budget in its log line, so this gauge is measured, not guessed.
- **`ssd`** is the disk tier under `~/.mlx-serve/kv-cache`. `/metrics.json` counts
  prefix-cache *hits* and says nothing about bytes on disk; the tier's own
  `[disk-cache] persisted … resident=10933.6 MB (12 entries)` line is the only place
  its occupancy appears, and its cap (`--prefix-cache-disk 100GB`) appears in no line
  at all — so the gauge is drawn only when you declare `diskCacheGb` in cli.json.
  Otherwise the row is bytes with no invented denominator.
- Entry counts are deliberately not drawn. With a gauge the row is already ~31 cells,
  and the sidebar truncates the **end** of a line: a trailing word is paid for in
  bytes.

## Poll rates

Nothing polls when nothing is on screen, and nothing polls four times a second
while the server is idle.

| Situation | /metrics.json | /props, /v1/models, log |
| --- | --- | --- |
| panel on screen, server idle | `idlePollHz` (1/s) | every `propsSeconds` / `modelsSeconds` / `logSeconds` |
| a turn is running | `pollHz` (4/s) | same slow cadence, plus one read at the end of every turn |
| host sidebar hidden, turn running | `pollHz` (4/s) — the footer meter needs it | never |
| TUI idle, nothing visible | never | never |

The log tail reads only appended bytes, stops at the last complete line, and skips
forward past a backlog larger than its read cap, so `--log-level debug` on the
server cannot turn into a stall in your TUI.

## Configuration

`~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/mlx-serve",
      "options": {
        "metricsUrl": "http://127.0.0.1:11234/metrics.json",
        "metricsToken": "mlx-serve",
        "sections": ["throughput", "server", "queue", "latency", "cache", "memory", "spec", "sampling", "totals", "log"],
        "sparkCells": 24,
        "barCells": 18,
        "ratioCells": 8,
        "historyCells": 14,
        "historyRelative": true,
        "diskCacheGb": 100,
        "wiredLimitGb": null,
        "refreshHz": 8,
        "pollHz": 4,
        "idlePollHz": 1,
        "propsSeconds": 15,
        "modelsSeconds": 30,
        "logSeconds": 5,
        "bytesPerToken": 4.75
      }
    }
  ]
}
```

- `metricsUrl` accepts a bare base (`http://host:port`), `/metrics` or
  `/metrics.json`. `/props` and `/v1/models` are derived from its origin, and the
  log path from its port.
- `metricsToken` is sent as `Authorization: Bearer …`; it is the server's
  `--api-key`, not an OpenCode credential.
- `logPath` — the server log to tail. Defaults to
  `~/.mlx-serve/logs/mlx-serve-<port>.log` (your `$HOME`, the port from
  `metricsUrl`). Set `"logPath": "off"` for a server on another machine or
  started with `--log-file off`; the log, spec and sampling rows simply vanish.
- `sections` — sections to draw, in the order given; unknown names are ignored, an
  empty list draws only the header, and a malformed value falls back to this
  plugin's default rather than to everything. Add `"attach"` to watch the
  plugin's own health while it is healthy.
- `sparkCells: 0` removes the sparkline; `barCells: 0` makes the prefill line a
  plain rate instead of a progress bar.
- `ratioCells` — gauge width in cells (default 8; `0` draws the numbers only).
- `historyCells` / `historyRelative` — the footer histogram's width in cells (default
  14; `0` omits it) and whether it scales to its own min..max (default true, which is
  what keeps a 22-30 t/s turn looking like bumps instead of a flat block).
- `diskCacheGb` — the SSD tier's cap in GiB for the `ssd` gauge. It is the server's
  `--prefix-cache-disk` flag and appears in no log line or endpoint, so the panel
  cannot discover it; unset, the tier shows bytes with no gauge.
- `wiredLimitGb` — the wired ceiling in GiB for the `footprint` gauge. Unset, the
  plugin reads `iogpu.wired_limit_mb` once; with no value anywhere the row shows
  bytes and no gauge.
- `bytesPerToken` — only used when the server gives no token counts (no
  `--metrics`, or another client is decoding): the meter estimates tokens from
  streamed bytes.

## Deploying to another machine

Copy this directory and add the entry above. There are no absolute paths, no
hostnames and no user names in the shipped code; the defaults are mlx-serve's own
(`--port 11234`) and your `$HOME`. It needs OpenCode 2 (the CLI-plugin API and the
`sidebar.content` slot), and it degrades by section rather than failing:

| Target | What you get |
| --- | --- |
| mlx-serve started without `--metrics` | header reads `--metrics off`; the footer meter still works, from streamed bytes |
| older mlx-serve with no ANE / n-gram / live gauges | those rows are absent; nothing is invented |
| server on another host | HTTP sections work over the network; set `logPath: "off"` and the file-tail rows disappear |
| no `/props` or `/v1/models` (proxy, older build) | memory headroom and model rows drop out; the metrics feed is unaffected |
| a host API that throws | the failure is named in the `Attach` section and echoed to stderr |

## Files

| File | Role |
| --- | --- |
| `tui.tsx` | The CLI plugin: polls, event wiring, slots, and the two renderers (sidebar panel, always-on footer meter). |
| `index.ts` | Server-side plugin stub (the TUI plugin does all the work). |
| `options.ts` | `cli.json` options, defaults, and the derived /props and /v1/models origin. Pure, so it is testable. |
| `stats.ts` | Feed shapes and the math: parse `/metrics.json`, `/props`, `/v1/models`, `[spec-stats]` and request lines; trailing-window rates; histogram quantiles. No I/O. |
| `rows.ts` | All wording: `footerLabel`, panel sections, progress and sparkline bars. No I/O. |
| `logtail.ts` | Incremental read of the server log file, with rewind on rotation. |
| `tracker.ts` | Per-turn speed tracking from streamed deltas + live gauges (from the original `speed` plugin; added the prefill baseline and the concurrency rule). |
| `fixtures.ts` | Real captured payloads and log lines, shared by the tests. |
| `probe-live.ts` | Manual probe against a running server: `METRICS_URL=… PROBE_SECONDS=10 node probe-live.ts`. |

## Tests

```sh
node --test        # 102 tests, no dependencies, no network
```

`tui.tsx` is the only file outside the test run: Node strips TypeScript types but
cannot compile JSX. It is checked with `tsc --noEmit` against `@opentui/solid`'s
JSX types, and transpiled with `babel-preset-solid`
(`moduleName: "@opentui/solid"`) — the same pipeline the host runs at load time —
so a Solid-specific transform error shows up here instead of in your terminal.

## Notes on accuracy

- Prefill tok/s divides **forwarded** tokens by prefill time. Using billed prompt
  tokens instead overstates warm-cache prefill by `prompt / (prompt - cached)` —
  mlx-serve's own panel calls out a measured 10.6x.
- Live rates are windowed and go `null` when the feed goes stale, so a dead server
  does not leave a confident old number on screen.
- A rank that only the `+Inf` bucket covers is reported as the last finite bound,
  not extrapolated: p50 ttft of 3.25s is an interpolation across a 2.5s–5s bucket.
- `[spec-stats]` is per request. A request that never finished has no line yet, so
  the section shows the last completed request and ages the line.
- Counter resets (a server restart) clear the window history instead of producing
  a negative rate.
- The totals in `Server log` are what the server has done **since boot** (its own
  counters). `tool calls` is the exception and says so: `tool_msgs` counts the
  `role == "tool"` messages the last prompt carried, so it is cumulative within one
  conversation and resets on a new one — there is no server-wide tool-call counter.
- mlx-serve publishes no uptime at all, so nothing here claims to know how long the
  server has been running.
