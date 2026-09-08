export type Phase = "idle" | "prefill" | "generate" | "frozen"

export interface MetricsSample {
  readonly t: number
  readonly prefillLive: number
  readonly genLive: number
  readonly prefilling: boolean
  readonly running: boolean
  readonly memoryMb?: number
  /**
   * `requests_running` as a COUNT. `gen_live` is a server-wide counter, so how
   * many clients are behind it decides whether a rate is this turn's or the
   * machine's. Absent (older feed) is treated as a single client.
   */
  readonly runningCount?: number
}

export interface SpeedValue {
  readonly phase: Phase
  readonly prefillTokens: number | null
  /**
   * Tokens the previous step of this session actually forwarded through the
   * model (`prompt - cached`). `prefill_tokens_live` says how far along we are
   * but never how far there is to go — that only arrives in `usage`, after the
   * step finishes — so the last settled count is the best available yardstick
   * for a progress bar. null on a session's first prefill.
   */
  readonly prefillBaseline: number | null
  readonly prefillTps: number | null
  readonly genTokens: number
  readonly genTps: number | null
  readonly ramGb: number | null
  readonly ttftMs: number | null
  readonly elapsedMs: number
  readonly tokensEstimated: boolean
  readonly metricsOk: boolean
}

export interface SpeedConfig {
  readonly bytesPerToken: number
}

const DEFAULT_CONFIG: SpeedConfig = {
  bytesPerToken: 4.75,
}

const LIVE_WINDOW_MS = 4_000
const PREFILL_WINDOW_MS = 30_000
const LIVE_STALE_MS = 1_500
const LIVE_MIN_DURATION_MS = 250
/** mlx-serve publishes gen_live in ~1.5s bursts. Shorter gaps are poll artifacts. */
const GEN_BURST_MERGE_MS = 1_000
/** Gaps longer than this are tool / permission / queue idle, not decode. */
const GEN_IDLE_MS = 4_000
const MAX_TRACKED_RUNS = 64

interface TokenSample {
  t: number
  tokens: number
}

interface ByteSample {
  t: number
  bytes: number
}

interface RunState {
  phase: Phase
  startedAt: number
  firstTokenAt: number | null
  assistantMessageID: string | null
  genBytes: number
  byteSamples: ByteSample[]
  prefillSamples: TokenSample[]
  genMetricSamples: TokenSample[]
  genLiveOrigin: number | null
  lastPrefillTokens: number
  lastPrefillTps: number | null
  settledPrefillTokens: number | null
  settledGenTokens: number | null
  lastGenAt: number | null
  lastGenTps: number | null
  runningCount: number
  stepActiveMs: number
  turnActiveMs: number
  turnGenTokens: number
  tokensEstimated: boolean
  metricsOk: boolean
  ramGb: number | null
  frozen: SpeedValue | null
}

function estimateTokens(bytes: number, bytesPerToken: number): number {
  if (bytes <= 0) return 0
  return Math.max(1, Math.round(bytes / bytesPerToken))
}

function rateFromSamples(samples: TokenSample[], now: number, windowMs: number): number | null {
  if (samples.length < 2) return null
  const latest = samples[samples.length - 1]
  if (!latest) return null
  const oldestAllowed = now - windowMs
  let base = samples[0]
  for (const sample of samples) {
    if (sample.t <= oldestAllowed) base = sample
    else break
  }
  const dt = (latest.t - base.t) / 1000
  if (dt < LIVE_MIN_DURATION_MS / 1000) return null
  const delta = latest.tokens - base.tokens
  if (delta < 0) return null
  return delta / dt
}

/** Decode tok/s from gen_live *increases*. First burst only starts the clock. */
function metricActiveRate(samples: TokenSample[], idleMs: number): number | null {
  if (samples.length < 2) return null
  let tokens = 0
  let ms = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    if (!prev || !cur) continue
    const gap = cur.t - prev.t
    const dtok = cur.tokens - prev.tokens
    if (dtok <= 0 || gap < GEN_BURST_MERGE_MS || gap > idleMs) continue
    tokens += dtok
    ms += gap
  }
  if (ms < GEN_BURST_MERGE_MS || tokens <= 0) return null
  return tokens / (ms / 1000)
}

function byteRate(samples: ByteSample[], now: number, bytesPerToken: number): number | null {
  const last = samples.at(-1)
  if (!last) return null
  const effectiveNow = Math.min(now, last.t + LIVE_STALE_MS)
  const oldest = effectiveNow - LIVE_WINDOW_MS
  const window = samples.filter((sample) => sample.t >= oldest)
  const first = window[0]
  if (!first) return null
  const bytes = window.reduce((sum, sample) => sum + sample.bytes, 0)
  const durationMs = Math.max(effectiveNow - first.t, LIVE_MIN_DURATION_MS)
  return estimateTokens(bytes, bytesPerToken) / (durationMs / 1000)
}

function trimSamples<T extends { t: number }>(samples: T[], now: number, retainMs: number): void {
  const cutoff = now - retainMs
  while (samples.length > 2 && samples[0] && samples[0].t < cutoff) samples.shift()
}

function noteGen(st: RunState, now: number): void {
  if (st.lastGenAt !== null) {
    const gap = now - st.lastGenAt
    if (gap > 0 && gap <= GEN_IDLE_MS) st.stepActiveMs += gap
  }
  st.lastGenAt = now
}

function bankStep(st: RunState, bytesPerToken: number): void {
  st.turnActiveMs += st.stepActiveMs
  if (st.settledGenTokens !== null) st.turnGenTokens += st.settledGenTokens
  else if (st.genBytes > 0) st.turnGenTokens += estimateTokens(st.genBytes, bytesPerToken)
  st.stepActiveMs = 0
  st.settledGenTokens = null
  st.genBytes = 0
  st.byteSamples = []
  st.genMetricSamples = []
  st.genLiveOrigin = null
  st.lastGenAt = null
  st.firstTokenAt = null
  st.assistantMessageID = null
}

export class SpeedTracker {
  private readonly runs = new Map<string, RunState>()
  /** Last forwarded prompt-token count per session, settled from `usage`. */
  private readonly lastForwarded = new Map<string, number>()
  private readonly config: SpeedConfig
  metricsOk = false
  ramGb: number | null = null

  constructor(config: SpeedConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  private state(sessionID: string): RunState {
    let st = this.runs.get(sessionID)
    if (!st) {
      st = emptyRun()
      this.runs.set(sessionID, st)
    }
    return st
  }

  beginRun(sessionID: string, now: number): void {
    const st = emptyRun()
    st.phase = "prefill"
    st.startedAt = now
    this.runs.delete(sessionID)
    this.runs.set(sessionID, st)
    this.evictStale()
  }

  beginStep(sessionID: string, assistantMessageID: string, now: number): void {
    const st = this.state(sessionID)
    if (st.phase === "idle" || st.phase === "frozen") this.beginRun(sessionID, now)
    const running = this.state(sessionID)
    if (running.assistantMessageID === assistantMessageID && running.phase !== "frozen") return
    if (running.phase === "generate" || running.phase === "prefill") {
      bankStep(running, this.config.bytesPerToken)
    }
    running.assistantMessageID = assistantMessageID
    running.phase = "prefill"
    running.startedAt = now
    running.prefillSamples = []
    running.lastPrefillTokens = 0
    running.lastPrefillTps = null
    running.settledPrefillTokens = null
    running.tokensEstimated = true
    running.frozen = null
  }

  pushDelta(sessionID: string, delta: string, now: number, assistantMessageID?: string): void {
    if (!delta) return
    const st = this.state(sessionID)
    if (st.phase === "idle" || st.phase === "frozen") this.beginRun(sessionID, now)
    const running = this.state(sessionID)
    if (assistantMessageID) running.assistantMessageID = assistantMessageID
    if (running.phase === "prefill") {
      running.phase = "generate"
      running.firstTokenAt = running.firstTokenAt ?? now
    }
    const bytes = Buffer.byteLength(delta, "utf8")
    running.genBytes += bytes
    running.byteSamples.push({ t: now, bytes })
    trimSamples(running.byteSamples, now, LIVE_WINDOW_MS + LIVE_STALE_MS)
  }

  applyMetrics(sessionID: string, sample: MetricsSample): void {
    this.metricsOk = true
    if (sample.memoryMb !== undefined && Number.isFinite(sample.memoryMb) && sample.memoryMb > 0) {
      this.ramGb = sample.memoryMb / 1024
    }
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "idle" || st.phase === "frozen") return
    st.metricsOk = true
    st.runningCount = sample.runningCount ?? (sample.running ? 1 : 0)
    if (this.ramGb !== null) st.ramGb = this.ramGb

    if (st.genLiveOrigin === null) st.genLiveOrigin = sample.genLive

    const generated = Math.max(0, sample.genLive - st.genLiveOrigin)

    if (st.phase === "prefill" && (sample.prefillLive > 0 || sample.prefilling)) {
      if (st.prefillSamples.length === 0) st.prefillSamples.push({ t: st.startedAt, tokens: 0 })
      const last = st.prefillSamples.at(-1)?.tokens ?? 0
      if (sample.prefillLive >= last) {
        st.prefillSamples.push({ t: sample.t, tokens: sample.prefillLive })
        trimSamples(st.prefillSamples, sample.t, PREFILL_WINDOW_MS)
        st.lastPrefillTokens = Math.max(st.lastPrefillTokens, sample.prefillLive)
        const tps = rateFromSamples(st.prefillSamples, sample.t, PREFILL_WINDOW_MS)
        if (tps !== null) st.lastPrefillTps = tps
      }
    }

    const last = st.genMetricSamples.at(-1)
    const lastGen = last?.tokens ?? 0
    if (generated > lastGen) {
      if (st.phase === "prefill") {
        st.phase = "generate"
        st.firstTokenAt = st.firstTokenAt ?? sample.t
      }
      if (last && sample.t - last.t < GEN_BURST_MERGE_MS) {
        last.tokens = generated
        last.t = sample.t
      } else {
        st.genMetricSamples.push({ t: sample.t, tokens: generated })
      }
      const tps = metricActiveRate(st.genMetricSamples, GEN_IDLE_MS)
      if (tps !== null) st.lastGenTps = tps
    } else if (
      st.phase === "prefill" &&
      sample.running &&
      !sample.prefilling &&
      sample.prefillLive === 0 &&
      st.lastPrefillTokens > 0
    ) {
      st.phase = "generate"
      st.firstTokenAt = st.firstTokenAt ?? sample.t
    }
  }

  markMetricsDown(): void {
    this.metricsOk = false
  }

  finishStep(
    sessionID: string,
    assistantMessageID: string,
    usage: { input?: number; output?: number; reasoning?: number; cacheRead?: number } | undefined,
    now: number,
  ): void {
    const st = this.runs.get(sessionID)
    if (!st) return
    if (st.assistantMessageID && assistantMessageID && st.assistantMessageID !== assistantMessageID) return

    const input = finite(usage?.input)
    const cacheRead = finite(usage?.cacheRead) ?? 0
    const output = finite(usage?.output)
    const reasoning = finite(usage?.reasoning) ?? 0

    if (input !== undefined) {
      const forwarded = Math.max(0, input - cacheRead)
      // Carried outside RunState because the next `beginStep` may replace it.
      if (forwarded > 0) this.lastForwarded.set(sessionID, forwarded)
      st.settledPrefillTokens = forwarded
      if (st.lastPrefillTokens === 0) st.lastPrefillTokens = forwarded
      // Keep the live prefill rate when we measured one. TTFT is only a
      // fallback — it includes queue wait and is exactly the end-of-turn
      // number this plugin exists to replace.
      if (st.lastPrefillTps === null) {
        const ttftMs = (st.firstTokenAt ?? now) - st.startedAt
        if (ttftMs > 50 && forwarded > 0) st.lastPrefillTps = forwarded / (ttftMs / 1000)
      }
    }

    if (output !== undefined) {
      st.settledGenTokens = output + reasoning
      st.tokensEstimated = false
    }
  }

  finish(sessionID: string, now: number): void {
    const st = this.runs.get(sessionID)
    if (!st || st.phase === "frozen" || st.phase === "idle") return
    bankStep(st, this.config.bytesPerToken)
    const value = this.value(sessionID, now)
    st.phase = "frozen"
    st.frozen = value ? { ...value, phase: "frozen" } : null
    this.evictStale()
  }

  evict(sessionID: string): void {
    this.runs.delete(sessionID)
    this.lastForwarded.delete(sessionID)
  }

  hasActive(now = Date.now()): boolean {
    for (const st of this.runs.values()) {
      if (st.phase === "prefill" || st.phase === "generate") return true
      const last = st.byteSamples.at(-1)
      if (last && now < last.t + LIVE_STALE_MS) return true
    }
    return false
  }

  value(sessionID: string, now: number): SpeedValue | null {
    const st = this.runs.get(sessionID)
    if (!st) return null
    if (st.frozen) return st.frozen
    if (st.phase === "idle") return null

    const elapsedMs = Math.max(0, now - st.startedAt)
    const ttftMs = st.firstTokenAt !== null ? Math.max(0, st.firstTokenAt - st.startedAt) : null

    const genFromMetrics = st.genMetricSamples.at(-1)?.tokens
    const genFromBytes = estimateTokens(st.genBytes, this.config.bytesPerToken)
    const stepTokens = st.settledGenTokens ?? genFromMetrics ?? genFromBytes
    const genTokens = st.turnGenTokens + stepTokens
    const tokensEstimated = st.settledGenTokens === null && st.turnGenTokens === 0

    const metricTps = metricActiveRate(st.genMetricSamples, GEN_IDLE_MS)
    const byteTps = byteRate(st.byteSamples, now, this.config.bytesPerToken)
    // `gen_live` counts every client. While another request is decoding
    // alongside ours, its rate is the machine's, not this turn's — so prefer the
    // per-session byte estimate, which only ever sees our own deltas. It is the
    // less precise number and the more honest one; `tokensEstimated` already
    // marks it with `~`.
    const shared = st.runningCount > 1
    let genTps: number | null = null
    if (shared && byteTps !== null) {
      genTps = byteTps
    } else if (metricTps !== null) {
      genTps = metricTps
      st.lastGenTps = metricTps
    } else if (st.lastGenTps !== null) {
      genTps = st.lastGenTps
    } else if (!st.metricsOk) {
      genTps = byteTps
    }
    if (st.phase === "prefill" && st.turnGenTokens === 0 && st.lastGenTps === null) genTps = null

    const prefillTokens = st.settledPrefillTokens ?? (st.lastPrefillTokens > 0 ? st.lastPrefillTokens : null)
    const prefillTps =
      st.lastPrefillTps ??
      (st.phase === "prefill" ? rateFromSamples(st.prefillSamples, now, PREFILL_WINDOW_MS) : null)

    if (st.phase === "prefill" && prefillTokens === null && prefillTps === null && elapsedMs < 80) {
      return {
        phase: "prefill",
        prefillTokens: null,
        prefillBaseline: this.lastForwarded.get(sessionID) ?? null,
        prefillTps: null,
        genTokens: 0,
        genTps: null,
        ramGb: st.ramGb ?? this.ramGb,
        ttftMs: null,
        elapsedMs,
        tokensEstimated: true,
        metricsOk: st.metricsOk || this.metricsOk,
      }
    }

    return {
      phase: st.phase,
      prefillTokens,
      prefillBaseline: this.lastForwarded.get(sessionID) ?? null,
      prefillTps,
      genTokens,
      genTps,
      ramGb: st.ramGb ?? this.ramGb,
      ttftMs,
      elapsedMs,
      tokensEstimated,
      metricsOk: st.metricsOk || this.metricsOk,
    }
  }

  private evictStale(): void {
    if (this.runs.size <= MAX_TRACKED_RUNS) return
    for (const [sessionID, st] of this.runs) {
      if (this.runs.size <= MAX_TRACKED_RUNS) return
      if (st.phase === "prefill" || st.phase === "generate") continue
      this.runs.delete(sessionID)
    }
  }
}

function emptyRun(): RunState {
  return {
    phase: "idle",
    startedAt: 0,
    firstTokenAt: null,
    assistantMessageID: null,
    genBytes: 0,
    byteSamples: [],
    prefillSamples: [],
    genMetricSamples: [],
    genLiveOrigin: null,
    lastPrefillTokens: 0,
    lastPrefillTps: null,
    settledPrefillTokens: null,
    settledGenTokens: null,
    lastGenAt: null,
    lastGenTps: null,
    runningCount: 0,
    stepActiveMs: 0,
    turnActiveMs: 0,
    turnGenTokens: 0,
    tokensEstimated: true,
    metricsOk: false,
    ramGb: null,
    frozen: null,
  }
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

export interface MetricsJson {
  gauges?: {
    prefill_tokens_live?: number
    generation_tokens_live?: number
    requests_prefilling?: number
    requests_running?: number
    memory_mb?: number
  }
}

export function parseMetricsJson(json: MetricsJson, t = Date.now()): MetricsSample {
  const g = json.gauges ?? {}
  const running = Number(g.requests_running) || 0
  return {
    t,
    prefillLive: Number(g.prefill_tokens_live) || 0,
    genLive: Number(g.generation_tokens_live) || 0,
    prefilling: (Number(g.requests_prefilling) || 0) > 0,
    running: running > 0,
    runningCount: running,
    memoryMb: Number(g.memory_mb) || 0,
  }
}

export function resolveMetricsUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (trimmed.endsWith("/metrics.json")) return trimmed
  if (trimmed.endsWith("/metrics")) return `${trimmed}.json`
  return `${trimmed}/metrics.json`
}
