/**
 * src/lib/gl.ts — the brain mesh, rendered. Raw WebGL, no library: one
 * program, one vertex buffer, one index buffer, a depth test, and the two
 * colours. Per frame the only upload is the 85 region activities.
 *
 * Matter is a pale tissue grey lit per pixel from the viewer's upper left,
 * darkened in the sulci by the baked occlusion. Excitation is painted over
 * it on the Turbo scale, blended in by each vertex's weighted regional
 * activity so quiescent cortex keeps its anatomy and active cortex runs
 * blue → green → yellow → red. The scale is NOT written out here: the table
 * and the blend come from colormap.ts and the table is uploaded once as a
 * uniform, so the cortex, the sections, the 2D overlay and the legend are
 * one decision. The view frame is the same right-handed basis render.ts
 * uses for the 2D overlay, so marks land on the surface.
 */

import type { BrainMesh } from './surface.ts';
import { fitView, type View } from './render.ts';
import { TURBO, TOP, MIX_FROM, MIX_FULL, EXCITE_FLOOR, EXCITE_SPAN, turboUniform } from './colormap.ts';

/* The scale's constants are interpolated into the shader source so GLSL and
   TypeScript cannot disagree about where colour starts or how far it runs.
   glf() keeps them GLSL floats: a bare `1` is an int and will not compile. */
const N = TURBO.length;
const LAST = N - 1;
const glf = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute float aOcc;
attribute float aGain;
attribute vec3 aRidx;
attribute vec3 aRw;
attribute float aLobe;
uniform mat3 uBasis;      // rows: right, up, toward-viewer
uniform vec3 uCentre;     // world offset applied before rotation
uniform vec2 uScale;      // mm → clip units, per axis
uniform vec2 uShift;      // clip-space offset: the fit's centre is not the canvas's
uniform float uAct[85];
varying vec3 vNrm;
varying float vOcc;
varying float vExcite;
varying float vDepth;
varying float vLobe;
float excite(float a) { return clamp((a - ${glf(EXCITE_FLOOR)}) / ${glf(EXCITE_SPAN)}, 0.0, 1.0); }
float actAt(float idx) {
  int i = int(idx + 0.5);
  for (int k = 0; k < 85; k++) { if (k == i) return uAct[k]; }
  return 0.0;
}
void main() {
  vec3 p = uBasis * (aPos + uCentre);
  float persp = 1.0 + p.z * 0.0022;
  gl_Position = vec4(p.x * uScale.x * persp + uShift.x, p.y * uScale.y * persp + uShift.y, -p.z / 200.0, 1.0);
  vNrm = uBasis * aNrm;
  vOcc = aOcc;
  vDepth = p.z;
  vLobe = aLobe;
  vExcite = aGain * excite(aRw.x * actAt(aRidx.x) + aRw.y * actAt(aRidx.y) + aRw.z * actAt(aRidx.z));
}
`;

const FS = `
precision mediump float;
varying vec3 vNrm;
varying float vOcc;
varying float vExcite;
varying float vDepth;
varying float vLobe;
uniform float uAlpha;
uniform float uHighlight;   // lobe index to tint, or -1
const vec3 HIGHLIGHT = vec3(0.21, 0.84, 1.0);
const vec3 MATTER = vec3(0.77, 0.745, 0.71);
uniform vec3 uRamp[${N}];    // the Turbo table, uploaded from colormap.ts
// Turbo at t, between the stops. Indexing a uniform array by a loop counter
// is the one dynamic index GLSL ES 1.00 allows, and it is what actAt above
// already does.
vec3 scaleAt(float t) {
  float s = clamp(t, 0.0, 1.0) * ${LAST}.0;
  int i = int(floor(s));
  float f = s - floor(s);
  vec3 lo = uRamp[0];
  vec3 hi = uRamp[0];
  for (int k = 0; k < ${LAST}; k++) {
    if (k == i) { lo = uRamp[k]; hi = uRamp[k + 1]; }
  }
  return mix(lo, hi, f);
}
void main() {
  vec3 n = normalize(vNrm);
  vec3 l = normalize(vec3(-0.45, 0.4, 0.8));
  float lambert = max(0.0, dot(n, l));
  float facing = max(0.0, n.z);
  float rim = pow(1.0 - facing, 3.0) * 0.12;
  float depthFade = 0.7 + 0.3 * clamp((vDepth + 80.0) / 160.0, 0.0, 1.0);
  float shade = (0.2 + 0.62 * lambert + 0.18 * facing) * vOcc * depthFade + rim;
  vec3 ex = scaleAt(vExcite * ${glf(TOP)});
  float k = smoothstep(${glf(MIX_FROM)}, ${glf(MIX_FULL)}, vExcite);
  vec3 lit = 0.55 + 0.45 * vec3(shade);
  vec3 c = mix(MATTER * shade, ex * lit, k);
  if (uHighlight >= 0.0 && abs(vLobe - uHighlight) < 0.5) c = mix(c, HIGHLIGHT * (0.5 + 0.5 * shade), 0.5);
  gl_FragColor = vec4(c, uAlpha);
}
`;

export interface DrawOptions {
  /** translucent cortex, deep structures and connectome visible with their depth */
  transparent: boolean;
  /** lobe index to tint (LOBE_ORDER), or -1 */
  highlightLobe: number;
}

export interface BrainGL {
  draw(view: View, activity: ArrayLike<number> | null, opts: DrawOptions): void;
  /** the vertex under a canvas point (CSS px), front-facing and nearest the viewer; -1 if none */
  pick(view: View, x: number, y: number): number;
  resize(): void;
}

export function createBrainGL(canvas: HTMLCanvasElement, mesh: BrainMesh): BrainGL | null {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return null;
  const ext = gl.getExtension('OES_element_index_uint');
  if (!ext) return null;

  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader failed');
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
  gl.useProgram(prog);

  // the colour scale, uploaded once: the shader reads the same table
  // colormap.ts hands the 2D overlay, the sections and the legend
  const rampLoc = gl.getUniformLocation(prog, 'uRamp[0]') ?? gl.getUniformLocation(prog, 'uRamp');
  if (rampLoc) gl.uniform3fv(rampLoc, turboUniform());

  // one interleaved buffer: pos(3) nrm(3) occ(1) gain(1) ridx(3) rw(3) lobe(1) = 15 floats
  const stride = 15;
  const data = new Float32Array(mesh.nv * stride);
  for (let k = 0; k < mesh.nv; k++) {
    const o = k * stride;
    data[o] = mesh.pos[k * 3]!;
    data[o + 1] = mesh.pos[k * 3 + 1]!;
    data[o + 2] = mesh.pos[k * 3 + 2]!;
    data[o + 3] = mesh.nrm[k * 3]!;
    data[o + 4] = mesh.nrm[k * 3 + 1]!;
    data[o + 5] = mesh.nrm[k * 3 + 2]!;
    data[o + 6] = mesh.occ[k]!;
    data[o + 7] = mesh.gain[k]!;
    data[o + 8] = mesh.ridx[k * 3]!;
    data[o + 9] = mesh.ridx[k * 3 + 1]!;
    data[o + 10] = mesh.ridx[k * 3 + 2]!;
    data[o + 11] = mesh.rw[k * 3]!;
    data[o + 12] = mesh.rw[k * 3 + 1]!;
    data[o + 13] = mesh.rw[k * 3 + 2]!;
    data[o + 14] = mesh.lobe[k]!;
  }
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.faces, gl.STATIC_DRAW);

  const attr = (name: string, size: number, offset: number) => {
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
  };
  attr('aPos', 3, 0);
  attr('aNrm', 3, 3);
  attr('aOcc', 1, 6);
  attr('aGain', 1, 7);
  attr('aRidx', 3, 8);
  attr('aRw', 3, 11);
  attr('aLobe', 1, 14);

  const uBasis = gl.getUniformLocation(prog, 'uBasis');
  const uCentre = gl.getUniformLocation(prog, 'uCentre');
  const uScale = gl.getUniformLocation(prog, 'uScale');
  const uShift = gl.getUniformLocation(prog, 'uShift');
  const uAct = gl.getUniformLocation(prog, 'uAct');
  const uAlpha = gl.getUniformLocation(prog, 'uAlpha');
  const uHighlight = gl.getUniformLocation(prog, 'uHighlight');
  const act = new Float32Array(85);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0, 0, 0, 0);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  /** the view frame as rows: right, up, toward-viewer */
  const frame = (view: View) => {
    const cy = Math.cos(view.yaw);
    const sy = Math.sin(view.yaw);
    const cp = Math.cos(view.pitch);
    const sp = Math.sin(view.pitch);
    return { rx: [-sy, cy, 0], ry: [-cy * sp, -sy * sp, cp], rd: [cy * cp, sy * cp, sp] };
  };

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  };

  return {
    resize,
    draw(view, activity, opts) {
      resize();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const { s, cy } = fitView(w, h, view); // px per mm and centre, matching the overlay
      const { rx, ry, rd } = frame(view);
      // column-major upload of the row matrix → pass the transpose
      gl.uniformMatrix3fv(uBasis, false, [rx[0]!, ry[0]!, rd[0]!, rx[1]!, ry[1]!, rd[1]!, rx[2]!, ry[2]!, rd[2]!]);
      gl.uniform3f(uCentre, 0, 18, -12);
      gl.uniform2f(uScale, (2 * s) / w, (2 * s) / h);
      gl.uniform2f(uShift, 0, -((cy - h / 2) * 2) / h);
      for (let i = 0; i < 85; i++) act[i] = activity ? Math.max(0, Math.min(1, activity[i] ?? 0)) : 0.1;
      gl.uniform1fv(uAct, act);
      gl.uniform1f(uHighlight, opts.highlightLobe);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (opts.transparent) {
        // back faces first, then front, without writing depth: a glass brain
        gl.enable(gl.BLEND);
        gl.depthMask(false);
        gl.uniform1f(uAlpha, 0.2);
        gl.cullFace(gl.FRONT);
        gl.drawElements(gl.TRIANGLES, mesh.nf * 3, gl.UNSIGNED_INT, 0);
        gl.uniform1f(uAlpha, 0.46);
        gl.cullFace(gl.BACK);
        gl.drawElements(gl.TRIANGLES, mesh.nf * 3, gl.UNSIGNED_INT, 0);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      } else {
        gl.uniform1f(uAlpha, 1);
        gl.cullFace(gl.BACK);
        gl.drawElements(gl.TRIANGLES, mesh.nf * 3, gl.UNSIGNED_INT, 0);
      }
    },
    pick(view, x, y) {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const { s, cy } = fitView(w, h, view);
      const { rx, ry, rd } = frame(view);
      const radius2 = 9 * 9;
      let best = -1;
      let bestScore = Infinity;
      for (let k = 0; k < mesh.nv; k++) {
        const nx = mesh.nrm[k * 3]!;
        const ny = mesh.nrm[k * 3 + 1]!;
        const nz = mesh.nrm[k * 3 + 2]!;
        if (nx * rd[0]! + ny * rd[1]! + nz * rd[2]! < 0.05) continue; // facing away
        const X = mesh.pos[k * 3]!;
        const Y = mesh.pos[k * 3 + 1]! + 18;
        const Z = mesh.pos[k * 3 + 2]! - 12;
        const depth = X * rd[0]! + Y * rd[1]! + Z * rd[2]!;
        const scale = 1 + depth * 0.0022;
        const px = w / 2 + (X * rx[0]! + Y * rx[1]! + Z * rx[2]!) * s * scale;
        const py = cy - (X * ry[0]! + Y * ry[1]! + Z * ry[2]!) * s * scale;
        const d2 = (px - x) ** 2 + (py - y) ** 2;
        if (d2 > radius2) continue;
        // nearer to the viewer wins; screen distance breaks ties
        const score = -depth * 10 + Math.sqrt(d2);
        if (score < bestScore) {
          bestScore = score;
          best = k;
        }
      }
      return best;
    },
  };
}
