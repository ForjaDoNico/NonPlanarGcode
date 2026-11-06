// Checagem de colisão do cabeçote e da velocidade do eixo Z no G-code já transformado.
//
// Modelo do cabeçote (visto de lado):
//
//          ┌──────────── cabeçote ────────────┐   ← parte mais baixa, a `folga` mm acima da ponta
//          └───────────────┐  ┌───────────────┘
//                          │  │  bico
//                          └──┘  ← ponta (Z do G-code)
//          |←── raioCabeca ──→|
//
// O bico em si encosta no material vizinho de propósito (como num "ironing"), então tudo a menos
// de `raioBico` da ponta é ignorado. Fora disso, qualquer material já depositado que esteja mais
// alto que `ponta + folga` dentro de `raioCabeca` é uma colisão.
//
// Usa um mapa de alturas em grade: cada célula guarda a maior altura de material depositada nela.

export interface Cabecote {
  /** Altura livre entre a ponta do bico e a parte mais baixa do cabeçote, em mm. */
  folga: number;
  /** Distância horizontal máxima, a partir do bico, que o cabeçote ocupa, em mm. */
  raioCabeca: number;
  /** Raio em volta da ponta que é ignorado (o bico alisa o material vizinho), em mm. */
  raioBico: number;
}

export const CABECOTE_PADRAO: Cabecote = { folga: 5, raioCabeca: 30, raioBico: 1.5 };

export interface PontoTrajeto {
  x: number;
  y: number;
  z: number;
  extrudindo: boolean;
}

export interface Colisao {
  x: number;
  y: number;
  z: number;
  /** Quanto o material passa da parte mais baixa do cabeçote, em mm. */
  invasao: number;
  /** Distância horizontal entre o bico e o material que causa a colisão, em mm. */
  distancia: number;
}

export interface RelatorioColisao {
  colisoes: number;
  /** Primeira colisão, na ordem de impressão. */
  primeira: Colisao | null;
  /** Pior colisão. */
  pior: Colisao | null;
  /** Folga mínima que o cabeçote precisaria ter para imprimir este arquivo sem colisão, em mm. */
  folgaNecessaria: number;
}

const CELULA = 0.5;
// Tolerância para arredondamentos da grade e do G-code.
const TOLERANCIA = 0.05;

export function checarColisao(pontos: PontoTrajeto[], cab: Cabecote = CABECOTE_PADRAO): RelatorioColisao {
  const vazio: RelatorioColisao = { colisoes: 0, primeira: null, pior: null, folgaNecessaria: 0 };
  if (pontos.length === 0) return vazio;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pontos) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const larg = Math.ceil((maxX - minX) / CELULA) + 1;
  const alt = Math.ceil((maxY - minY) / CELULA) + 1;
  const mapa = new Float32Array(larg * alt).fill(-Infinity);

  // Deslocamentos de células dentro do anel entre raioBico e raioCabeca, com a distância de cada um.
  const raioCel = Math.ceil(cab.raioCabeca / CELULA);
  const vizinhos: { dx: number; dy: number; d: number }[] = [];
  for (let dy = -raioCel; dy <= raioCel; dy++)
    for (let dx = -raioCel; dx <= raioCel; dx++) {
      const d = Math.hypot(dx, dy) * CELULA;
      if (d > cab.raioBico && d <= cab.raioCabeca) vizinhos.push({ dx, dy, d });
    }

  let colisoes = 0, folgaNecessaria = 0;
  let primeira: Colisao | null = null, pior: Colisao | null = null;

  for (const p of pontos) {
    const cx = Math.round((p.x - minX) / CELULA), cy = Math.round((p.y - minY) / CELULA);
    let maiorAcima = -Infinity, distMaior = 0;
    for (const v of vizinhos) {
      const ix = cx + v.dx, iy = cy + v.dy;
      if (ix < 0 || iy < 0 || ix >= larg || iy >= alt) continue;
      const acima = mapa[iy * larg + ix] - p.z;
      if (acima > maiorAcima) { maiorAcima = acima; distMaior = v.d; }
    }
    if (maiorAcima > folgaNecessaria) folgaNecessaria = maiorAcima;
    const invasao = maiorAcima - cab.folga;
    if (invasao > TOLERANCIA) {
      colisoes++;
      const c: Colisao = { x: p.x, y: p.y, z: p.z, invasao, distancia: distMaior };
      primeira ??= c;
      if (!pior || invasao > pior.invasao) pior = c;
    }
    if (p.extrudindo) {
      const i = cy * larg + cx;
      if (p.z > mapa[i]) mapa[i] = p.z;
    }
  }
  return { colisoes, primeira, pior, folgaNecessaria };
}

export interface RelatorioVelocidadeZ {
  /** Segmentos em que o Z precisaria ir mais rápido que o limite. */
  segmentosLimitados: number;
  /** Fração do comprimento impresso que o firmware vai desacelerar. */
  fracaoDoTrajeto: number;
  /** Maior velocidade de Z pedida, em mm/s. */
  maiorVelocidadeZ: number;
}

/**
 * Compara a velocidade de Z que cada segmento pede com o limite do firmware. O Klipper e o Marlin
 * não ultrapassam o limite: desaceleram o movimento inteiro. Por isso isto é aviso, não erro.
 */
export function checarVelocidadeZ(
  segmentos: { dxy: number; dz: number; f: number }[],
  zMaximo: number,
): RelatorioVelocidadeZ {
  let limitados = 0, compLimitado = 0, compTotal = 0, maior = 0;
  for (const s of segmentos) {
    const comp = Math.hypot(s.dxy, s.dz);
    if (comp === 0) continue;
    const vz = (Math.abs(s.dz) / comp) * (s.f / 60);
    compTotal += comp;
    if (vz > maior) maior = vz;
    if (vz > zMaximo) { limitados++; compLimitado += comp; }
  }
  return { segmentosLimitados: limitados, fracaoDoTrajeto: compTotal ? compLimitado / compTotal : 0, maiorVelocidadeZ: maior };
}
