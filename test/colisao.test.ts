import { test } from "node:test";
import assert from "node:assert/strict";
import { checarColisao, checarVelocidadeZ, type PontoTrajeto } from "../src/colisao.ts";

const cab = { folga: 5, raioCabeca: 20, raioBico: 1.5 };

/** Quadrado preenchido por linhas, na altura z. */
function camada(z: number, lado = 20, passo = 0.5): PontoTrajeto[] {
  const pts: PontoTrajeto[] = [];
  for (let y = 0; y <= lado; y += passo) for (let x = 0; x <= lado; x += passo) pts.push({ x, y, z, extrudindo: true });
  return pts;
}

test("camadas planas empilhadas nunca colidem", () => {
  const pts = [0.2, 0.4, 0.6, 0.8, 1.0].flatMap((z) => camada(z));
  const r = checarColisao(pts, cab);
  assert.equal(r.colisoes, 0);
  assert.ok(r.folgaNecessaria < 0.3, `folga ${r.folgaNecessaria}`);
});

test("parede alta perto do bico é colisão, com distância e invasão corretas", () => {
  const parede: PontoTrajeto[] = [];
  for (let z = 0.2; z <= 10; z += 0.2) parede.push({ x: 10, y: 0, z, extrudindo: true });
  const bico: PontoTrajeto = { x: 0, y: 0, z: 2, extrudindo: false };
  const r = checarColisao([...parede, bico], cab);
  assert.equal(r.colisoes, 1);
  assert.ok(Math.abs(r.primeira!.distancia - 10) < 0.01);
  assert.ok(Math.abs(r.primeira!.invasao - (10 - 2 - 5)) < 0.05);
  assert.ok(Math.abs(r.folgaNecessaria - 8) < 0.05);
});

test("material fora do raio do cabeçote não conta", () => {
  const parede: PontoTrajeto[] = [{ x: 25, y: 0, z: 30, extrudindo: true }];
  const r = checarColisao([...parede, { x: 0, y: 0, z: 1, extrudindo: true }], cab);
  assert.equal(r.colisoes, 0);
});

test("material colado ao bico é ignorado (o bico alisa o vizinho)", () => {
  const r = checarColisao([{ x: 1, y: 0, z: 9, extrudindo: true }, { x: 0, y: 0, z: 1, extrudindo: true }], cab);
  assert.equal(r.colisoes, 0);
});

test("camada cônica: folga necessária cresce com o ângulo", () => {
  // Cone invertido de raio 20 em volta de (20,20): z = h − r·tan θ. O material de dentro fica mais alto.
  const folga = (graus: number) => {
    const tan = Math.tan((graus * Math.PI) / 180);
    const pts: PontoTrajeto[] = [];
    for (let h = 0.2; h <= 4; h += 0.2)
      for (let r = 0; r <= 20; r += 0.5)
        for (let a = 0; a < 360; a += 10) {
          const z = 10 + h - r * tan;
          pts.push({ x: 20 + r * Math.cos((a * Math.PI) / 180), y: 20 + r * Math.sin((a * Math.PI) / 180), z, extrudindo: true });
        }
    return checarColisao(pts, { folga: 100, raioCabeca: 20, raioBico: 1.5 }).folgaNecessaria;
  };
  const f10 = folga(10), f30 = folga(30);
  // Até 20 mm para dentro, o material sobe 20·tan θ (menos a espessura das camadas).
  assert.ok(f10 > 2.5 && f10 < 3.8, `10°: ${f10}`);
  assert.ok(f30 > 10 && f30 < 11.6, `30°: ${f30}`);
});

test("velocidade de Z: avisa só os segmentos acima do limite", () => {
  const r = checarVelocidadeZ(
    [
      { dxy: 1, dz: 0, f: 6000 },       // plano
      { dxy: 1, dz: 0.05, f: 6000 },    // ~5 mm/s
      { dxy: 1, dz: 0.5, f: 6000 },     // ~45 mm/s
    ],
    10,
  );
  assert.equal(r.segmentosLimitados, 1);
  assert.ok(r.maiorVelocidadeZ > 40 && r.maiorVelocidadeZ < 50);
});

import { folgaDoStl } from "../src/cabecote.ts";
import type { Triangulo } from "../src/stl.ts";

test("formato do cabeçote: saída só de um lado libera o outro", () => {
  // Placa horizontal de 10 × 10 mm, 3 mm acima da ponta do bico, entre x = 5 e 15 (só do lado +X).
  const placa: Triangulo[] = [[[5, -5, 3], [15, -5, 3], [15, 5, 3]], [[5, -5, 3], [15, 5, 3], [5, 5, 3]]];
  const formato = folgaDoStl(placa, [0, 0, 0]);
  assert.ok(Math.abs(formato.em(10, 0)! - 3) < 1e-9);
  assert.equal(formato.em(-10, 0), null);
  const cab = { folga: 20, raioCabeca: 20, raioBico: 1.5, formato };
  const parede = (x: number): PontoTrajeto[] => [{ x, y: 0, z: 5, extrudindo: true }, { x: 0, y: 0, z: 0.5, extrudindo: false }];
  assert.equal(checarColisao(parede(10), cab).colisoes, 1, "material 4,5 mm acima, sob a placa de 3 mm: bate");
  assert.equal(checarColisao(parede(-10), cab).colisoes, 0, "do outro lado não há cabeçote baixo");
});
