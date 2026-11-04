// Live preview of the voice chain: the editor routes the <video> element's audio through this node.
import { VoiceChain } from "./dsp.js";

class LumenVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = null; this.bypass = false;
    this.buf = [new Float32Array(128), new Float32Array(128)];
    this.port.onmessage = ({ data }) => {
      if (data.type === "config") {
        this.chain = data.on && data.profile ? new VoiceChain({ sr: sampleRate, channels: 2, settings: data.settings, profile: data.profile, preGainDb: data.pre, postGainDb: data.post, limit: true }) : null;
      } else if (data.type === "bypass") this.bypass = !!data.value;
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out?.length) return true;
    const n = out[0].length;
    if (!inp?.length) { for (const o of out) o.fill(0); return true; }
    for (let c = 0; c < 2; c++) {
      if (this.buf[c].length !== n) this.buf[c] = new Float32Array(n);
      this.buf[c].set(inp[Math.min(c, inp.length - 1)]);
    }
    if (this.chain) {
      const original = this.bypass ? [this.buf[0].slice(), this.buf[1].slice()] : null;
      this.chain.process(this.buf, n); // keep the chain running so A/B switches are seamless
      if (original) { this.buf[0].set(original[0]); this.buf[1].set(original[1]); }
    }
    for (let c = 0; c < out.length; c++) out[c].set(this.buf[Math.min(c, 1)]);
    return true;
  }
}
registerProcessor("lumen-voice", LumenVoice);
