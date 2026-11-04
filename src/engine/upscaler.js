// GPU upscaler shared by the Upscale and Edit pages.
/* =====================================================================
   GPU upscaler: Catmull-Rom with anti-ringing clamp, then contrast-adaptive sharpening
   ===================================================================== */
const VS_FLIP = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
const FS_UP = `#version 300 es
precision highp float;
uniform sampler2D src; uniform vec2 size; uniform mat3 cm; in vec2 uv; out vec4 o;
void main(){
  vec2 sp = uv*size; vec2 t1 = floor(sp-.5)+.5; vec2 f = sp-t1;
  vec2 w0 = f*(-.5+f*(1.-.5*f)), w1 = 1.+f*f*(-2.5+1.5*f), w2 = f*(.5+f*(2.-1.5*f)), w3 = f*f*(-.5+.5*f);
  vec2 w12 = w1+w2; vec2 t0 = (t1-1.)/size, t3 = (t1+2.)/size, t12 = (t1+w2/w12)/size;
  vec3 c =
    texture(src,vec2(t0.x,t0.y)).rgb*w0.x*w0.y + texture(src,vec2(t12.x,t0.y)).rgb*w12.x*w0.y + texture(src,vec2(t3.x,t0.y)).rgb*w3.x*w0.y +
    texture(src,vec2(t0.x,t12.y)).rgb*w0.x*w12.y + texture(src,vec2(t12.x,t12.y)).rgb*w12.x*w12.y + texture(src,vec2(t3.x,t12.y)).rgb*w3.x*w12.y +
    texture(src,vec2(t0.x,t3.y)).rgb*w0.x*w3.y + texture(src,vec2(t12.x,t3.y)).rgb*w12.x*w3.y + texture(src,vec2(t3.x,t3.y)).rgb*w3.x*w3.y;
  ivec2 b = ivec2(t1-.5); ivec2 m = ivec2(size)-1;
  vec3 a0 = texelFetch(src, clamp(b,ivec2(0),m),0).rgb, a1 = texelFetch(src, clamp(b+ivec2(1,0),ivec2(0),m),0).rgb,
       a2 = texelFetch(src, clamp(b+ivec2(0,1),ivec2(0),m),0).rgb, a3 = texelFetch(src, clamp(b+ivec2(1,1),ivec2(0),m),0).rgb;
  c = clamp(c, min(min(a0,a1),min(a2,a3)), max(max(a0,a1),max(a2,a3)));
  o = vec4(clamp(cm * c, 0., 1.), 1.);
}`;
const FS_CAS = `#version 300 es
precision highp float;
uniform sampler2D src; uniform float sharp; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 m = textureSize(src,0)-1;
  vec3 c = texelFetch(src,p,0).rgb;
  vec3 n = texelFetch(src,clamp(p+ivec2(0,1),ivec2(0),m),0).rgb, s = texelFetch(src,clamp(p-ivec2(0,1),ivec2(0),m),0).rgb;
  vec3 e = texelFetch(src,clamp(p+ivec2(1,0),ivec2(0),m),0).rgb, w = texelFetch(src,clamp(p-ivec2(1,0),ivec2(0),m),0).rgb;
  vec3 mn = min(c,min(min(n,s),min(e,w))), mx = max(c,max(max(n,s),max(e,w)));
  vec3 amp = sqrt(clamp(min(mn, 1.-mx)/max(mx, 1e-4), 0., 1.));
  vec3 wt = amp * (-sharp/mix(8.,4.6,sharp));
  o = vec4(clamp((c + (n+s+e+w)*wt)/(1.+4.*wt), 0., 1.), 1.);
}`;

/* Colour fix for untagged SD video: Chrome decodes it as BT.709, while players (VLC, mpv, ffmpeg)
   treat untagged SD as BT.601. M = RGB<-YCbCr(601) · YCbCr<-RGB(709), column-major for GLSL. */
export const IDENTITY = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
export const FIX_601 = (() => {
  const mul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const kr = .2126, kb = .0722, kg = 1 - kr - kb;
  const fwd709 = [[kr, kg, kb], [-kr / 1.8556, -kg / 1.8556, (1 - kb) / 1.8556], [(1 - kr) / 1.5748, -kg / 1.5748, -kb / 1.5748]];
  const inv601 = [[1, 0, 1.402], [1, -0.344136, -0.714136], [1, 1.772, 0]];
  const m = mul(inv601, fwd709);
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
})();

export class Upscaler {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    const mk = (vs, fs) => {
      const p = gl.createProgram();
      for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error("Shader error: " + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p); return p;
    };
    this.up = mk(VS_FLIP, FS_UP); this.cas = mk(VS, FS_CAS);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (filter) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    this.srcTex = tex(gl.LINEAR); this.midTex = tex(gl.NEAREST);
    this.fbo = gl.createFramebuffer(); this.mw = 0; this.mh = 0;
    this.uSize = gl.getUniformLocation(this.up, "size"); this.uCm = gl.getUniformLocation(this.up, "cm"); this.cm = IDENTITY; this.uSharp = gl.getUniformLocation(this.cas, "sharp");
    gl.useProgram(this.up); gl.uniform1i(gl.getUniformLocation(this.up, "src"), 0);
    gl.useProgram(this.cas); gl.uniform1i(gl.getUniformLocation(this.cas, "src"), 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  }
  get lost() { return this.gl.isContextLost(); }
  /** Upscales `source` (sw×sh) into this canvas at ow×oh. */
  render(source, sw, sh, ow, oh, sharp) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("The graphics context was lost.");
    if (ow > this.maxSize || oh > this.maxSize) throw new Error(`Your GPU supports frames up to ${this.maxSize}px; ${ow}×${oh} is too large.`);
    if (this.canvas.width !== ow || this.canvas.height !== oh) { this.canvas.width = ow; this.canvas.height = oh; }
    if (this.mw !== ow || this.mh !== oh) {
      gl.bindTexture(gl.TEXTURE_2D, this.midTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("The GPU could not allocate an output frame.");
      this.mw = ow; this.mh = oh;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.viewport(0, 0, ow, oh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.useProgram(this.up); gl.uniform2f(this.uSize, sw, sh); gl.uniformMatrix3fv(this.uCm, false, this.cm);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.useProgram(this.cas); gl.uniform1f(this.uSharp, sharp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  destroy() { try { this.gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {} }
}

