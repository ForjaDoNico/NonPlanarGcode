// Gera um modelo de teste: haste cilíndrica com um funil que abre para fora a 50° da vertical.
// No fatiamento plano esse balanço precisa de suporte. Com camadas cônicas de ~30°, não.
import { escreverStl, type Triangulo, type Vec3 } from "../src/stl.ts";

const saida = process.argv[2] ?? "funil.stl";
const N = 96;
// Perfil (raio, z) de baixo para cima.
const perfil: [number, number][] = [[6, 0], [6, 8], [30, 28]];
const tris: Triangulo[] = [];
const ponto = (r: number, z: number, i: number): Vec3 => {
  const a = (2 * Math.PI * i) / N;
  return [r * Math.cos(a), r * Math.sin(a), z];
};
for (let i = 0; i < N; i++) {
  for (let k = 0; k < perfil.length - 1; k++) {
    const [r0, z0] = perfil[k], [r1, z1] = perfil[k + 1];
    const a = ponto(r0, z0, i), b = ponto(r0, z0, i + 1), c = ponto(r1, z1, i + 1), d = ponto(r1, z1, i);
    tris.push([a, b, c], [a, c, d]);
  }
  const [rb, zb] = perfil[0], [rt, zt] = perfil[perfil.length - 1];
  tris.push([[0, 0, zb], ponto(rb, zb, i + 1), ponto(rb, zb, i)]);
  tris.push([[0, 0, zt], ponto(rt, zt, i), ponto(rt, zt, i + 1)]);
}
escreverStl(saida, tris);
console.log(`${saida}: ${tris.length} triângulos`);
