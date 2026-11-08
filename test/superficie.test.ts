import { test } from "node:test";
import assert from "node:assert/strict";
import { alturaDaAncora, criarCampo, FORMAS, superficieDoCone, validarSuperficie, type Superficie } from "../src/superficie.ts";
import { criarMapeamento, deformarComSuperficie, deformarMalha, paraDeformado, paraReal } from "../src/conico.ts";
import { lerStl } from "../src/stl.ts";

const grade: [number, number][] = [];
for (let x = -30; x <= 30; x += 6) for (let y = -30; y <= 30; y += 6) grade.push([x, y]);

test("uma âncora de cone reproduz o mapeamento cônico antigo", () => {
  for (const ang of [-20, 15, 30]) {
    const m = criarMapeamento(ang, 1, 42);
    const campo = criarCampo(superficieDoCone(m.tan, m.base, m.transicao, 42));
    for (const [dx, dy] of grade) for (let z = 0; z < 30; z += 0.7) {
      const r = Math.hypot(dx, dy);
      assert.ok(Math.abs(campo.paraDeformado(dx, dy, z) - paraDeformado(m, r, z)) < 1e-9);
      const zl = paraDeformado(m, r, z);
      assert.ok(Math.abs(campo.paraReal(dx, dy, zl) - paraReal(m, r, zl)) < 1e-6);
    }
  }
});

test("ida e volta é a identidade em todas as formas", () => {
  for (const forma of FORMAS) for (const angulo of [-15, 20]) {
    const sup: Superficie = { versao: 2, ancoras: [{ z: 0, forma, angulo, direcao: 30 }], base: 1, transicao: 30, raioPeca: 42 };
    const campo = criarCampo(sup);
    for (const [dx, dy] of grade) for (let z = 0; z < 30; z += 1.3)
      assert.ok(Math.abs(campo.paraReal(dx, dy, campo.paraDeformado(dx, dy, z)) - z) < 1e-6, `${forma} ${angulo}`);
  }
});

test("nenhuma forma é mais íngreme que o cone", () => {
  for (const forma of FORMAS) {
    const a = { z: 0, forma, angulo: 25, direcao: 17 };
    for (const [dx, dy] of grade) {
      const d = 0.01;
      const gx = (alturaDaAncora(a, dx + d, dy, 42) - alturaDaAncora(a, dx - d, dy, 42)) / (2 * d);
      const gy = (alturaDaAncora(a, dx, dy + d, 42) - alturaDaAncora(a, dx, dy - d, 42)) / (2 * d);
      assert.ok(Math.hypot(gx, gy) <= Math.tan((25 * Math.PI) / 180) + 1e-3, `${forma} em ${dx},${dy}`);
    }
  }
});

test("âncoras por altura misturam a altura, e a validação recusa mudanças rápidas demais", () => {
  const lenta: Superficie = {
    versao: 2, base: 0, transicao: 0, raioPeca: 30,
    ancoras: [{ z: 0, forma: "cone", angulo: 0 }, { z: 40, forma: "cone", angulo: 15 }],
  };
  const v = validarSuperficie(lenta, grade, 50);
  assert.ok(v.ok, v.problema);
  const campo = criarCampo(lenta);
  // No meio, metade do efeito do cone de 15°.
  assert.ok(Math.abs(campo.paraDeformado(20, 0, 20) - (20 + 0.5 * 20 * Math.tan((15 * Math.PI) / 180))) < 1e-9);
  const rapida: Superficie = { ...lenta, ancoras: [{ z: 0, forma: "cone", angulo: 0 }, { z: 3, forma: "cone", angulo: -30 }] };
  const r = validarSuperficie(rapida, grade, 50);
  assert.equal(r.ok, false);
  assert.match(r.problema!, /âncoras/);
});

test("deformar com superfície de cone dá a mesma malha que o deformar antigo", () => {
  const tris = lerStl(new URL("../exemplos/funil.stl", import.meta.url).pathname);
  const antigo = deformarMalha(tris, 15, { base: 1 });
  const novo = deformarComSuperficie(tris, [{ z: 0, forma: "cone", angulo: 15 }], { base: 1 });
  assert.equal(novo.triangulos.length, antigo.triangulos.length);
  assert.ok(Math.abs(novo.superficie.transicao - antigo.mapa.transicao) < 1e-6);
  let maior = 0;
  for (let i = 0; i < antigo.triangulos.length; i += 97)
    for (let k = 0; k < 3; k++) maior = Math.max(maior, Math.abs(novo.triangulos[i][k][2] - antigo.triangulos[i][k][2]));
  assert.ok(maior < 1e-6, `diferença ${maior}`);
});
