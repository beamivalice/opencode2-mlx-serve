/**
 * Plugin options: defaults, clamping, and the derived log path. Kept apart from
 * `tui.tsx` (JSX the host transpiles, which `node --test` cannot import) so it
 * is testable.
 */

import { resolveMetricsUrl } from "./tracker.ts"
import { defaultLogPath, portFromUrl } from "./logtail.ts"
import { ALL_SECTIONS, resolveSections, type SectionName } from "./rows.ts"

/**
 * Default sidebar sections. `turn` is left out because the footer meter already
 * shows it; add `"turn"` to `sections` to draw it in the panel too.
 */
export const DEFAULT_SECTIONS: readonly SectionName[] = ALL_SECTIONS.filter((name) => name !== "turn")

export interface ServeOptions {
  readonly metricsUrl: string
  /** The user named `logPath` (a path, or "off"), so the tail does not follow the feed's port. */
  readonly logPathExplicit: boolean
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
   * The wired ceiling the memory gauge is drawn against, in GiB. null means read
   * `iogpu.wired_limit_mb` once; with no value from either source the Memory
   * section shows the footprint as bytes and no gauge.
   */
  readonly wiredLimitGb: number | null
}

export const DEFAULTS: ServeOptions = {
  metricsUrl: "http://127.0.0.1:11234/metrics.json",
  logPathExplicit: false,
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
    logPathExplicit: src.logPath !== undefined,
    metricsToken: typeof src.metricsToken === "string" ? src.metricsToken : DEFAULTS.metricsToken,
    bytesPerToken: clamp(src.bytesPerToken, DEFAULTS.bytesPerToken, 1, 16),
    refreshHz: clamp(src.refreshHz, DEFAULTS.refreshHz, 1, 30),
    pollHz: clamp(src.pollHz, DEFAULTS.pollHz, 1, 20),
    idlePollHz: clamp(src.idlePollHz, DEFAULTS.idlePollHz, 0.2, 10),
    propsSeconds: clamp(src.propsSeconds, DEFAULTS.propsSeconds, 2, 600),
    modelsSeconds: clamp(src.modelsSeconds, DEFAULTS.modelsSeconds, 5, 3600),
    logSeconds: clamp(src.logSeconds, DEFAULTS.logSeconds, 1, 600),
    logPath,
    // A malformed `sections` value falls back to the default, not to every section.
    sections: resolveSections(src.sections, DEFAULT_SECTIONS),
    sparkCells: clamp(src.sparkCells, DEFAULTS.sparkCells, 0, 60),
    barCells: clamp(src.barCells, DEFAULTS.barCells, 0, 40),
    ratioCells: clamp(src.ratioCells, DEFAULTS.ratioCells, 0, 20),
    historyCells: clamp(src.historyCells, DEFAULTS.historyCells, 0, 60),
    // Only an explicit, sane number counts; anything else means no gauge.
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


