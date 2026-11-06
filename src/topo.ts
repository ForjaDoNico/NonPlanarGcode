// Modo de topo liso: a última camada de topo segue a superfície real da peça.
//
// Com camadas cônicas, um topo plano (ou qualquer topo que não seja um cone igual ao das camadas)
// sai em degraus: cada camada cônica corta a superfície numa faixa estreita, e o topo fica com
// degraus de uma altura de camada. Aqui, cada ponto de extrusão do topo que está a menos de uma
// camada abaixo da superfície real sobe até ela, e a extrusão cresce na mesma proporção para
// preencher a camada mais grossa.
//
// A superfície vem do STL original, como um mapa de alturas: o maior Z da malha em cada célula.

import type { Triangulo } from "./stl.ts";
import { caixa } from "./stl.ts";

export interface MapaTopo {
  /** Altura da superfície de cima em (x, y), em coordenadas do modelo, ou null fora da peça. */
  altura(x: number, y: number): number | null;
  /** Centro da caixa XY do modelo, para converter de coordenadas da mesa. */
  centro: [number, number];
  /** Z mínimo do modelo (as alturas são relativas a ele). */
  zMin: number;
}

export function criarMapaTopo(tris: Triangulo[], celula = 0.25): MapaTopo {
  const { min, max } = caixa(tris);
  const larg = Math.ceil((max[0] - min[0]) / celula) + 1;
  const alt = Math.ceil((max[1] - min[1]) / celula) + 1;
  const mapa = new Float32Array(larg * alt).fill(-Infinity);

  for (const [a, b, c] of tris) {
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue; // triângulo vertical: não define altura
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - min[0]) / celula));
    const i1 = Math.min(larg - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - min[0]) / celula));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - min[1]) / celula));
    const j1 = Math.min(alt - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - min[1]) / celula));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = min[0] + i * celula, y = min[1] + j * celula;
        const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
        const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
        const l3 = 1 - l1 - l2;
        const eps = -1e-6;
        if (l1 < eps || l2 < eps || l3 < eps) continue;
        const z = l1 * a[2] + l2 * b[2] + l3 * c[2] - min[2];
        const k = j * larg + i;
        if (z > mapa[k]) mapa[k] = z;
      }
  }

  return {
    centro: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2],
    zMin: min[2],
    altura(x, y) {
      // Interpolação bilinear entre as quatro células vizinhas; fora da peça devolve null.
      const fx = (x - min[0]) / celula, fy = (y - min[1]) / celula;
      const i = Math.floor(fx), j = Math.floor(fy);
      if (i < 0 || j < 0 || i + 1 >= larg || j + 1 >= alt) return null;
      const v00 = mapa[j * larg + i], v10 = mapa[j * larg + i + 1];
      const v01 = mapa[(j + 1) * larg + i], v11 = mapa[(j + 1) * larg + i + 1];
      if (![v00, v10, v01, v11].every(Number.isFinite)) return null;
      const tx = fx - i, ty = fy - j;
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    },
  };
}

/** Tipos de trecho do topo: PrusaSlicer "Top solid infill", OrcaSlicer/Bambu "Top surface", e passar ferro. */
export function ehTrechoDeTopo(tipo: string): boolean {
  return /^(top solid infill|top surface|ironing)/i.test(tipo);
}

/** Lê a altura de camada do bloco de configuração que o OrcaSlicer e o PrusaSlicer gravam no G-code. */
export function alturaDeCamada(gcode: string): number | null {
  const m = /^;\s*layer_height\s*=\s*([\d.]+)/m.exec(gcode);
  return m ? Number(m[1]) : null;
}
