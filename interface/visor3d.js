// Visor 3D mínimo em WebGL, sem dependências: a malha da peça e o caminho do bico em linhas.

const VS_MALHA = `
attribute vec3 pos; attribute vec3 nor;
uniform mat4 mvp; varying float luz;
void main() { gl_Position = mvp * vec4(pos, 1.0); luz = 0.35 + 0.65 * abs(dot(normalize(nor), normalize(vec3(0.4, -0.5, 0.8)))); }`;
const FS_MALHA = `
precision mediump float; varying float luz; uniform vec4 cor;
void main() { gl_FragColor = vec4(cor.rgb * luz, cor.a); }`;
const VS_LINHA = `
attribute vec3 pos; uniform mat4 mvp; uniform vec2 faixaZ; varying float t;
void main() { gl_Position = mvp * vec4(pos, 1.0); t = clamp((pos.z - faixaZ.x) / max(faixaZ.y - faixaZ.x, 1e-6), 0.0, 1.0); }`;
const FS_LINHA = `
precision mediump float; varying float t;
void main() {
  vec3 a = vec3(0.16, 0.36, 0.62), b = vec3(0.18, 0.62, 0.42), c = vec3(0.93, 0.62, 0.20);
  vec3 cor = t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, t * 2.0 - 1.0);
  gl_FragColor = vec4(cor, 1.0);
}`;

function compilar(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [tipo, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(tipo);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  return p;
}

function multiplicar(a, b) {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    r[i * 4 + j] = s;
  }
  return r;
}

function perspectiva(fov, aspecto, perto, longe) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (perto - longe);
  return new Float32Array([f / aspecto, 0, 0, 0, 0, f, 0, 0, 0, 0, (longe + perto) * nf, -1, 0, 0, 2 * longe * perto * nf, 0]);
}

function olharPara(olho, alvo, cima) {
  const z = normalizar([olho[0] - alvo[0], olho[1] - alvo[1], olho[2] - alvo[2]]);
  const x = normalizar(cruz(cima, z));
  const y = cruz(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -ponto(x, olho), -ponto(y, olho), -ponto(z, olho), 1,
  ]);
}
const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const ponto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalizar = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

export function criarVisor3d(canvas) {
  const gl = canvas.getContext("webgl", { antialias: true });
  if (!gl) return null;
  const progMalha = compilar(gl, VS_MALHA, FS_MALHA);
  const progLinha = compilar(gl, VS_LINHA, FS_LINHA);
  const estado = {
    malha: null, linhas: null, mostrarMalha: true, mostrarLinhas: true,
    alvo: [0, 0, 0], raio: 100, azimute: -0.9, elevacao: 0.55, faixaZ: [0, 1],
  };

  function definirMalha(tris) {
    // tris: Float32Array com 9 números por triângulo
    const n = tris.length / 9;
    const pos = new Float32Array(n * 9), nor = new Float32Array(n * 9);
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const a = [tris[o], tris[o + 1], tris[o + 2]], b = [tris[o + 3], tris[o + 4], tris[o + 5]], c = [tris[o + 6], tris[o + 7], tris[o + 8]];
      const nn = normalizar(cruz([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      for (let k = 0; k < 9; k++) { pos[o + k] = tris[o + k]; nor[o + k] = nn[k % 3]; }
      for (const p of [a, b, c]) for (let e = 0; e < 3; e++) { mn[e] = Math.min(mn[e], p[e]); mx[e] = Math.max(mx[e], p[e]); }
    }
    const bp = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bp); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const bn = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bn); gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
    estado.malha = { bp, bn, n: n * 3 };
    enquadrar(mn, mx);
  }

  function definirLinhas(segs) {
    // segs: Float32Array com 6 números por segmento (x, y, z de cada ponta)
    let zMin = Infinity, zMax = -Infinity;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < segs.length; i += 3) {
      for (let e = 0; e < 3; e++) { mn[e] = Math.min(mn[e], segs[i + e]); mx[e] = Math.max(mx[e], segs[i + e]); }
    }
    zMin = mn[2]; zMax = mx[2];
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, segs, gl.STATIC_DRAW);
    estado.linhas = { b, n: segs.length / 3 };
    estado.faixaZ = [zMin, zMax];
    if (segs.length) enquadrar(mn, mx);
  }

  function limparLinhas() { estado.linhas = null; desenhar(); }

  function enquadrar(mn, mx) {
    estado.alvo = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    estado.raio = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 1.8 + 10;
    desenhar();
  }

  function desenhar() {
    const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const escuro = matchMedia("(prefers-color-scheme: dark)").matches;
    gl.clearColor(escuro ? 0.12 : 1, escuro ? 0.12 : 1, escuro ? 0.11 : 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const { alvo, raio, azimute, elevacao } = estado;
    const olho = [
      alvo[0] + raio * Math.cos(elevacao) * Math.cos(azimute),
      alvo[1] + raio * Math.cos(elevacao) * Math.sin(azimute),
      alvo[2] + raio * Math.sin(elevacao),
    ];
    const mvp = multiplicar(perspectiva(0.7, w / Math.max(h, 1), raio / 100, raio * 10), olharPara(olho, alvo, [0, 0, 1]));

    if (estado.linhas && estado.mostrarLinhas) {
      gl.useProgram(progLinha);
      gl.uniformMatrix4fv(gl.getUniformLocation(progLinha, "mvp"), false, mvp);
      gl.uniform2f(gl.getUniformLocation(progLinha, "faixaZ"), estado.faixaZ[0], estado.faixaZ[1]);
      const lp = gl.getAttribLocation(progLinha, "pos");
      gl.bindBuffer(gl.ARRAY_BUFFER, estado.linhas.b);
      gl.enableVertexAttribArray(lp);
      gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, estado.linhas.n);
      gl.disableVertexAttribArray(lp);
    }
    if (estado.malha && estado.mostrarMalha) {
      gl.useProgram(progMalha);
      gl.uniformMatrix4fv(gl.getUniformLocation(progMalha, "mvp"), false, mvp);
      const transparente = !!(estado.linhas && estado.mostrarLinhas);
      gl.uniform4f(gl.getUniformLocation(progMalha, "cor"), 0.62, 0.64, 0.66, transparente ? 0.18 : 1);
      if (transparente) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      const lp = gl.getAttribLocation(progMalha, "pos"), ln = gl.getAttribLocation(progMalha, "nor");
      gl.bindBuffer(gl.ARRAY_BUFFER, estado.malha.bp); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, estado.malha.bn); gl.enableVertexAttribArray(ln); gl.vertexAttribPointer(ln, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, estado.malha.n);
      gl.disableVertexAttribArray(lp); gl.disableVertexAttribArray(ln);
      gl.disable(gl.BLEND); gl.depthMask(true);
    }
  }

  let arrastando = null;
  canvas.addEventListener("pointerdown", (e) => { arrastando = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { arrastando = null; });
  canvas.addEventListener("pointermove", (e) => {
    if (!arrastando) return;
    estado.azimute -= (e.clientX - arrastando[0]) * 0.008;
    estado.elevacao = Math.max(-1.5, Math.min(1.5, estado.elevacao + (e.clientY - arrastando[1]) * 0.008));
    arrastando = [e.clientX, e.clientY];
    desenhar();
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); estado.raio *= Math.exp(e.deltaY * 0.001); desenhar(); }, { passive: false });
  new ResizeObserver(desenhar).observe(canvas);

  return {
    definirMalha, definirLinhas, limparLinhas, desenhar,
    mostrar(malha, linhas) { estado.mostrarMalha = malha; estado.mostrarLinhas = linhas; desenhar(); },
  };
}
