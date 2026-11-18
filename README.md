# Radix WebGPU sorter growth

A browser test for the delay that can occur when the Radix 0.0.1 WebGPU sorter grows its scratch buffers. Run both versions on the same device, keep the tab visible, and compare the **Capacity crossing** row with **Same-count replay** and **Increase within stock capacity**.

**[Run stock Radix 0.0.1](https://mistere123.github.io/radix-sort-growth-repro/radix-0.0.1/?mode=stock) · [Run the proposed fix](https://mistere123.github.io/radix-sort-growth-repro/radix-0.0.1/?mode=unmapped)**

Both pages draw the public Roman Parish scan by Andrii Shramko. They fetch about 47 MB from PlayCanvas before measuring. The camera stays fixed while the test changes how many splats are passed to the sorter. Use **Save measurements** to keep your device’s results.

| Included material | Location |
|---|---|
| Proposed upstream change | [Unmapped scratch allocation](radix-0.0.1/patches/unmapped-growth.patch) |
| Regression tests | [GPU correctness checks](radix-0.0.1/patches/unmapped-growth-tests.patch) |
| Hardware measurements and methods | [Investigation](radix-0.0.1/INVESTIGATION.md) · [Public-scene results](radix-0.0.1/measurements.json) |
| Local reproduction and source credits | [Instructions](radix-0.0.1/README.md) · [Code license notices](radix-0.0.1/licenses/) |

The test runs in a WebGPU-capable browser. The `radix-0.0.1/` path pins the comparison to the measured renderer version. [Upstream issue](https://github.com/sparkjsdev/radix/issues/1) · [Original PlayCanvas example and scan credit](https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/lod-streaming.example.mjs)
