// Transformação cônica: o núcleo do fatiamento não planar.
//
// Ideia (técnica aberta de "conical slicing"):
//   1. Deformar a malha: z' = z + r·tan(θ), onde r é a distância horizontal até o eixo do cone.
//   2. Fatiar a malha deformada normalmente (camadas planas) no OrcaSlicer ou PrusaSlicer.
//   3. Desfazer a deformação no G-code: z = z' − r·tan(θ).
// Cada camada plana do passo 2 vira uma superfície cônica na peça real.
//
// θ > 0: as camadas descem para fora (cone invertido). Bom para balanços que abrem para fora,
//        como um funil ou um cogumelo, que no fatiamento plano precisariam de suporte.
// θ < 0: as camadas sobem para fora (cone normal). Bom para balanços que fecham para dentro.

import type { Triangulo, Vec3 } from "./stl.ts";
import { caixa } from "./stl.ts";
import { criarCampo, transicaoAutomatica, validarSuperficie, type Ancora, type Campo, type Superficie, type Validacao } from "./superficie.ts";

export interface ParametrosCone {
  /** Ângulo do cone em graus. */
  anguloGraus: number;
  /** Eixo do cone, em coordenadas do modelo. */
  centro: [number, number];
}

export interface ResultadoDeformacao {
  triangulos: Triangulo[];
  /** Deslocamento em Z aplicado para a malha deformada encostar na mesa (z mínimo = 0). */
  deslocamentoZ: number;
  /** Centro do cone em relação ao centro da caixa XY do modelo. */
  centroRelativo: [number, number];
  mapa: Mapeamento;
}

export function tanAngulo(graus: number): number {
  return Math.tan((graus * Math.PI) / 180);
}

/** Divide triângulos até nenhuma aresta passar de `maxAresta` mm, para a deformação ficar suave. */
export function subdividir(tris: Triangulo[], maxAresta: number): Triangulo[] {
  const saida: Triangulo[] = [];
  const pilha = [...tris];
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const meio = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  while (pilha.length) {
    const t = pilha.pop()!;
    const [a, b, c] = t;
    const ab = d(a, b), bc = d(b, c), ca = d(c, a);
    const maior = Math.max(ab, bc, ca);
    if (maior <= maxAresta) { saida.push(t); continue; }
    // Divide a maior aresta ao meio. Dividir sempre a maior evita rachaduras entre triângulos
    // vizinhos, porque os dois lados de uma aresta compartilhada escolhem o mesmo ponto médio.
    if (maior === ab) { const m = meio(a, b); pilha.push([a, m, c], [m, b, c]); }
    else if (maior === bc) { const m = meio(b, c); pilha.push([a, b, m], [a, m, c]); }
    else { const m = meio(c, a); pilha.push([a, b, m], [m, b, c]); }
  }
  return saida;
}

/**
 * Mapeamento entre a peça real (z) e a malha deformada (z'), por coluna de raio r.
 *
 * Sem base: z' = z + r·tan(θ).
 * Com base plana de altura b: abaixo de b nada muda; entre b e b+T a deformação cresce
 * linearmente; acima de b+T vale a fórmula completa. Assim as primeiras camadas ficam planas
 * e grudam bem na mesa. T é escolhido para z' continuar crescente em z (camadas não se cruzam).
 */
export interface Mapeamento {
  tan: number;
  base: number;
  transicao: number;
}

export function criarMapeamento(anguloGraus: number, base: number, raioMaximo: number): Mapeamento {
  const tan = tanAngulo(anguloGraus);
  // Para θ < 0 a transição precisa ser mais longa que r·|tan| em todo raio, senão z' deixaria
  // de crescer com z. Usamos o dobro para ter folga. Para θ > 0 não há esse risco, mas uma
  // transição curta demais afina as camadas (ver espessuraRelativa): com T = r·tan, a camada
  // na borda da peça chega à metade da altura configurada.
  const folga = tan < 0 ? 2 : 1;
  const transicao = base > 0 ? Math.max(folga * raioMaximo * Math.abs(tan), 1) : 0;
  return { tan, base, transicao };
}

/**
 * Espessura real da camada (na vertical) em relação à altura configurada no fatiador.
 * Fora da transição vale 1. Dentro dela, z = (zl + k·b/T) / (1 + k/T), logo dz/dzl = 1 / (1 + k/T).
 */
export function espessuraRelativa(m: Mapeamento, r: number, zl: number): number {
  if (m.base <= 0 || zl <= m.base) return 1;
  const k = r * m.tan;
  if (zl >= m.base + m.transicao + k) return 1;
  return 1 / (1 + k / m.transicao);
}

export function paraDeformado(m: Mapeamento, r: number, z: number): number {
  if (m.base <= 0) return z + r * m.tan;
  if (z <= m.base) return z;
  const s = Math.min(1, (z - m.base) / m.transicao);
  return z + r * m.tan * s;
}

export function paraReal(m: Mapeamento, r: number, zl: number): number {
  if (m.base <= 0) return zl - r * m.tan;
  if (zl <= m.base) return zl;
  const k = r * m.tan;
  const limite = m.base + m.transicao + k; // z' no fim da transição
  if (zl >= limite) return zl - k;
  // zl = z + k·(z − b)/T  →  z = (zl + k·b/T) / (1 + k/T)
  return (zl + (k * m.base) / m.transicao) / (1 + k / m.transicao);
}

export function deformarMalha(
  trisOriginais: Triangulo[],
  anguloGraus: number,
  opcoes: { maxAresta?: number; centro?: [number, number]; base?: number } = {},
): ResultadoDeformacao {
  const { min, max } = caixa(trisOriginais);
  const meioX = (min[0] + max[0]) / 2, meioY = (min[1] + max[1]) / 2;
  const centro = opcoes.centro ?? [meioX, meioY];
  let raioMaximo = 0;
  for (const t of trisOriginais)
    for (const [x, y] of t) raioMaximo = Math.max(raioMaximo, Math.hypot(x - centro[0], y - centro[1]));
  const mapa = criarMapeamento(anguloGraus, opcoes.base ?? 0, raioMaximo);
  const tris = subdividir(trisOriginais, opcoes.maxAresta ?? 1);
  let zMin = Infinity;
  const deformados = tris.map((t) =>
    t.map(([x, y, z]) => {
      const r = Math.hypot(x - centro[0], y - centro[1]);
      const zn = paraDeformado(mapa, r, z - min[2]);
      if (zn < zMin) zMin = zn;
      return [x, y, zn] as Vec3;
    }) as Triangulo,
  );
  for (const t of deformados) for (const v of t) v[2] -= zMin;
  return {
    triangulos: deformados,
    deslocamentoZ: zMin,
    centroRelativo: [centro[0] - meioX, centro[1] - meioY],
    mapa,
  };
}

/** O mapeamento cônico antigo no formato de campo usado pelo retransformar. */
export function campoDoMapeamento(m: Mapeamento): Campo {
  return {
    paraDeformado: (dx, dy, z) => paraDeformado(m, Math.hypot(dx, dy), z),
    paraReal: (dx, dy, zl) => paraReal(m, Math.hypot(dx, dy), zl),
    espessura: (dx, dy, zl) => espessuraRelativa(m, Math.hypot(dx, dy), zl),
  };
}

export interface ResultadoSuperficie {
  triangulos: Triangulo[];
  deslocamentoZ: number;
  centroRelativo: [number, number];
  superficie: Superficie;
  validacao: Validacao;
}

/** Pontos (dx, dy) da peça em volta do eixo, para escolher a transição e validar a superfície. */
export function amostrasDaPeca(tris: Triangulo[], centro: [number, number], max = 4000): [number, number][] {
  const todos: [number, number][] = [];
  const vistos = new Set<string>();
  for (const t of tris)
    for (const [x, y] of t) {
      const k = `${Math.round(x * 2)},${Math.round(y * 2)}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      todos.push([x - centro[0], y - centro[1]]);
    }
  if (todos.length <= max) return todos;
  const passo = todos.length / max;
  return Array.from({ length: max }, (_, i) => todos[Math.floor(i * passo)]);
}

/**
 * Deforma a malha com uma superfície (formas e âncoras por altura). Com uma âncora de cone,
 * dá o mesmo resultado que `deformarMalha`.
 */
export function deformarComSuperficie(
  trisOriginais: Triangulo[],
  ancoras: Ancora[],
  opcoes: { maxAresta?: number; centro?: [number, number]; base?: number; transicao?: number } = {},
): ResultadoSuperficie {
  if (ancoras.length === 0) throw new Error("Informe pelo menos uma âncora.");
  const { min, max } = caixa(trisOriginais);
  const meioX = (min[0] + max[0]) / 2, meioY = (min[1] + max[1]) / 2;
  const centro = opcoes.centro ?? [meioX, meioY];
  let raioPeca = 0;
  for (const t of trisOriginais)
    for (const [x, y] of t) raioPeca = Math.max(raioPeca, Math.hypot(x - centro[0], y - centro[1]));
  const amostras = amostrasDaPeca(trisOriginais, centro);
  const base = opcoes.base ?? 0;
  const primeira = [...ancoras].sort((a, b) => a.z - b.z)[0];
  const transicao = base > 0 ? (opcoes.transicao ?? transicaoAutomatica(primeira, raioPeca, amostras)) : 0;
  const superficie: Superficie = { versao: 2, ancoras, base, transicao, raioPeca };
  const validacao = validarSuperficie(superficie, amostras, max[2] - min[2]);
  if (!validacao.ok) throw new Error(validacao.problema);
  const campo = criarCampo(superficie);
  const tris = subdividir(trisOriginais, opcoes.maxAresta ?? 1);
  let zMin = Infinity;
  const deformados = tris.map((t) =>
    t.map(([x, y, z]) => {
      const zn = campo.paraDeformado(x - centro[0], y - centro[1], z - min[2]);
      if (zn < zMin) zMin = zn;
      return [x, y, zn] as Vec3;
    }) as Triangulo,
  );
  for (const t of deformados) for (const v of t) v[2] -= zMin;
  return { triangulos: deformados, deslocamentoZ: zMin, centroRelativo: [centro[0] - meioX, centro[1] - meioY], superficie, validacao };
}
