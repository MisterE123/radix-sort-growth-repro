import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const modes = process.env.MODES?.split(",") ?? ["stock", "unmapped", "patched", "reserve"];
const idleMs = Number(process.env.IDLE_MS ?? 0);
const output = process.env.RESULTS ?? "roman-parish-results.json";
const channel = process.env.BROWSER ?? "msedge";
const { server, url } = await serve();
const reports = {};
let browser;
try {
  browser = await chromium.launch({ channel, headless: true, args: ["--enable-unsafe-webgpu", "--enable-webgl"] });
  for (const mode of modes) {
    const page = await browser.newPage({ viewport: { width: 880, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
    });
    const query = new URLSearchParams({ mode, idleMs: String(idleMs) });
    if (process.env.ROMAN_PARISH_CACHE) query.set("assetBase", "/cache/");
    await page.goto(`${url}?${query}`);
    try {
      await page.waitForFunction(() => window.repro?.done || window.repro?.errors.length, undefined, { timeout: idleMs + 90_000 });
    } finally {
      reports[mode] = { ...await page.evaluate(() => window.repro), browserErrors: errors };
      if (reports[mode].done) {
        const image = await page.locator("#viewport canvas").screenshot();
        reports[mode].finalCanvasSha256 = createHash("sha256").update(image).digest("hex");
      }
      await writeFile(output, JSON.stringify(reports, null, 2));
    }
    const report = reports[mode];
    const { stages } = report;
    assert.deepEqual(report.errors, [], `${mode} page errors`);
    assert.deepEqual(errors, [], `${mode} browser errors`);
    assert.equal(report.adapter.backend, "webgpu");
    assert.equal(stages.length, 4);
    for (const [i, frame] of stages.entries()) {
      assert.equal(frame.candidates, [2_000_000, 3_000_000, 3_000_000, 3_500_000][i]);
      assert.equal(frame.sorter, stages[0].sorter);
      assert.ok(frame.drawCalls > 0 && frame.visible > 0, `${mode} ${frame.name} drew no splats`);
      assert.equal(new Set(frame.buffers.map((buffer) => buffer.label)).size, frame.buffers.length);
    }
    assert.equal(stages[2].visible, stages[1].visible, "same-count replay must draw the same visible count");
    assert.equal(stages[2].sortedIndicesSha256, stages[1].sortedIndicesSha256, "same-count replay must sort the same indices");
    assert.equal(stages[0].buffers.length, 0);
    assert.equal(stages[1].buffers.length, mode === "reserve" ? 0 : 6);
    assert.equal(stages[2].buffers.length, 0);
    assert.equal(stages[3].buffers.length, 0);
    assert.equal(report.reserve.length, mode === "reserve" ? 6 : 0);
    assert.ok(stages[1].buffers.every((buffer) => buffer.mappedAtCreation === (mode !== "unmapped")));
    if (mode === "reserve") {
      assert.ok(stages.every((frame) => frame.capacityBefore >= 3_500_000 && frame.capacityBefore === frame.capacityAfter));
    } else {
      assert.ok(stages[1].capacityBefore < stages[1].candidates);
      assert.ok(stages[1].capacityAfter >= stages[3].candidates);
    }
    console.log(mode, report.adapter.info, stages.map(({name, candidates, visible, sortMs, followingCallbackGapMs, buffers}) =>
      ({name, candidates, visible, sortMs, followingCallbackGapMs, buffers: buffers.length})));
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}-${mode}.png` });
    await page.close();
  }
  const [reference, ...candidates] = Object.values(reports);
  for (const candidate of candidates) {
    const signature = (report) => report.stages.map(({ visible, sortedIndicesSha256 }) => ({ visible, sortedIndicesSha256 }));
    assert.deepEqual(signature(candidate), signature(reference), "visibility and sorted indices must match across modes");
    assert.equal(candidate.finalCanvasSha256, reference.finalCanvasSha256, "final canvas pixels must match across modes");
  }
} finally {
  await browser?.close();
  server.close();
}
