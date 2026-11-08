// Superfícies de camada: generaliza o cone com as ideias do fatiamento por blocos.
//
// Cada camada é uma translação vertical de uma superfície H(x, y): a camada que o fatiador vê no
// plano z' corresponde, na peça real, aos pontos com z' = z + H(x, y). Como todas as camadas são
// a mesma superfície deslocada, camadas vizinhas nunca se cruzam.
//
// Formas (β = ângulo, (u, v) = coordenadas giradas pela direção, r = raio até o eixo):
//   cone       H = r·tan β
//   pirâmide   H = max(|u|, |v|)·tan β       (r·max(|cos|, |sen|): nunca mais íngreme que o cone)
//   cunha      H = |u|·tan β                  (dobra ao longo de uma reta)
//   inclinado  H = u·tan β                    (plano inclinado)
//   calota     esfera de raio R = rc/sen β até o raio rc, depois cone tangente
//
// Âncoras por altura: cada âncora vale a partir de uma altura da peça real. Entre duas âncoras
// não se interpola o ângulo, e sim o efeito: H = (1 − w)·H_j + w·H_j+1. Interpolar o ângulo
// camada a camada faz camadas vizinhas se cortarem. A mistura de alturas só é segura se a
// derivada de z' em z continuar positiva, e `validarSuperficie` confere isso.
//
// Base plana: abaixo de `base` mm nada muda, para a peça grudar na mesa. Entre `base` e
// `base + transicao` a deformação cresce linearmente até a superfície completa.
//
// Este arquivo não usa nada do Node, porque a interface no navegador também o importa.

export type Forma = "cone" | "piramide" | "cunha" | "inclinado" | "calota";

export const FORMAS: Forma[] = ["cone", "piramide", "cunha", "inclinado", "calota"];

export interface Ancora {
  /** Altura na peça real, em mm a partir da base do modelo, onde esta âncora vale inteira. */
  z: number;
  forma: Forma;
  /** Ângulo em graus. Positivo: as camadas descem para fora (balanços para fora). */
  angulo: number;
  /** Direção em graus no plano XY, para pirâmide, cunha e inclinado. */
  direcao?: number;
  /** Raio da parte esférica da calota, em mm (padrão: raio da peça). */
  raioCalota?: number;
}

export interface Superficie {
  versao: 2;
  ancoras: Ancora[];
  /** Altura das camadas planas na base, em mm. */
  base: number;
  /** Altura da transição da base plana até a superfície completa, em mm. */
  transicao: number;
  /** Maior raio da peça em volta do eixo, usado pela calota sem raio próprio. */
  raioPeca: number;
}

/** Relação entre a peça real (z) e a malha deformada (z'), em coordenadas relativas ao eixo. */
export interface Campo {
  paraDeformado(dx: number, dy: number, z: number): number;
  paraReal(dx: number, dy: number, zl: number): number;
  /** Espessura real da camada em relação à configurada no fatiador (dz/dz'). */
  espessura(dx: number, dy: number, zl: number): number;
}

const RAD = Math.PI / 180;

/** Altura H de uma âncora no ponto (dx, dy) relativo ao eixo. */
export function alturaDaAncora(a: Ancora, dx: number, dy: number, raioPeca: number): number {
  const t = Math.tan(a.angulo * RAD);
  const d = (a.direcao ?? 0) * RAD;
  const u = dx * Math.cos(d) + dy * Math.sin(d);
  const v = -dx * Math.sin(d) + dy * Math.cos(d);
  switch (a.forma) {
    case "cone": return Math.hypot(dx, dy) * t;
    case "piramide": return Math.max(Math.abs(u), Math.abs(v)) * t;
    case "cunha": return Math.abs(u) * t;
    case "inclinado": return u * t;
    case "calota": {
      const r = Math.hypot(dx, dy);
      const s = Math.sin(Math.abs(a.angulo) * RAD);
      if (s < 1e-9) return 0;
      const rc = Math.max(a.raioCalota ?? raioPeca, 1e-6);
      const R = rc / s;
      const dentro = Math.min(r, rc);
      const h = R - Math.sqrt(Math.max(R * R - dentro * dentro, 0)) + Math.max(r - rc, 0) * Math.abs(t);
      return Math.sign(a.angulo) * h;
    }
  }
}

function ordenadas(sup: Superficie): Ancora[] {
  if (sup.ancoras.length === 0) throw new Error("A superfície precisa de pelo menos uma âncora.");
  return [...sup.ancoras].sort((a, b) => a.z - b.z);
}

export function criarCampo(sup: Superficie): Campo {
  const ancoras = ordenadas(sup);
  const H = (dx: number, dy: number, z: number): number => {
    if (ancoras.length === 1 || z <= ancoras[0].z) return alturaDaAncora(ancoras[0], dx, dy, sup.raioPeca);
    const ult = ancoras[ancoras.length - 1];
    if (z >= ult.z) return alturaDaAncora(ult, dx, dy, sup.raioPeca);
    let j = 0;
    while (ancoras[j + 1].z < z) j++;
    const a = ancoras[j], b = ancoras[j + 1];
    const w = (z - a.z) / (b.z - a.z);
    return (1 - w) * alturaDaAncora(a, dx, dy, sup.raioPeca) + w * alturaDaAncora(b, dx, dy, sup.raioPeca);
  };
  const s = (z: number) => {
    if (sup.base <= 0) return 1;
    if (z <= sup.base) return 0;
    return sup.transicao > 0 ? Math.min(1, (z - sup.base) / sup.transicao) : 1;
  };
  const phi = (dx: number, dy: number, z: number) => z + s(z) * H(dx, dy, z);
  // Limite de |H| no ponto, para cercar a raiz da inversa.
  const limiteH = (dx: number, dy: number) => {
    let m = 0;
    for (const a of ancoras) m = Math.max(m, Math.abs(alturaDaAncora(a, dx, dy, sup.raioPeca)));
    return m;
  };
  const paraReal = (dx: number, dy: number, zl: number) => {
    // φ é crescente em z (ver validarSuperficie), então a bisseção sempre converge.
    const m = limiteH(dx, dy) + 1;
    let lo = zl - m, hi = zl + m;
    for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
      const meio = (lo + hi) / 2;
      if (phi(dx, dy, meio) < zl) lo = meio; else hi = meio;
    }
    return (lo + hi) / 2;
  };
  return {
    paraDeformado: phi,
    paraReal,
    espessura(dx, dy, zl) {
      const z = paraReal(dx, dy, zl);
      const d = 1e-3;
      const derivada = (phi(dx, dy, z + d) - phi(dx, dy, z - d)) / (2 * d);
      return derivada > 0 ? 1 / derivada : 1;
    },
  };
}

/**
 * Escolhe a transição da base para as camadas não ficarem mais finas que metade nem mais
 * grossas que o dobro da altura configurada: z' = z + H·(z − base)/T tem derivada 1 + H/T,
 * que fica em [0,5; 2] com T ≥ H máximo e T ≥ 2·|H mínimo|.
 */
export function transicaoAutomatica(primeira: Ancora, raioPeca: number, amostrasXY: [number, number][]): number {
  let maxPos = 0, maxNeg = 0;
  for (const [dx, dy] of amostrasXY) {
    if (Math.hypot(dx, dy) > raioPeca + 1e-9) continue;
    const h = alturaDaAncora(primeira, dx, dy, raioPeca);
    if (h > maxPos) maxPos = h;
    if (-h > maxNeg) maxNeg = -h;
  }
  return Math.max(1, maxPos, 2 * maxNeg);
}

export interface Validacao {
  ok: boolean;
  /** Menor e maior espessura relativa encontradas (1 = altura configurada). */
  espessuraMin: number;
  espessuraMax: number;
  /** Mensagem em português (linha de comando). */
  problema?: string;
  /** Código e valores do problema, para a interface traduzir. */
  codigo?: "cruzam" | "grossas" | "finas";
  valores?: Record<string, number>;
}

/**
 * Confere, numa grade de pontos da peça, se as camadas reais ficam entre metade e o dobro da
 * altura configurada. Fora disso a mistura entre âncoras está rápida demais (camadas quase se
 * tocando ou grossas demais para o bico).
 */
export function validarSuperficie(sup: Superficie, amostrasXY: [number, number][], alturaPeca: number): Validacao {
  const campo = criarCampo(sup);
  let eMin = Infinity, eMax = -Infinity, pior: [number, number, number] = [0, 0, 0];
  const passo = Math.max(alturaPeca / 200, 0.05);
  for (const [dx, dy] of amostrasXY) {
    let anterior = campo.paraDeformado(dx, dy, 0);
    for (let z = passo; z <= alturaPeca + 1e-9; z += passo) {
      const atual = campo.paraDeformado(dx, dy, z);
      const derivada = (atual - anterior) / passo;
      const e = derivada > 0 ? 1 / derivada : Infinity;
      if (e < eMin) eMin = e;
      if (e > eMax) { eMax = e; if (e > 2) pior = [dx, dy, z]; }
      if (e < 0.5 && eMin === e) pior = [dx, dy, z];
      anterior = atual;
    }
  }
  const tol = 0.02;
  if (eMax > 2 + tol)
    return {
      ok: false, espessuraMin: eMin, espessuraMax: eMax,
      codigo: eMax === Infinity ? "cruzam" : "grossas",
      valores: { x: pior[0], y: pior[1], z: pior[2], vezes: eMax },
      problema: eMax === Infinity
        ? `As camadas se cruzam perto de X${pior[0].toFixed(1)} Y${pior[1].toFixed(1)} Z${pior[2].toFixed(1)}. Afaste as âncoras na altura ou reduza a diferença de ângulo entre elas.`
        : `As camadas ficam ${eMax.toFixed(1)}× mais grossas que o configurado perto de Z${pior[2].toFixed(1)}. Afaste as âncoras na altura ou reduza a diferença de ângulo entre elas.`,
    };
  if (eMin < 0.5 - tol)
    return {
      ok: false, espessuraMin: eMin, espessuraMax: eMax,
      codigo: "finas",
      valores: { z: pior[2], porcento: eMin * 100 },
      problema: `As camadas ficam com ${(eMin * 100).toFixed(0)}% da altura configurada perto de Z${pior[2].toFixed(1)}. Afaste as âncoras na altura ou reduza a diferença de ângulo entre elas.`,
    };
  return { ok: true, espessuraMin: eMin, espessuraMax: eMax };
}

/** Superfície equivalente ao mapeamento cônico antigo (conico.ts), para arquivos da versão 1. */
export function superficieDoCone(tan: number, base: number, transicao: number, raioPeca = 0): Superficie {
  return { versao: 2, ancoras: [{ z: 0, forma: "cone", angulo: Math.atan(tan) / RAD }], base, transicao, raioPeca };
}
