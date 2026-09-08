/**
 * What the sidebar actually draws: one `SidebarRow` per statistic, grouped into
 * sections. Pure functions over the values `stats.ts` and `logtail.ts` produce,
 * so the wording of every line is testable without a terminal.
 *
 * A row is `label value · note` — label and note dim, value bright — which is
 * how the host's own sidebar sections read (bold title, subdued lines). Lines
 * aim to stay under ~30 cells: the sidebar is a narrow column, so it is better
 * to drop a note than to wrap a row.
 */

import {
  fmtBytes,
  fmtCount,
  fmtDur,
  fmtGib,
  fmtMs,
  fmtMsFine,
  fmtExact,
  fmtRate,
  levelBar,
  mbToGb,
  progressBar,
  sparkline,
  wiredCeilingGb,
  type ModelStats,
  type SamplingStats,
  type ServiceStats,
  type SpecStats,
  type CacheTier,
  type Link,
} from "./stats.ts"
import type { LogStatus, Observed } from "./logtail.ts"
import type { SpeedValue } from "./tracker.ts"

export interface SidebarRow {
  /** Dimmed key. */
  readonly label: string
  /** Colour for the value: a status worth colouring, a number that is not. */
  readonly tone?: Tone
  /** The statistic, in the default (bright) colour. */
  readonly value: string
  /** Dimmed trailing context, carrying its own `· ` separator. */
  readonly note?: string
  /** Draw the note in the value colour: a second statistic, not an aside. */
  readonly noteBright?: boolean
}

export interface SidebarSection {
  readonly name: SectionName
  readonly title: string
  /** A gauge that belongs to the section itself, drawn on the heading line in the value colour. */
  readonly note?: string
  readonly rows: readonly SidebarRow[]
}

export type SectionName =
  | "turn"
  | "throughput"
  | "server"
  | "cache"
  | "memory"
  | "spec"
  | "sampling"
  | "log"
  | "attach"

export const ALL_SECTIONS: readonly SectionName[] = [
  "turn",
  "throughput",
  "server",
  "cache",
  "memory",
  "spec",
  "sampling",
  "log",
]

/**
 * Not in `ALL_SECTIONS`, and not drawn while the plugin is healthy: it is about
 * this plugin, not the server. Add `"attach"` to `sections` to see it always.
 */
export const DIAGNOSTIC_SECTION = "attach"

export const DEFAULT_SECTIONS: readonly SectionName[] = [...ALL_SECTIONS]

export const SECTION_TITLES: Readonly<Record<SectionName, string>> = {
  turn: "Turn",
  throughput: "Throughput",
  server: "Server",
  cache: "Prefix cache",
  memory: "Memory",
  spec: "Speculative Decoding",
  sampling: "Sampling",
  log: "Server log",
  attach: "Attach",
}

/**
 * Sections a user asked for, in their order; unknown names are dropped. Anything
 * that is not a list at all yields `fallback` — the caller's default, which is
 * not the same thing as "everything".
 */
export function resolveSections(raw: unknown, fallback: readonly SectionName[] = ALL_SECTIONS): SectionName[] {
  if (!Array.isArray(raw)) return [...fallback]
  const known = new Set<string>(ALL_SECTIONS)
  return raw.filter((name): name is SectionName => typeof name === "string" && known.has(name))
}

function row(label: string, value: string, note?: string, tone?: Tone): SidebarRow {
  const base: SidebarRow = note ? { label, value, note } : { label, value }
  return tone ? { ...base, tone } : base
}

/** ` 12m ago` when the newest log line of this kind predates our attention span. */
function ageNote(observed: Observed<unknown>, now: number): string | undefined {
  const age = Math.max(0, now - observed.at)
  if (age < 90_000) return undefined
  return `· ${fmtDur(age)} ago`
}

// ---------------------------------------------------------------------------
// Link status
// ---------------------------------------------------------------------------

export type Tone = "live" | "warn" | "error" | "muted"

/**
 * How the last /metrics.json read went. It used to be the panel's title line;
 * it is a row in `Server log` now, because the panel's name is not information
 * and "is the server answering" is.
 */
export function feedStatus(link: Link | undefined): { value: string; tone: Tone } {
  switch (link ?? "unknown") {
    case "live":
      return { value: "live", tone: "live" }
    case "disabled":
      return { value: "--metrics off", tone: "warn" }
    case "down":
      return { value: "unreachable", tone: "error" }
    case "unauthorized":
      return { value: "401 unauthorized", tone: "error" }
    default:
      return { value: "connecting", tone: "muted" }
  }
}

/**
 * What is loaded, how busy the GPU is, and whether anyone is using it. These
 * were three sections (Server, part of Memory, Queue): each row is one line about
 * the same machine and none needs a heading of its own.
 *
 * The model's own weight quantization is left out on purpose — `4-bit` says what
 * the checkpoint is, not what the server is doing, and the sidebar is not a model
 * card. The KV quantization is kept because it sets the memory ceiling per token.
 */
function serverRows(model: ModelStats | null, service: ServiceStats | null | undefined, cells: number): SidebarRow[] {
  const rows: SidebarRow[] = []
  if (model) {
    // Bytes of the model's identity lead the section; the architecture is drawn on
    // the `spec` row, where it fits and means something.
    rows.push(row("model", model.shortId))
    if (model.kvQuant !== null) rows.push(row("kv-quant", `${model.kvQuant}-bit`))
    if (model.contextLength !== null) rows.push(row("context", fmtExact(model.contextLength)))
    if (model.mtpLoaded || model.drafterLoaded) {
      const which = model.mtpLoaded ? "mtp head" : "drafter"
      // The architecture used to hang off the `model` row and pushed it to 36
      // cells; the sidebar cuts the END of a line, so the suffix was eating the
      // model name. Here it fits (26 cells) and belongs anyway: the architecture
      // is why an MTP head exists. Dropped when `+ drafter` would overflow.
      const notes = [model.mtpLoaded && model.drafterLoaded ? "+ drafter" : null, model.architecture].filter(
        (n): n is string => n !== null,
      )
      let note = notes.length > 0 ? `· ${notes.join(" · ")}` : undefined
      if (note !== undefined && 4 + which.length + note.length > 34) note = undefined
      rows.push(row("spec", which, note))
    }
  }
  // Utilisation belongs with the machine's identity. A bar because the trend is
  // the information: one digit read once a second cannot say "it has been pinned
  // for a minute", and 100% here is normal, not a warning.
  if (service && service.gpuPct > 0) {
    const pct = Math.max(0, Math.min(100, service.gpuPct))
    rows.push(row("gpu", `${gauge(pct / 100, cells)}${pct}%`))
  }
  // The old Queue section, as one line.
  if (service) {
    const waiting = `${service.waiting} waiting`
    const busy = service.prefilling > 0 ? ` · ${service.prefilling} prefilling` : ""
    rows.push(row("running", `${service.running} · ${waiting}${busy}`))
  }
  return rows
}

/**
 * The panel's one gauge style: `\u25ae\u25ae\u25ae\u25ae\u25af\u25af\u25af\u25af\u25af\u25af ` plus a trailing space, always drawn as part
 * of the row's *value*, so it takes the bright text colour. Every percentage in the
 * panel \u2014 GPU busy, drafts accepted, a cache tier filled, bytes against the wired
 * ceiling \u2014 is drawn the same way, because each is "how full is this thing
 * relative to its own number".
 *
 * `\u2588` stays reserved for the prefill progress bar (it fills toward a total over
 * time) and `\u2581\u2582\u2585` for a sparkline (a series, not a level).
 */
function gauge(fraction: number | null, cells: number): string {
  return cells > 0 ? `${levelBar(fraction, cells)} ` : ""
}

/** Safe divide: a missing or zero denominator yields an empty bar, never NaN. */
function ratio(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  return Math.max(0, Math.min(1, part / whole))
}

// ---------------------------------------------------------------------------
// Turn: the per-session meter (drawn in the sidebar only if `turn` is in `sections`)
// ---------------------------------------------------------------------------

/**
 * Rows for the per-session speed meter \u2014 the same readout the footer line prints,
 * drawn as panel rows for anyone who adds `turn` to `sections`.
 * `inflight` is the server's request count, used only to label a rate that had to
 * be measured per-session because the shared counter covered other clients.
 * `barCells` turns the prefill line into a progress bar; 0 keeps the plain rate.
 */
export function turnRows(speed: SpeedValue | null, inflight = 1, barCells = 0): SidebarRow[] {
  if (!speed) return []
  const approx = speed.tokensEstimated ? "~" : ""
  if (speed.phase === "prefill") {
    const bar = prefillBar(speed, barCells)
    if (bar !== null) return bar
    const rate = speed.prefillTps === null ? null : `${fmtRate(speed.prefillTps)} t/s`
    const tokens = speed.prefillTokens === null ? null : `${fmtCount(speed.prefillTokens)} tok`
    if (rate !== null && tokens !== null) return [row("prefill", rate, `· ${tokens}`)]
    if (rate !== null) return [row("prefill", rate)]
    if (tokens !== null) return [row("prefill", tokens, `· ${fmtDur(speed.elapsedMs)}`)]
    return [row("prefill", "waiting", `· ${fmtDur(speed.elapsedMs)}`)]
  }

  const rows: SidebarRow[] = []
  // More than one client is decoding, so this session's rate came from its own
  // streamed bytes instead of the server-wide token counter. Naming the crowd is
  // what tells the reader the two numbers are not the same measurement.
  const crowd = inflight > 1 ? ` · ${inflight} clients` : ""
  if (speed.genTps !== null) {
    rows.push(row("decode", `${approx}${fmtRate(speed.genTps)} t/s`, `· ${approx}${fmtCount(speed.genTokens)} tok${crowd}`))
  } else if (speed.genTokens > 0) {
    rows.push(row("decode", `${approx}${fmtCount(speed.genTokens)} tok`, "· settling"))
  }
  if (speed.prefillTps !== null) {
    const tokens = speed.prefillTokens === null ? "" : ` ${fmtCount(speed.prefillTokens)} tok`
    rows.push(row("prefill", `${fmtRate(speed.prefillTps)} t/s${tokens}`, "· last"))
  }
  if (speed.ttftMs !== null) {
    rows.push(row("ttft", fmtMs(speed.ttftMs), `· turn ${fmtDur(speed.elapsedMs)}`))
  }
  return rows
}

/**
 * `prefill ████████░░░░░░░░ 12.4k/~48.0k` plus `1.6k t/s · ~22s left`.
 *
 * The denominator is the previous step's forwarded count, not this prompt's
 * size: mlx-serve only publishes how many tokens it has forwarded so far
 * (`prefill_tokens_live`), and the total lands in `usage` after the step is
 * done. Marking it `~` is what keeps a yardstick from being read as a promise —
 * on a warm prefix cache a turn forwards its new tail, so the real count is
 * usually smaller than last turn's whole prompt.
 */
function prefillBar(speed: SpeedValue, cells: number): SidebarRow[] | null {
  if (cells <= 0) return null
  const live = speed.prefillTokens
  const base = speed.prefillBaseline
  // No previous settled count, or nothing forwarded yet: there is no denominator,
  // so no bar. An always-empty bar reads as "0% of a known total", which is a
  // different and more wrong claim than showing the rate alone.
  if (base === null || base <= 0 || live === null) return null
  const remaining = base - live
  const left = speed.prefillTps !== null && remaining > 0 ? Math.round(remaining / speed.prefillTps) : null
  const note =
    speed.prefillTps === null ? "measuring" : left === null ? "· at last turn's size" : `· ~${left}s left`
  return [
    row("prefill", `${progressBar(live / base, cells)} ${fmtCount(live)}/~${fmtCount(base)}`),
    row("", note.startsWith("measuring") ? note : `${fmtRate(speed.prefillTps ?? 0)} t/s ${note}`.trim()),
  ]
}

// ---------------------------------------------------------------------------
// Server stats sections
// ---------------------------------------------------------------------------

/** `~49.3 t/s`, `1311 t/s`, `12.3k t/s` → the number behind the string. */
export function parseTps(value: string): number | null {
  const m = /^~?([\d.]+)(k)? t\/s$/.exec(value.trim())
  if (!m?.[1]) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n * (m[2] ? 1000 : 1) : null
}

/** Rates the Turn meter already put on screen, by row label. */
export function turnRates(rows: readonly SidebarRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const n = parseTps(r.value)
    if (n !== null) out.set(r.label, n)
  }
  return out
}

/**
 * Two windows over the same counter, so "the same number twice" is a matter of
 * tolerance, not equality: the turn meter measures gen_live from the deltas it
 * saw, the server row measures it over its own trailing window. Within 5% they
 * are one measurement, and printing both reads as a bug.
 */
function sameRate(rates: ReadonlyMap<string, number>, label: string, value: number | null): boolean {
  const other = rates.get(label)
  if (other === undefined || value === null) return false
  const span = Math.max(other, value)
  return span === 0 || Math.abs(other - value) / span < 0.05
}

/**
 * Server-wide throughput. With one request in flight the server's live decode
 * rate IS the turn's decode rate, so when the Turn section already drew it this
 * section yields the number the turn meter cannot know: the since-boot average.
 */
function throughputRows(
  s: ServiceStats,
  cells: number,
  already: ReadonlyMap<string, number>,
  inflight: number,
): SidebarRow[] {
  const rows: SidebarRow[] = []
  const avg = (label: string, value: number | null): SidebarRow | null =>
    value === null ? null : row(`${label} avg`, `${fmtRate(value)} t/s`, "· since boot")
  // With one request in flight the server's live rate and the turn's rate are the
  // same measurement twice, so the second copy yields to the since-boot average.
  // With two or more they are genuinely different numbers and both stay.
  const dup = inflight <= 1
  if (s.genTps !== null) {
    const live = row("decode", `${fmtRate(s.genTps)} t/s`, `· avg ${fmtRate(s.avgGenTps)}`)
    rows.push(dup && sameRate(already, "decode", s.genTps) ? (avg("decode", s.avgGenTps) ?? live) : live)
  }
  if (s.prefillTps !== null) {
    const live = row("prefill", `${fmtRate(s.prefillTps)} t/s`, `· avg ${fmtRate(s.avgPrefillTps)}`)
    rows.push(dup && sameRate(already, "prefill", s.prefillTps) ? (avg("prefill", s.avgPrefillTps) ?? live) : live)
  }
  if (s.genTps === null && s.prefillTps === null) {
    // Nothing is running: the only honest numbers left are the cumulative ones.
    if (s.avgPrefillTps !== null) rows.push(row("prefill", `${fmtRate(s.avgPrefillTps)} t/s`, "· avg"))
    if (s.avgGenTps !== null) rows.push(row("decode", `${fmtRate(s.avgGenTps)} t/s`, "· avg"))
  }
  const spark = sparkline(s.genSeries, cells)
  if (spark !== "") rows.push(row("60s", spark))
  // Admissions per second over a 60s window: how many requests a client is
  // actually driving through the server. ~0.07 is one agent working; it jumps the
  // moment a second window starts, which is the earliest sign of a shared machine.
  if (s.reqPerSec !== null) rows.push(row("admitted", `${s.reqPerSec.toFixed(2)} req/s`))
  return rows
}

/**
 * What the cache saved, and what it costs to save it. The two percentages come
 * from `/metrics.json`; the two tiers come from the log, because the feed counts
 * prefix-cache HITS and says nothing about bytes. Read together they are one
 * story: a 99% token hit rate is worth little if the hot tier is pinned at its
 * budget and thrashing to SSD.
 *
 * `hot` prints its own cap in the log line, so its gauge is measured. `ssd`'s cap
 * is the `--prefix-cache-disk` launch flag, which appears in no line and no
 * endpoint, so it is gauged only when declared in cli.json — otherwise the row is
 * bytes with no invented denominator.
 */
function cacheRows(
  s: ServiceStats,
  hot: CacheTier | null,
  ssd: CacheTier | null,
  cells: number,
  diskCapGb: number | null,
): SidebarRow[] {
  const rows: SidebarRow[] = []
  if (s.cacheTokenPct !== null) rows.push(row("tokens", `${s.cacheTokenPct}%`, "· from cache"))
  if (s.cacheHitPct !== null) rows.push(row("requests", `${s.cacheHitPct}%`, "· had a hit"))
  // One cache tier against its own denominator. The entry count is deliberately
  // not drawn: with a gauge the row is already ~31 cells, and the count is the
  // first thing the sidebar's truncate would cut anyway.
  // Bytes and denominator only, with no trailing qualifier. "budget" and
  // "declared" were accurate and still cost the row its number: the sidebar
  // truncates the END of a line, so a word at the back is paid for in bytes.
  const tier = (name: string, t: CacheTier | null, capGb: number | null): SidebarRow | null => {
    if (t === null) return null
    const used = mbToGb(t.residentMb)
    if (used === null || used <= 0) return null
    if (capGb === null || cells <= 0) return row(name, fmtGib(used))
    const fraction = ratio(used, capGb) ?? 0
    return { label: name, value: `${gauge(fraction, cells)}${Math.round(fraction * 100)}%`, note: `· ${fmtGib(used)}/${fmtGib(capGb)}` }
  }
  const capOf = (t: CacheTier | null): number | null => (t?.capMb == null ? null : mbToGb(t.capMb))
  // What the two denominators ARE is documented in the README, because the words
  // describing them do not fit beside them: the hot tier's cap is the computed
  // budget (`ctx_kv + idle`, 28.7 GB here) and NOT the `--prefix-cache-mem 10GB`
  // flag, which is only the idle allowance inside it (ssdFirstPrefixCacheMem);
  // the SSD tier's 100 GB is that flag's sibling `--prefix-cache-disk`, verbatim.
  const hotRow = tier("hot", hot, capOf(hot))
  const ssdRow = tier("ssd", ssd, diskCapGb)
  if (hotRow) rows.push(hotRow)
  if (ssdRow) rows.push(ssdRow)
  return rows
}



/**
 * Allocator and system memory. The footprint does not appear here when a wired
 * ceiling is declared — it rides on the section heading instead, as `memoryGauge`
 * below — because "how close am I to the wall" is the section's whole point and
 * not a line item. With no declared ceiling the row shows its bytes alone.
 */
function memoryRows(s: ServiceStats, input: PanelInput): SidebarRow[] {
  const rows: SidebarRow[] = []
  if (s.memGb !== null && wiredCeilingGb(input.wiredLimitGb ?? null) === null) {
    rows.push(row("footprint", `${s.memGb.toFixed(1)}G`))
  }
  // MLX's allocator holds two very different things: bytes in use, and a
  // reclaimable pool the process has not given back (issue #110's blind spot).
  // The bar is in-use over what it is holding, so a swelling pool visibly
  // shrinks the bar instead of hiding behind a second number.
  if (s.mlxActiveGb !== null) {
    rows.push(row("mlx in use", fmtGib(s.mlxActiveGb), `· pool ${fmtGib(s.mlxPoolGb)}`))
  }
  if (s.freeRamGb !== null) {
    rows.push(row("ram free", fmtGib(s.freeRamGb), `· peak ${fmtGib(s.peakRamGb)}`))
  }
  if (s.aneBytes > 0) rows.push(row("ane", fmtGib(s.aneBytes / 1024 ** 3), `· ${s.aneLayers} layers`))
  if (s.ngramBytes > 0) {
    const size = fmtGib(s.ngramBytes / 1024 ** 3)
    if (s.ngramProgress === null) rows.push(row("ngram warm", size))
    else if (s.ngramProgress >= 1) rows.push(row("ngram", size))
    else rows.push(row("ngram", `${Math.round(s.ngramProgress * 100)}%`, `· ${size} read`))
  }
  return rows
}

/**
 * Acceptance keeps both: the bar for the shape of the ratio at a glance, the
 * percent because a bar without its number is a guess, and the counts only when
 * there is room for them. The row is cut at the sidebar's edge, so anything after
 * the percent is what disappears first — the note is 9 cells with a bar drawn
 * (`· 1.4k/2.3k`) and spells itself out when no bar is taking the space.
 */
function acceptNote(s: SpecStats, drafted: number, cells: number): string {
  if (drafted <= 0) return cells > 0 ? `· ${fmtCount(s.accepts)} tok` : `· ${fmtCount(s.accepts)} accepted tok`
  return cells > 0 ? `· ${fmtCount(s.accepts)}/${fmtCount(drafted)}` : `· ${fmtCount(s.accepts)}/${fmtCount(drafted)} drafts`
}


function specRows(observed: Observed<SpecStats> | null, now: number, cells: number): SidebarRow[] {
  const s = observed?.value
  if (!s || !observed) return []
  const rows: SidebarRow[] = []
  if (s.perDraftPct !== null) {
    const drafted = s.drafted ?? 0
    rows.push(
      row(
        "accept",
        `${gauge(s.perDraftPct / 100, cells)}${fmtRate(s.perDraftPct)}%`,
        acceptNote(s, drafted, cells),
      ),
    )
  } else if (s.avgPerRound !== null) {
    // PLD and dspark vary their width per round, so there is no fixed
    // denominator worth calling a percentage; tokens per round is the honest unit.
    rows.push(
      row("accept", `${s.avgPerRound.toFixed(2)} tok/round`, `· ${fmtCount(s.accepts)}/${fmtCount(s.attempts)} rounds`),
    )
  }
  if (s.avgPerRound !== null && s.perDraftPct !== null) {
    rows.push(row("per round", `${s.avgPerRound.toFixed(2)} tok`, `· ${fmtCount(s.attempts)} rounds`))
  }
  if (s.roundMs !== null || s.syncMs !== null) {
    // Sub-10ms numbers matter here: a 2.93ms sync is a different story than a
    // 9ms one, and both round to the same integer second later.
    const round = s.roundMs === null ? "—" : fmtMsFine(s.roundMs)
    const sync = s.syncMs === null ? "—" : fmtMsFine(s.syncMs)
    rows.push(row("round", round, `· sync ${sync}`))
  }
  if (s.runtimeDisabled) {
    rows.push(row("gate", "off", `· ${s.reason ?? "adaptive"} → ${s.adaptive ?? "serial"}`, "warn"))
  }
  return rows
}

/**
 * The sampling the last request actually ran with. mlx-serve logs it per
 * request, so this is what the server did, not what config says it should do.
 */
function samplingRows(observed: Observed<SamplingStats> | null, now: number): SidebarRow[] {
  const v = observed?.value
  if (!v) return []
  const rows: SidebarRow[] = []
  const temp = v.temperature === null ? null : v.temperature.toFixed(2)
  const topP = v.topP === null ? null : v.topP.toFixed(2)
  if (temp === null && topP === null && v.topK === null) return []

  const tail: string[] = []
  if (topP !== null) tail.push(`p ${topP}`)
  if (v.topK !== null) tail.push(`k ${v.topK}`)
  rows.push(row("temp", temp ?? "unknown", tail.length > 0 ? `· ${tail.join(" ")}` : undefined))

  if (v.maxTokens !== null) {
    rows.push(row("max out", String(v.maxTokens), v.maxTokensOrigin === null ? undefined : `· ${v.maxTokensOrigin}`))
  }
  // The prompt's message count moved to `Server log` beside the token totals, and
  // `thinking` is gone: it said nothing a reader could act on. A request that
  // did NOT stream is still worth naming, because that is when a client reads a
  // single late response instead of a flow.
  if (v.stream === false) rows.push(row("stream", "off"))
  if (v.endpoint !== "chat/completions") {
    rows.push(row("route", v.endpoint, ageNote(observed, now)))
  }
  return rows
}

/**
 * What the server has done since it started. Folded into `Server log`: the totals
 * are three lines, and they come from the same feed the log row points at.
 */
function totalsRows(s: ServiceStats, sampling: SamplingStats | null): SidebarRow[] {
  const rows: SidebarRow[] = [
    // "in" and "out" are one measurement read twice, so both numbers are drawn in
    // the value colour — a statistic that trails in dim type looks like a
    // footnote to the number in front of it.
    { label: "tokens", value: `${fmtCount(s.promptTokens)} in`, note: `· ${fmtCount(s.genTokens)} out`, noteBright: true },
    {
      label: "requests",
      value: `${fmtCount(s.requestsOk)} ok`,
      note: `· ${s.requestsCancelled} cancelled`,
      noteBright: s.requestsCancelled > 0,
    },
  ]
  const msgs = sampling?.messages
  if (msgs !== null && msgs !== undefined) {
    // What the last prompt carried, next to the token totals it implies. Exact
    // digits: this is the number you compare against a context budget.
    rows.splice(2, 0, { label: "messages", value: `req ${fmtExact(msgs)}` })
  }
  const toolMsgs = sampling?.toolMsgs
  if (toolMsgs !== null && toolMsgs !== undefined) {
    // Cumulative within THIS conversation, not since boot: `tool_msgs` counts the
    // role=="tool" messages the last prompt carried, and the feed publishes no
    // tool-call counter. The note is what stops it being read like the row above.
    rows.push({ label: "tool calls", value: fmtCount(toolMsgs), note: "· this session" })
  }
  return rows
}

/**
 * The panel's last section: whether the server answers, what it has done since
 * boot, and which file the raw lines came from. `Since boot` used to be its own
 * section and the log its own; three numbers and two rows did not need two
 * headings.
 */
function logRows(input: PanelInput): SidebarRow[] {
  const log = input.log
  const status = feedStatus(input.link)
  const head = row("feed", status.value, log === null && input.link === "live" ? "· log tail off" : undefined, status.tone)
  const totals = input.service === null ? [] : totalsRows(input.service, input.sampling?.value ?? null)
  if (!log) return [head, ...totals, row("log", "not tailed", "· logPath off")]

  if (log.error !== null || log.bytes === null) {
    return [head, ...totals, row("log", log.name, `· ${log.error ?? "unreadable"}`, "warn")]
  }
  const age = log.mtimeMs === null ? null : Math.max(0, input.now - log.mtimeMs)
  const rows: SidebarRow[] = [head, ...totals, row("log", log.name, `· ${fmtBytes(log.bytes)}`)]
  if (age !== null) rows.push(row("last write", age < 5_000 ? "just now" : `${fmtDur(age)} ago`))
  if (log.dropped > 0) rows.push(row("tail", `+${fmtBytes(log.dropped)}`, "· unread"))
  return rows
}

/**
 * The panel's own health: which host integration refused to load. It appears by
 * itself when something failed, because a panel that silently stopped talking to
 * the server still looks like a panel — it just stops being true.
 */
function attachRows(input: PanelInput): SidebarRow[] {
  const errors = input.attachErrors ?? []
  return errors.slice(0, 4).map((failure) => row(failure.where, clip(failure.detail, 34), "· degraded"))
}

/** Truncated to fit the column, with the cut made visible. */
export function clip(text: string, cells: number): string {
  const chars = [...text]
  return chars.length <= cells ? text : `${chars.slice(0, cells - 1).join("")}…`
}

/**
 * The heading-line gauge for `Memory`: bytes held, against the declared wired
 * ceiling. `null` when there is no declared ceiling — the panel then shows the
 * footprint as a plain row rather than gauging against a guess (75% of RAM read
 * like an emergency on a machine whose owner raised the limit to 117 GiB).
 */
export function memoryGauge(input: PanelInput): { note: string } | null {
  const s = input.service
  const ceiling = wiredCeilingGb(input.wiredLimitGb ?? null)
  if (s === null || s.memGb === null || ceiling === null) return null
  const fraction = ratio(s.memGb, ceiling) ?? 0
  const cells = input.ratioCells ?? 0
  const pct = Math.round(fraction * 100)
  return { note: `${gauge(fraction, cells)}${pct}% of ${fmtGib(ceiling)} wired` }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface PanelInput {
  /** This session's turn meter, from `SpeedTracker`. */
  readonly speed: SpeedValue | null
  readonly service: ServiceStats | null
  readonly model: ModelStats | null
  readonly spec: Observed<SpecStats> | null
  readonly sampling: Observed<SamplingStats> | null
  readonly log: LogStatus | null
  /** Sparkline width in cells; 0 turns the sparkline off. */
  readonly sparkCells: number
  readonly now: number
  /** `ui.format.path` from the host, so the toast abbreviates $HOME like the rest of the TUI. */
  readonly formatPath?: (path: string) => string
  /** Filled in by `buildSections`: rates the Turn section already drew. */
  readonly turnRates?: ReadonlyMap<string, number>
  /** Width of the prefill progress bar in cells; 0 draws the plain rate instead. */
  readonly barCells?: number
  /** Host integrations that threw (a refused slot, a missing API). */
  readonly attachErrors?: readonly { where: string; detail: string }[]
  /** The declared wired ceiling (cli.json, or `iogpu.wired_limit_mb`), in GiB. */
  readonly wiredLimitGb?: number | null
  /** Width of the ratio bars in cells; 0 draws percentages only. */
  readonly ratioCells?: number
  /** KV-cache tiers (newest line of each) and the declared SSD cap in GiB. */
  readonly hot?: Observed<CacheTier> | null
  readonly ssd?: Observed<CacheTier> | null
  readonly diskCacheGb?: number | null
  /** Outcome of the last /metrics.json read. Defaults to what the snapshot
   * carries, so a caller cannot accidentally report "connecting" over live data. */
  readonly link?: Link
  /** Requests the server says are running; 1 or fewer means "this turn is alone".
   * Defaults to the feed's `requests_running` — tests override it. */
  readonly inflight?: number
}

/** How many clients were behind the shared counters when the feed was read. */
function inflightOf(input: PanelInput): number {
  return input.inflight ?? input.service?.running ?? 0
}

function rowsFor(name: SectionName, input: PanelInput): SidebarRow[] {
  const s = input.service
  const inflight = inflightOf(input)
  switch (name) {
    case "turn":
      return turnRows(input.speed, inflight, input.barCells ?? 0)
    case "throughput":
      return s === null ? [] : throughputRows(s, input.sparkCells, input.turnRates ?? new Map(), inflight)
    case "server":
      return serverRows(input.model, input.service, input.ratioCells ?? 0)
    case "cache":
      return s === null ? [] : cacheRows(s, input.hot?.value ?? null, input.ssd?.value ?? null, input.ratioCells ?? 0, input.diskCacheGb ?? null)
    case "memory":
      return s === null ? [] : memoryRows(s, input)
    case "spec":
      return specRows(input.spec, input.now, input.ratioCells ?? 0)
    case "sampling":
      return samplingRows(input.sampling, input.now)
    case "log":
      return logRows(input)
    case "attach":
      return attachRows(input)
    default:
      return []
  }
}

/**
 * Sections in the order asked for, with the empty ones dropped. The Turn
 * section is drawn first regardless of order so the sections below it can tell
 * which numbers are already on screen.
 */
export function buildSections(input: PanelInput, enabled: readonly SectionName[]): SidebarSection[] {
  const turn = enabled.includes("turn") ? turnRows(input.speed, inflightOf(input)) : []
  // Two things every section below the turn meter needs, and neither is something
  // a caller should have to remember to write by hand: which numbers the turn
  // meter already put on screen (so Throughput does not repeat one), and whether
  // the server is answering at all (so the panel is never silently empty).
  const derived: PanelInput = {
    ...input,
    link: input.link ?? input.service?.link ?? "unknown",
    turnRates: turnRates(turn),
  }
  const sections: SidebarSection[] = []
  for (const name of enabled) {
    const rows = name === "turn" ? turn : rowsFor(name, derived)
    if (rows.length === 0) continue
    const gauge = name === "memory" ? memoryGauge(derived) : null
    sections.push({
      name,
      title: SECTION_TITLES[name],
      ...(gauge === null ? {} : { note: gauge.note }),
      rows,
    })
  }
  return sections
}

// ---------------------------------------------------------------------------
// Footer meter (the always-on line under the prompt)
// ---------------------------------------------------------------------------

/**
 * One line of turn stats, in the order a person glances for them: what the turn
 * is doing now, and how far it has got.
 *
 * No memory figure and no time-to-first-token here: the Memory section carries the
 * footprint and its wired gauge, while this line is a per-turn readout. Formatting is
 * shared with the panel (`fmtRate`, `fmtCount`, `fmtMs`) so a number that appears
 * in both places is written identically in both.
 *
 * During prefill this becomes a progress bar, because prefill is the one phase
 * with nothing else worth watching:
 * `prefill ██████████░░░░░░░░ 12.4k/~48.0k · 1600 t/s · ~22s left`
 */
export function footerLabel(speed: SpeedValue | null, options: FooterOptions = {}): string | null {
  if (!speed) return null
  if (speed.phase === "prefill") return prefillLine(speed, options.barCells ?? 0)

  // Tokens first (the one number that grows monotonically while you watch), then
  // the rate and the histogram of that same rate, then the prefill speed that got
  // us here, then the turn's age once it is long enough to matter. The histogram
  // is glued to the number it graphs \u2014 after a `·` separator it reads as one more
  // statistic three numbers away from the one it belongs to.
  const approx = speed.tokensEstimated ? "~" : ""
  const bits: string[] = []
  const spark = footerSpark(options.series ?? null, options.historyCells ?? 0)
  if (speed.genTokens > 0) bits.push(`${approx}${fmtExact(speed.genTokens)} tok`)
  if (speed.genTps !== null) bits.push(`decode ${approx}${fmtRate(speed.genTps)} t/s${spark === "" ? "" : ` ${spark}`}`)
  else if (spark !== "") bits.push(`decode ${spark}`)
  if (speed.prefillTps !== null) bits.push(`prefill ${fmtRate(speed.prefillTps)} t/s`)
  if (speed.elapsedMs >= 60_000) bits.push(fmtDur(speed.elapsedMs))
  return bits.length > 0 ? bits.join(" · ") : null
}

export interface FooterOptions {
  /** Prefill progress-bar width in cells; 0 keeps the plain rate line. */
  readonly barCells?: number
  /** Width of the decode-rate history drawn at the end of the line; 0 omits it. */
  readonly historyCells?: number
  /** This turn's decode rate, one point per cell, oldest first. */
  readonly series?: readonly number[] | null
}

/**
 * The turn's rate history, as `▁▂▅█▆▃` — the same zero-to-peak scale the panel's
 * `60s` sparkline uses, so a bar means the same thing in both places, and the
 * same number the headline is reading (`genTps`) is what gets sampled.
 *
 * Deliberately the meter's own windowed rate and not a per-cell delta: the
 * window is what makes the line legible. A delta series resolves a two-second
 * tool pause as a cliff to the floor, which reads as a fault and was rejected in
 * favour of the smoother trace. Flat or absent history draws nothing — a row of
 * baselines would read as "steady at zero" when it means "nothing to plot".
 */
export function footerSpark(series: readonly number[] | null | undefined, cells: number): string {
  if (cells <= 0 || !series || series.length < 2) return ""
  const window = series.slice(-cells)
  const peak = Math.max(...window)
  const floor = Math.min(...window)
  if (peak <= 0 || peak - floor < peak * 0.02) return ""
  return sparkline(window, cells)
}


/** Prefill: progress bar when there is a yardstick, tokens and rate when there is not. */
function prefillLine(speed: SpeedValue, cells: number): string | null {
  const live = speed.prefillTokens
  const base = speed.prefillBaseline
  const rate = speed.prefillTps === null ? null : `${fmtRate(speed.prefillTps)} t/s`

  if (cells > 0 && base !== null && base > 0 && live !== null) {
    const remaining = base - live
    const parts = [`prefill ${progressBar(live / base, cells)} ${fmtExact(live)}/~${fmtExact(base)}`]
    if (rate === null) parts.push("measuring")
    else {
      parts.push(rate)
      parts.push(remaining > 0 ? `~${Math.max(1, Math.round(remaining / (speed.prefillTps as number)))}s left` : "past last turn")
    }
    return parts.join(" · ")
  }

  const bits: string[] = []
  if (live !== null) bits.push(`prefill ${fmtExact(live)} tok`)
  if (rate !== null) bits.push(bits.length > 0 ? rate : `prefill ${rate}`)
  else if (live === null) bits.push(`prefill ${fmtDur(speed.elapsedMs)}`)
  if (speed.ttftMs !== null) bits.push(`ttft ${fmtMs(speed.ttftMs)}`)
  return bits.length > 0 ? bits.join(" · ") : null
}
