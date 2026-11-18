const byId = (id) => document.getElementById(id);
const url = new URL(location.href);
const mode = url.searchParams.get("mode") ?? "stock";
const modes = new Map([
  ["stock", ["Stock Radix 0.0.1", "The published sorter creates mapped scratch buffers when it needs more room."]],
  ["unmapped", ["Unmapped growth", "The proposed fix creates scratch buffers unmapped. The GPU writes the data during sorting."]],
  ["patched", ["Reservation patch without reserving", "This control uses the separate reservation patch and leaves the startup reservation off. Scratch buffers are allocated on demand."]],
  ["reserve", ["Startup reservation", "This control uses the separate reservation patch. Before the first frame it requests room for the final candidate count."]],
]);
const [title, explanation] = modes.get(mode) ?? ["Unknown mode", "Choose a test mode to run the benchmark."];
const count = new Intl.NumberFormat("en-US");
const ms = (value) => value.toFixed(2);
const runButton = byId("run-both");
const pairDownload = byId("save-comparison");
const progress = byId("compare-progress");
const storageKey = "radix-0.0.1:pending-comparison";
const manual = "Run Stock and Proposed fix separately and download each run’s JSON.";
const settings = new URLSearchParams(url.search);
settings.delete("mode");
settings.delete("pair");
settings.sort();
const settingsKey = JSON.stringify([url.pathname, settings.toString()]);
let pair = null;
let completed = null;
let failed = false;
let standaloneNotice = "";

function modeUrl(nextMode, token) {
  const next = new URL(url);
  next.searchParams.set("mode", nextMode);
  next.searchParams.delete("pair");
  if (token) next.searchParams.set("pair", token);
  return next;
}

byId("mode-title").textContent = title;
byId("mode-explanation").textContent = explanation;
for (const link of document.querySelectorAll("a[data-mode]")) {
  link.href = modeUrl(link.dataset.mode);
  if (link.dataset.mode === mode) link.setAttribute("aria-current", "page");
}
if (["reserve", "patched"].includes(mode)) byId("controls").open = true;

function inCapacity(frame) {
  return frame.candidates <= frame.capacityBefore && frame.capacityBefore === frame.capacityAfter;
}

function increaseLabel(frame, index) {
  const increase = index === 1 ? "First increase" : "Final increase";
  if (frame.capacityAfter > frame.capacityBefore) return increase + " · capacity grew";
  if (inCapacity(frame)) return increase + (mode === "reserve" ? " within reservation" : " within capacity");
  return increase;
}

function appendRow(body, values) {
  const row = document.createElement("tr");
  for (const [index, value] of values.entries()) {
    const cell = document.createElement(index === 0 ? "th" : "td");
    if (index === 0) cell.scope = "row";
    cell.textContent = value;
    row.append(cell);
  }
  body.append(row);
}

function bufferSummary(buffers) {
  if (!buffers.length) return "0";
  const mapped = buffers.filter((buffer) => buffer.mappedAtCreation).length;
  if (mapped === 0) return buffers.length + " unmapped";
  if (mapped === buffers.length) return buffers.length + " mapped";
  return mapped + " mapped, " + (buffers.length - mapped) + " unmapped";
}

function renderFrames(report) {
  const body = byId("frame-rows");
  body.replaceChildren();
  report.stages.forEach((frame, index) => {
    const label = index === 0 ? "Baseline" : index === 2 ? "Same-count replay" : increaseLabel(frame, index);
    const capacity = frame.capacityBefore === frame.capacityAfter
      ? count.format(frame.capacityAfter)
      : count.format(frame.capacityBefore) + " → " + count.format(frame.capacityAfter);
    appendRow(body, [label, count.format(frame.candidates), capacity, bufferSummary(frame.buffers),
      ms(frame.sortMs), ms(frame.followingCallbackGapMs)]);
  });
  const first = report.stages[1];
  const replay = report.stages[2];
  byId("live-summary").textContent = title + " sorted " + count.format(first.candidates) + " candidates in " +
    ms(first.sortMs) + " ms on the first increase and " + ms(replay.sortMs) + " ms on replay.";
  const note = byId("allocation-note");
  if (mode === "reserve") {
    byId("live-summary").textContent = "Startup reservation took " + ms(report.reserveMs) +
      " ms. Increasing to " + count.format(first.candidates) + " candidates then created " + first.buffers.length + " scratch buffers.";
    note.textContent = "Before the first frame, reservation took " + ms(report.reserveMs) +
      " ms and created " + report.reserve.length + " tracked scratch buffers. Baseline capacity was " +
      count.format(report.stages[0].capacityBefore) + " candidates. The first increase created " +
      first.buffers.length + " buffers.";
  } else {
    note.textContent = "The first increase created " + first.buffers.length + " tracked scratch buffers. " +
      "The same-count replay created " + replay.buffers.length + ".";
  }
}

function renderComparison(stock, unmapped) {
  const body = byId("comparison-body");
  body.replaceChildren();
  for (const [label, report] of [["Stock 0.0.1", stock], ["Unmapped growth", unmapped]]) {
    if (!report) {
      appendRow(body, [label, "—", "—", "—", "—", "—"]);
      continue;
    }
    const [, first, replay, last] = report.stages;
    appendRow(body, [label, ms(first.sortMs), ms(first.followingCallbackGapMs),
      bufferSummary(first.buffers), ms(replay.sortMs), ms(last.sortMs)]);
  }
}

// Use the actual workload and reported device for both finished runs. The URL
// check separately prevents an unrelated navigation from continuing a pair.
function workload(report) {
  return JSON.stringify([report.idleMs, report.assets, report.stages.map((frame) => frame.candidates)]);
}

function sameOutputs(stock, unmapped) {
  return stock.stages.every((frame, index) => Number.isSafeInteger(frame.visible) &&
    frame.visible === unmapped.stages[index].visible && /^[a-f0-9]{64}$/.test(frame.sortedIndicesSha256) &&
    frame.sortedIndicesSha256 === unmapped.stages[index].sortedIndicesSha256);
}

function offerDownload(stock, unmapped) {
  pairDownload.hidden = false;
  pairDownload.onclick = () => {
    const json = JSON.stringify({ settings: Object.fromEntries(settings), stock, unmapped }, null, 2);
    const href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "roman-parish-stock-and-unmapped.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
}

function compareRuns(stock, unmapped) {
  const note = byId("comparison-note");
  if (workload(stock) !== workload(unmapped) || stock.browser !== unmapped.browser ||
      JSON.stringify(stock.adapter) !== JSON.stringify(unmapped.adapter)) {
    progress.textContent = "Comparison stopped.";
    byId("live-summary").textContent = "These runs used different workloads or reported different browser or GPU details.";
    note.textContent = "The table shows the proposed fix run. Select Compare stock and fix to start a fresh pair.";
    return;
  }
  renderComparison(stock, unmapped);
  progress.textContent = "Both runs complete.";
  const a = stock.stages[1];
  const b = unmapped.stages[1];
  const delta = Number(ms(a.sortMs - b.sortMs));
  const direction = delta === 0 ? "the same as stock at this precision" :
    ms(Math.abs(delta)) + " ms " + (delta > 0 ? "less" : "more") + " than stock";
  byId("live-summary").textContent = "At " + count.format(b.candidates) + " candidates, the proposed fix sorted in " +
    ms(b.sortMs) + " ms, " + direction + ". Its next callback arrived after " + ms(b.followingCallbackGapMs) + " ms.";
  const growing = [a, b].filter((frame) => frame.capacityAfter > frame.capacityBefore).length;
  note.textContent = ["Neither first increase grew capacity.",
    "Only one run grew capacity on the first increase.", "Both first increases grew capacity."][growing];
  if ([stock, unmapped].some((report) => report.stages[3].candidates > report.stages[3].capacityBefore)) {
    note.textContent += " The final increase also exceeded the previous capacity in at least one run.";
  }
  if (!Object.values(stock.adapter.info).some(Boolean)) {
    note.textContent += " The browser withheld the adapter identity. Its reported GPU capabilities matched.";
  }
  if (sameOutputs(stock, unmapped)) {
    note.textContent += " Visible counts and sorted-index hashes matched on all four frames.";
  } else {
    byId("live-summary").textContent = "Output check failed. The two runs did not report matching visible counts and sorted-index hashes for every frame.";
    note.textContent += " Download the comparison JSON to inspect the affected frames.";
  }
  offerDownload(stock, unmapped);
}

function finishedRun(report) {
  return report?.done === true && Array.isArray(report.errors) && report.errors.length === 0 &&
    report.adapter?.backend === "webgpu" && report.adapter.info && Array.isArray(report.assets) &&
    Array.isArray(report.stages) && report.stages.length === 4 &&
    report.stages.every((frame) => frame && [frame.candidates, frame.capacityBefore, frame.capacityAfter,
      frame.sortMs, frame.followingCallbackGapMs].every(Number.isFinite) && Array.isArray(frame.buffers) &&
      frame.buffers.every((buffer) => buffer && typeof buffer === "object")) &&
    (report.mode !== "reserve" || Number.isFinite(report.reserveMs) && Array.isArray(report.reserve));
}

function enterPair() {
  const token = url.searchParams.get("pair");
  if (!token) return;
  // Consume the handoff once. A reload or a shared direct link runs only the
  // selected mode, even if a previous comparison was interrupted.
  history.replaceState(history.state, "", modeUrl(mode));
  try {
    const pending = JSON.parse(sessionStorage.getItem(storageKey));
    if (pending?.token === token) {
      sessionStorage.removeItem(storageKey);
      if (pending.settings === settingsKey && pending.next === mode &&
          (mode === "stock" || mode === "unmapped" && pending.stock?.mode === "stock" && finishedRun(pending.stock))) {
        pair = pending;
      }
    }
  } catch {
    // The individual benchmark works with storage disabled.
  }
  if (!pair) standaloneNotice = "This link will run one mode. " + manual;
}

function handoff(next, stock) {
  const pending = { token: pair.token, settings: settingsKey, next, stock };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
  } catch {
    pair = null;
    runButton.disabled = false;
    standaloneNotice = "This tab could not save the comparison. " + manual;
    progress.textContent = standaloneNotice;
    return;
  }
  location.replace(modeUrl(next, pending.token));
}

function finishPair() {
  if (mode === "stock") {
    handoff("unmapped", completed);
  } else {
    compareRuns(pair.stock, completed);
    runButton.disabled = false;
    pair = null;
  }
}

function showProgress() {
  runButton.disabled = true;
  progress.textContent = mode === "stock" ? "Running stock (1 of 2)…" : "Running unmapped growth (2 of 2)…";
  if (pair.stock) renderComparison(pair.stock, null);
}

runButton.addEventListener("click", () => {
  if (pair) return;
  pairDownload.hidden = true;
  pair = { token: crypto.getRandomValues(new Uint32Array(4)).join("-") };
  if (mode !== "stock" || failed || completed) {
    runButton.disabled = true;
    handoff("stock", null);
    return;
  }
  showProgress();
});

enterPair();
if (pair) showProgress();

const status = byId("status");
const save = byId("save");
function update() {
  const state = globalThis.repro;
  // The original fixture uses fixed stage names, even with custom counts or
  // reservation. Report only the step being attempted until measurements exist.
  const message = status.textContent;
  if (message) {
    byId("run-status").textContent = message
      .replace(/^Capacity crossing · /, "First increase · ")
      .replace(/^Increase within stock capacity · /, "Final increase · ");
  }
  if (state?.errors?.length || message.startsWith("Could not load the test module")) {
    if (pair) progress.textContent = "Comparison stopped because the " + title + " run reported an error. " + manual;
    else progress.textContent = standaloneNotice || title + " stopped.";
    pairDownload.hidden = true;
    byId("live-summary").textContent = "This run could not finish. The recorded comparison above is available for reference.";
    byId("comparison-note").textContent = /WebGPU|adapter/i.test(message)
      ? "Try a WebGPU-capable browser with hardware acceleration enabled."
      : "See the individual run below for the error.";
    renderComparison(pair?.stock, null);
    pair = null;
    failed = true;
    runButton.disabled = false;
    return;
  }
  if (failed || completed) return;
  if (save.disabled || !finishedRun(state) || state.mode !== mode) {
    const step = pair ? (mode === "stock" ? "Stock (1 of 2)" : "Proposed fix (2 of 2)") : title;
    progress.textContent = standaloneNotice || step + " · " + (byId("run-status").textContent || "Preparing the renderer…");
    return;
  }
  completed = { ...state, browser: navigator.userAgent };
  progress.textContent = standaloneNotice || title + " complete.";
  renderFrames(completed);
  if (mode === "stock" || mode === "unmapped") {
    renderComparison(mode === "stock" ? completed : null, mode === "unmapped" ? completed : null);
    byId("comparison-note").textContent = "Select Compare stock and fix to measure both modes together.";
  } else {
    renderComparison(null, null);
    byId("comparison-note").textContent = "This reservation control is listed below. Select Compare stock and fix to fill the comparison table.";
  }
  if (pair) finishPair();
}
const observer = new MutationObserver(update);
observer.observe(save, { attributes: true, attributeFilter: ["disabled"] });
observer.observe(status, { childList: true, characterData: true, subtree: true });
update();
