"""Builds Lumen's AI upscaling models (ONNX) from the official Real-ESRGAN release weights.

Model: SRVGGNetCompact "realesr-general-x4v3" (Xintao Wang et al., BSD-3-Clause), the compact
network Real-ESRGAN uses for real-world video. Like Real-ESRGAN's own `--denoise_strength`, the
general and "wdn" (denoise) weights are blended linearly (deep network interpolation):

    w = s * general + (1 - s) * wdn      s = 1: keep texture/grain, s = 0: strongest clean-up

Reads PyTorch .pth files WITHOUT PyTorch, using a restricted unpickler that only accepts plain
tensors. Usage:

    python3 -I scripts/convert-esrgan.py <dir with the two .pth files> <out dir>
"""
import collections, hashlib, json, pickle, sys, zipfile
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SOURCES = {  # official v0.2.5.0 release assets, pinned
    "realesr-general-x4v3.pth": "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    "realesr-general-wdn-x4v3.pth": "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
}
VARIANTS = {"detail": 0.75, "clean": 0.25}  # denoise strength s for each shipped model


def load_pth(path):
    """Loads a torch zip checkpoint into {name: ndarray}; refuses anything that isn't a tensor."""
    z = zipfile.ZipFile(path)
    prefix = z.namelist()[0].split("/")[0]

    def rebuild(storage, offset, size, stride, *_):
        t = np.lib.stride_tricks.as_strided(storage[offset:], shape=size, strides=[s * storage.itemsize for s in stride])
        return np.array(t, dtype=np.float32)

    class SafeUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return rebuild
            if module == "torch" and name in ("FloatStorage", "HalfStorage"):
                return name
            if (module, name) == ("collections", "OrderedDict"):
                return collections.OrderedDict
            raise pickle.UnpicklingError(f"refusing {module}.{name}")

        def persistent_load(self, pid):
            _, stype, key, _loc, _numel = pid
            dtype = {"FloatStorage": np.float32, "HalfStorage": np.float16}[stype]
            return np.frombuffer(z.read(f"{prefix}/data/{key}"), dtype=dtype)

    obj = SafeUnpickler(z.open(f"{prefix}/data.pkl")).load()
    return obj.get("params", obj.get("params_ema", obj))


def layers(sd):
    """[(conv_w, conv_b, prelu_slope_or_None), ...] in order."""
    idx = sorted({int(k.split(".")[1]) for k in sd if k.startswith("body.")})
    out, i = [], 0
    while i < len(idx):
        n = idx[i]
        w, b = sd[f"body.{n}.weight"], sd[f"body.{n}.bias"]
        slope = sd.get(f"body.{n + 1}.weight") if i + 1 < len(idx) and idx[i + 1] == n + 1 else None
        out.append((w, b, slope))
        i += 2 if slope is not None else 1
    return out


def build(net, name):
    nodes, inits = [], []
    x = "input"
    for i, (w, b, slope) in enumerate(net):
        inits += [numpy_helper.from_array(w, f"w{i}"), numpy_helper.from_array(b, f"b{i}")]
        nodes.append(helper.make_node("Conv", [x, f"w{i}", f"b{i}"], [f"c{i}"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        x = f"c{i}"
        if slope is not None:
            inits.append(numpy_helper.from_array(slope.reshape(-1, 1, 1).astype(np.float32), f"p{i}"))
            nodes.append(helper.make_node("PRelu", [x, f"p{i}"], [f"a{i}"]))
            x = f"a{i}"
    nodes.append(helper.make_node("DepthToSpace", [x], ["shuffled"], blocksize=4, mode="CRD"))  # == pixel_shuffle(4)
    inits.append(numpy_helper.from_array(np.array([1, 1, 4, 4], np.float32), "scales"))
    nodes.append(helper.make_node("Resize", ["input", "", "scales"], ["base"], mode="nearest",
                                  coordinate_transformation_mode="asymmetric", nearest_mode="floor"))
    nodes.append(helper.make_node("Add", ["shuffled", "base"], ["output"]))
    g = helper.make_graph(nodes, name,
                          [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "h", "w"])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, "H", "W"])], inits)
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], producer_name="lumen convert-esrgan")
    m.ir_version = 9  # readable by onnxruntime-web 1.31 and current Python onnxruntime
    m.doc_string = "Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause, Xintao Wang). Input/output: RGB in [0,1], NCHW, x4."
    onnx.checker.check_model(m)
    return m


def reference(net, img):
    """Independent NumPy forward pass (for verifying the ONNX graph)."""
    x = img[0]
    def conv(x, w, b):
        c, h, wd = x.shape
        p = np.pad(x, ((0, 0), (1, 1), (1, 1)))
        cols = np.stack([p[:, dy:dy + h, dx:dx + wd] for dy in range(3) for dx in range(3)], 1)  # c,9,h,w
        return np.einsum("ocK,cKhw->ohw", w.reshape(w.shape[0], c, 9), cols) + b[:, None, None]
    h = x
    for w, b, slope in net:
        h = conv(h, w, b)
        if slope is not None:
            h = np.where(h >= 0, h, h * slope[:, None, None])
    c, H, W = h.shape
    sh = h.reshape(3, 4, 4, H, W).transpose(0, 3, 1, 4, 2).reshape(3, H * 4, W * 4)  # pixel_shuffle
    base = x.repeat(4, 1).repeat(4, 2)
    return (sh + base)[None]


def main(src, out):
    src, out = Path(src), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for f, sha in SOURCES.items():
        got = hashlib.sha256((src / f).read_bytes()).hexdigest()
        if got != sha:
            sys.exit(f"checksum mismatch for {f}: {got}")
    gen, wdn = load_pth(src / "realesr-general-x4v3.pth"), load_pth(src / "realesr-general-wdn-x4v3.pth")
    assert gen.keys() == wdn.keys()
    manifest = {}
    for variant, s in VARIANTS.items():
        sd = {k: (s * gen[k] + (1 - s) * wdn[k]).astype(np.float32) for k in gen}
        net = layers(sd)
        model = build(net, f"realesr-general-x4v3-{variant}")
        path = out / f"esrgan-{variant}.onnx"
        onnx.save(model, path)
        manifest[variant] = {"file": path.name, "denoise_strength": s, "layers": len(net),
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
        print(f"{path.name}: {len(net)} conv layers, {path.stat().st_size / 1e6:.2f} MB, denoise strength {s}")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    main(*sys.argv[1:3])
