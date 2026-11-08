import { test } from "node:test";
import assert from "node:assert/strict";
import { criarMapaTopo, alturaDeCamada, ehTrechoDeTopo } from "../src/topo.ts";
import { criarMapeamento } from "../src/conico.ts";
import { retransformarGcode } from "../src/gcode.ts";
import type { Triangulo, Vec3 } from "../src/stl.ts";

/** Caixa de 20 × 20 com topo inclinado: z = 10 + 0,1·x (x de 0 a 20). */
function caixaInclinada(): Triangulo[] {
  const zt = (x: number) => 10 + 0.1 * x;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  return [
    [v(0, 0, zt(0)), v(20, 0, zt(20)), v(20, 20, zt(20))], [v(0, 0, zt(0)), v(20, 20, zt(20)), v(0, 20, zt(0))], // topo
    [v(0, 0, 0), v(20, 20, 0), v(20, 0, 0)], [v(0, 0, 0), v(0, 20, 0), v(20, 20, 0)], // base
    [v(0, 0, 0), v(20, 0, 0), v(20, 0, zt(20))], [v(0, 0, 0), v(20, 0, zt(20)), v(0, 0, zt(0))], // lateral vertical (ignorada)
  ];
}

test("mapa de topo devolve a superfície de cima, e null fora da peça", () => {
  const m = criarMapaTopo(caixaInclinada());
  assert.ok(Math.abs(m.altura(5, 5)! - 10.5) < 0.02);
  assert.ok(Math.abs(m.altura(15, 10)! - 11.5) < 0.02);
  assert.equal(m.altura(30, 5), null);
  assert.deepEqual(m.centro, [10, 10]);
});

test("altura de camada e tipos de topo", () => {
  assert.equal(alturaDeCamada("G1 X1\n; layer_height = 0.2\n"), 0.2);
  assert.equal(alturaDeCamada("G1 X1"), null);
  assert.ok(ehTrechoDeTopo("Top solid infill") && ehTrechoDeTopo("Top surface") && ehTrechoDeTopo("Ironing"));
  assert.ok(!ehTrechoDeTopo("Internal solid infill"));
});

test("topo liso: ponto do topo a menos de uma camada sobe até a superfície, com mais extrusão", () => {
  const mapa = criarMapaTopo(caixaInclinada());
  // Sem cone (ângulo 0), a peça centrada na mesa em (100,100): o ponto (100,100) do G-code é o (10,10) do modelo,
  // onde a superfície está em 11,0. A camada em 10,9 fica a 0,1 mm dela; a camada em 10,6 fica a 0,4 mm.
  const g = [
    "G90", "M83", "G1 X90 Y90 Z5",
    ";LAYER_CHANGE", "G1 Z10.6", ";TYPE:Top solid infill", "G1 X95 Y100", "G1 X100 Y100 E1",
    ";LAYER_CHANGE", "G1 Z10.9", ";TYPE:Top solid infill", "G1 X95 Y100", "G1 X100 Y100 E1",
    "G1 X100 Y105", // deslocamento sobre o topo, onde a superfície também está em 11,0
  ].join("\n");
  const r = retransformarGcode(g, {
    mapa: criarMapeamento(0, 0, 10), deslocamentoZ: 0, centro: [100, 100], segmento: 10,
    topo: { mapa, alturaCamada: 0.2 }, cabecote: null,
  });
  const l = r.gcode.split("\n");
  assert.ok(l.includes("G1 X100 Y100 Z10.6 E1"), "a 0,4 mm do topo: não muda");
  const alto = l.find((x) => x.startsWith("G1 X100 Y100 Z11 "))!;
  assert.ok(alto, "a 0,1 mm do topo: sobe até 11");
  assert.ok(Math.abs(Number(/E([\d.]+)/.exec(alto)![1]) - 1.5) < 0.01, "camada 50% mais grossa, 50% mais extrusão");
  const desl = l.find((x) => x.startsWith("G1 X100 Y105"))!;
  assert.ok(Number(/Z([\d.]+)/.exec(desl)![1]) >= 11.05, "deslocamento passa por cima do topo");
  assert.ok(r.pontosDeTopoAjustados >= 1);
});
