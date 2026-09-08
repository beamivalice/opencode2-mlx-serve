import assert from "node:assert/strict"
import { test } from "node:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LogTail, defaultLogPath, portFromUrl } from "./logtail.ts"

const MTP =
  "  [spec-stats] mode=mtp attempts=168 accepts=191 avg_per_round=1.14 per_draft_pct=67.7% depth=6 drafted=282 ext_rounds=21 partial_rounds=54 runtime_disabled=false reason=none adaptive=mtp serial_cell=21.74 sync_ms=2.93 round_ms=47.31 two_ms_tok=13.24 one_ms_tok=11.00 verdict_round=15 trials=3 width_trials=4 table=128-256k:w1:22.73/390 table_drops=t1/c0/b0/i0 serial_drops=t2/c0/b0"

const GATED =
  "  [spec-stats] mode=mtp attempts=55 accepts=89 avg_per_round=1.62 per_draft_pct=38.4% depth=6 drafted=232 ext_rounds=1 partial_rounds=44 runtime_disabled=true reason=adaptive adaptive=serial serial_cell=25.63 sync_ms=3.60 round_ms=35.17 verdict_round=15 table=32-64k:w1:19.26/611 table_drops=t0/c0/b0/i0 serial_drops=t0/c0/b0"

const CHAT =
  "POST /v1/chat/completions (127 msgs, max_tokens=64000 (launch default), temp=1.00, top_p=0.95, top_k=20, stream=true, thinking=true, sys=18571b, user=760b, tools=13061b, tool_msgs=68)"

function workspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mlx-tail-${name}-`))
  return dir
}

function tail(dir: string, name = "mlx-serve-11234.log", options = {}) {
  return new LogTail(join(dir, name), options)
}

// --- addressing ------------------------------------------------------------

test("defaultLogPath mirrors mlx-serve's per-port convention", () => {
  assert.equal(defaultLogPath(11234, "/Users/x"), "/Users/x/.mlx-serve/logs/mlx-serve-11234.log")
  assert.equal(defaultLogPath(8098, "/Users/x"), "/Users/x/.mlx-serve/logs/mlx-serve-8098.log")
  assert.match(defaultLogPath(11234, "/Users/x"), /\.log$/, "it must name a file, not a directory")
})

test("portFromUrl finds the port mlx-serve listens on", () => {
  assert.equal(portFromUrl("http://127.0.0.1:11234/metrics.json"), 11234)
  assert.equal(portFromUrl("http://localhost:11234"), 11234)
  assert.equal(portFromUrl("https://gpu.example:8443/metrics.json"), 8443)
  assert.equal(portFromUrl("https://gpu.example/metrics.json"), 443)
  assert.equal(portFromUrl("http://gpu.example/metrics.json"), 80)
  assert.equal(portFromUrl("11234", 9999), 9999, "garbage falls back instead of throwing")
  assert.equal(portFromUrl("", 80), 80)
})

// --- reading ---------------------------------------------------------------

test("the first poll back-reads the tail and marks it historic", () => {
  const dir = workspace("backread")
  try {
    writeFileSync(join(dir, "mlx-serve-11234.log"), `boot noise\n${CHAT}\n${MTP}\n`)
    const read = tail(dir).poll(1_000)
    assert.equal(read.status.error, null)
    assert.ok((read.status.bytes ?? 0) > MTP.length)
    assert.ok(read.spec, "the newest spec line is the one that describes the server")
    assert.equal(read.spec?.value.mode, "mtp")
    assert.equal(read.spec?.value.perDraftPct, 67.7)
    assert.equal(read.spec?.at, 1_000, "a value is stamped with the poll clock that read it")
    assert.equal(read.sampling?.value.temperature, 1)
    assert.equal(read.sampling?.value.messages, 127)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("appended lines advance the offset and read as fresh", () => {
  const dir = workspace("incremental")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    writeFileSync(file, `${MTP}\n`)
    const t = tail(dir)
    t.poll(1_000) // attach: the back-read consumes what is already there
    appendFileSync(file, `${GATED}\n${CHAT}\n`)
    const read = t.poll(2_000)
    assert.equal(read.status.lines, 2, "only the two new lines were scanned")
    assert.equal(read.spec?.value.perDraftPct, 38.4, "the newer tally replaced it")
    assert.equal(read.spec?.value.runtimeDisabled, true)
    assert.equal(read.spec?.at, 2_000, "the newest line replaces it and is re-stamped")
    assert.equal(read.sampling?.value.messages, 127)
    assert.equal(t.poll(3_000).status.lines, 0, "the second poll re-reads nothing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a line still being written is read again whole, not parsed in halves", () => {
  const dir = workspace("partial")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    const t = tail(dir)
    writeFileSync(file, `${MTP}\n`)
    assert.equal(t.poll(1_000).spec?.value.attempts, 168)

    const half = CHAT.slice(0, 60)
    appendFileSync(file, half)
    const held = t.poll(2_000)
        assert.equal(held.spec?.value.attempts, 168, "the unfinished line cannot replace the last good one")

    appendFileSync(file, `${CHAT.slice(60)}\n`)
    assert.equal(t.poll(3_000).sampling?.value.topK, 20, "it parses once the newline lands")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unicode survives a poll that stops mid-line", () => {
  const dir = workspace("unicode")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    const t = tail(dir)
    writeFileSync(file, `${MTP}\n`)
    t.poll(1_000)
    appendFileSync(file, "model said: 你好 🌍 — and kept going")
    const cut = t.poll(2_000)
    assert.equal(cut.status.lines, 0, "half a line is not a line: nothing is scanned yet")
    appendFileSync(file, "\n")
    const done = t.poll(3_000)
    assert.equal(done.status.error, null)
    assert.equal(done.status.lines, 1, "the line was scanned once, after it was complete")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotation and truncation rewind instead of reading past the end", () => {
  const dir = workspace("rotate")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    const t = tail(dir)
    writeFileSync(file, `${MTP}\n${"x".repeat(400)}\n`)
    t.poll(1_000)
    // mlx-serve renames the live file to `<path>.1` and starts a fresh one.
    writeFileSync(file, `${GATED}\n`)
    const read = t.poll(2_000)
    assert.equal(read.status.error, null)
    assert.equal(read.spec?.value.attempts, 55, "rewound to the new file's tail")
    assert.equal(read.spec?.at, 2_000, "bytes re-read after a rewind are stamped anew")
    appendFileSync(file, `${MTP}\n`)
    assert.equal(t.poll(3_000).spec?.value.attempts, 168)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing log file is a status line, not an exception", () => {
  const dir = workspace("missing")
  try {
    const t = tail(dir)
    const read = t.poll(1_000)
    assert.equal(read.status.bytes, null)
    assert.equal(read.status.error, "no log file", "--log-file off, or the server is remote")
    assert.equal(read.spec, null)
    writeFileSync(join(dir, "mlx-serve-11234.log"), `${CHAT}\n`)
    assert.equal(t.poll(2_000).sampling?.value.endpoint, "chat/completions", "it recovers on its own")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a multi-line backlog drains a chunk at a time without losing lines", () => {
  const dir = workspace("backlog")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    writeFileSync(file, "")
    const t = tail(dir, "mlx-serve-11234.log", { backBytes: 0, chunkBytes: 8192 })
    assert.equal(t.poll(1_000).status.error, null, "an empty file is not an error")

    appendFileSync(file, `${"noise-".repeat(200)}\n`.repeat(8)) // ~9.6 KB, then the line we care about
    appendFileSync(file, `${GATED}\n`)
    const first = t.poll(2_000)
    assert.equal(first.status.dropped, 0, "lines are not skipped just because the file grew")
    assert.equal(first.spec, null, "this poll only got as far as the noise")

    const next = t.poll(3_000)
    assert.equal(next.spec?.value.attempts, 55, "the next chunk reaches the spec line")
    assert.equal(next.spec?.at, 3_000, "the spec line lands on the poll that drained it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the newest line of each kind in a chunk wins", () => {
  const dir = workspace("lastwins")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    const t = tail(dir)
    writeFileSync(file, "")
    t.poll(1_000)
    appendFileSync(file, `${MTP}\n${CHAT}\n${GATED}\n`)
    const read = t.poll(2_000)
    assert.equal(read.spec?.value.attempts, 55, "not the first line in the chunk")
    assert.equal(read.sampling?.value.messages, 127)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a line longer than the read cap is skipped, not stuck", () => {
  const dir = workspace("longline")
  try {
    const file = join(dir, "mlx-serve-11234.log")
    const t = tail(dir, "mlx-serve-11234.log", { backBytes: 4096, chunkBytes: 4096 })
    writeFileSync(file, "")
    t.poll(1_000)
    appendFileSync(file, `${"z".repeat(20_000)}\n`)
    const read = t.poll(2_000)
    assert.ok(read.status.dropped >= 20_000, `one poll walks past the whole over-long line, saw ${read.status.dropped}`)
        appendFileSync(file, `${MTP}\n`)
    assert.equal(t.poll(3_000).spec?.value.mode, "mtp", "and the tail keeps working after it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
