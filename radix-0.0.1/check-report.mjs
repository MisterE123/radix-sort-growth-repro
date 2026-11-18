// Exercise the published report UI using recorded stage data. The performance
// benchmark itself runs on actual WebGPU via npm run check.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const data = JSON.parse(await readFile(new URL("./measurements.json", import.meta.url)));
const records = data.runs.find(run => run.transport === "direct from PlayCanvas CDN").modes;
const browser = await chromium.launch({
  channel: process.env.BROWSER ?? "msedge",
  args: ["--disable-gpu", "--disable-software-rasterizer"],
});
const { server, url } = await serve();
try {
  const context = await browser.newContext();
  const modes = [];
  await context.route(/\/app-(stock|unmapped|patched)\.js$/, async route => {
    const mode = new URL(route.request().frame().url()).searchParams.get("mode") ?? "stock";
    modes.push(mode);
    const record = records[mode];
    const state = { ...record, mode, stages: record.frames, adapter: { backend: "webgpu", info: {vendor: "test fixture"} }, assets: [], idleMs: 0 };
    await route.fulfill({contentType: "text/javascript", body:
      `window.repro = ${JSON.stringify(state)};
       document.getElementById("status").textContent = "complete";
       document.getElementById("save").disabled = false;`});
  });
  const page = await context.newPage();
  await page.goto(url + "?mode=reserve");
  await page.locator("#frame-rows tr").nth(3).waitFor();
  assert.match(await page.locator("#allocation-note").innerText(), /35\.20\s*ms/);
  assert.match(await page.locator("#frame-rows tr").nth(1).innerText(), /within reservation/i);
  assert.equal(await page.locator("#save-comparison").isVisible(), false);
  await page.locator("#run-both").click();
  await page.locator("#save-comparison").waitFor();
  assert.deepEqual(modes, ["reserve", "stock", "unmapped"]);
  const costs = await page.locator("#comparison-body tr td:nth-child(2)").allTextContents();
  assert.deepEqual(costs.map(Number), [records.stock.frames[1].sortMs, records.unmapped.frames[1].sortMs]);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save-comparison").click();
  const result = JSON.parse(await readFile(await (await downloadPromise).path(), "utf8"));
  assert.deepEqual(result.stock.stages, records.stock.frames);
  assert.deepEqual(result.unmapped.stages, records.unmapped.frames);
  await page.reload();
  await page.locator("#frame-rows tr").nth(3).waitFor();
  assert.deepEqual(modes, ["reserve", "stock", "unmapped", "unmapped"]);
  assert.equal(await page.locator("#save-comparison").isVisible(), false);
  console.log("Passed reservation interpretation, paired measurements, JSON download and single-mode reload.");
} finally {
  await browser.close();
  server.close();
}
