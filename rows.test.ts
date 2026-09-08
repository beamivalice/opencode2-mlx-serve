import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCacheTier, parseFeed, parseModels, parseProps, parseSampling, parseSpecStats, progressBar, ServiceTracker } from "./stats.ts"
import {
  ALL_SECTIONS,
  SECTION_TITLES,
  buildSections,
  clip,
  footerLabel,
  footerSpark,
  memoryGauge,
  DIAGNOSTIC_SECTION,
  feedStatus,
  resolveSections,
  turnRows,
  type PanelInput,
  type SidebarRow,
} from "./rows.ts"
import { HOT_TIER_LINE, SSD_TIER_LINE, CHAT_LINE, GATED_LINE, LIVE_MODELS, LIVE_PROPS, MTP_LINE, RESPONSES_LINE, feed } from "./fixtures.ts"
import type { LogStatus, Observed } from "./logtail.ts"
import type { SamplingStats, ServiceStats } from "./stats.ts"
import type { SpeedValue } from "./tracker.ts"

const NOW = 1_800_000_000_000

function observed<T>(value: T, at = NOW, historic = false): Observed<T> {
  return { value, at, historic }
}

function logStatus(part: Partial<LogStatus> = {}): LogStatus {
  return {
    path: "/Users/beam/.mlx-serve/logs/mlx-serve-11234.log",
    name: "mlx-serve-11234.log",
    bytes: 302 * 1024,
    mtimeMs: NOW - 1_500,
    error: null,
    lines: 4,
    pending: 0,
    dropped: 0,
    ...part,
  }
}

/** A tracker fed the live payload twice, so both rates and averages exist. */
function service(overrides: { counters?: never; gauges?: never } = {}): ServiceStats {
  const t = new ServiceTracker()
  t.sample(feed(), NOW - 4_000)
  t.sample(feed(), NOW)
  t.noteProps(parseProps(LIVE_PROPS))
  const stats = t.statsAt(NOW)
  assert.ok(stats)
  return stats
}

function speed(overrides: Partial<SpeedValue> = {}): SpeedValue {
  return {
    phase: "generate",
    prefillTokens: 128_000,
    prefillBaseline: null,
    prefillTps: 4200,
    genTokens: 1400,
    genTps: 24.6,
    ramGb: 73.3,
    ttftMs: 430,
    elapsedMs: 62_000,
    tokensEstimated: false,
    metricsOk: true,
    ...overrides,
  }
}

function input(part: Partial<PanelInput> = {}): PanelInput {
  return {
    speed: null,
    service: service(),
    model: parseModels(LIVE_MODELS),
    spec: observed(parseSpecStats(MTP_LINE)!),
    sampling: observed(parseSampling(CHAT_LINE)!),
    log: logStatus(),
    sparkCells: 0,
    barCells: 0,
    now: NOW,
    link: "live",
    ...part,
  }
}

/** As the TUI draws it: a row with an empty label is a continuation line. */
const text = (rows: readonly SidebarRow[]) =>
  rows.map((r) => `${r.label === "" ? "" : `${r.label} `}${r.value}${r.note ? ` ${r.note}` : ""}`)

const render = (sec: { rows: readonly SidebarRow[] }) => text(sec.rows)

const obs = <T,>(value: T) => ({ value, at: NOW, historic: false })

/** The Prefix cache section as the panel draws it, with the tiers it was handed. */
const cacheRowsOf = (part: Partial<PanelInput>) =>
  text(buildSections(input(part), ["cache"])[0]?.rows ?? [])

const section = (name: string, i: PanelInput = input()) =>
  buildSections(i, [name as never]).flatMap((s) => text(s.rows))

// --- header ----------------------------------------------------------------

test("the feed status is one row, not a title", () => {
  assert.deepEqual(feedStatus(service().link), { value: "live", tone: "live" })
  const link = (which: "disabled" | "down" | "unauthorized" | "unknown") => {
    const t = new ServiceTracker()
    if (which !== "unknown") t.sample(feed(), NOW)
    t.noteLink(which)
    return feedStatus(which === "unknown" ? undefined : t.statsAt(NOW)?.link ?? t.linkState())
  }
  assert.deepEqual(link("disabled"), { value: "--metrics off", tone: "warn" }, "a server without --metrics is a config fact, not an outage")
  assert.deepEqual(link("down"), { value: "unreachable", tone: "error" })
  assert.deepEqual(link("unauthorized"), { value: "401 unauthorized", tone: "error" })
  assert.deepEqual(link("unknown"), { value: "connecting", tone: "muted" })
  assert.deepEqual(feedStatus(undefined), { value: "connecting", tone: "muted" })
})

test("turn rows are the footer meter, line by line", () => {
  assert.deepEqual(section("turn", input({ speed: speed() })), [
    "decode 24.6 t/s · 1.4k tok",
    "prefill 4200 t/s 128.0k tok · last",
    "ttft 430ms · turn 1m02s",
  ])
})

test("turn rows say what they are while the prompt is still being read", () => {
  assert.deepEqual(text(turnRows(speed({ phase: "prefill", genTps: null, genTokens: 0, ttftMs: null }))), [
    "prefill 4200 t/s · 128.0k tok",
  ])
  assert.deepEqual(
    text(turnRows(speed({ phase: "prefill", prefillTps: null, prefillTokens: null, genTps: null, ttftMs: null, elapsedMs: 400 }))),
    ["prefill waiting · 0.4s"],
  )
  assert.deepEqual(turnRows(null), [])
})

test("turn rows keep the estimate marker the footer HUD had", () => {
  const rows = turnRows(speed({ tokensEstimated: true }))
  assert.equal(rows[0]?.value, "~24.6 t/s", "byte-estimated tokens are marked as estimates")
  assert.equal(rows[0]?.note, "· ~1.4k tok")
})

// --- server sections -------------------------------------------------------

test("throughput shows live rates when the server is busy and averages when it is not", () => {
  const busy = new ServiceTracker()
  busy.sample(feed({ gauges: { generation_tokens_live: 1000, requests_running: 1 } }), NOW - 1_000)
  busy.sample(feed({ gauges: { generation_tokens_live: 1030, requests_running: 1 } }), NOW)
  assert.deepEqual(buildSections(input({ service: busy.statsAt(NOW)! }), ["throughput"])[0]?.rows.length, 1)
  assert.equal(section("throughput", input({ service: busy.statsAt(NOW)! }))[0], "decode 30.0 t/s · avg 68.9")

  const idle = new ServiceTracker()
  idle.sample(feed({ gauges: { requests_running: 0, requests_prefilling: 0 } }), NOW)
  assert.deepEqual(section("throughput", input({ service: idle.statsAt(NOW)! })), [
    "prefill 1311 t/s · avg",
    "decode 68.9 t/s · avg",
  ])
})

test("the prefill bar fills against the yardstick, saturates past it", () => {
  assert.equal(progressBar(0.5, 12), "██████░░░░░░")
  assert.equal(progressBar(0, 4), "░░░░")
  assert.equal(progressBar(null, 4), "░░░░", "unknown progress is an empty bar, never a half one")
  assert.equal(progressBar(2, 4), "████", "a turn bigger than the yardstick saturates instead of throwing")
  assert.equal(progressBar(0.3, 0), "", "zero cells means no bar at all")
})

test("prefill becomes a progress bar with speed and x/y tokens", () => {
  const rows = turnRows(
    speed({
      phase: "prefill",
      prefillTokens: 12_400,
      prefillBaseline: 48_000,
      prefillTps: 1_600,
      genTps: null,
      ttftMs: null,
    }),
    1,
    12,
  )
  assert.deepEqual(text(rows), [
    "prefill ███░░░░░░░░░ 12.4k/~48.0k",
    "1600 t/s · ~22s left",
  ])
})

test("the bar's denominator is marked as an estimate", () => {
  const rows = turnRows(
    speed({ phase: "prefill", prefillTokens: 1_000, prefillBaseline: 4_000, prefillTps: null, genTps: null, ttftMs: null }),
    1,
    8,
  )
  assert.deepEqual(text(rows), ["prefill ██░░░░░░ 1.0k/~4.0k", "measuring"])
})

test("no yardstick yet: the prefill line stays a plain rate", () => {
  const firstTurn = speed({ phase: "prefill", prefillTokens: 8_192, prefillBaseline: null, genTps: null, ttftMs: null })
  assert.deepEqual(text(turnRows(firstTurn, 1, 12)), ["prefill 4200 t/s · 8.2k tok"])
  const cold = speed({ phase: "prefill", prefillTokens: null, prefillBaseline: null, prefillTps: null, genTps: null, ttftMs: null })
  assert.deepEqual(text(turnRows(cold, 1, 12)), ["prefill waiting · 1m02s"], "nothing to measure, so nothing is invented")
})

test("barCells 0 keeps the old two-line meter exactly", () => {
  const rows = turnRows(speed({ phase: "prefill", genTps: null, ttftMs: null }), 1, 0)
  assert.deepEqual(text(rows), ["prefill 4200 t/s · 128.0k tok"])
})

test("the footer's decode history is a histogram of the number beside it", () => {
  assert.equal(footerSpark([24, 26, 25, 30, 22], 5), "\u2583\u2585\u2584\u2588\u2581", "min..max: the bumps are the point")
  assert.equal(footerSpark([24, 26, 25, 30, 22], 5, false), "\u2587\u2587\u2587\u2588\u2586", "zero-based reads as one flat block")
  assert.equal(footerSpark([30, 30, 30, 30], 4), "", "flat means nothing to see: a row of equal bars reads as a trend")
  assert.equal(footerSpark([1, 2], 0), "", "cells 0 omits the histogram")
  assert.equal(footerSpark([1], 8), "", "one point is not a history")
  assert.equal(footerSpark(null, 8), "")
  assert.equal(footerSpark([0, 0, 0], 3), "", "an all-zero series draws nothing, not a baseline")
  assert.equal(footerSpark(Array.from({ length: 40 }, (_, k) => k), 6).length, 6, "a long history is cut to the cells asked for")
})

test("the footer line reads rate then its histogram", () => {
  const hist = { historyCells: 6, series: [20, 24, 28, 26, 30, 22] }
  assert.equal(footerLabel(speed({ prefillTps: null }), hist), "1,400 tok \u00b7 decode 24.6 t/s \u2581\u2584\u2587\u2585\u2588\u2582 \u00b7 1m02s")
  assert.equal(footerLabel(speed({ prefillTps: null })), "1,400 tok \u00b7 decode 24.6 t/s \u00b7 1m02s", "no series, no bars")
  assert.equal(
    footerLabel(speed({ prefillTps: null }), { historyCells: 6, series: [30, 30, 30] }),
    "1,400 tok \u00b7 decode 24.6 t/s \u00b7 1m02s",
    "steady is flat, and flat is not a story",
  )
  assert.equal(
    footerLabel(speed({ elapsedMs: 20_000 }), hist),
    "1,400 tok \u00b7 decode 24.6 t/s \u2581\u2584\u2587\u2585\u2588\u2582 \u00b7 prefill 4200 t/s",
    "the histogram stays attached to the decode rate, ahead of the other clauses",
  )
  // A rate that has not settled yet still shows its shape: the series is the
  // history, and a stall in it is exactly what you want visible.
  assert.equal(
    footerLabel(speed({ genTps: null }), { historyCells: 4, series: [24, 20, 0, 0] }),
    "1,400 tok \u00b7 decode \u2588\u2587\u2581\u2581 \u00b7 prefill 4200 t/s \u00b7 1m02s",
  )
})
test("one client in flight: throughput does not repeat the turn's rate", () => {
  const busy = new ServiceTracker()
  busy.sample(feed({ gauges: { generation_tokens_live: 1000, requests_running: 1 } }), NOW - 1_000)
  busy.sample(feed({ gauges: { generation_tokens_live: 1030, requests_running: 1 } }), NOW)
  const stats = busy.statsAt(NOW)
  assert.ok(stats)
  const rows = buildSections(
    input({ speed: speed({ genTps: 30, prefillTps: null, prefillTokens: null, ttftMs: null }), service: stats }),
    ["turn", "throughput"],
  ).flatMap(render)
  assert.deepEqual(rows, ["decode 30.0 t/s · 1.4k tok", "decode avg 68.9 t/s · since boot"])
})

test("two clients in flight: both rates stay, and the turn's names the crowd", () => {
  const busy = new ServiceTracker()
  busy.sample(feed({ gauges: { generation_tokens_live: 1000, requests_running: 2 } }), NOW - 1_000)
  busy.sample(feed({ gauges: { generation_tokens_live: 1130, requests_running: 2 } }), NOW)
  const stats = busy.statsAt(NOW)
  assert.ok(stats)
  assert.equal(stats.running, 2)
  const rows = buildSections(
    input({ speed: speed({ genTps: 12.5, prefillTps: null, prefillTokens: null, ttftMs: null }), service: stats }),
    ["turn", "throughput"],
  ).flatMap(render)
  assert.deepEqual(rows, ["decode 12.5 t/s · 1.4k tok · 2 clients", "decode 130 t/s · avg 68.9"])
  assert.equal(rows.length, 2, "two clients: the server-wide rate is a different measurement, so it stays")
})

test("the sparkline row is opt-in by cells and never stretches past them", () => {
  const busy = new ServiceTracker()
  for (let i = 0; i < 6; i++) {
    busy.sample(feed({ gauges: { generation_tokens_live: 1000 + i * 10, requests_running: 1 } }), NOW - (5 - i) * 1_000)
  }
  const rows = buildSections(input({ service: busy.statsAt(NOW)!, sparkCells: 8 }), ["throughput"])[0]?.rows ?? []
  const spark = rows.find((r) => r.label === "60s")
  assert.ok(spark)
  assert.equal(spark.value.length, 6, "six seconds of history draw six cells, not eight")
  assert.equal(sparklineWidth(spark.value), 6)
})

/** Sparkline blocks are one cell each regardless of byte length. */
function sparklineWidth(spark: string): number {
  return [...spark].length
}

test("cache rows read from the feed alone", () => {
  assert.deepEqual(section("cache"), ["tokens 62% · from cache", "requests 60% · had a hit"])
})

test("the queue has no section of its own any more", () => {
  assert.deepEqual(buildSections(input(), ["queue" as never]), [], "unknown names draw nothing, they do not fall back")
  assert.equal(section("server").at(-1), "running 1 · 0 waiting")
})

test("memory rows carry the allocator split and the accelerator warm", () => {
  assert.deepEqual(section("memory"), [
    "footprint 73.3G",
    "mlx in use 72.1G · pool 0.7G",
    "ram free 44.5G · peak 75.7G",
    "ngram 29.8G",
  ])

  const partial = new ServiceTracker()
  partial.sample(parseFeed({ gauges: { memory_mb: 1000 } }), NOW)
  assert.deepEqual(section("memory", input({ service: partial.statsAt(NOW)! })), ["footprint 1.0G"], "no props, no claims")

  const warming = { ...service(), ngramBytes: 8 * 1024 ** 3, ngramProgress: 0.25 }
  assert.deepEqual(text(memoryRowsOf(warming)).at(-1), "ngram 25% · 8.0G read", "a partial warm is a percentage")
})

function memoryRowsOf(s: ServiceStats): readonly SidebarRow[] {
  return buildSections(input({ service: s }), ["memory"])[0]?.rows ?? []
}

test("Server carries identity, the gpu bar, and the merged queue line", () => {
  assert.deepEqual(section("server"), [
    "model Qwen3.8-Flash-Next",
    "kv-quant 8-bit",
    "context 1,048,576",
    "spec mtp head \u00b7 qwen4_exp",
    "gpu 63%",
    "running 1 · 0 waiting",
  ])
})

test("Server stops reciting the model card", () => {
  const lines = section("server")
  assert.equal(lines.some((l) => l.includes("4-bit")), false, "weight quantization is not a serving statistic")
  assert.equal(lines.some((l) => /layers/.test(l)), false, "layer count never changes while it runs")
  assert.equal(lines.some((l) => /moe/.test(l)), false, "is_moe explains nothing about this turn")
  assert.ok(lines.every((l) => [...l].length <= 34), `every Server line must fit the sidebar: ${lines.filter((l) => [...l].length > 34).join(" / ")}`)
  assert.ok(lines.includes("model Qwen3.8-Flash-Next"), "the architecture left the model row, not the panel")
  assert.ok(lines.includes("context 1,048,576"), "exact count, the way the host writes its context meter")
})

test("a third client waiting shows on the merged queue line", () => {
  const loaded = new ServiceTracker()
  loaded.sample(feed({ gauges: { requests_running: 2, requests_waiting: 3, requests_prefilling: 1 } }), NOW)
  assert.equal(section("server", input({ service: loaded.statsAt(NOW) })).at(-1), "running 2 · 3 waiting · 1 prefilling")
})

test("Server still names the model when nothing is running", () => {
  const idle = new ServiceTracker()
  idle.sample(feed({ gauges: { requests_running: 0, requests_waiting: 0, gpu_utilization_pct: 0 } }), NOW)
  assert.deepEqual(section("server", input({ service: idle.statsAt(NOW) })), [
    "model Qwen3.8-Flash-Next",
    "kv-quant 8-bit",
    "context 1,048,576",
    "spec mtp head \u00b7 qwen4_exp",
    "running 0 · 0 waiting",
  ], "gpu 0% draws no row: an idle GPU every second is not information")
})

test("no model loaded: the queue line is still worth drawing", () => {
  assert.deepEqual(section("server", input({ model: null })), ["gpu 63%", "running 1 · 0 waiting"])
})

test("a declared wired limit puts the gauge on the Memory heading, not a row", () => {
  const withCeiling = buildSections(input({ wiredLimitGb: 117.1875, ratioCells: 10 }), ["memory"])[0]
  assert.ok(withCeiling)
  assert.equal(withCeiling.note, "▮▮▮▮▮▮░░░░ 63% of 117G wired", "the section's own reading, on its own line")
  assert.deepEqual(text(withCeiling.rows), [
    "mlx in use 72.1G · pool 0.7G",
    "ram free 44.5G · peak 75.7G",
    "ngram 29.8G",
  ], "no footprint row: it would repeat the heading")

  assert.match(buildSections(input({ wiredLimitGb: 77 }), ["memory"])[0].note ?? "", /95% of 77.0G wired/)
  assert.match(buildSections(input({ wiredLimitGb: 80 }), ["memory"])[0].note ?? "", /92% of 80.0G wired/)

  const without = buildSections(input(), ["memory"])[0]
  assert.equal(without.note, undefined, "no declaration, no gauge")
  assert.equal(text(without.rows)[0], "footprint 73.3G", "bytes alone, exactly as before")
})

test("memoryGauge only speaks when it has a declared ceiling", () => {
  assert.equal(memoryGauge(input()), null, "nothing declared")
  assert.equal(memoryGauge(input({ wiredLimitGb: 0 })), null, "zero is not a ceiling")
  const noBar = memoryGauge(input({ wiredLimitGb: 117.1875, ratioCells: 0 }))?.note ?? ""
  assert.equal(noBar, "63% of 117G wired", "cells 0 drops the gauge but keeps the reading, with no stray space")
  assert.equal(memoryGauge(input({ service: null, wiredLimitGb: 117 })), null, "no feed, no claim")
})
test("acceptance keeps the gauge, the percent, and only room for one note", () => {
  const withBar = text(buildSections(input({ ratioCells: 8 }), ["spec"])[0]?.rows ?? [])
  assert.equal(withBar[0], "accept ▮▮▮▮▮░░░ 67.7% · 191/282", "bar and percent lead; the counts shrink to fit")
  assert.equal([...withBar[0]].length <= 34, true, "the percent must survive a 34-column sidebar")
  const noBar = text(buildSections(input({ ratioCells: 0 }), ["spec"])[0]?.rows ?? [])
  assert.equal(noBar[0], "accept 67.7% · 191/282 drafts", "with no bar the note spells out what it counts")
})

test("spec rows report acceptance, per-round yield and round cost", () => {
  assert.deepEqual(section("spec"), [
    "accept 67.7% · 191/282 drafts",
    "per round 1.14 tok · 168 rounds",
    "round 47ms · sync 2.93ms",
  ])
  assert.equal(section("spec").some((r) => /^spec /.test(r)), false, "no mode-and-age line: Server already names the decoder")
})

test("spec rows name the runtime gate when it goes off", () => {
  const rows = section("spec", input({ spec: observed(parseSpecStats(GATED_LINE)!) }))
  assert.deepEqual(rows, [
    "accept 38.4% · 89/232 drafts",
    "per round 1.62 tok · 55 rounds",
    "round 35ms · sync 3.60ms",
    "gate off · adaptive → serial",
  ], "speculation stopped mid-request: the headline fact")
})

test("spec modes without a fixed depth report tokens per round", () => {
  const pld = parseSpecStats("[spec-stats] mode=pld attempts=410 accepts=612 avg_per_round=1.49 runtime_disabled=false")!
  assert.deepEqual(section("spec", input({ spec: observed(pld) })), ["accept 1.49 tok/round · 612/410 rounds"])
})

test("a stale spec line still shows its numbers, unaged", () => {
  const old = observed(parseSpecStats(MTP_LINE)!, NOW - 20 * 60_000)
  assert.deepEqual(section("spec", input({ spec: old })), [
    "accept 67.7% · 191/282 drafts",
    "per round 1.14 tok · 168 rounds",
    "round 47ms · sync 2.93ms",
  ], "the acceptance of the last finished request is still true 20 minutes later")
})

// --- sampling --------------------------------------------------------------

test("sampling rows show the params the last request ran with", () => {
  assert.deepEqual(section("sampling"), [
    "temp 1.00 · p 0.95 k 20",
    "max out 64000 · launch default",
  ])
})

test("sampling rows note the route only when it is not chat completions", () => {
  const responses = observed(parseSampling(RESPONSES_LINE)!)
  assert.deepEqual(section("sampling", input({ sampling: responses })), [
    "temp 0.70",
    "max out 4096",
    "route responses",
  ])
})

test("sampling rows say nothing when the log has no request in it", () => {
  assert.deepEqual(section("sampling", input({ sampling: null })), [])
  const nan = observed(parseSampling(CHAT_LINE.replace("temp=1.00", "temp=nan"))!)
  assert.equal(text(samplingRowsOf(nan))[0], "temp unknown · p 0.95 k 20")
})

function samplingRowsOf(s: Observed<SamplingStats> | null): readonly SidebarRow[] {
  return buildSections(input({ sampling: s }), ["sampling"])[0]?.rows ?? []
}

// --- log section -----------------------------------------------------------

test("log rows point at the file and its freshness", () => {
  assert.deepEqual(logRowsOf(logStatus()), [
    "feed live",
    "tokens 347.3k in · 3.3k out",
    "requests 15 ok · 0 cancelled",
    "messages req 127",
    "tool calls 68 · this session",
    "log mlx-serve-11234.log · 302K",
    "last write just now",
  ])
  assert.deepEqual(logRowsOf(logStatus({ error: "no log file", bytes: null, mtimeMs: null })), [
    "feed live",
    "tokens 347.3k in · 3.3k out",
    "requests 15 ok · 0 cancelled",
    "messages req 127",
    "tool calls 68 · this session",
    "log mlx-serve-11234.log · no log file",
  ], "the name still shows, so the user knows which file is missing")
  assert.deepEqual(logRowsOf(logStatus({ mtimeMs: NOW - 3_600_000 })), [
    "feed live",
    "tokens 347.3k in · 3.3k out",
    "requests 15 ok · 0 cancelled",
    "messages req 127",
    "tool calls 68 · this session",
    "log mlx-serve-11234.log · 302K",
    "last write 60m00s ago",
  ])
  assert.deepEqual(logRowsOf(logStatus({ dropped: 40 * 1024 })), [
    "feed live",
    "tokens 347.3k in · 3.3k out",
    "requests 15 ok · 0 cancelled",
    "messages req 127",
    "tool calls 68 · this session",
    "log mlx-serve-11234.log · 302K",
    "last write just now",
    "tail +40K · unread",
  ])
  assert.deepEqual(logRowsOf(null), [
    "feed live · log tail off",
    "tokens 347.3k in · 3.3k out",
    "requests 15 ok · 0 cancelled",
    "messages req 127",
    "tool calls 68 · this session",
    "log not tailed · logPath off",
  ], "the feed row answers for the whole section when there is no file to point at")
  assert.deepEqual(buildSections(input({ log: null, link: "down" }), ["log"])[0].rows[0], { label: "feed", value: "unreachable", tone: "error" }, "a dead server still shows, in red")
})

function logRowsOf(log: LogStatus | null): string[] {
  const rows = buildSections(input({ log }), ["log"])[0]?.rows ?? []
  return rows.map((r) => `${r.label} ${r.value}${r.note ? ` ${r.note}` : ""}`)
}

// --- assembly --------------------------------------------------------------

test("buildSections keeps the requested order and drops empty sections", () => {
  const input0 = input({ speed: speed(), sparkCells: 0 })
  const names = (i: PanelInput) => buildSections(i, resolveSections(["log", "turn", "cache", "nosuch"])).map((s) => s.name)
  assert.deepEqual(names(input0), ["log", "turn", "cache"], "order follows the user's list, not ours")
  assert.deepEqual(names({ ...input0, log: null, service: null }), ["log", "turn"], "only the feed row survives a dead server")
})

test("every section has a title and every default section draws", () => {
  assert.deepEqual([...ALL_SECTIONS, DIAGNOSTIC_SECTION], Object.keys(SECTION_TITLES))
  const full = buildSections(input({ speed: speed() }), ALL_SECTIONS)
  assert.deepEqual(full.map((s) => s.title), [...ALL_SECTIONS].map((n) => SECTION_TITLES[n]))
  assert.equal(full.length, ALL_SECTIONS.length, `missing sections: ${ALL_SECTIONS.filter((n) => !full.some((s) => s.name === n)).join(",")}`)
})

test("the KV cache tiers gauge themselves, without the entry count", () => {
  const hot = parseCacheTier(HOT_TIER_LINE)!
  const ssd = parseCacheTier(SSD_TIER_LINE)!
  assert.deepEqual(hot, { kind: "hot", residentMb: 9481.06, capMb: 28672, entries: 1, maxEntries: 1, wroteMb: null, persistedTokens: null, totalTokens: null })
  assert.equal(ssd.capMb, null, "the SSD cap is a launch flag; no log line carries it")
  const rows = cacheRowsOf({ hot: obs(hot), ssd: obs(ssd), diskCacheGb: 100, ratioCells: 8 })
  assert.deepEqual(rows, [
    "tokens 62% · from cache",
    "requests 60% · had a hit",
    "hot \u25ae\u25ae\u25ae\u2591\u2591\u2591\u2591\u2591 33% · 9.3G/28.0G",
    "ssd \u25ae\u2591\u2591\u2591\u2591\u2591\u2591\u2591 11% · 10.7G/100G",
  ])
  assert.equal(rows.some((l) => l.includes("entries")), false, "the entry count is the first thing cut, so it is not drawn")
  for (const l of rows) assert.ok([...l].length <= 34, `${l} is ${[...l].length} cells`)
  for (const l of rows) assert.ok([...l].length <= 32, `${l} must fit the sidebar without clipping its bytes`)
  assert.equal(rows[2].includes("budget"), false, "naming the denominator cost the bytes their place; the README says what they are")
})

test("an undeclared SSD cap draws bytes and no gauge", () => {
  const ssd = parseCacheTier(SSD_TIER_LINE)!
  assert.deepEqual(cacheRowsOf({ ssd: obs(ssd), diskCacheGb: null, ratioCells: 10 }), [
    "tokens 62% · from cache",
    "requests 60% · had a hit",
    "ssd 10.7G",
  ], "no invented denominator, and no entry count to fill the space")
  assert.deepEqual(cacheRowsOf({ hot: obs(parseCacheTier("[hot-cache] resident=9481.06 MB (1/2 entries)")!), ratioCells: 10 }), [
    "tokens 62% · from cache",
    "requests 60% · had a hit",
    "hot 9.3G",
  ], "the cap-less hot-cache line variant reports bytes only, like an undeclared SSD")
})

test("no cache tiers in the log means no tier rows", () => {
  assert.deepEqual(cacheRowsOf({ ratioCells: 8 }), ["tokens 62% · from cache", "requests 60% · had a hit"])
  assert.deepEqual(cacheRowsOf({ hot: obs(parseCacheTier("[hot-cache] resident=0.00 / 28672.00 MB (0/1 entries)")!), ratioCells: 8 }), [
    "tokens 62% · from cache",
    "requests 60% · had a hit",
  ], "an empty tier draws nothing")
})


test("the attach section stays out of the panel while the plugin is healthy", () => {
  assert.deepEqual(buildSections(input({ speed: speed() }), ["attach"]), [])
  assert.deepEqual(buildSections(input({ speed: speed(), attachErrors: [] }), ["attach"]), [])
})

test("an integration that threw is named on screen instead of hidden", () => {
  const rows = buildSections(
    input({ attachErrors: [{ where: "slot", detail: "TypeError: ctx.ui.slot is not a function" }, { where: "store", detail: "denied" }] }),
    ["attach"],
  )
  assert.deepEqual(render(rows[0] ?? { rows: [] }), [
    "slot TypeError: ctx.ui.slot is not a f… · degraded",
    "store denied · degraded",
  ])
  assert.equal(clip("abcdefghij", 6), "abcde…")
  assert.equal(clip("short", 12), "short", "nothing to truncate")
})

test("rows fit a narrow sidebar", () => {
  const wide = input({ speed: speed(), sparkCells: 24 })
  for (const s of buildSections(wide, ALL_SECTIONS)) {
    for (const r of s.rows) {
      const line = `${r.label} ${r.value}${r.note ? ` ${r.note}` : ""}`
      assert.ok([...line].length <= 40, `${s.name}/${line} is ${[...line].length} cells wide`)
      assert.ok(r.label.length <= 11, `label ${r.label} crowds the value column`)
    }
  }
})

test("resolveSections is permissive about typos and strict about order", () => {
  assert.deepEqual(resolveSections(undefined), [...ALL_SECTIONS])
  assert.deepEqual(resolveSections(["log", "turn"]), ["log", "turn"])
  assert.deepEqual(resolveSections(["turn", "bogus"]), ["turn"])
  assert.deepEqual(resolveSections([]), [], "an explicit empty list draws only the header")
})
