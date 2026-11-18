import * as THREE from "three";
import { SplatCollection, SplatRenderer, WgpuSplatSorter, createRenderer, getGpuCaps } from "@sparkjsdev/radix";
import { decodeSogGpu } from "./sogs/gpuDecode.js";
import { parseSogMeta } from "./sogs/sog.js";

const officialBase = "https://code.playcanvas.com/examples_data/example_roman_parish_03/";
const labels = new Set([
  "radix_compactKeys", "radix_compactValues", "radix_compactBlockOffsets",
  "radix_sortKeysB", "radix_sortValuesB", "radix_sortBlockHistograms",
]);
const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "stock";
const idleMs = Number(params.get("idleMs") ?? 0);
const startCount = Number(params.get("start") ?? 2_000_000);
const growCount = Number(params.get("grow") ?? 3_000_000);
const withinCount = Number(params.get("within") ?? 3_500_000);
const base = new URL(params.get("assetBase") ?? officialBase, location.href);
const chunkCounts = [528507, 534035, 590090, 554730, 594452, 573643, 556083];
const fmt = new Intl.NumberFormat("en-US");
const el = (id) => document.getElementById(id);
const status = (message) => { el("status").textContent = message; };
const state = globalThis.repro = { mode, idleMs, assets: [], reserve: [], stages: [], errors: [], done: false };

function fail(error) {
  const message = error?.stack ?? String(error);
  state.errors.push(message);
  status(String(error));
  console.error(error);
}
addEventListener("error", (event) => fail(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => fail(event.reason));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const now = () => performance.now();
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(now())));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const measure = (fn) => {
  const t = now();
  fn();
  return now() - t;
};

async function run() {
  if (!["stock", "patched", "reserve", "unmapped"].includes(mode)) throw new Error("Use stock, patched, reserve, or unmapped for mode.");
  if (![startCount, growCount, withinCount, idleMs].every(Number.isSafeInteger) || idleMs < 0 ||
      startCount < 1 || growCount <= startCount || withinCount <= growCount ||
      withinCount > chunkCounts.reduce((sum, count) => sum + count, 0)) {
    throw new Error("Choose increasing start, grow and within counts within the available scene rows, and idleMs ≥ 0.");
  }
  const renderer = await createRenderer({ hdr: false });
  if (getGpuCaps(renderer).backend !== "webgpu") throw new Error("WebGPU is required.");
  const device = renderer.backend.device;
  device.addEventListener("uncapturederror", (event) => fail(event.error));
  device.lost.then((info) => { if (!state.done) fail(new Error(`WebGPU device lost: ${info.message}`)); });
  state.adapter = { ...getGpuCaps(renderer), info: Object.fromEntries(
    ["vendor", "architecture", "device", "description"].map((key) => [key, device.adapterInfo?.[key] ?? renderer.backend.adapter?.info?.[key] ?? ""]),
  ) };
  const viewport = el("viewport");
  const width = 640, height = 360;
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  viewport.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#17191d");
  const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const camera = new THREE.PerspectiveCamera(58, width / height, 0.05, 800);
  const splats = new SplatRenderer({ renderer, sortMode: "gpu", sortBits: 24, directCanvas: false });
  scene.add(splats);

  // Decode the same real source rows up front. No asset IO, upload, or
  // generator creation occurs during a collection swap in the frame probe.
  const files = [];
  const bounds = new THREE.Box3();
  const decodeMean = (value) => Math.sign(value) * Math.expm1(Math.abs(value));
  let total = 0;
  for (const [index, expected] of chunkCounts.entries()) {
    const name = `0_${index}`;
    status(`Loading Roman Parish chunk ${name}…`);
    const url = new URL(`${name}/meta.json`, base);
    const { shN: _, ...raw } = await (await download(url)).json();
    const meta = parseSogMeta(raw);
    if (meta.count !== expected) throw new Error(`Unexpected row count in ${url}. Expected ${expected}, got ${meta.count}.`);
    const file = await decodeSogGpu(renderer, { name, meta, async getFile(channel) {
      return new Uint8Array(await (await download(new URL(channel, url))).arrayBuffer());
    } });
    if (file.arrays.count !== expected) throw new Error(`Decoded row count differs in ${url}.`);
    files.push(file.arrays);
    bounds.union(new THREE.Box3(
      new THREE.Vector3(...meta.means.mins.map(decodeMean)),
      new THREE.Vector3(...meta.means.maxs.map(decodeMean)),
    ).applyMatrix4(rotation));
    total += expected;
    state.assets.push({ url: url.href, count: expected });
    if (total >= withinCount) break;
  }
  await device.queue.onSubmittedWorkDone();
  state.loadedRows = total;
  const middle = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z);
  camera.position.copy(middle).add(new THREE.Vector3(-span * 0.66, span * 0.75, span * 0.74));
  camera.lookAt(middle);
  camera.updateMatrixWorld();

  // One renderer and one sorter throughout. A collection simply touches a
  // longer prefix of disjoint level-0 chunks and their unmodified source rows.
  const collections = new Map([startCount, growCount, withinCount].map((count) => {
    let left = count;
    const objects = [];
    for (const arrays of files) {
      if (left === 0) break;
      const rows = Math.min(left, arrays.count);
      objects.push(SplatCollection.arrays(arrays, { sh: false, count: rows, matrixWorld: rotation }));
      left -= rows;
    }
    const collection = new SplatCollection(objects);
    if (collection.count !== count) throw new Error(`Collection contains ${collection.count} rows. Expected ${count}.`);
    return [count, collection];
  }));

  let capture;
  let activeFrame;
  let lastSorter;
  const createBuffer = device.createBuffer;
  device.createBuffer = function (descriptor) {
    const buffer = createBuffer.call(this, descriptor);
    if (labels.has(descriptor.label)) capture?.push({
      label: descriptor.label, bytes: descriptor.size, mappedAtCreation: Boolean(descriptor.mappedAtCreation),
    });
    return buffer;
  };
  const sorterIds = new WeakMap();
  let nextSorterId = 0;
  const originalSort = WgpuSplatSorter.prototype.sort;
  WgpuSplatSorter.prototype.sort = function (arrays, count, bits) {
    lastSorter = this;
    if (!sorterIds.has(this)) sorterIds.set(this, ++nextSorterId);
    if (activeFrame) {
      activeFrame.candidates = count;
      activeFrame.sorter = sorterIds.get(this);
      activeFrame.capacityBefore = this.values.capacity;
    }
    originalSort.call(this, arrays, count, bits);
    if (activeFrame) activeFrame.capacityAfter = this.values.capacity;
  };
  splats.phase = (name, action) => {
    const duration = measure(action);
    if (activeFrame) activeFrame[`${name}Ms`] = duration;
  };
  splats.onAfterRender = () => {
    if (activeFrame) activeFrame.drawCalls++;
  };

  if (mode === "reserve") {
    capture = state.reserve;
    state.reserveMs = measure(() => splats.reserveSortCapacity(withinCount));
    capture = undefined;
    await device.queue.onSubmittedWorkDone();
  }
  function draw(count, stage) {
    activeFrame = stage;
    capture = stage?.buffers;
    const duration = measure(() => {
      splats.collection = collections.get(count);
      splats.prepare(camera);
      renderer.render(scene, camera);
    });
    activeFrame = undefined;
    capture = undefined;
    if (stage) stage.frameMs = duration;
  }
  async function stage(name, count) {
    status(`${name} · ${fmt.format(count)} candidate rows`);
    const entry = { name, requested: count, buffers: [], drawCalls: 0 };
    const start = await nextFrame();
    draw(count, entry);
    const following = await nextFrame();
    entry.followingCallbackGapMs = following - start;
    // Read back only after the frame-to-following-callback sample is over.
    entry.visible = await splats.readSortedCount();
    const sorted = await lastSorter.values.read(0, entry.visible);
    const digest = await crypto.subtle.digest("SHA-256", sorted);
    entry.sortedIndicesSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    state.stages.push(entry);
    const tr = document.createElement("tr");
    for (const value of [entry.name, fmt.format(entry.candidates), fmt.format(entry.visible),
      `${entry.capacityBefore.toLocaleString()} → ${entry.capacityAfter.toLocaleString()}`, entry.buffers.length,
      entry.sortMs.toFixed(2), entry.followingCallbackGapMs.toFixed(2)]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    el("results").append(tr);
  }
  status("Warming the renderer…");
  for (let i = 0; i < 8; i++) {
    await nextFrame();
    draw(startCount);
  }
  await device.queue.onSubmittedWorkDone();
  await stage("Baseline", startCount);
  if (idleMs) {
    status(`Idle for ${(idleMs / 1000).toFixed(1)} seconds…`);
    await pause(idleMs);
  }
  await stage("Capacity crossing", growCount);
  await stage("Same-count replay", growCount);
  await stage("Increase within stock capacity", withinCount);
  state.done = true;
  status(`${mode} complete${mode === "reserve" ? ` · ${state.reserve.length} startup scratch buffers` : ""}`);
  el("save").disabled = false;
}

el("save").onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
  const download = Object.assign(document.createElement("a"), { href: url, download: `roman-parish-${mode}.json` });
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
run().catch(fail);
