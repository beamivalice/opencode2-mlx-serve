import assert from "node:assert/strict"
import { test } from "node:test"
import {
  SpeedTracker,
  parseMetricsJson,
  resolveMetricsUrl,
} from "./tracker.ts"
import { footerLabel } from "./rows.ts"
import { progressBar } from "./stats.ts"

test("resolveMetricsUrl accepts base, /metrics, and /metrics.json", () => {
  assert.equal(resolveMetricsUrl("http://127.0.0.1:11234"), "http://127.0.0.1:11234/metrics.json")
  assert.equal(resolveMetricsUrl("http://127.0.0.1:11234/"), "http://127.0.0.1:11234/metrics.json")
  assert.equal(resolveMetricsUrl("http://127.0.0.1:11234/metrics"), "http://127.0.0.1:11234/metrics.json")
  assert.equal(
    resolveMetricsUrl("http://127.0.0.1:11234/metrics.json"),
    "http://127.0.0.1:11234/metrics.json",
  )
})

test("parseMetricsJson reads live gauges", () => {
  const sample = parseMetricsJson(
    {
      gauges: {
        prefill_tokens_live: 8192,
        generation_tokens_live: 100,
        requests_prefilling: 1,
        requests_running: 1,
      },
    },
    1_000,
  )
  assert.equal(sample.prefillLive, 8192)
  assert.equal(sample.prefilling, true)
  assert.equal(sample.running, true)
})

test("prefill phase reports live tokens and rate from metrics chunks", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  t.applyMetrics("s1", {
    t: 0,
    prefillLive: 0,
    genLive: 10_000,
    prefilling: true,
    running: true,
  })
  t.applyMetrics("s1", {
    t: 2_000,
    prefillLive: 8_192,
    genLive: 10_000,
    prefilling: true,
    running: true,
  })
  const v = t.value("s1", 2_000)
  assert.equal(v?.phase, "prefill")
  assert.equal(v?.prefillTokens, 8_192)
  assert.ok(v?.prefillTps !== null && Math.abs(v.prefillTps - 8_192 / 2) < 1)
  assert.match(footerLabel(v!) ?? "", /prefill/)
  assert.match(footerLabel(v!) ?? "", /t\/s/)
})

test("metrics gen bursts become a live generate rate", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  const idle = { prefillLive: 0, prefilling: false, running: true }
  t.applyMetrics("s1", { t: 1_000, genLive: 30_000, ...idle })
  t.applyMetrics("s1", { t: 2_500, genLive: 30_106, ...idle })
  t.applyMetrics("s1", { t: 4_000, genLive: 30_212, ...idle })
  const v = t.value("s1", 4_000)
  assert.equal(v?.phase, "generate")
  assert.equal(v?.genTokens, 212)
  assert.ok(v?.genTps !== null && Math.abs(v.genTps - 106 / 1.5) < 1)
})

test("stream deltas estimate gen speed without metrics", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  t.pushDelta("s1", "abcd", 200, "m1") // 4 bytes → ~1 tok
  t.pushDelta("s1", "abcdefghijkl", 700, "m1") // 12 bytes
  const v = t.value("s1", 700)
  assert.equal(v?.phase, "generate")
  assert.ok((v?.genTokens ?? 0) > 0)
  assert.ok(v?.genTps !== null)
  assert.equal(v?.tokensEstimated, true)
})

test("finishStep keeps live prefill tps and applies exact gen tokens", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  t.applyMetrics("s1", { t: 0, prefillLive: 0, genLive: 0, prefilling: true, running: true })
  t.applyMetrics("s1", { t: 2_000, prefillLive: 8_000, genLive: 0, prefilling: true, running: true })
  t.pushDelta("s1", "hello world", 2_100, "m1")
  t.finishStep("s1", "m1", { input: 12_000, cacheRead: 4_000, output: 50, reasoning: 10 }, 3_000)
  t.finish("s1", 3_000)
  const v = t.value("s1", 3_000)
  assert.equal(v?.phase, "frozen")
  assert.equal(v?.genTokens, 60)
  assert.equal(v?.tokensEstimated, false)
  assert.ok(v?.prefillTps !== null && Math.abs(v.prefillTps - 4_000) < 1)
  assert.equal(v?.prefillTokens, 8_000)
})

test("text deltas do not inflate gen t/s above mlx-serve gen_live", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  const idle = { prefillLive: 0, prefilling: false, running: true }
  t.applyMetrics("s1", { t: 0, genLive: 10_000, ...idle })
  for (let i = 1; i <= 20; i++) t.pushDelta("s1", "abcdefghij", i * 10, "m1")
  t.applyMetrics("s1", { t: 1_500, genLive: 10_106, ...idle })
  t.applyMetrics("s1", { t: 3_000, genLive: 10_212, ...idle })
  const v = t.value("s1", 3_000)
  assert.ok(v?.genTps !== null)
  assert.ok(v!.genTps! < 90, `got ${v?.genTps}`)
  assert.ok(Math.abs(v!.genTps! - 106 / 1.5) < 5)
})

test("a 250ms gen_live jump does not report 300 t/s", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  const idle = { prefillLive: 0, prefilling: false, running: true }
  t.applyMetrics("s1", { t: 0, genLive: 10_000, ...idle })
  t.applyMetrics("s1", { t: 250, genLive: 10_106, ...idle })
  const early = t.value("s1", 250)
  assert.equal(early?.genTps ?? null, null)
  t.applyMetrics("s1", { t: 1_750, genLive: 10_212, ...idle })
  const v = t.value("s1", 1_750)
  assert.ok(v?.genTps !== null && v.genTps < 90, `got ${v?.genTps}`)
})

test("a single late burst does not report 30 t/s", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  const idle = { prefillLive: 0, prefilling: false, running: true }
  t.applyMetrics("s1", { t: 0, genLive: 10_000, ...idle })
  t.applyMetrics("s1", { t: 3_500, genLive: 10_106, ...idle })
  const early = t.value("s1", 3_500)
  assert.equal(early?.genTps ?? null, null)
  t.applyMetrics("s1", { t: 5_000, genLive: 10_212, ...idle })
  const v = t.value("s1", 5_000)
  assert.ok(v?.genTps !== null && Math.abs(v.genTps - 106 / 1.5) < 5, `got ${v?.genTps}`)
})

test("tool idle between gen bursts is excluded from average gen t/s", () => {
  const t = new SpeedTracker()
  t.beginRun("s1", 0)
  t.beginStep("s1", "m1", 0)
  const idle = {
    prefillLive: 0,
    prefilling: false,
    running: true,
  }
  t.applyMetrics("s1", { t: 0, genLive: 1_000, ...idle })
  t.applyMetrics("s1", { t: 1_000, genLive: 1_100, ...idle })
  t.applyMetrics("s1", { t: 2_000, genLive: 1_200, ...idle })
  const during = t.value("s1", 2_000)
  assert.ok(during?.genTps !== null && Math.abs(during.genTps - 100) < 1)

  t.finishStep("s1", "m1", { output: 100, reasoning: 0 }, 1_100)
  t.applyMetrics("s1", { t: 12_000, genLive: 1_200, ...idle })
  const waiting = t.value("s1", 12_000)
  assert.ok(waiting?.genTps !== null && Math.abs(waiting.genTps - 100) < 1, "tool wait must not dilute the rate")

  t.beginStep("s1", "m2", 12_000)
  t.applyMetrics("s1", { t: 12_000, genLive: 1_200, ...idle })
  t.applyMetrics("s1", { t: 13_000, genLive: 1_300, ...idle })
  t.applyMetrics("s1", { t: 14_000, genLive: 1_400, ...idle })
  const after = t.value("s1", 14_000)
  assert.ok(after?.genTps !== null && Math.abs(after.genTps - 100) < 1)
})

test("the footer line is turn stats, and holds no memory figure", () => {
  assert.equal(
    footerLabel({
      phase: "prefill",
      prefillTokens: null,
      prefillBaseline: null,
      prefillTps: null,
      genTokens: 0,
      genTps: null,
      ramGb: null,
      ttftMs: null,
      elapsedMs: 4_200,
      tokensEstimated: true,
      metricsOk: false,
    }),
    "prefill 4.2s",
  )

  assert.equal(
    footerLabel({
      phase: "generate",
      prefillTokens: 8_192,
      prefillBaseline: null,
      prefillTps: 410.4,
      genTokens: 312,
      genTps: 51.4,
      ramGb: 76.58,
      ttftMs: 1_200,
      elapsedMs: 8_000,
      tokensEstimated: true,
      metricsOk: true,
    }),
    "~312 tok · decode ~51.4 t/s · prefill 410 t/s",
  )

})

test("a second client decoding alongside us does not inflate our rate", () => {
  const tracker = new SpeedTracker()
  // The server-wide counter says 100 tok/s across two clients; our own stream
  // is ~10 tok/s of bytes. The meter must report our turn, not the machine.
  const shared = (t: number, runningCount: number) => ({
    t,
    prefillLive: 0,
    genLive: (t / 1000) * 100,
    prefilling: false,
    running: true,
    runningCount,
    memoryMb: 70_000,
  })
  for (let i = 1; i <= 10; i++) {
    tracker.pushDelta("a", "x".repeat(48), i * 1000, "m1")
    tracker.applyMetrics("a", shared(i * 1000, 2))
  }
  const v = tracker.value("a", 10_000)
  assert.ok(v)
  assert.ok(v.genTps !== null && v.genTps < 30, `expected our own ~10 t/s, got ${v.genTps}`)
  assert.equal(v.tokensEstimated, true, "a byte-estimated rate says so")
})

test("alone, the turn still uses the server's own token counter", () => {
  const tracker = new SpeedTracker()
  tracker.beginRun("a", 0)
  tracker.beginStep("a", "m1", 0)
  for (let i = 1; i <= 6; i++) {
    tracker.pushDelta("a", "x".repeat(48), i * 1000, "m1")
    tracker.applyMetrics("a", {
      t: i * 1000,
      prefillLive: 0,
      genLive: i * 100,
      prefilling: false,
      running: true,
      runningCount: 1,
      memoryMb: 70_000,
    })
  }
  const v = tracker.value("a", 6_000)
  assert.ok(v)
  assert.equal(v.genTps, 100, "one client: the counter is ours, and it beats a byte estimate")
})

test("prefill baseline is the last settled forwarded count", () => {
  const tracker = new SpeedTracker()
  // First step of a session: nothing settled, so there is no yardstick yet.
  tracker.beginRun("a", 0)
  tracker.beginStep("a", "m1", 0)
  tracker.pushDelta("a", "hello", 200, "m1")
  assert.equal(tracker.value("a", 200)?.prefillBaseline, null, "first prefill has no baseline")

  // It forwarded 50k prompt tokens of which 48k came back from the prefix cache.
  tracker.finishStep("a", "m1", { input: 50_000, output: 100, cacheRead: 48_000 }, 1_000)
  tracker.finish("a", 1_000)

  // Second step: the meter must remember 2k forwarded tokens across the new run.
  tracker.beginStep("a", "m2", 2_000)
  const during = tracker.value("a", 2_100)
  assert.equal(during?.phase, "prefill")
  assert.equal(during?.prefillBaseline, 2_000, "the yardstick carries across beginRun")
})

test("evicting a session forgets its prefill baseline", () => {
  const tracker = new SpeedTracker()
  tracker.beginRun("a", 0)
  tracker.beginStep("a", "m1", 0)
  tracker.finishStep("a", "m1", { input: 9_000, output: 10, cacheRead: 4_000 }, 1_000)
  tracker.evict("a")
  tracker.beginRun("a", 2_000)
  tracker.beginStep("a", "m2", 2_000)
  assert.equal(tracker.value("a", 2_100)?.prefillBaseline, null, "a deleted session starts over")
})

test("the footer prefill line becomes a progress bar against the last turn", () => {
  const t = new SpeedTracker()
  t.beginRun("a", 0)
  t.beginStep("a", "m1", 0)
  t.finishStep("a", "m1", { input: 48_000, output: 40, cacheRead: 44_000 }, 5_000) // forwarded 4k last turn
  t.finish("a", 5_000)

  t.beginStep("a", "m2", 6_000)
  for (let chunk = 1024; chunk <= 12_288; chunk += 1024) {
    t.applyMetrics("a", {
      t: 6_000 + chunk / 8,
      prefillLive: chunk,
      genLive: 1_000,
      prefilling: true,
      running: true,
      runningCount: 1,
      memoryMb: 70_000,
    })
  }
  const line = footerLabel(t.value("a", 7_600), { barCells: 18 })
  assert.ok(line !== null)
  assert.match(line, /^prefill [█░]{18} 12,288\/~4,000 · /, "bar, then x/y tokens with the yardstick marked as an estimate")
  assert.equal(line.includes("Memory"), false, "no memory figure in a turn readout")
  assert.equal([...line].filter((c) => c === "█").length, 18, "12,288 forwarded past a 4,000 yardstick saturates the bar")
})

test("no yardstick, no bar: the first prefill stays a rate line", () => {
  const t = new SpeedTracker()
  t.beginRun("a", 0)
  t.beginStep("a", "m1", 0)
  t.applyMetrics("a", { t: 1_200, prefillLive: 8_192, genLive: 0, prefilling: true, running: true, runningCount: 1, memoryMb: 70_000 })
  const line = footerLabel(t.value("a", 1_200), { barCells: 18 })
  assert.equal(line, "prefill 8,192 tok · 6827 t/s")
  assert.equal(progressBar(0.5, 6), "███░░░", "the bar primitive the footer draws with")
  assert.equal(footerLabel(t.value("a", 1_200), { barCells: 0 }), line, "barCells 0 draws the same facts as a saturated bar would")
})
