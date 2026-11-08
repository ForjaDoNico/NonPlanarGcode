// Formato real do cabeçote a partir de um STL (por exemplo, o duto do fan).
//
// A checagem de colisão padrão trata o cabeçote como um disco plano a `folga` mm acima da ponta
// do bico. Com o STL, cada ponto em volta do bico tem a sua própria folga: a altura da parte mais
// baixa do cabeçote naquele ponto, medida a partir da ponta do bico. Um duto com saídas só dos
// lados libera bem mais ângulo na frente e atrás.

import type { Triangulo } from "./stl.ts";

export interface FolgaDoCabecote {
  /** Folga em mm no deslocamento (dx, dy) a partir do bico, ou null se o STL não tem nada ali. */
  em(dx: number, dy: number): number | null;
}

/**
 * Monta o mapa de folgas. `bico` é a posição da ponta do bico nas coordenadas do STL, que precisa
 * estar com Z para cima, na mesma orientação em que está montado na impressora.
 */
export function folgaDoStl(tris: Triangulo[], bico: [number, number, number], celula = 0.5): FolgaDoCabecote {
  const mapa = new Map<number, number>();
  const chave = (i: number, j: number) => i * 100003 + j;
  const registrar = (i: number, j: number, z: number) => {
    const k = chave(i, j), atual = mapa.get(k);
    if (atual === undefined || z < atual) mapa.set(k, z);
  };
  for (const [a, b, c] of tris) {
    // Pontos de amostra dentro do triângulo, em passos menores que a célula, para não deixar buracos.
    const lado = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
    const n = Math.max(1, Math.ceil(lado / (celula / 2)));
    for (let s = 0; s <= n; s++)
      for (let t = 0; s + t <= n; t++) {
        const u = s / n, v = t / n, w = 1 - u - v;
        const x = w * a[0] + u * b[0] + v * c[0], y = w * a[1] + u * b[1] + v * c[1], z = w * a[2] + u * b[2] + v * c[2];
        registrar(Math.round((x - bico[0]) / celula), Math.round((y - bico[1]) / celula), z - bico[2]);
      }
  }
  return {
    em(dx, dy) {
      const v = mapa.get(chave(Math.round(dx / celula), Math.round(dy / celula)));
      return v === undefined ? null : v;
    },
  };
}
