# MLX Serve Monitor

An OpenCode 2 CLI plugin that shows what a local **mlx-serve** is doing while it
is OpenCode's model: a stats panel in the session sidebar and a turn meter in the
prompt footer.

It only reads:

```
GET /metrics.json   counters, gauges, histograms        (needs the server's --metrics)
GET /props          memory headroom, n-gram warm total  (optional)
GET /v1/models      model, kv quant, MTP head           (optional)
tail  ~/.mlx-serve/logs/mlx-serve-<port>.log            [spec-stats], request lines, cache tiers
```

MTP acceptance and the KV-cache tier sizes come from the log because the server
publishes them nowhere else. `[spec-stats]` is documented in
`mlx-serve/src/generate.zig` as a stable format for external tooling.

## Layout

| Surface | Where | Content |
| --- | --- | --- |
| Turn meter | prompt footer, always | `~1,833 tok · decode ~24.0 t/s` |
| Stats panel | session sidebar | throughput, server, prefix cache, memory, speculative decoding, sampling, server log |

There are no slash commands. OpenCode 2 `beta-19296` does not dispatch CLI-plugin
commands into the prompt, so everything is either always-on or a `cli.json`
option. To hide the panel, hide the host sidebar (`<leader>b`, or
`session.sidebar: "hide"`); that unmounts it and stops its slow reads. The turn
meter stays in the footer.

## Footer meter

```
prefill █████░░░░░░░░░░░░░ 12,288/~48,000 · 10.2k t/s · ~3s left   ← prefilling
~1,833 tok · decode ~24.0 t/s ▁▂▅█▆▃                                ← decoding
~17,453 tok · decode ~24.0 t/s · 1m15s                             ← long turn
288 tok · decode 24.0 t/s · prefill 10.0k t/s                      ← settled from usage
```

- Token counts print in full with thousands separators; rates use the compact
  form (`10.2k t/s`).
- `~` marks a count estimated from streamed bytes rather than reported by the
  server.
- The prefill bar's denominator is the previous step's forwarded token count
  (`prompt − cached`), because mlx-serve publishes `prefill_tokens_live` but the
  total only arrives in `usage` after the step. When this turn forwards more than
  the last one the bar saturates and reads `past last turn`. With no previous
  step, or `barCells: 0`, the line is `prefill 12,288 tok · 10.2k t/s`.
- The sparkline after the decode rate is this turn's decode rate, one point per
  second, sampled from the meter's own windowed `genTps` and scaled zero-to-peak
  like the panel's `60s` sparkline. A per-cell delta series was tried and
  reverted: it showed tool pauses as cliffs. Seconds with no rate are not
  sampled, and a flat or absent series draws nothing.

## Panel sections

Only sections with data are drawn, in the order given by `sections`. The `feed`
row in Server log draws even when everything else is empty, so an unreachable
server is visible rather than absent.

| Section | Rows |
| --- | --- |
| Throughput | live decode and prefill tok/s beside their since-boot averages, a 60-second sparkline, admitted req/s |
| Server | `model`, `kv-quant`, `context` (exact digits), `spec mtp head · <arch>`, a GPU gauge, `running N · M waiting` |
| Prefix cache | share of billed prompt tokens restored from cache, share of requests with a hit, `hot` and `ssd` tiers gauged against their own caps |
| Memory | heading gauge `Memory ▮▮▮▮▮▮▮░░░ 79% of 117G wired` when a ceiling is known, else a plain `footprint` row; MLX in-use vs pool, free RAM and peak, ANE bytes, n-gram table |
| Speculative Decoding | per-draft acceptance as gauge and percent, accepted per round, verify round time vs GPU→CPU sync, `gate off` when the runtime disabled speculation |
| Sampling | what the last request ran with: `temp 1.00 · p 0.95 k 20`, `max out 64000 · launch default`, `stream off`, `route responses` |
| Server log | `feed live` / `--metrics off` / `unreachable` / `401 unauthorized`; totals since boot (`tokens`, `requests`, `messages`, `tool calls`); the log file, its size and last write |
| Turn (opt-in) | the footer meter's numbers as rows |
| Attach (opt-in) | the plugin's own integration failures; appears on its own whenever a host API refused |

### One client or several

`generation_tokens_live` is a server-wide counter. With one request in flight the
footer meter and the Throughput section are the same measurement, and if `turn` is
in `sections` the Throughput row yields to the since-boot average instead of
repeating it. With two or more in flight the footer meter switches to this
session's streamed bytes (marked `~`) while Throughput keeps the server's combined
rate.

### Gauges, bars, sparklines

| Mark | Glyphs | Meaning |
| --- | --- | --- |
| gauge | `▮▮▮▮▮▮░░░░` | a level against its own limit (gpu, accept, cache tiers, wired ceiling) |
| progress | `████░░░░░░` | filling toward a total over time (prefill) |
| sparkline | `▁▂▅█▆▃` | a series over the last N cells |

With `ratioCells: 8` every row fits in 34 cells on live data; the sidebar
truncates the end of a line, so wider gauges cost the trailing figure.

### Memory ceiling

mlx-serve compares its working set against Metal's
`max_recommended_working_set_size`, which it never publishes. The plugin uses
`wiredLimitGb` if set, otherwise reads `iogpu.wired_limit_mb` once at load. With
neither it shows the footprint in bytes and draws no gauge rather than guessing a
denominator.

### Cache tier denominators

- `hot` is the RAM tier. Its log line carries its own budget, which is
  `ctx_kv_bytes + idle` (one session at the working context plus the
  `--prefix-cache-mem` idle allowance), so the gauge is measured. The flag alone
  is not the denominator.
- `ssd` is the disk tier under `~/.mlx-serve/kv-cache`. Its occupancy comes from
  the `[disk-cache] persisted … resident=` line; its cap (`--prefix-cache-disk`)
  appears nowhere, so the gauge is drawn only when `diskCacheGb` is set.

## Poll rates

| Situation | /metrics.json | /props, /v1/models, log |
| --- | --- | --- |
| panel on screen, server idle | `idlePollHz` (1/s) | every `propsSeconds` / `modelsSeconds` / `logSeconds` |
| a turn is running | `pollHz` (4/s) | same, plus one read at the end of every turn |
| sidebar hidden, turn running | `pollHz` (4/s) | never |
| idle, nothing visible | never | never |

The log tail reads only appended bytes, stops at the last complete line, and
skips forward past a backlog larger than its read cap.

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
        "sections": ["throughput", "server", "cache", "memory", "spec", "sampling", "log"],
        "sparkCells": 24,
        "barCells": 18,
        "ratioCells": 8,
        "historyCells": 14,
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

- `metricsUrl` accepts a bare origin, `/metrics` or `/metrics.json`. `/props` and
  `/v1/models` derive from its origin, the log path from its port.
- `metricsToken` is sent as `Authorization: Bearer …` (the server's `--api-key`).
- `logPath` defaults to `~/.mlx-serve/logs/mlx-serve-<port>.log`. Set `"off"` for
  a remote server or one started with `--log-file off`; the log, spec, sampling
  and cache-tier rows disappear.
- `sections` is the list of sections to draw, in order. Unknown names are
  ignored; an empty list draws nothing; a malformed value falls back to the
  default. Add `"turn"` or `"attach"` to opt those in.
- `sparkCells: 0` removes the sparkline; `barCells: 0` makes the prefill line a
  plain rate; `ratioCells: 0` draws percentages without gauges;
  `historyCells: 0` omits the footer's decode-rate sparkline.
- `diskCacheGb` is the SSD tier cap in GiB (`--prefix-cache-disk`).
- `wiredLimitGb` overrides the `iogpu.wired_limit_mb` sysctl.
- `bytesPerToken` is only used when the server gives no token counts.

## Deploying elsewhere

Copy this directory and add the entry above. There are no absolute paths or
hostnames in the code. It needs OpenCode 2 (CLI-plugin API with the
`sidebar.content` and `prompt.footer.status` slots) and degrades by section:

| Target | Result |
| --- | --- |
| mlx-serve without `--metrics` | feed reads `--metrics off`; the footer meter still works from streamed bytes |
| older mlx-serve without ANE / n-gram / live gauges | those rows are absent |
| server on another host | HTTP sections work; set `logPath: "off"` |
| no `/props` or `/v1/models` | memory headroom and model rows drop out |
| a host API that throws | named in the Attach section and echoed to stderr |

## Files

| File | Role |
| --- | --- |
| `tui.tsx` | the CLI plugin: polling, event wiring, slots, the two renderers |
| `index.ts` | server-side plugin stub |
| `options.ts` | `cli.json` options and defaults |
| `stats.ts` | parsing of `/metrics.json`, `/props`, `/v1/models` and log lines; windowed rates; formatting |
| `rows.ts` | all wording: `footerLabel` and the panel sections |
| `logtail.ts` | incremental read of the server log, with rewind on rotation |
| `tracker.ts` | per-turn speed from streamed deltas and live gauges |
| `fixtures.ts` | captured payloads and log lines for the tests |
| `probe-live.ts` | manual probe: `METRICS_URL=… PROBE_SECONDS=10 node probe-live.ts` |

## Tests

```sh
node --test
```

No dependencies, no network. `tui.tsx` is JSX the host transpiles at load time
and is not covered by the test run.

## Accuracy notes

- Prefill tok/s divides forwarded tokens by prefill time. Billed prompt tokens
  would overstate warm-cache prefill by `prompt / (prompt − cached)`.
- Live rates are windowed and go `null` when the feed goes stale.
- `[spec-stats]` is per request; the section shows the last completed request and
  ages the line.
- Counter resets (a server restart) clear the window history instead of producing
  a negative rate.
- Totals in Server log are the server's own since-boot counters. `tool calls` is
  the `role == "tool"` message count of the last prompt, so it is per
  conversation.
- mlx-serve publishes no uptime, so nothing here claims one.
