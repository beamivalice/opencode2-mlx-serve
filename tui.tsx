/** @jsxImportSource @opentui/solid */
/**
 * mlx-serve serving stats in the OpenCode sidebar, with the turn speed meter in
 * the prompt footer.
 *
 * The layout is fixed, not a mode:
 *
 *   footer   — turn stats, always on: `~456 tok · decode ~24.0 t/s`, and a
 *              progress bar while a prompt is being prefilled.
 *   sidebar  — server throughput, model, queue, latency, prefix cache, memory,
 *              MTP acceptance, last request's sampling, totals since boot, and
 *              the location of the server log.
 *
 * There are deliberately no slash commands: this OpenCode build does not dispatch
 * CLI-plugin commands into the prompt at all (`keymap.layer` accepts the spec, the
 * host lists none of our commands back), so a command here would be a promise this
 * build cannot keep. What used to be `/sidebar` and `/speed` is now either
 * always-on behaviour or a `cli.json` option (`sections`, `sparkCells`, `barCells`,
 * `logPath`).
 *
 * All of it is read, never asked for: three GETs (/metrics.json, /props,
 * /v1/models) and one read-only tail of the log file mlx-serve already writes.
 * The server has no idea this panel exists, and no turn is slower for it.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { parseMetricsJson, SpeedTracker, TurnRateSeries, type MetricsJson, type SpeedValue } from "./tracker.ts"
import {
  mbToGb,
  parseFeed,
  parseModels,
  parseProps,
  ServiceTracker,
  type Link,
  type ModelStats,
  type RawMetricsJson,
  type RawPropsJson,
} from "./stats.ts"
import { LogTail, type LogRead } from "./logtail.ts"
import {
  buildSections,
  footerLabel,
  type PanelInput,
  type SectionName,
  type SidebarSection,
} from "./rows.ts"
import { originOf, resolveOptions, type ServeOptions } from "./options.ts"
import { execFileSync } from "node:child_process"

// Do not import @opencode-ai/plugin at runtime: a v1 copy in
// ~/.config/opencode/node_modules shadows the package OpenCode 2 bundles. The
// host shapes below are written structurally and every call into them is
// wrapped, so an API change costs a section of the panel, not a dead TUI.
type AnyEvent = {
  id: string
  type: string
  created?: number
  data: Record<string, unknown>
}

type Ctx = {
  options?: Record<string, unknown>
  storage: {
    memory: (
      key: string,
      init: { initial: Record<string, unknown> },
    ) => [Record<string, unknown>, (fn: (d: Record<string, unknown>) => void) => void]
  }
  data: { on: (type: string, handler: (e: AnyEvent) => void) => () => void }
  ui: {
    slot: (spec: Record<string, unknown>) => () => void
    toast: { show: (spec: { title?: string; message: string; variant?: string; duration?: number }) => void }
    format?: { path: (path: string) => string }
  }
  theme: {
    text?: { subdued?: string; muted?: string; default?: string }
    feedback?: Record<string, { default?: string }>
  }
}

export type { ServeOptions, SectionName }

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const definition = {
  id: "opencode2.mlx-serve",
  setup(ctx: Ctx) {
    const options = resolveOptions(ctx.options)

    /**
     * The wired ceiling the memory gauge is drawn against: an explicit
     * `wiredLimitGb` option wins, otherwise the machine's declared
     * `iogpu.wired_limit_mb`, read once — the same policy mlx-serve's own
     * `wiredLimitBytes` uses, because a limit that moved under a live request
     * would make the gauge lie mid-turn.
     *
     * Nothing else is trusted. Metal's real per-device working-set size is what
     * the server actually compares against and it is never published, and guessing
     * 75% of RAM would have drawn this machine's 90 GB footprint at 95% of a
     * ceiling its owner raised to ~117 GB. A missing OID is normal (stock Mac,
     * Linux, Windows), so this returns null quietly rather than reporting a fault.
     */
    function declaredWiredGb(): number | null {
      if (options.wiredLimitGb !== null) return options.wiredLimitGb
      try {
        const out = execFileSync("sysctl", ["-n", "iogpu.wired_limit_mb"], {
          encoding: "utf8",
          timeout: 1_500,
          stdio: ["ignore", "pipe", "ignore"],
        })
        return mbToGb(Number(out.trim()))
      } catch {
        return null
      }
    }
    const wiredGb = declaredWiredGb()

    /** Host integrations that threw, named in the panel so a partial load is visible. */
    const attachErrors: { where: string; detail: string }[] = []
    const clipWhere = (name: string) => name.replace(/\(.*\)$/, "").slice(0, 12)

    function attempt<T>(what: string, fn: () => T): T | null {
      try {
        return fn()
      } catch (err) {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        attachErrors.push({ where: clipWhere(what), detail })
        try {
          console.error(`[mlx-serve] ${what} failed:`, err)
        } catch {
          // no stderr to echo to
        }
        return null
      }
    }

    /** $HOME → ~, the way the rest of the TUI writes paths. */
    function formatPath(path: string): string {
      return attempt("ui.format.path", () => ctx.ui.format?.path(path) ?? path) ?? path
    }

    // Only the newest plugin instance drives the UI. OpenCode reloads CLI
    // plugins on file change, and two meters in one footer is nobody's idea.
    const guard = attempt("storage.memory(generation)", () =>
      ctx.storage.memory("generation", { initial: { active: 0 } }),
    ) as [{ active: number }, (fn: (d: { active: number }) => void) => void] | null
    const gen = guard?.[0] ?? { active: 0 }
    const setGen = guard?.[1] ?? (() => {})
    const mine = Number(gen.active) + 1
    setGen((d) => {
      d.active = mine
    })
    const instanceIsOurs = () => gen.active === mine

    const tracker = new SpeedTracker({ bytesPerToken: options.bytesPerToken })
    const service = new ServiceTracker()
    const tail = options.logPath === null ? null : new LogTail(options.logPath)

    const [version, setVersion] = createSignal(0)
    const [panelOnScreen, setPanelOnScreen] = createSignal(false)
    let model: ModelStats | null = null
    let logRead: LogRead | null = null

    const activeSessions = new Set<string>()
    let lastSession: string | null = null

    /**
     * This turn's decode rate, one point per second, sampled from the very number
     * the footer prints — so the bars and the headline can never disagree. The
     * server's own `gen_live` history would be the machine's rate, and with a
     * second client decoding that series would not describe the `decode 30.4 t/s`
     * written in front of it.
     *
     * Written only from `tick`, never from a memo: a memo that writes a signal it
     * also reads re-triggers itself.
     */
    const history = new Map<string, TurnRateSeries>()

    /** One series per session, bounded like the meter it feeds. */
    function seriesFor(sessionID: string): TurnRateSeries {
      const existing = history.get(sessionID)
      if (existing !== undefined) return existing
      if (history.size > 64) {
        const oldest = history.keys().next().value
        if (oldest !== undefined) history.delete(oldest)
      }
      const created = new TurnRateSeries(1, options.historyCells)
      history.set(sessionID, created)
      return created
    }

    function sampleHistory(sessionID: string | null, now: number): void {
      if (sessionID === null) return
      const value = tracker.value(sessionID, now)
      if (value === null) return
      // The CUMULATIVE token count goes in, not the rate: `genTps` is already a
      // rate over a trailing window, and sampling that once a second averages
      // away the very bumps the histogram exists to show.
      seriesFor(sessionID).push(value.genTokens, now)
    }

    // Server busyness is cached instead of recomputed eight times a second: the
    // tick only needs to know whether anything is still decoding.
    let serverBusyUntil = 0
    let metricsInFlight = false
    let propsInFlight = false
    let modelsInFlight = false
    let lastMetrics = 0
    let lastProps = 0
    let lastModels = 0
    let lastLog = 0
    let uiTimer: ReturnType<typeof setInterval> | undefined
    let reported = false
    const abort = new AbortController()

    const seenEventIDs = new Set<string>()
    function isNewEvent(e: AnyEvent): boolean {
      if (seenEventIDs.has(e.id)) return false
      seenEventIDs.add(e.id)
      if (seenEventIDs.size > 4_096) {
        const oldest = seenEventIDs.values().next().value
        if (oldest !== undefined) seenEventIDs.delete(oldest)
      }
      return true
    }

    const createdAt = (e: AnyEvent) => (typeof e.created === "number" && Number.isFinite(e.created) ? e.created : Date.now())

    function aborted(err: unknown): boolean {
      return (err as { name?: string } | undefined)?.name === "AbortError"
    }

    async function get(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (options.metricsToken) headers.Authorization = `Bearer ${options.metricsToken}`
      const res = await fetch(url, { headers, signal: abort.signal })
      if (!res.ok) return { ok: false, status: res.status, body: null }
      return { ok: true, status: res.status, body: await res.json() }
    }

    /** Counters, gauges, histograms: most of the panel, and the turn meter's live feed. */
    async function pollMetrics(): Promise<void> {
      if (metricsInFlight) return
      metricsInFlight = true
      lastMetrics = Date.now()
      try {
        const res = await get(options.metricsUrl)
        const now = Date.now()
        let link: Link = "live"
        if (res.status === 503) link = "disabled"
        else if (!res.ok) link = res.status === 401 || res.status === 403 ? "unauthorized" : "down"
        if (link === "live") {
          service.sample(parseFeed(res.body as RawMetricsJson), now)
          const sample = parseMetricsJson(res.body as MetricsJson, now)
          for (const sessionID of activeSessions) tracker.applyMetrics(sessionID, sample)
          const stats = service.statsAt(now)
          serverBusyUntil =
            stats !== null && (stats.running > 0 || stats.prefilling > 0 || stats.waiting > 0) ? now + 6_000 : now
        } else {
          service.noteLink(link)
          serverBusyUntil = now
        }
      } catch (err) {
        if (!aborted(err)) service.noteLink("down")
      } finally {
        metricsInFlight = false
      }
      startUi()
    }

    /** /props: memory headroom and the n-gram warm total. Slow-changing. */
    async function pollProps(): Promise<void> {
      const origin = originOf(options.metricsUrl)
      if (origin === null || propsInFlight) return
      propsInFlight = true
      lastProps = Date.now()
      try {
        const res = await get(`${origin}/props`)
        if (res.ok) service.noteProps(parseProps(res.body as RawPropsJson))
      } catch {
        // /props is decoration on top of the metrics feed. A server without it, or
        // behind a proxy that 404s it, must not make the header claim the whole
        // server is unreachable — only /metrics.json gets to say that.
      } finally {
        propsInFlight = false
      }
      startUi()
    }

    /** /v1/models: which model, quantizer and speculative decoder are resident. */
    async function pollModels(): Promise<void> {
      const origin = originOf(options.metricsUrl)
      if (origin === null || modelsInFlight) return
      modelsInFlight = true
      lastModels = Date.now()
      try {
        const res = await get(`${origin}/v1/models`)
        if (res.ok) model = parseModels(res.body)
      } catch {
        // the panel draws without it
      } finally {
        modelsInFlight = false
      }
      startUi()
    }

    /** The log tail: acceptance and sampling. A missing file is a row, not a fault. */
    function pollLog(): void {
      if (tail === null) return
      lastLog = Date.now()
      try {
        logRead = tail.poll(Date.now())
      } catch {
        logRead = null
      }
    }

    // --- scheduling --------------------------------------------------------

    function busy(now: number): boolean {
      return tracker.hasActive(now) || now < serverBusyUntil
    }

    /**
     * Does anything visible need these numbers? The footer meter needs the feed
     * while a turn runs; the slow reads only matter when the panel is on screen.
     */
    function wanted(now: number): boolean {
      if (!instanceIsOurs()) return false
      return panelOnScreen() || busy(now)
    }

    function stopUi(): void {
      if (uiTimer === undefined) return
      clearInterval(uiTimer)
      uiTimer = undefined
    }

    function tick(): void {
      if (!instanceIsOurs()) {
        stopUi()
        return
      }
      const now = Date.now()
      const running = busy(now)
      const needed = wanted(now)
      if (!needed && !running) {
        stopUi()
        return
      }
      if (needed) {
        // Sample, then paint: the memo has to read the history this tick wrote.
        sampleHistory(lastSession, now)
        setVersion((v) => v + 1)
      }
      reportOnce()

      if (needed && !metricsInFlight) {
        const everyMs = 1000 / (running ? options.pollHz : options.idlePollHz)
        if (now - lastMetrics >= everyMs) void pollMetrics()
      }
      if (needed && panelOnScreen()) {
        if (!propsInFlight && now - lastProps >= options.propsSeconds * 1000) void pollProps()
        if (!modelsInFlight && now - lastModels >= options.modelsSeconds * 1000) void pollModels()
        if (now - lastLog >= options.logSeconds * 1000) pollLog()
      }
    }

    function startUi(): void {
      if (uiTimer !== undefined) return
      uiTimer = setInterval(tick, Math.round(1000 / options.refreshHz))
      uiTimer.unref?.()
    }

    /** An integration that failed is worth one interruption; the panel says it forever. */
    function reportOnce(): void {
      if (reported || attachErrors.length === 0) return
      reported = true
      try {
        ctx.ui.toast.show({
          title: "MLX Serve",
          message: `${attachErrors.length} integration(s) failed: ${attachErrors.map((e) => e.where).join(", ")}`,
          variant: "warning",
          duration: 6_000,
        })
      } catch {
        // nothing to toast into; the attach section still carries the detail
      }
    }

    // --- session events ----------------------------------------------------

    const sessionIDOf = (e: AnyEvent) => String(e.data.sessionID ?? "")
    const assistantOf = (e: AnyEvent) => String(e.data.assistantMessageID ?? "")
    const deltaOf = (e: AnyEvent) => (typeof e.data.delta === "string" ? e.data.delta : "")

    function claim(sessionID: string): void {
      if (sessionID === "") return
      activeSessions.add(sessionID)
      lastSession = sessionID
    }

    function onDelta(e: AnyEvent): void {
      if (!instanceIsOurs() || !isNewEvent(e)) return
      const sid = sessionIDOf(e)
      if (sid === "") return
      claim(sid)
      tracker.pushDelta(sid, deltaOf(e), createdAt(e), assistantOf(e))
      startUi()
    }

    function finishStep(e: AnyEvent): void {
      if (!instanceIsOurs() || !isNewEvent(e)) return
      const tokens = e.data.tokens as
        | { input?: number; output?: number; reasoning?: number; cache?: { read?: number }; cacheRead?: number }
        | undefined
      tracker.finishStep(
        sessionIDOf(e),
        assistantOf(e),
        tokens
          ? {
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cacheRead: tokens.cache?.read ?? tokens.cacheRead,
            }
          : undefined,
        createdAt(e),
      )
      startUi()
    }

    function finishRun(e: AnyEvent): void {
      if (!instanceIsOurs() || !isNewEvent(e)) return
      const sid = sessionIDOf(e)
      tracker.finish(sid, createdAt(e))
      activeSessions.delete(sid)
      if (lastSession === sid) lastSession = null
      serverBusyUntil = 0
      startUi()
      // The end of a turn is when the new [spec-stats] line lands in the log and
      // the histograms move. Read them now instead of on the next slow tick.
      pollLog()
      lastMetrics = 0
      void pollMetrics()
      void pollProps()
    }

    function listen(type: string, handler: (e: AnyEvent) => void): () => void {
      try {
        return ctx.data.on(type, handler)
      } catch (err) {
        attachErrors.push({ where: "data.on", detail: type })
        void err
        return () => {}
      }
    }

    const unsubs = [
      listen("session.execution.started", (e) => {
        if (!instanceIsOurs() || !isNewEvent(e)) return
        const sid = sessionIDOf(e)
        if (sid === "") return
        claim(sid)
        tracker.beginRun(sid, createdAt(e))
        history.delete(sid) // a new turn starts its own history
        startUi()
      }),
      listen("session.text.delta", onDelta),
      listen("session.reasoning.delta", onDelta),
      listen("session.tool.input.delta", onDelta),
      listen("session.step.started", (e) => {
        if (!instanceIsOurs() || !isNewEvent(e)) return
        const sid = sessionIDOf(e)
        if (sid === "") return
        claim(sid)
        tracker.beginStep(sid, assistantOf(e), createdAt(e))
        startUi()
      }),
      listen("session.step.ended", finishStep),
      listen("session.step.failed", finishStep),
      listen("session.execution.succeeded", finishRun),
      listen("session.execution.failed", finishRun),
      listen("session.execution.interrupted", finishRun),
      listen("session.idle", finishRun),
      listen("session.deleted", (e) => {
        if (!instanceIsOurs() || !isNewEvent(e)) return
        const sid = sessionIDOf(e)
        tracker.evict(sid)
        history.delete(sid)
        activeSessions.delete(sid)
        if (lastSession === sid) lastSession = null
        startUi()
      }),
    ]

    // --- data for the renderer ---------------------------------------------

    function speedFor(sessionID?: string): SpeedValue | null {
      const sid = sessionID ?? lastSession ?? activeSessions.values().next().value ?? null
      if (sid === null || sid === "") return null
      return tracker.value(sid, Date.now())
    }

    function panelInput(sessionID?: string): PanelInput {
      const now = Date.now()
      return {
        speed: speedFor(sessionID),
        service: service.statsAt(now),
        model,
        spec: tail?.latestSpec() ?? null,
        sampling: tail?.latestSampling() ?? null,
        hot: tail?.latestHot() ?? null,
        ssd: tail?.latestSsd() ?? null,
        diskCacheGb: options.diskCacheGb,
        log: logRead?.status ?? null,
        sparkCells: options.sparkCells,
        barCells: options.barCells,
        now,
        link: service.linkState(),
        wiredLimitGb: wiredGb,
        ratioCells: options.ratioCells,
        formatPath,
        attachErrors,
      }
    }

    // --- rendering ---------------------------------------------------------

    const dim = () => ctx.theme.text?.subdued ?? ctx.theme.text?.muted ?? ctx.theme.text?.default
    const bright = () => ctx.theme.text?.default ?? ctx.theme.text?.subdued

    function toneColor(tone: string): string | undefined {
      const key = tone === "live" ? "success" : tone === "warn" ? "warning" : tone === "error" ? "error" : "info"
      return ctx.theme.feedback?.[key]?.default ?? dim()
    }

    const Row = (props: { label: string; value: string; note?: string; tone?: string; noteBright?: boolean }) => (
      <text wrapMode="none" truncate>
        {props.label === "" ? null : <span style={{ fg: dim() }}>{props.label} </span>}
        <span style={{ fg: props.tone ? toneColor(props.tone) : bright() }}>{props.value}</span>
        {/* A note can be a second statistic ("34.5M in · 49.8k out"), not only an
            aside; drawing it dim makes it read as commentary on the number in
            front of it. */}
        {props.note ? <span style={{ fg: props.noteBright ? bright() : dim() }}> {props.note}</span> : null}
      </text>
    )

    const Block = (props: { section: SidebarSection }) => (
      <box>
        <text fg={bright()} wrapMode="none" truncate>
          <b>{props.section.title}</b>
          {/* One colour for every gauge: the value colour. A heading that faded
              to the theme's subdued tone read as a label, not a reading. */}
          {props.section.note === undefined ? null : <span style={{ fg: bright() }}> {props.section.note}</span>}
        </text>
        <For each={props.section.rows}>{(row) => <Row label={row.label} value={row.value} note={row.note} tone={row.tone} noteBright={row.noteBright} />}</For>
      </box>
    )

    /** The sidebar panel: header line, then each enabled section that has data. */
    const SidebarPanel = (props: { sessionID?: string }) => {
      // The poll schedule follows reality: we do the slow reads only while this
      // component is actually mounted, and hide the sidebar to stop them.
      createEffect(() => {
        setPanelOnScreen(true)
        onCleanup(() => setPanelOnScreen(false))
        startUi()
      })
      const sections = createMemo(() => {
        version()
        return buildSections(panelInput(props.sessionID), options.sections)
      })
      // No title line. The panel is named by what is in it, and "is the server
      // answering" is a statistic, so it is a row in the Server log section now.
      return (
        <box gap={1}>
          <For each={sections()}>{(section) => <Block section={section} />}</For>
        </box>
      )
    }

    /** The turn meter: always at the bottom, whatever the sidebar is doing. */
    const FooterMeter = (props: { sessionID?: string }) => {
      const label = createMemo(() => {
        version()
        if (!instanceIsOurs()) return null
        const value = speedFor(props.sessionID)
        if (value === null) return null
        // A prefill younger than ~5 frames has no tokens yet: drawing "prefill 0.0s"
        // and replacing it a blink later is a flicker, not a measurement.
        if (value.phase === "prefill" && value.elapsedMs < 80 && value.prefillTokens === null) return null
        return footerLabel(value, {
          barCells: options.barCells,
          historyCells: options.historyCells,
          historyRelative: options.historyRelative,
          series: props.sessionID == null ? null : seriesFor(props.sessionID).values(),
        })
      })
      return (
        <Show when={label()}>
          {(text: () => string) => <text fg={dim()}>{text()}</text>}
        </Show>
      )
    }

    const unslots: Array<() => void> = []
    // `prepend` puts the serving stats above the host's own Context and MCP
    // sections instead of burying them; the footer slot is where the meter was.
    const mounts: Array<{ spec: Record<string, unknown>; render: (input: { sessionID?: string }) => unknown }> = [
      {
        spec: { prepend: "sidebar.content" },
        render: (input) => <SidebarPanel sessionID={input.sessionID} />,
      },
      {
        spec: { append: "prompt.footer.status" },
        render: (input) => <FooterMeter sessionID={input.sessionID} />,
      },
    ]
    for (const mount of mounts) {
      const slotName = String(Object.values(mount.spec)[0] ?? "slot")
      const unslot = attempt(`ui.slot(${slotName})`, () => ctx.ui.slot({ ...mount.spec, render: mount.render }))
      if (unslot !== null) unslots.push(unslot)
    }

    void pollMetrics()
    void pollProps()
    void pollModels()
    pollLog()
    startUi()
    reportOnce()

    return () => {
      for (const unsub of unsubs) unsub()
      for (const unslot of unslots) unslot()
      stopUi()
      abort.abort()
      if (gen.active === mine)
        setGen((d) => {
          d.active = 0
        })
    }
  },
}

export default definition
