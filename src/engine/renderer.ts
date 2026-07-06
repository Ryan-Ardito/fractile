// WebGL2 tile renderer, two-pass:
//
//  - Palette pass (only when style variables change): colorize a tile's R32F
//    escape-time texture into a cached RGBA8 texture. All palette math — HSL,
//    banding, and the band-limit fade where contours outrun the data — runs
//    once per texel here, not per screen fragment.
//  - Composite pass (every frame): draw the colored textures with hardware
//    bilinear filtering. One fetch per fragment, so pan/zoom render at full
//    frame rate regardless of scale. Linear filtering on RGBA is color-space
//    interpolation, which keeps magnified low-res tiles looking blurry
//    instead of sprouting false banding.

export type StyleVars = {
  iterFalloff: number;
  paletteScale: number;
  hueOffset: number;
  bandSpacing: number;
  bandContrast: number;
  bandOffset: number;
  saturation: number;
  lightness: number;
};

export type TileHandle = {
  dataTex: WebGLTexture;
  colorTex: WebGLTexture | null;
  colorVersion: number;
  // Separate colorization for the export style slot (see setExportStyle):
  // export frames must not read — or invalidate — the live view's cached
  // colors, and vice versa. Freed when the export session ends.
  exportColorTex: WebGLTexture | null;
  exportColorVersion: number;
  // Physical texture size; the logical tile is the inner square inset by
  // apron texels of true neighbor data on every side (see TILE_APRON).
  size: number;
  apron: number;
  // Progress stand-in: the palette pass makes its value-0 texels
  // transparent (see uPreview).
  preview: boolean;
  // Physical rows whose color is stale but whose STYLE is current — set by
  // patchTile, cleared by ensureColor via a partial (scissored) recolor.
  // Avoids a full-tile recolor per progress patch (~30x redundant on a
  // slow tile). [lo, hi); lo >= hi means clean.
  colorDirtyLo: number;
  colorDirtyHi: number;
};

// Offscreen RGBA8 render target for video export frames.
export type ExportTarget = {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
};

const QUAD_VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;     // x, y, w, h in device pixels, origin top-left
uniform vec2 uViewport; // device pixels
// -1 for the screen (and FBO passes tuned to that convention); +1 when
// compositing an export frame into an FBO so readPixels' bottom-up row
// order comes back as a top-down image.
uniform float uYSign;
out vec2 vUV;
void main() {
  vUV = aPos;
  vec2 px = uRect.xy + aPos * uRect.zw;
  vec2 clip = (px / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, uYSign * clip.y, 0.0, 1.0);
}`;

const PALETTE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uData;
uniform float uIterFalloff;
uniform float uPaletteScale;
uniform float uHueOffset;
uniform float uBandSpacing;
uniform float uBandContrast;
uniform float uBandOffset;
uniform float uSaturation;
uniform float uLightness;
// 1 on progress stand-ins: value-0 texels (not yet computed) become
// transparent so the smooth ancestor fallback shows through beneath.
// Normal tiles keep alpha 1 everywhere (0 = interior = opaque black).
uniform float uPreview;
in vec2 vUV;
out vec4 outColor;

// Escape-time level sets crowd geometrically toward the set boundary, so raw
// iteration gradients grow without bound at depth while the palette's band
// and hue frequencies are fixed — deep views alias into noise, then the
// band-limit fade below turns them flat gray. Compressing iterations
// logarithmically above a threshold makes palette-space gradients
// scale-invariant (~K x the relative gradient), so filaments keep bands and
// color at any depth. Identity below the threshold preserves the shallow
// look exactly, and the remap is fixed and view-independent: no color
// breathing while zooming, and cached tiles stay valid.
const float REMAP_T = 1024.0;
const float REMAP_K = 2048.0;

float fetchIter(ivec2 p, int hi) {
  float it = texelFetch(uData, clamp(p, ivec2(0), ivec2(hi)), 0).r;
  return it <= REMAP_T ? it : REMAP_T + REMAP_K * log(1.0 + (it - REMAP_T) / REMAP_K);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int hi = textureSize(uData, 0).x - 1;
  float it = fetchIter(p, hi);

  // The data can only resolve palette features wider than one sample step;
  // fade bands/hue toward their means where they cycle faster than that,
  // rather than render detail the tile doesn't actually contain. On preview
  // stand-ins a 0-valued neighbor is ABSENT data, not a real cliff — it
  // must not gray out the last computed row at the patch boundary.
  float n0 = fetchIter(p + ivec2(1, 0), hi);
  float n1 = fetchIter(p + ivec2(-1, 0), hi);
  float n2 = fetchIter(p + ivec2(0, 1), hi);
  float n3 = fetchIter(p + ivec2(0, -1), hi);
  float d0 = (uPreview > 0.5 && n0 <= 0.0) ? 0.0 : abs(it - n0);
  float d1 = (uPreview > 0.5 && n1 <= 0.0) ? 0.0 : abs(it - n1);
  float d2 = (uPreview > 0.5 && n2 <= 0.0) ? 0.0 : abs(it - n2);
  float d3 = (uPreview > 0.5 && n3 <= 0.0) ? 0.0 : abs(it - n3);
  float spread = max(max(d0, d1), max(d2, d3));
  spread = max(spread, 1e-20);
  float bandAA = smoothstep(1.0, 2.0, 6.28318530718 / (uBandSpacing * spread));
  float hueAA = smoothstep(1.0, 2.0, 360.0 / (uPaletteScale * spread));

  float hue = mod(it * uPaletteScale + uHueOffset, 360.0);
  float band = sin(it * uBandSpacing + uBandOffset) * uBandContrast * bandAA + 0.5;
  float sat = band * uSaturation * hueAA;
  float falloff = clamp((it - 1.0) * uIterFalloff, 0.0, 1.0);
  float light = uLightness * band * falloff;

  float c = (1.0 - abs(2.0 * light - 1.0)) * sat;
  float hp = hue / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if      (hp < 1.0) rgb = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c);
  else if (hp < 5.0) rgb = vec3(x, 0.0, c);
  else               rgb = vec3(c, 0.0, x);
  float m = light - 0.5 * c;
  float a = it <= 0.0 ? 1.0 - uPreview : 1.0;
  // PREMULTIPLIED: transparent texels must carry zero rgb, or the
  // compositor's bilinear filtering bleeds their black into the boundary
  // row (a dark seam along partial-patch edges). a = 1 everywhere on
  // normal tiles, so their colors are untouched.
  outColor = vec4(clamp(rgb + m, 0.0, 1.0) * a, a);
}`;

// Build a parent tile's escape-time data by 2:1 subsampling a child tile
// into one quadrant of the target. Point sampling (no averaging): averaging
// iteration values across an interior/exterior discontinuity would fabricate
// values that exist nowhere; the cost is a fixed quarter-pixel sampling
// offset, which is invisible.
const SUBSAMPLE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uData;
uniform ivec2 uQuadOrigin; // this child's quadrant origin, in LOGICAL texels
uniform int uApron;        // shared apron width (parent and children)
out vec4 outColor;
void main() {
  // Parent physical texel -> parent logical -> child logical (2:1 point
  // sample) -> child physical. Parent apron texels map past the child's
  // logical edge into (or beyond) the child's own apron; the clamp gives an
  // approximate outer apron, which only softens synthesized tiles' borders.
  ivec2 ct =
    (ivec2(gl_FragCoord.xy) - ivec2(uApron) - uQuadOrigin) * 2 + ivec2(uApron);
  int hi = textureSize(uData, 0).x - 1;
  outColor = vec4(texelFetch(uData, clamp(ct, ivec2(0), ivec2(hi)), 0).r, 0.0, 0.0, 1.0);
}`;


const COMPOSITE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform vec4 uTexRect; // u0, v0, uSpan, vSpan
uniform float uAlpha;
// 0 = plain bilinear (native scale), 1 = full B-spline (heavy magnification).
uniform float uCubicMix;
uniform float uTexSize;
in vec2 vUV;
out vec4 outColor;

// Cubic B-spline resampling folded into 4 bilinear taps (all weights are
// positive, so texel pairs combine in the hardware interpolator). C2-smooth:
// magnified tiles read as a gaussian-like blur where bilinear reads as boxy
// tenting. Taps may cross a sub-rect edge into the rest of the same ancestor
// texture, which is the correct neighboring content anyway.
//
// Filters the full PREMULTIPLIED RGBA, not just rgb: on preview stand-ins the
// tile carries interior alpha edges (transparent uncomputed texels beside
// opaque computed ones). Smoothing rgb with this wide kernel while taking
// alpha from a single bilinear tap desyncs the premultiplied ratio at those
// edges, so the un-premultiplied color rgb/a overshoots — a bright fringe
// along the flush boundary. Same kernel for both keeps the ratio in gamut.
vec4 bspline(vec2 uv) {
  vec2 ts = vec2(uTexSize);
  vec2 st = uv * ts - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  vec2 uv0 = (base - 0.5 + w1 / g0) / ts;
  vec2 uv1 = (base + 1.5 + w3 / g1) / ts;
  return g0.y * (g0.x * texture(uColor, vec2(uv0.x, uv0.y)) +
                 g1.x * texture(uColor, vec2(uv1.x, uv0.y))) +
         g1.y * (g0.x * texture(uColor, vec2(uv0.x, uv1.y)) +
                 g1.x * texture(uColor, vec2(uv1.x, uv1.y)));
}

void main() {
  vec2 uv = uTexRect.xy + vUV * uTexRect.zw;
  // colorTex is PREMULTIPLIED (see the palette pass); scale by uAlpha only.
  vec4 c = texture(uColor, uv);
  if (uCubicMix > 0.0) c = mix(c, bspline(uv), uCubicMix);
  outColor = c * uAlpha;
}`;

const compile = (
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader allocation failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
};

const link = (
  gl: WebGL2RenderingContext,
  frag: string
): WebGLProgram => {
  const prog = gl.createProgram();
  if (!prog) throw new Error("program allocation failed");
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, QUAD_VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
  }
  return prog;
};

const STYLE_UNIFORMS = [
  "uIterFalloff",
  "uPaletteScale",
  "uHueOffset",
  "uBandSpacing",
  "uBandContrast",
  "uBandOffset",
  "uSaturation",
  "uLightness",
] as const;

export class TileRenderer {
  private gl: WebGL2RenderingContext;
  private paletteProg: WebGLProgram;
  private compositeProg: WebGLProgram;
  private subsampleProg: WebGLProgram;
  private paletteUni: Map<string, WebGLUniformLocation | null> = new Map();
  private compUni: Map<string, WebGLUniformLocation | null> = new Map();
  private subUni: Map<string, WebGLUniformLocation | null> = new Map();
  private fbo: WebGLFramebuffer;
  private style: StyleVars | null = null;
  private styleVersion = 0;
  // Export style slot: a snapshot of the live style taken at export begin,
  // with the exporter's per-frame overrides (animated color offsets) applied
  // on top. Export-target compositing colorizes through this slot so the
  // movie is deterministic in video time — decoupled from whatever the live
  // style is doing while segments render.
  private exportStyle: StyleVars | null = null;
  private exportStyleVersion = 0;
  private viewportW = 0;
  private viewportH = 0;
  // The composite pass's current destination (null = the canvas). Side
  // passes (palette colorize, synthesis) borrow the shared FBO mid-pass and
  // must restore this binding, not assume the canvas.
  private boundTarget: ExportTarget | null = null;
  // Rendering INTO an R32F texture needs this extension; without it tile
  // synthesis is silently unavailable and callers fall back to computing.
  private canSynthesize: boolean;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;

    this.paletteProg = link(gl, PALETTE_FRAG);
    this.compositeProg = link(gl, COMPOSITE_FRAG);
    this.subsampleProg = link(gl, SUBSAMPLE_FRAG);
    for (const name of [...STYLE_UNIFORMS, "uRect", "uViewport", "uData", "uYSign", "uPreview"]) {
      this.paletteUni.set(name, gl.getUniformLocation(this.paletteProg, name));
    }
    for (const name of [
      "uRect",
      "uViewport",
      "uTexRect",
      "uAlpha",
      "uColor",
      "uCubicMix",
      "uTexSize",
      "uYSign",
    ]) {
      this.compUni.set(name, gl.getUniformLocation(this.compositeProg, name));
    }
    for (const name of [
      "uRect",
      "uViewport",
      "uData",
      "uQuadOrigin",
      "uApron",
      "uYSign",
    ]) {
      this.subUni.set(name, gl.getUniformLocation(this.subsampleProg, name));
    }
    // Palette and subsample passes always use the screen convention; only
    // the composite pass toggles (see begin/beginExport).
    gl.useProgram(this.paletteProg);
    gl.uniform1f(this.paletteUni.get("uYSign") ?? null, -1);
    gl.useProgram(this.subsampleProg);
    gl.uniform1f(this.subUni.get("uYSign") ?? null, -1);
    this.canSynthesize = !!gl.getExtension("EXT_color_buffer_float");

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    // Both programs share the same attribute layout (location 0).
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("framebuffer allocation failed");
    this.fbo = fbo;

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
    gl.clearColor(0, 0, 0, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  setStyle(vars: Partial<StyleVars>): void {
    this.style = { ...(this.style as StyleVars), ...vars } as StyleVars;
    this.styleVersion++;
  }

  // Open the export style slot as a snapshot of the current live style.
  beginExportStyle(): void {
    this.exportStyle = { ...(this.style as StyleVars) };
    this.exportStyleVersion++;
  }

  setExportStyle(vars: Partial<StyleVars>): void {
    if (!this.exportStyle) this.exportStyle = { ...(this.style as StyleVars) };
    this.exportStyle = { ...this.exportStyle, ...vars };
    this.exportStyleVersion++;
  }

  endExportStyle(): void {
    this.exportStyle = null;
  }

  // Free a tile's export-slot colorization (the session is over; the live
  // slot is untouched).
  dropExportColor(handle: TileHandle): void {
    if (handle.exportColorTex) {
      this.gl.deleteTexture(handle.exportColorTex);
      handle.exportColorTex = null;
      handle.exportColorVersion = -1;
    }
  }

  uploadTile(data: Float32Array, size: number, apron = 0, preview = false): TileHandle {
    const gl = this.gl;
    const dataTex = gl.createTexture();
    if (!dataTex) throw new Error("texture allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, size, 0, gl.RED, gl.FLOAT, data);
    return {
      dataTex,
      colorTex: null,
      colorVersion: -1,
      exportColorTex: null,
      exportColorVersion: -1,
      size,
      apron,
      preview,
      colorDirtyLo: 0,
      colorDirtyHi: 0,
    };
  }

  deleteTile(handle: TileHandle): void {
    this.gl.deleteTexture(handle.dataTex);
    if (handle.colorTex) this.gl.deleteTexture(handle.colorTex);
    if (handle.exportColorTex) this.gl.deleteTexture(handle.exportColorTex);
  }

  // Build a parent tile's data texture by 2:1 subsampling its four cached
  // children — entirely on the GPU, no worker compute and no readback.
  // Children in row-major quadrant order: [(0,0), (1,0), (0,1), (1,1)],
  // where (i, j) covers the parent's texel block starting at (i·s/2, j·s/2)
  // (j is the py/imaginary axis, increasing downward like tile rows).
  synthesizeTile(
    children: [TileHandle, TileHandle, TileHandle, TileHandle]
  ): TileHandle | null {
    if (!this.canSynthesize) return null;
    const gl = this.gl;
    const size = children[0].size;
    const dataTex = gl.createTexture();
    if (!dataTex) return null;
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, size, 0, gl.RED, gl.FLOAT, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dataTex, 0
    );
    gl.viewport(0, 0, size, size);
    gl.disable(gl.BLEND);
    gl.useProgram(this.subsampleProg);
    gl.uniform2f(this.subUni.get("uViewport") ?? null, size, size);
    gl.uniform1i(this.subUni.get("uData") ?? null, 0);
    const apron = children[0].apron;
    gl.uniform1i(this.subUni.get("uApron") ?? null, apron);
    const inner = size - 2 * apron;
    const h = inner >> 1;
    // Each quadrant's draw rect also covers the parent apron on its outer
    // sides, so the 4 rects tile the full physical square.
    const wq = apron + h;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        gl.bindTexture(gl.TEXTURE_2D, children[i + 2 * j].dataTex);
        const x0 = i === 0 ? 0 : wq;
        const rowStart = j === 0 ? 0 : wq;
        // QUAD_VERT flips y for screen rendering: rect y = size - (rowStart
        // + height) lands on FBO texel rows [rowStart, rowStart + wq).
        gl.uniform4f(this.subUni.get("uRect") ?? null, x0, size - (rowStart + wq), wq, wq);
        gl.uniform2i(this.subUni.get("uQuadOrigin") ?? null, i * h, j * h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    // Restore composite state.
    this.restoreCompositeTarget();
    return {
      dataTex,
      colorTex: null,
      colorVersion: -1,
      exportColorTex: null,
      exportColorVersion: -1,
      size,
      apron,
      preview: false,
      colorDirtyLo: 0,
      colorDirtyHi: 0,
    };
  }

  private restoreCompositeTarget(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundTarget?.fbo ?? null);
    gl.viewport(0, 0, this.viewportW, this.viewportH);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
  }

  // Overwrite rows [r0, r1) of a tile's escape-time data in place (partial
  // progress from a still-running job) and invalidate its colorizations.
  patchTile(handle: TileHandle, data: Float32Array, r0: number, r1: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, handle.dataTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, r0, handle.size, r1 - r0, gl.RED, gl.FLOAT, data
    );
    // The apron's band-limit spread reads one row past each edge, so a
    // patch's coloring can shift the row just outside it — widen by 1.
    const lo = Math.max(0, r0 - 1);
    const hi = Math.min(handle.size, r1 + 1);
    if (handle.colorDirtyLo >= handle.colorDirtyHi) {
      handle.colorDirtyLo = lo;
      handle.colorDirtyHi = hi;
    } else {
      handle.colorDirtyLo = Math.min(handle.colorDirtyLo, lo);
      handle.colorDirtyHi = Math.max(handle.colorDirtyHi, hi);
    }
    handle.exportColorVersion = -1;
  }

  begin(wDev: number, hDev: number): void {
    const gl = this.gl;
    this.viewportW = wDev;
    this.viewportH = hDev;
    this.boundTarget = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, wDev, hDev);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
    gl.uniform2f(this.compUni.get("uViewport") ?? null, wDev, hDev);
    gl.uniform1i(this.compUni.get("uColor") ?? null, 0);
    gl.uniform1f(this.compUni.get("uYSign") ?? null, -1);
  }

  createExportTarget(w: number, h: number): ExportTarget {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("texture allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("framebuffer allocation failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  deleteExportTarget(target: ExportTarget): void {
    this.gl.deleteFramebuffer(target.fbo);
    this.gl.deleteTexture(target.tex);
    if (this.boundTarget === target) this.boundTarget = null;
  }

  // Like begin(), but compositing into the export target with flipped Y so
  // the readback below is top-down. Must be paired with readExport in the
  // same task: side passes triggered by drawTile restore state correctly,
  // but the interactive begin() may retake the context between tasks.
  beginExport(target: ExportTarget): void {
    const gl = this.gl;
    this.viewportW = target.w;
    this.viewportH = target.h;
    this.boundTarget = target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
    gl.uniform2f(this.compUni.get("uViewport") ?? null, target.w, target.h);
    gl.uniform1i(this.compUni.get("uColor") ?? null, 0);
    gl.uniform1f(this.compUni.get("uYSign") ?? null, 1);
  }

  readExport(target: ExportTarget, out: Uint8Array): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.boundTarget = null;
  }

  // Re-colorize a tile's RGBA texture from its escape-time data (runs only
  // when the tile is drawn with a stale style version). While compositing
  // into an export target the export style slot is used — its own texture
  // and version, so live and export colorizations never invalidate each
  // other. Under an animated export the version changes every frame, so the
  // export slot degenerates to colorize-per-draw, which is the honest cost
  // of animated palettes. Returns the texture to composite from.
  private ensureColor(handle: TileHandle): WebGLTexture {
    const exporting = this.boundTarget !== null && this.exportStyle !== null;
    const version = exporting ? this.exportStyleVersion : this.styleVersion;
    let tex = exporting ? handle.exportColorTex : handle.colorTex;
    const texVersion = exporting
      ? handle.exportColorVersion
      : handle.colorVersion;
    const gl = this.gl;
    const size = handle.size;
    // Style current, texture exists: only a partial recolor of patched rows
    // is needed (or nothing). Never partial-recolor the export slot — its
    // dirty range isn't tracked and animated frames recolor wholesale.
    if (tex && texVersion === version) {
      if (!exporting && handle.colorDirtyLo < handle.colorDirtyHi) {
        this.recolorRows(handle, tex, handle.colorDirtyLo, handle.colorDirtyHi);
        handle.colorDirtyLo = handle.colorDirtyHi = 0;
      }
      return tex;
    }
    if (!tex) {
      tex = gl.createTexture();
      if (!tex) throw new Error("texture allocation failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      if (exporting) handle.exportColorTex = tex;
      else handle.colorTex = tex;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0
    );
    gl.viewport(0, 0, size, size);
    gl.disable(gl.BLEND);
    gl.useProgram(this.paletteProg);
    const style = exporting ? this.exportStyle : this.style;
    if (style) {
      gl.uniform1f(this.paletteUni.get("uIterFalloff") ?? null, style.iterFalloff);
      gl.uniform1f(this.paletteUni.get("uPaletteScale") ?? null, style.paletteScale);
      gl.uniform1f(this.paletteUni.get("uHueOffset") ?? null, style.hueOffset);
      gl.uniform1f(this.paletteUni.get("uBandSpacing") ?? null, style.bandSpacing);
      gl.uniform1f(this.paletteUni.get("uBandContrast") ?? null, style.bandContrast);
      gl.uniform1f(this.paletteUni.get("uBandOffset") ?? null, style.bandOffset);
      gl.uniform1f(this.paletteUni.get("uSaturation") ?? null, style.saturation);
      gl.uniform1f(this.paletteUni.get("uLightness") ?? null, style.lightness);
    }
    gl.uniform1i(this.paletteUni.get("uData") ?? null, 0);
    gl.uniform1f(this.paletteUni.get("uPreview") ?? null, handle.preview ? 1 : 0);
    gl.uniform4f(this.paletteUni.get("uRect") ?? null, 0, 0, size, size);
    gl.uniform2f(this.paletteUni.get("uViewport") ?? null, size, size);
    gl.bindTexture(gl.TEXTURE_2D, handle.dataTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (exporting) {
      handle.exportColorVersion = version;
    } else {
      handle.colorVersion = version;
      handle.colorDirtyLo = handle.colorDirtyHi = 0;
    }

    // Restore composite state.
    this.restoreCompositeTarget();
    return tex;
  }

  // Repaint physical rows [lo, hi) of a tile's live colorization from its
  // data — the incremental counterpart to ensureColor's full pass. Scissor
  // restricts the palette pass to those rows; gl_FragCoord/texelFetch use
  // absolute texels, so the result is identical to a full recolor there.
  private recolorRows(
    handle: TileHandle,
    tex: WebGLTexture,
    lo: number,
    hi: number
  ): void {
    const gl = this.gl;
    const size = handle.size;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0
    );
    gl.viewport(0, 0, size, size);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    // uYSign=-1 flips y, so data row r lands on FBO row (size-1-r); the
    // scissor (bottom-left origin) for data rows [lo, hi) is [size-hi, size-lo).
    gl.scissor(0, size - hi, size, hi - lo);
    gl.useProgram(this.paletteProg);
    const style = this.style;
    if (style) {
      gl.uniform1f(this.paletteUni.get("uIterFalloff") ?? null, style.iterFalloff);
      gl.uniform1f(this.paletteUni.get("uPaletteScale") ?? null, style.paletteScale);
      gl.uniform1f(this.paletteUni.get("uHueOffset") ?? null, style.hueOffset);
      gl.uniform1f(this.paletteUni.get("uBandSpacing") ?? null, style.bandSpacing);
      gl.uniform1f(this.paletteUni.get("uBandContrast") ?? null, style.bandContrast);
      gl.uniform1f(this.paletteUni.get("uBandOffset") ?? null, style.bandOffset);
      gl.uniform1f(this.paletteUni.get("uSaturation") ?? null, style.saturation);
      gl.uniform1f(this.paletteUni.get("uLightness") ?? null, style.lightness);
    }
    gl.uniform1i(this.paletteUni.get("uData") ?? null, 0);
    gl.uniform1f(this.paletteUni.get("uPreview") ?? null, handle.preview ? 1 : 0);
    gl.uniform4f(this.paletteUni.get("uRect") ?? null, 0, 0, size, size);
    gl.uniform2f(this.paletteUni.get("uViewport") ?? null, size, size);
    gl.bindTexture(gl.TEXTURE_2D, handle.dataTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    this.restoreCompositeTarget();
  }

  drawTile(
    handle: TileHandle,
    x: number,
    y: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    uSpan: number,
    vSpan: number,
    alpha: number
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.ensureColor(handle));
    // Callers address the LOGICAL tile in [0,1]; inset through the apron so
    // sampling kernels read real neighbor data across logical edges.
    const phys = handle.size;
    const inner = phys - 2 * handle.apron;
    gl.uniform4f(this.compUni.get("uRect") ?? null, x, y, w, h);
    gl.uniform4f(
      this.compUni.get("uTexRect") ?? null,
      (handle.apron + u0 * inner) / phys,
      (handle.apron + v0 * inner) / phys,
      (uSpan * inner) / phys,
      (vSpan * inner) / phys
    );
    gl.uniform1f(this.compUni.get("uAlpha") ?? null, alpha);
    // Ramp from bilinear to B-spline as magnification grows past native:
    // native tiles stay bit-exact, stretched fallbacks get the smooth kernel.
    // Preview stand-ins are exempt: their row-by-row fill leaves an
    // opaque->transparent boundary at the flush high-water mark, and the
    // B-spline's wide kernel smears that alpha edge into a feathered band over
    // the ancestor beneath (only ever horizontal, since whole rows land at
    // once). Bilinear keeps the reveal edge tight; the detail is transient
    // anyway and sharpens on commit.
    const mag = w / (uSpan * inner);
    gl.uniform1f(
      this.compUni.get("uCubicMix") ?? null,
      handle.preview ? 0 : Math.min(1, Math.max(0, mag - 1))
    );
    gl.uniform1f(this.compUni.get("uTexSize") ?? null, handle.size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
