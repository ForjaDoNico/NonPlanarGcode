import { test } from "node:test";
import assert from "node:assert/strict";
import { criarMapeamento, deformarMalha, espessuraRelativa, paraDeformado, paraReal, subdividir } from "../src/conico.ts";
import type { Triangulo } from "../src/stl.ts";
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

const movimentos = (texto: string) => texto.split("\n").filter((l) => l.startsWith("G1 X"));

test("velocidades terminadas em zero são preservadas", () => {
  const mapa = criarMapeamento(30, 0, 40);
  for (const f of [600, 1200, 3000, 7200, 1234]) {
    const g = `G90\nM83\n;LAYER_CHANGE\nG1 X10 Y0 Z30\nG1 X20 Y0 E1 F${f}`;
    const r = retransformarGcode(g, { mapa, deslocamentoZ: 0, centro: [0, 0] });
    assert.ok(r.gcode.includes(` F${f}`), `F${f} deveria estar em: ${r.gcode}`);
  }
});

test("com base e ângulo positivo, o cone completo é atingido dentro da transição esperada", () => {
  const m = criarMapeamento(30, 1, 30);
  assert.ok(Math.abs(m.transicao - 30 * m.tan) < 1e-9);
  // Acima da transição, a inclinação da camada é exatamente o ângulo pedido.
  const zl = paraDeformado(m, 30, 28);
  const inclinacao = (paraReal(m, 29, zl) - paraReal(m, 30, zl));
  assert.ok(Math.abs(inclinacao - m.tan) < 1e-9, `inclinação ${inclinacao}`);
});

test("transição usa o raio real da peça, não o canto da caixa", () => {
  const N = 64;
  const tris: Triangulo[] = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N, b = (2 * Math.PI * (i + 1)) / N;
    tris.push([[0, 0, 0], [30 * Math.cos(a), 30 * Math.sin(a), 0], [30 * Math.cos(b), 30 * Math.sin(b), 10]]);
  }
  const { mapa } = deformarMalha(tris, 30, { base: 1, centro: [0, 0] });
  assert.ok(Math.abs(mapa.transicao - 30 * mapa.tan) < 1e-9);
});

test("espessuraRelativa bate com a distância real entre camadas", () => {
  for (const ang of [-30, 30]) {
    const m = criarMapeamento(ang, 1, 30);
    for (const r of [0, 10, 30]) for (const zl of [0.5, 3, 6, 40]) {
      const h = 1e-6;
      const medida = (paraReal(m, r, zl + h) - paraReal(m, r, zl)) / h;
      assert.ok(Math.abs(medida - espessuraRelativa(m, r, zl)) < 1e-4, `ang=${ang} r=${r} zl=${zl}`);
    }
  }
});

test("extrusão é reduzida na transição e não é alterada fora dela", () => {
  const mapa = criarMapeamento(30, 1, 30); // T ≈ 17,32
  const extrusao = (zl: number) => {
    const g = `G90\nM83\n;LAYER_CHANGE\nG1 Z${zl}\nG1 X30 Y0\nG1 X30 Y1 E1`;
    const r = retransformarGcode(g, { mapa, deslocamentoZ: 0, centro: [0, 0], segmento: 10 });
    return Number(/E([\d.]+)/.exec(movimentos(r.gcode).at(-1)!)![1]);
  };
  assert.ok(Math.abs(extrusao(5) - 0.5) < 1e-3, `transição: ${extrusao(5)}`);
  assert.equal(extrusao(0.5), 1); // base plana
  assert.equal(extrusao(60), 1); // cone completo
});

test("código personalizado entre camadas não encerra a transformação", () => {
  const g = "G90\nM83\n;LAYER_CHANGE\nG1 Z30\nG1 X30 Y0 E1\n;TYPE:Custom\nM117 oi\n;LAYER_CHANGE\nG1 Z30.2\n;TYPE:External perimeter\nG1 X30 Y10 E1";
  const r = retransformarGcode(g, { mapa: criarMapeamento(30, 0, 40), deslocamentoZ: 0, centro: [0, 0], segmento: 100 });
  const ultimo = movimentos(r.gcode).at(-1)!;
  assert.match(ultimo, /Z(\d+\.?\d*)/);
  const zFinal = Number(/Z(\d+\.?\d*)/.exec(ultimo)![1]);
  assert.ok(Math.abs(zFinal - (30.2 - Math.hypot(30, 10) * Math.tan(Math.PI / 6))) < 1e-2, ultimo);
});

test("código final não é transformado, mesmo com comentário depois do marcador", () => {
  const g = "G90\nM83\n;LAYER_CHANGE\nG1 Z30\n;TYPE:Perimeter\nG1 X30 Y0 E1\n;TYPE:Custom\n; end gcode\nG1 X0 Y200 Z50";
  const r = retransformarGcode(g, { mapa: criarMapeamento(30, 0, 40), deslocamentoZ: 0, centro: [0, 0] });
  assert.ok(r.gcode.split("\n").includes("G1 X0 Y200 Z50"));
});

test("extrusão abaixo da mesa é recusada", () => {
  const g = "G90\nM83\n;LAYER_CHANGE\nG1 Z0.2\nG1 X40 Y0\nG1 X40 Y5 E0.5 F1800";
  assert.throws(() => retransformarGcode(g, { mapa: criarMapeamento(30, 0, 30), deslocamentoZ: 0, centro: [0, 0] }), /abaixo da mesa/);
});

test("deslocamento abaixo da mesa é elevado, sem raspar", () => {
  const g = "G90\nM83\nG1 X0 Y0 Z5\n;LAYER_CHANGE\nG1 Z0.2\nG1 X40 Y0";
  const r = retransformarGcode(g, { mapa: criarMapeamento(30, 0, 30), deslocamentoZ: 0, centro: [0, 0] });
  const transformados = movimentos(r.gcode).slice(1); // a primeira linha é do código inicial
  assert.ok(transformados.length > 30);
  for (const l of transformados) assert.ok(Number(/Z([\d.]+)/.exec(l)![1]) >= 0.2, l);
  assert.ok(r.avisos.some((a) => a.includes("elevados")));
});

test("primeiro movimento depois de uma macro inicial não sai da origem nem desce o bico", () => {
  // Estrutura real do OrcaSlicer com PRINT_START: X e Y vêm antes de qualquer Z.
  const g = "PRINT_START\nG90\nM83\n;LAYER_CHANGE\nG92 E0\nG1 E-1.2 F2400\nG1 X97.688 Y111.171 F18000\nG1 Z.6\nG1 Z.2\nG1 E1.2\nG1 X97.497 Y111.073 E.00829";
  const r = retransformarGcode(g, { mapa: criarMapeamento(30, 1, 40), deslocamentoZ: 0, centro: [110, 110] });
  const linhas = r.gcode.split("\n");
  assert.ok(linhas.includes("G1 X97.688 Y111.171 F18000"), "deslocamento inicial deve ser copiado");
  assert.ok(linhas.includes("G1 Z.6"), "subida inicial deve ser copiada");
  assert.deepEqual(r.avisos, []);
  for (const l of movimentos(r.gcode)) assert.ok(Number(/X([\d.]+)/.exec(l)![1]) > 90, `perto da origem: ${l}`);
});

test("arcos são recusados com mensagem clara", () => {
  const m = criarMapeamento(20, 0, 10);
  assert.throws(() => retransformarGcode(";LAYER_CHANGE\nG1 X1 Y1 E1\nG2 X5 Y5 I1 J1 E1", { mapa: m, deslocamentoZ: 0, centro: [0, 0] }), /Arc fitting/);
});
