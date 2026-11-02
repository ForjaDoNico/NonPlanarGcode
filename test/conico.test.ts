import { test } from "node:test";
import assert from "node:assert/strict";
import { criarMapeamento, paraDeformado, paraReal, subdividir } from "../src/conico.ts";
import { retransformarGcode, detectarCentro } from "../src/gcode.ts";

test("mapeamento ida e volta é a identidade, com e sem base", () => {
  for (const ang of [-30, -10, 15, 30]) for (const base of [0, 1.2]) {
    const m = criarMapeamento(ang, base, 40);
    for (let r = 0; r <= 40; r += 3.7) for (let z = 0; z <= 30; z += 0.73) {
      assert.ok(Math.abs(paraReal(m, r, paraDeformado(m, r, z)) - z) < 1e-9, `ang=${ang} base=${base} r=${r} z=${z}`);
    }
  }
});

test("z deformado cresce com z (camadas não se cruzam)", () => {
  for (const ang of [-30, 30]) {
    const m = criarMapeamento(ang, 1, 40);
    for (let r = 0; r <= 40; r += 5) for (let z = 0; z < 30; z += 0.1)
      assert.ok(paraDeformado(m, r, z + 0.1) > paraDeformado(m, r, z));
  }
});

test("subdivisão limita o tamanho das arestas", () => {
  const t = subdividir([[[0, 0, 0], [10, 0, 0], [0, 7, 0]]], 1);
  for (const tri of t) for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1 + 1e-9);
  }
});

const gcode = [
  "G90", "M83", "G1 Z5 F600", "G1 X0 Y0", ";TYPE:Skirt", "G1 X100 Y0 E1", // fora das camadas: não conta
  ";LAYER_CHANGE", ";Z:0.2", "G1 Z0.2", ";TYPE:External perimeter",
  "G1 X90 Y100", "G1 X110 Y100 E1 F1200", "G1 X110 Y120 E1", "G1 X90 Y120 E1", "G1 E-0.8",
  ";TYPE:Custom", "G1 X0 Y200 Z50",
].join("\n");

test("centro detectado ignora saia e código inicial", () => {
  assert.deepEqual(detectarCentro(gcode.split("\n")), [100, 110]);
});

test("retransformação segmenta, ajusta Z e preserva a extrusão total", () => {
  const mapa = criarMapeamento(45, 0, 20);
  const r = retransformarGcode(gcode, { mapa, deslocamentoZ: 20, segmento: 1 });
  const linhas = r.gcode.split("\n");
  // Primeiro canto (90,100): r = hypot(10,10) ≈ 14.14 → z = 0.2 + 20 − 14.14
  const canto = linhas.find((l) => l.startsWith("G1 X90 Y100"))!;
  assert.match(canto, /Z6\.05/);
  const eTotal = linhas.filter((l) => /^G1 .*X/.test(l) && /E/.test(l))
    .reduce((s, l) => s + Number(/E(-?[\d.]+)/.exec(l)![1]), 0);
  assert.ok(Math.abs(eTotal - 4) < 1e-4, `E total ${eTotal}`); // saia (1) + 3 do perímetro
  assert.ok(r.segmentosGerados > 40);
  assert.ok(linhas.includes("G1 X0 Y200 Z50"), "final do arquivo não deve ser transformado");
  assert.ok(linhas.includes("G1 E-0.8"), "retração pura passa sem mudança");
});

test("arcos são recusados com mensagem clara", () => {
  const m = criarMapeamento(20, 0, 10);
  assert.throws(() => retransformarGcode(";LAYER_CHANGE\nG1 X1 Y1 E1\nG2 X5 Y5 I1 J1 E1", { mapa: m, deslocamentoZ: 0, centro: [0, 0] }), /Arc fitting/);
});
