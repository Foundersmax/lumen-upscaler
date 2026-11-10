# AI upscaling models

`esrgan-detail.onnx` and `esrgan-clean.onnx` are Real-ESRGAN's compact video network
(`realesr-general-x4v3`, SRVGGNetCompact, ×4) by Xintao Wang et al., BSD-3-Clause (see
`LICENSE-Real-ESRGAN`). Each is a linear blend of the official `realesr-general-x4v3` and
`realesr-general-wdn-x4v3` weights, as Real-ESRGAN's `--denoise_strength` does:

| file | denoise strength | character |
|---|---|---|
| esrgan-detail.onnx | 0.75 | keeps more texture and grain |
| esrgan-clean.onnx | 0.25 | strongest clean-up of noise and compression blocks |

Regenerate from the official v0.2.5.0 release assets (checksums are pinned in the script):

    python3 -I scripts/convert-esrgan.py <dir with the two .pth files> models

The converter reads the PyTorch checkpoints without PyTorch (restricted unpickler) and checks
its ONNX graph against an independent NumPy implementation.
