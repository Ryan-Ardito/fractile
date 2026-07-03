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
  size: number;
};

const QUAD_VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;     // x, y, w, h in device pixels, origin top-left
uniform vec2 uViewport; // device pixels
out vec2 vUV;
void main() {
  vUV = aPos;
  vec2 px = uRect.xy + aPos * uRect.zw;
  vec2 clip = (px / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
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
  // rather than render detail the tile doesn't actually contain.
  float spread = max(
    max(
      abs(it - fetchIter(p + ivec2(1, 0), hi)),
      abs(it - fetchIter(p + ivec2(-1, 0), hi))
    ),
    max(
      abs(it - fetchIter(p + ivec2(0, 1), hi)),
      abs(it - fetchIter(p + ivec2(0, -1), hi))
    )
  );
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
  outColor = vec4(clamp(rgb + m, 0.0, 1.0), 1.0);
}`;

// Build a parent tile's escape-time data by 2:1 subsampling a child tile
// into one quadrant of the target. Point sampling (no averaging): averaging
// iteration values across an interior/exterior discontinuity would fabricate
// values that exist nowhere; the cost is a fixed quarter-pixel sampling
// offset, which is invisible.
const SUBSAMPLE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uData;
uniform ivec2 uQuadOrigin; // this child's quadrant origin, in target texels
out vec4 outColor;
void main() {
  ivec2 ct = (ivec2(gl_FragCoord.xy) - uQuadOrigin) * 2;
  int hi = textureSize(uData, 0).x - 1;
  outColor = vec4(texelFetch(uData, clamp(ct, ivec2(0), ivec2(hi)), 0).r, 0.0, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform vec4 uTexRect; // u0, v0, uSpan, vSpan
uniform float uAlpha;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 rgb = texture(uColor, uTexRect.xy + vUV * uTexRect.zw).rgb;
  outColor = vec4(rgb * uAlpha, uAlpha);
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
  private viewportW = 0;
  private viewportH = 0;
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
    for (const name of [...STYLE_UNIFORMS, "uRect", "uViewport", "uData"]) {
      this.paletteUni.set(name, gl.getUniformLocation(this.paletteProg, name));
    }
    for (const name of ["uRect", "uViewport", "uTexRect", "uAlpha", "uColor"]) {
      this.compUni.set(name, gl.getUniformLocation(this.compositeProg, name));
    }
    for (const name of ["uRect", "uViewport", "uData", "uQuadOrigin"]) {
      this.subUni.set(name, gl.getUniformLocation(this.subsampleProg, name));
    }
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

  uploadTile(data: Float32Array, size: number): TileHandle {
    const gl = this.gl;
    const dataTex = gl.createTexture();
    if (!dataTex) throw new Error("texture allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, size, 0, gl.RED, gl.FLOAT, data);
    return { dataTex, colorTex: null, colorVersion: -1, size };
  }

  deleteTile(handle: TileHandle): void {
    this.gl.deleteTexture(handle.dataTex);
    if (handle.colorTex) this.gl.deleteTexture(handle.colorTex);
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
    const h = size >> 1;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        gl.bindTexture(gl.TEXTURE_2D, children[i + 2 * j].dataTex);
        // QUAD_VERT flips y for screen rendering, so a rect at y = h - j·h
        // lands on FBO texel rows [j·h, j·h + h).
        gl.uniform4f(this.subUni.get("uRect") ?? null, i * h, h - j * h, h, h);
        gl.uniform2i(this.subUni.get("uQuadOrigin") ?? null, i * h, j * h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    // Restore composite state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.viewportW, this.viewportH);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
    return { dataTex, colorTex: null, colorVersion: -1, size };
  }

  begin(wDev: number, hDev: number): void {
    const gl = this.gl;
    this.viewportW = wDev;
    this.viewportH = hDev;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, wDev, hDev);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
    gl.uniform2f(this.compUni.get("uViewport") ?? null, wDev, hDev);
    gl.uniform1i(this.compUni.get("uColor") ?? null, 0);
  }

  // Re-colorize a tile's RGBA texture from its escape-time data (runs only
  // when the tile is drawn with a stale style version).
  private ensureColor(handle: TileHandle): void {
    if (handle.colorTex && handle.colorVersion === this.styleVersion) return;
    const gl = this.gl;
    const size = handle.size;
    if (!handle.colorTex) {
      const tex = gl.createTexture();
      if (!tex) throw new Error("texture allocation failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      handle.colorTex = tex;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle.colorTex, 0
    );
    gl.viewport(0, 0, size, size);
    gl.disable(gl.BLEND);
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
    gl.uniform4f(this.paletteUni.get("uRect") ?? null, 0, 0, size, size);
    gl.uniform2f(this.paletteUni.get("uViewport") ?? null, size, size);
    gl.bindTexture(gl.TEXTURE_2D, handle.dataTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    handle.colorVersion = this.styleVersion;

    // Restore composite state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.viewportW, this.viewportH);
    gl.enable(gl.BLEND);
    gl.useProgram(this.compositeProg);
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
    this.ensureColor(handle);
    gl.bindTexture(gl.TEXTURE_2D, handle.colorTex);
    gl.uniform4f(this.compUni.get("uRect") ?? null, x, y, w, h);
    gl.uniform4f(this.compUni.get("uTexRect") ?? null, u0, v0, uSpan, vSpan);
    gl.uniform1f(this.compUni.get("uAlpha") ?? null, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
