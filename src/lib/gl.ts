/**
 * src/lib/gl.ts — the brain mesh, rendered. Raw WebGL, no library: one
 * program, one vertex buffer, one index buffer, a depth test, and the two
 * colours. Per frame the only upload is the 85 region activities.
 *
 * Matter is a pale tissue grey lit per pixel by three lights fixed to the
 * viewer — a warm key from the upper left, a cool fill from the lower right,
 * a warm back light grazing the far edge — over a hemisphere ambient that
 * is brighter from above, darkened in the sulci by the baked occlusion, with
 * a wet Blinn-Phong highlight at the key (the pia is wet) and a filmic curve
 * on the irradiance so a lit crown rolls off instead of clipping. The curve
 * shapes BRIGHTNESS only: excitation is painted over the tissue on the Turbo
 * scale, blended in by each vertex's weighted regional activity so quiescent
 * cortex keeps its anatomy and active cortex runs blue → green → yellow →
 * red, and the hue a region takes is the hue the legend shows, lit by a
 * scalar. The scale is NOT written out here: the table and the blend come
 * from colormap.ts and the table is uploaded once as a uniform, so the
 * cortex, the sections, the 2D overlay and the legend are one decision. The
 * view frame is the same right-handed basis render.ts uses for the 2D
 * overlay, so marks land on the surface.
 *
 * Under the brain a second, tiny program draws the floor: a pool of the key
 * light on the table and the specimen's soft shadow in it, offset away from
 * the key. It is drawn first, carries no text, and fades as the view drops to
 * the side (a table seen edge-on has no visible top).
 */

import type { BrainMesh } from './surface.ts';
import { fitView, MESH_OFFSET, type View } from './render.ts';
import { TURBO, TOP, MIX_FROM, MIX_FULL, EXCITE_FLOOR, EXCITE_SPAN, turboUniform } from './colormap.ts';

/* The scale's constants are interpolated into the shader source so GLSL and
   TypeScript cannot disagree about where colour starts or how far it runs.
   glf() keeps them GLSL floats: a bare `1` is an int and will not compile. */
const N = TURBO.length;
const LAST = N - 1;
const glf = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** the key light's direction in view space (x right, y up, z toward the viewer): the floor's shadow falls away from it */
const KEY = [-0.55, 0.6, 0.65] as const;
/** exposure before the filmic curve: a key-lit crown lands near 0.92 */
const EXPOSURE = 1.9;
/** the floor's centre, mm, in the mesh's own frame (just under the lowest point of the brainstem) */
const FLOOR_Z = -78;
/** the floor ellipse's radius, mm — well past the brain's 87 mm half-length, so the pool shows around it and the shadow is not all hidden under it */
const FLOOR_R = 150;

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
// ACES filmic (the Narkowicz fit), applied to irradiance: a lit crown rolls
// off softly instead of clipping to white
float aces(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 aces3(vec3 x) { return vec3(aces(x.r), aces(x.g), aces(x.b)); }
// the three lights and the ambient, fixed to the viewer
const vec3 L_KEY = vec3(${glf(KEY[0])}, ${glf(KEY[1])}, ${glf(KEY[2])});
const vec3 L_FILL = vec3(0.7, 0.1, 0.55);
const vec3 L_BACK = vec3(0.3, 0.5, -0.8);
const vec3 C_KEY = vec3(1.0, 0.96, 0.9);     // warm
const vec3 C_FILL = vec3(0.86, 0.91, 1.0);   // cool
const vec3 C_BACK = vec3(1.0, 0.9, 0.84);    // warm
const vec3 C_SKY = vec3(0.94, 0.96, 1.0);
void main() {
  vec3 n = normalize(vNrm);
  vec3 lk = normalize(L_KEY);
  float key = max(0.0, dot(n, lk));
  float fill = max(0.0, dot(n, normalize(L_FILL)));
  float back = max(0.0, dot(n, normalize(L_BACK)));
  float sky = 0.5 + 0.5 * n.y;   // hemisphere: lit from above, dim beneath
  float facing = max(0.0, n.z);
  float rim = pow(1.0 - facing, 3.0) * 0.14;
  float depthFade = 0.7 + 0.3 * clamp((vDepth + 80.0) / 160.0, 0.0, 1.0);
  // irradiance on the tissue, in colour; the occlusion darkens the sulci
  vec3 irr = (C_SKY * (0.10 + 0.10 * sky) + C_KEY * (0.78 * key) + C_FILL * (0.22 * fill) + C_BACK * (0.18 * back)) * vOcc + rim;
  irr *= depthFade * ${glf(EXPOSURE)};
  vec3 shade3 = aces3(irr);
  float shade = aces(dot(irr, vec3(0.3333)));
  // the wet highlight: a broad Blinn-Phong lobe at the key and a tighter sheen over it
  vec3 h = normalize(lk + vec3(0.0, 0.0, 1.0));
  float nh = max(0.0, dot(n, h));
  float spec = (pow(nh, 28.0) * 0.14 + pow(nh, 110.0) * 0.10) * vOcc;
  vec3 ex = scaleAt(vExcite * ${glf(TOP)});
  float k = smoothstep(${glf(MIX_FROM)}, ${glf(MIX_FULL)}, vExcite);
  // excitation keeps its hue: lit by the scalar, never by the tinted lights
  vec3 lit = 0.55 + 0.45 * vec3(shade);
  vec3 c = mix(MATTER * shade3, ex * lit, k) + vec3(spec);
  if (uHighlight >= 0.0 && abs(vLobe - uHighlight) < 0.5) c = mix(c, HIGHLIGHT * (0.5 + 0.5 * shade), 0.5);
  gl_FragColor = vec4(c, uAlpha);
}
`;

/* The floor under the specimen: one quad, its own program. The fragment is
   a radial pool of the key light with the brain's shadow in it, offset away
   from the key. Drawn before the brain without writing depth. */
const FLOOR_VS = `
attribute vec2 aQ;
uniform vec2 uC;     // clip-space centre of the ellipse
uniform vec2 uR;     // clip-space radii
varying vec2 vQ;
void main() {
  vQ = aQ;
  gl_Position = vec4(uC + aQ * uR, 0.999, 1.0);
}
`;
const FLOOR_FS = `
precision mediump float;
varying vec2 vQ;
uniform float uFade;   // 0 edge-on … 1 seen from above
void main() {
  float d = length(vQ);
  float pool = pow(max(0.0, 1.0 - d), 1.3);
  // the shadow falls away from the key light (upper left → lower right)
  float ds = length((vQ - vec2(0.12, -0.08)) * vec2(1.5, 1.7));
  float shadow = smoothstep(1.0, 0.15, ds);
  vec3 poolCol = vec3(0.46, 0.44, 0.41);
  vec3 c = mix(poolCol, vec3(0.0), 0.8 * shadow);
  float a = (0.42 * pool + 0.5 * shadow) * uFade;
  gl_FragColor = vec4(c, a);
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

  // WebGL1 has no vertex-array objects: attribute pointers are global state,
  // so each program re-binds its own before it draws
  const MESH_ATTRS: Array<[string, number, number]> = [
    ['aPos', 3, 0], ['aNrm', 3, 3], ['aOcc', 1, 6], ['aGain', 1, 7], ['aRidx', 3, 8], ['aRw', 3, 11], ['aLobe', 1, 14],
  ];
  const meshLocs = MESH_ATTRS.map(([name]) => gl.getAttribLocation(prog, name));
  const bindMesh = () => {
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    MESH_ATTRS.forEach(([, size, offset], i) => {
      const loc = meshLocs[i]!;
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
    });
  };

  // the floor: its own program and a unit quad
  const floorProg = gl.createProgram()!;
  gl.attachShader(floorProg, compile(gl.VERTEX_SHADER, FLOOR_VS));
  gl.attachShader(floorProg, compile(gl.FRAGMENT_SHADER, FLOOR_FS));
  gl.linkProgram(floorProg);
  if (!gl.getProgramParameter(floorProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(floorProg) ?? 'floor link failed');
  const qbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aQ = gl.getAttribLocation(floorProg, 'aQ');
  const uFloorC = gl.getUniformLocation(floorProg, 'uC');
  const uFloorR = gl.getUniformLocation(floorProg, 'uR');
  const uFloorFade = gl.getUniformLocation(floorProg, 'uFade');
  const bindFloor = () => {
    gl.useProgram(floorProg);
    for (const loc of meshLocs) if (loc >= 0 && loc !== aQ) gl.disableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, qbo);
    gl.enableVertexAttribArray(aQ);
    gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 0, 0);
  };
  bindMesh();

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
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // the floor first: the centre is the point under the brainstem, put
      // through the same frame and perspective the vertex shader applies
      {
        const X = 0;
        const Y = 0; // the mesh's y centre, after uCentre
        const Z = FLOOR_Z + MESH_OFFSET.z;
        const depth = X * rd[0]! + Y * rd[1]! + Z * rd[2]!;
        const persp = 1 + depth * 0.0022;
        const px = (X * rx[0]! + Y * rx[1]! + Z * rx[2]!) * s * persp;
        const py = (X * ry[0]! + Y * ry[1]! + Z * ry[2]!) * s * persp;
        const shiftY = -((cy - h / 2) * 2) / h;
        // a disc on the table: full width always, its height the sine of the tilt
        const tilt = Math.sin(view.pitch);
        const fade = Math.min(1, Math.max(0, tilt / 0.3));
        if (fade > 0) {
          bindFloor();
          gl.uniform2f(uFloorC, (px * 2) / w, (py * 2) / h + shiftY);
          gl.uniform2f(uFloorR, (FLOOR_R * s * persp * 2) / w, (FLOOR_R * s * persp * Math.max(0.04, tilt) * 2) / h);
          gl.uniform1f(uFloorFade, fade);
          gl.enable(gl.BLEND);
          // the canvas is not premultiplied: let the floor's coverage land in
          // the alpha channel as-is, or a faint pool squares itself to nothing
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.disable(gl.CULL_FACE);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.enable(gl.CULL_FACE);
          gl.depthMask(true);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.disable(gl.BLEND);
        }
      }

      bindMesh();
      // column-major upload of the row matrix → pass the transpose
      gl.uniformMatrix3fv(uBasis, false, [rx[0]!, ry[0]!, rd[0]!, rx[1]!, ry[1]!, rd[1]!, rx[2]!, ry[2]!, rd[2]!]);
      gl.uniform3f(uCentre, MESH_OFFSET.x, MESH_OFFSET.y, MESH_OFFSET.z);
      gl.uniform2f(uScale, (2 * s) / w, (2 * s) / h);
      gl.uniform2f(uShift, 0, -((cy - h / 2) * 2) / h);
      for (let i = 0; i < 85; i++) act[i] = activity ? Math.max(0, Math.min(1, activity[i] ?? 0)) : 0.1;
      gl.uniform1fv(uAct, act);
      gl.uniform1f(uHighlight, opts.highlightLobe);
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
        const X = mesh.pos[k * 3]! + MESH_OFFSET.x;
        const Y = mesh.pos[k * 3 + 1]! + MESH_OFFSET.y;
        const Z = mesh.pos[k * 3 + 2]! + MESH_OFFSET.z;
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
