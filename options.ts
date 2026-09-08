/**
 * Plugin options and command-argument parsing — the decisions the plugin makes
 * before it talks to a server or a terminal.
 *
 * This lives apart from `tui.tsx` on purpose: that file is JSX the host
 * transpiles, so Node's test runner cannot import it, and the argument matching
 * below is exactly the code that silently broke `/speed` (the host's slash
 * matcher ignores commands that do not declare `arguments: true`). Pure and
 * tiny beats untestable and confident.
 */

import { resolveMetricsUrl } from "./tracker.ts"
import { defaultLogPath, portFromUrl } from "./logtail.ts"
import { ALL_SECTIONS, resolveSections, type SectionName } from "./rows.ts"

/**
 * What the sidebar draws by default. `turn` is left out: the speed meter lives in
 * the prompt footer, permanently, and repeating it above would be the same
 * measurement twice. Add `"turn"` to `sections` to get it back in the panel (the
 * Throughput section then folds itself away instead of duplicating the rate).
 */
export const DEFAULT_SECTIONS: readonly SectionName[] = ALL_SECTIONS.filter((name) => name !== "turn")

export interface ServeOptions {
  readonly metricsUrl: string
  readonly metricsToken: string
  readonly bytesPerToken: number
  /** UI re-render rate while something is moving. */
  readonly refreshHz: number
  /** /metrics.json rate while a request is in flight. */
  readonly pollHz: number
  /** /metrics.json rate while the panel is on screen and the server is idle. */
  readonly idlePollHz: number
  readonly propsSeconds: number
  readonly modelsSeconds: number
  readonly logSeconds: number
  /** null disables the log tail (remote server, or the server ran --log-file off). */
  readonly logPath: string | null
  readonly sections: SectionName[]
  /** Sparkline width in cells; 0 turns it off. */
  readonly sparkCells: number
  /** Prefill progress bar width in cells; 0 falls back to the plain rate. */
  readonly barCells: number
  /** Ratio-bar width in cells; 0 draws percentages only. */
  readonly ratioCells: number
  /** Width of the footer's decode-rate histogram in cells; 0 omits it. */
  readonly historyCells: number
  /**
   * The SSD tier's cap in GiB, for the `ssd` gauge: it is the server's
   * `--prefix-cache-disk` flag and appears in no log line or endpoint, so the
   * panel cannot discover it. null draws the tier's bytes with no gauge.
   */
  readonly diskCacheGb: number | null
  /**
   * The wired ceiling the memory gauge is drawn against, in GiB. Set this to
   * `sysctl iogpu.wired_limit_mb / 1024` when it has been raised — mlx-serve
   * reads the real Metal working-set size but does not publish it.
   *
   * null with no sysctl to read means NO gauge: the Memory section shows the
   * footprint as bytes alone. Guessing 75% of RAM put a 92 GB footprint at 95% of
   * a ceiling this machine's owner had already raised to ~117 GB.
   */
  readonly wiredLimitGb: number | null
  /**
   * Scale the footer's decode histogram to its own min..max rather than 0..max.
   * Default true: against a zero baseline a turn holding 22-30 t/s is a flat
   * block, and the bumps are the only reason the series is drawn. The exact rate
   * is printed in front of it, so the scale is never hidden.
   */
  readonly historyRelative: boolean
}

export const DEFAULTS: ServeOptions = {
  metricsUrl: "http://127.0.0.1:11234/metrics.json",
  metricsToken: "mlx-serve",
  bytesPerToken: 4.75,
  refreshHz: 8,
  pollHz: 4,
  idlePollHz: 1,
  propsSeconds: 15,
  modelsSeconds: 30,
  logSeconds: 5,
  logPath: null,
  sections: [...DEFAULT_SECTIONS],
  sparkCells: 24,
  barCells: 18,
  ratioCells: 8,
  historyCells: 14,
  historyRelative: true,
  diskCacheGb: null,
  wiredLimitGb: null,
}

export function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

/** Scheme + host + port of a feed URL, so /props and /v1/models can be reached. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

export function resolveOptions(raw: Record<string, unknown> | undefined): ServeOptions {
  const src = raw ?? {}
  const metricsUrl =
    typeof src.metricsUrl === "string" && src.metricsUrl.trim() !== ""
      ? resolveMetricsUrl(src.metricsUrl)
      : DEFAULTS.metricsUrl
  // Any blank or off-ish value disables the tail; a non-string falls back to the
  // conventional path for the feed's port.
  const logPath =
    typeof src.logPath === "string"
      ? src.logPath.trim() === "" || src.logPath.trim().toLowerCase() === "off" || src.logPath.trim().toLowerCase() === "none"
        ? null
        : src.logPath.trim()
      : src.logPath === undefined
        ? defaultLogPath(portFromUrl(metricsUrl))
        : null
  return {
    metricsUrl,
    metricsToken: typeof src.metricsToken === "string" ? src.metricsToken : DEFAULTS.metricsToken,
    bytesPerToken: clamp(src.bytesPerToken, DEFAULTS.bytesPerToken, 1, 16),
    refreshHz: clamp(src.refreshHz, DEFAULTS.refreshHz, 1, 30),
    pollHz: clamp(src.pollHz, DEFAULTS.pollHz, 1, 20),
    idlePollHz: clamp(src.idlePollHz, DEFAULTS.idlePollHz, 0.2, 10),
    propsSeconds: clamp(src.propsSeconds, DEFAULTS.propsSeconds, 2, 600),
    modelsSeconds: clamp(src.modelsSeconds, DEFAULTS.modelsSeconds, 5, 3600),
    logSeconds: clamp(src.logSeconds, DEFAULTS.logSeconds, 1, 600),
    logPath,
    // A malformed `sections` value falls back to this plugin's default, not to
    // every section there is (which would put the turn meter back in the panel).
    sections: resolveSections(src.sections, DEFAULT_SECTIONS),
    sparkCells: clamp(src.sparkCells, DEFAULTS.sparkCells, 0, 60),
    barCells: clamp(src.barCells, DEFAULTS.barCells, 0, 40),
    ratioCells: clamp(src.ratioCells, DEFAULTS.ratioCells, 0, 20),
    historyCells: clamp(src.historyCells, DEFAULTS.historyCells, 0, 60),
    historyRelative: typeof src.historyRelative === "boolean" ? src.historyRelative : DEFAULTS.historyRelative,
    // Only an explicit, sane number counts as a declaration; anything else leaves
    // the gauge assuming the macOS default.
    diskCacheGb:
      typeof src.diskCacheGb === "number" && Number.isFinite(src.diskCacheGb) && src.diskCacheGb >= 0.5 && src.diskCacheGb <= 65536
        ? src.diskCacheGb
        : null,
    wiredLimitGb:
      typeof src.wiredLimitGb === "number" && Number.isFinite(src.wiredLimitGb) && src.wiredLimitGb >= 0.5 && src.wiredLimitGb <= 8192
        ? src.wiredLimitGb
        : null,
  }
}


