**Problem.** A warmed WebGPU renderer can miss several frames when it first sorts more splats than its existing scratch buffers can hold. I can reproduce this on public Roman Parish data using Radix 0.0.1 directly, with Studio and its importer closed.

**Yes, the sorter hitch in this reproduction occurred only when the buffers needed to grow.** Increasing the candidate count alone was insufficient. I preloaded the scene, kept the camera fixed and used the same sorter for all four frames. On an RTX 3090 in Edge 157, two runs gave the following results.

| Stock Radix operation | Scratch buffers created | Time inside `sort()` |
|---|---:|---:|
| Increase from 2M to 3M candidates, exceeding capacity | 6 | 42.2 and 52.5 ms |
| Replay the same 3M | 0 | 0.3 and 0.4 ms |
| Increase to 3.5M, within the new 4M capacity | 0 | 0.3 and 0.2 ms |

The interval to the next animation callback on the growth frame was **46.1 and 61.3 ms**. A separate 125-second test at a steady 5M keys recorded 7,500 callbacks, zero reallocations and a maximum of 1.2 ms inside the sorter. I traced the regular ~30-second interruption from my original testing separately to contention with our GPU importer. I’m withdrawing that symptom as evidence for this issue.

**Proposed fix.** The six scratch buffers currently go through a mapped-at-creation path that copies a zero-filled host array. The attached Radix diff allocates fresh GPU storage directly for these discardable buffers. They still grew on exactly the same public-scene frame, but the sort took **1.3 and 1.5 ms** and the following callback arrived after **16.5 and 16.7 ms**. The complete sorted indices at all four stages and the final rendered pixels matched stock in the public-network comparison. These are elapsed times on the calling thread and between browser callbacks.

To reproduce, unzip the attachment, run `node serve.mjs`, and open the printed local URL in a WebGPU browser. Compare **Stock 0.0.1** and **Unmapped growth**. The page downloads the public scene before it starts timing. The proposed title is **“WebGPU sorter stalls when scratch buffers grow.”** [Public Roman Parish sample](https://sparkjs.dev/radix/examples/sogs/index.html?sample=roman-parish) · [Sorter scratch growth](https://github.com/sparkjsdev/radix/blob/a9963abf8a333a3ff8d1580c0271274b6d909ff5/src/wgpu/WgpuRadixSort.ts#L109-L140)
