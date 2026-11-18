# Reproducing the WebGPU sorter growth hitch

A warmed Radix WebGPU renderer missed its next animation callback by several frame intervals when it first sorted more candidates than its scratch storage could hold. The public repro crosses that boundary once, replays the same count, then increases the count again while remaining within capacity. This lets a maintainer distinguish a capacity change from higher detail, camera motion, a new scene, or time spent downloading splats.

## Public scene

The test preloads 3,931,540 real splats from seven disjoint level-0 chunks of Andrii Shramko’s Roman Parish capture. It uses the upstream SOG example decoder and base color, a fixed camera, a 640 × 360 viewport, a single warmed renderer and a single sorter. Each measured frame actually projects, sorts and draws. The probe reads back sorted indices after measuring the following callback interval. One run used a local cache of the official assets. A second downloaded the assets directly from the original public host. See `measurements.json` for per-stage candidate and visible counts, allocation labels, bytes, hashes and browser errors. [Scene and attribution](https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/lod-streaming.example.mjs)

| 2M → 3M candidates | Buffers created in sort | Stock sort | Patched sort | Stock callback interval | Patched callback interval |
|---|---:|---:|---:|---:|---:|
| Assets from public host | 6 in both | 42.2 ms | 1.3 ms | 46.1 ms | 16.5 ms |
| Cached public assets | 6 in both | 52.5 ms | 1.5 ms | 61.3 ms | 16.7 ms |

In the public-host run the pair capacity doubled from 2M to 4M. Repeating 3M and then increasing to 3.5M each took 0.3 ms on stock and created zero scratch buffers. In the four-mode public-host comparison, the sorted-index SHA-256 matched at every stage and the final canvas SHA-256 matched across all modes. At the 3M crossing the sorter retained 681,005 visible splats. Candidate count is the size of the input before compaction.

The repro sets candidate counts explicitly. A production LoD selector determines when those counts change. That distinction matters when diagnosing a touring application. A repeatable threshold in this test establishes the cost of crossing it. It does not predict how often an actual camera route will cross it.

## Independent five-million-key control

The isolated sorter used a pre-uploaded key texture with readback disabled. Hardware was a GeForce RTX 3090, driver 610.88, Windows, hardware WebGPU in Edge 157.0.4341.60. With the importer closed, 12 one-second desktop samples before browser launch showed P8 idle clocks at 210 MHz and 4–7% GPU utilization. `evidence/desktop-before-launch.csv` records the samples.

| Stock run | First 5M sort exceeding capacity | Following callback interval | Native create-buffer time within sort |
|---|---:|---:|---:|
| Instrumented | 79.5 ms | 80.5 ms | 48.7 ms over six buffers |
| Instrumentation disabled | 73.6 ms | 74.3 ms | Unmeasured |
| Instrumented, fresh process | 73.5 ms | 74.2 ms | 47.6 ms over six buffers |

Raising the count again from 5M to 5.1M fit the new 7.2M pair capacity and took 0.4 ms in the first run. A 125-second, 7,500-callback replay at 5M produced zero scratch allocations. The longest sort was 1.2 ms and the longest callback interval was 18.9 ms. The same input in a separate source-level comparison took 72.7 ms for stock growth versus 4.6 ms with the unmapped patch. See `evidence/synthetic-stock.json` and `evidence/synthetic-patch-comparison.json`. Warm-up is labeled separately in the data. Allocation fields in the unwrapped run were uninstrumented.

## Why the proposed diff helps

Compaction grows its key, value and block-offset buffers. The radix passes grow a second key/value pair and block histograms. For a warmed pipeline these six discardable buffers use a Three 0.186.1 storage-attribute path that maps each new native buffer at creation, copies the host typed array and unmaps the buffer. Each new scratch array initially contains zeroes. That path runs synchronously in the sort call. [Radix compaction](https://github.com/sparkjsdev/radix/blob/a9963abf8a333a3ff8d1580c0271274b6d909ff5/src/wgpu/WgpuCompact.ts#L121-L132) · [Radix sort](https://github.com/sparkjsdev/radix/blob/a9963abf8a333a3ff8d1580c0271274b6d909ff5/src/wgpu/WgpuRadixSort.ts#L109-L140)

`patches/unmapped-growth.patch` opts just those six scalar buffers into creating ordinary WebGPU storage with the existing usage flags. The patch uses the GPU backend’s attribute record, so review it against future changes to Three. The growth policy and the CPU backing array remain. Normal initialization of populated attributes, indirect arguments, and copies that preserve the old contents follow the existing paths. The public-network run recorded six mapped allocations on stock and six unmapped ones with the patch.

An optional reservation patch in the repro tests a second mechanism. Reserving 3.5M candidates before the public scene draws moved 35.2 ms of allocation into startup in the public-host run. It requires an up-front capacity and commits memory early. The suggested upstream change is the automatic unmapped-growth diff.

## Reproduction and limits

To run the scene, follow `README.md`. To run the additional correctness checks in a Radix source checkout, apply `patches/unmapped-growth.patch` and `patches/unmapped-growth-tests.patch`, run `npm ci` and `npm run build`, then `npm run serve`. Open `/build/test/gpu/index.html?gpu=webgpu` on the printed local host. The additional cases check direct and indirect sorting against CPU results, stable ordering, repeated growth, 16/24/32-bit keys, culling, empty input, draw arguments and preservation of buffer contents.

Both patch files passed `git apply --check` on the published 0.0.1 source commit and on upstream `a9963ab`. The patched build and type checks passed. On hardware WebGPU all 199 shared upstream GPU checks had identical outcomes and reported details on stock and patched code. Those included 189 passes, one skip and nine existing failures in splat encoding, spherical harmonics and HDR tolerances. All three added correctness checks passed. Neither GPU run reported an uncaptured device error. The full comparison, including the nine failure details and browser metadata, is in `evidence/upstream-gpu-comparison.json`.

The measurements describe synchronous call duration and elapsed time between entries into browser animation callbacks. They establish a sorter growth hitch on this machine. Hardware GPU execution times, physical display presentation, XR and other graphics drivers require their own measurements. The separately reproduced periodic stall during concurrent import belongs to the application’s converter investigation.
