// Desfaz a deformação cônica no G-code gerado pelo fatiador.
//
// O fatiador imprimiu a malha deformada em camadas planas (z'). Para cada movimento,
// aplicamos o mapeamento inverso (ver conico.ts). Como Z passa a variar ao longo de cada
// linha reta, os movimentos são quebrados em segmentos curtos.

import { espessuraRelativa, paraReal, type Mapeamento } from "./conico.ts";

// Altura mínima dos deslocamentos sem extrusão, para o bico não raspar a mesa.
const Z_MINIMO_DESLOCAMENTO = 0.2;

export interface ParametrosRetransformacao {
  mapa: Mapeamento;
  deslocamentoZ: number;
  /** Centro do cone relativo ao centro XY da peça. Usado quando `centro` não é informado. */
  centroRelativo?: [number, number];
  /** Centro do cone em coordenadas da mesa. Se omitido, é detectado no próprio G-code. */
  centro?: [number, number];
  /** Comprimento máximo de cada segmento, em mm. */
  segmento?: number;
  /** Multiplicador de extrusão (1 = sem compensação). */
  fatorExtrusao?: number;
}

export interface RelatorioRetransformacao {
  gcode: string;
  centro: [number, number];
  linhasTransformadas: number;
  segmentosGerados: number;
  zMinimo: number;
  zMaximo: number;
  avisos: string[];
}

// Tipos de trecho que não pertencem à peça e não entram no cálculo do centro.
const TIPOS_FORA_DA_PECA = /^(skirt|brim|custom|wipe|prime|purge)/i;

function tipoDaLinha(linha: string): string | null {
  // PrusaSlicer e OrcaSlicer: ";TYPE:External perimeter". Bambu Studio: "; FEATURE: Outer wall".
  const m = /^;\s*(?:TYPE|FEATURE):\s*(.+)$/.exec(linha.trim());
  return m ? m[1].trim() : null;
}

function ehMudancaDeCamada(linha: string): boolean {
  return /^;\s*(LAYER_CHANGE|CHANGE_LAYER)\b/.test(linha.trim());
}

function ehInicioDoFinal(linha: string): boolean {
  const t = linha.trim();
  return /^;\s*(TYPE|FEATURE):\s*Custom/i.test(t) || /^;\s*(filament )?end g-?code/i.test(t) || /^;\s*MACHINE_END_GCODE_START/i.test(t);
}

interface Palavras { [letra: string]: number }

function lerPalavras(cmd: string): Palavras {
  const p: Palavras = {};
  for (const m of cmd.matchAll(/([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) p[m[1].toUpperCase()] = Number(m[2]);
  return p;
}

const fmt = (n: number, casas: number) => {
  const fixo = n.toFixed(casas);
  // Só há zeros supérfluos depois da vírgula: F1200 precisa continuar F1200.
  const s = fixo.includes(".") ? fixo.replace(/\.?0+$/, "") : fixo;
  return s === "-0" ? "0" : s;
};

/**
 * Índice da linha em que começa o código final da impressão. Marcadores de código personalizado
 * também aparecem no meio da impressão, então só valem os que vêm depois da última camada e
 * não são seguidos por outro tipo de trecho da peça.
 */
function encontrarInicioDoFinal(linhas: string[]): number {
  const ultimaCamada = linhas.findLastIndex(ehMudancaDeCamada);
  let fim = linhas.length;
  for (let i = linhas.length - 1; i > ultimaCamada && ultimaCamada >= 0; i--) {
    const tipo = tipoDaLinha(linhas[i]);
    if (tipo !== null && !/^custom/i.test(tipo)) break;
    if (ehInicioDoFinal(linhas[i])) fim = i;
  }
  return fim;
}

/** Primeira passada: encontra o centro XY da peça pelos movimentos de extrusão dela. */
export function detectarCentro(linhas: string[]): [number, number] | null {
  let x = 0, y = 0, e = 0, eRelativo = false, ativo = false, tipo = "";
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const bruta of linhas) {
    if (ehMudancaDeCamada(bruta)) ativo = true;
    const t = tipoDaLinha(bruta);
    if (t !== null) tipo = t;
    const cmd = bruta.split(";")[0].trim();
    if (!cmd) continue;
    const p = lerPalavras(cmd);
    const g = cmd.match(/^([GM])(\d+)/i);
    if (!g) continue;
    const codigo = g[1].toUpperCase() + g[2];
    if (codigo === "M82") eRelativo = false;
    else if (codigo === "M83") eRelativo = true;
    else if (codigo === "G92" && p.E !== undefined) e = p.E;
    else if (codigo === "G0" || codigo === "G1") {
      const nx = p.X ?? x, ny = p.Y ?? y;
      let extrudou = false;
      if (p.E !== undefined) {
        const de = eRelativo ? p.E : p.E - e;
        extrudou = de > 0 && (nx !== x || ny !== y);
        e = eRelativo ? e + p.E : p.E;
      }
      if (ativo && extrudou && !TIPOS_FORA_DA_PECA.test(tipo)) {
        for (const [px, py] of [[x, y], [nx, ny]]) {
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        }
      }
      x = nx; y = ny;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function retransformarGcode(texto: string, params: ParametrosRetransformacao): RelatorioRetransformacao {
  const linhas = texto.split(/\r?\n/);
  const avisos: string[] = [];
  let centro = params.centro;
  if (!centro) {
    const c = detectarCentro(linhas);
    if (!c) throw new Error("Não encontrei movimentos de extrusão da peça no G-code. Informe o centro com --centro x,y.");
    const rel = params.centroRelativo ?? [0, 0];
    centro = [c[0] + rel[0], c[1] + rel[1]];
  }
  const seg = params.segmento ?? 1;
  const fatorE = params.fatorExtrusao ?? 1;
  const zReal = (x: number, y: number, zl: number) =>
    paraReal(params.mapa, Math.hypot(x - centro![0], y - centro![1]), zl + params.deslocamentoZ);

  // Posição no espaço deformado (como o fatiador vê).
  let x = 0, y = 0, z = 0, e = 0;
  let eRelativo = false, absoluto = true, ativo = false;
  // Até o G-code definir os três eixos, o bico está onde o código inicial o deixou (por exemplo,
  // uma macro PRINT_START). Sem saber a origem, esses movimentos não podem ser interpolados.
  const conhecido = { X: false, Y: false, Z: false };
  let zMin = Infinity, zMax = -Infinity, transformadas = 0, segmentos = 0;
  let extrusoesAbaixoDaMesa = 0, deslocamentosElevados = 0, semCompensacao = 0;
  const saida: string[] = [];
  const inicioDoFinal = encontrarInicioDoFinal(linhas);

  for (const [indice, bruta] of linhas.entries()) {
    if (indice < inicioDoFinal && ehMudancaDeCamada(bruta)) ativo = true;
    if (indice === inicioDoFinal) ativo = false;

    const [cmdBruto, ...resto] = bruta.split(";");
    const comentario = resto.length ? ";" + resto.join(";") : "";
    const cmd = cmdBruto.trim();
    const g = cmd.match(/^([GM])(\d+)\b/i);
    const codigo = g ? g[1].toUpperCase() + Number(g[2]) : "";
    const p = cmd ? lerPalavras(cmd) : {};

    if (codigo === "G90") absoluto = true;
    else if (codigo === "G91") absoluto = false;
    else if (codigo === "M82") eRelativo = false;
    else if (codigo === "M83") eRelativo = true;
    else if (codigo === "G92") {
      if (p.X !== undefined) x = p.X;
      if (p.Y !== undefined) y = p.Y;
      if (p.Z !== undefined) z = p.Z;
      if (p.E !== undefined) e = p.E;
    }

    const ehMovimento = codigo === "G0" || codigo === "G1";
    if (ativo && (codigo === "G2" || codigo === "G3"))
      throw new Error("O G-code tem arcos (G2/G3). Desative \"Arc fitting\" no fatiador e exporte de novo.");
    if (ativo && ehMovimento && !absoluto)
      throw new Error("Movimento relativo (G91) dentro das camadas não é suportado neste protótipo.");

    const origemConhecida = conhecido.X && conhecido.Y && conhecido.Z;
    if ((ehMovimento && absoluto) || codigo === "G92") {
      if (p.X !== undefined) conhecido.X = true;
      if (p.Y !== undefined) conhecido.Y = true;
      if (p.Z !== undefined) conhecido.Z = true;
    }

    if (!ehMovimento || !ativo || !origemConhecida || (p.X === undefined && p.Y === undefined && p.Z === undefined)) {
      // Fora da área da peça, sem origem conhecida ou sem movimento de eixo: copia como está,
      // mas acompanha a posição.
      if (ehMovimento) {
        if (absoluto) { x = p.X ?? x; y = p.Y ?? y; z = p.Z ?? z; }
        else { x += p.X ?? 0; y += p.Y ?? 0; z += p.Z ?? 0; }
        // Retração e avanço puros (só E) não são escalados, para manter a retração configurada.
        if (p.E !== undefined) e = eRelativo ? e + p.E : p.E;
      }
      saida.push(bruta);
      continue;
    }

    const nx = p.X ?? x, ny = p.Y ?? y, nz = p.Z ?? z;
    const eInicial = e;
    const eFinal = p.E === undefined ? e : eRelativo ? e + p.E : p.E;
    const dist = Math.hypot(nx - x, ny - y);
    const n = Math.max(1, Math.ceil(dist / seg));
    const extrudindo = eFinal > eInicial && dist > 0;
    transformadas++;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const sx = x + (nx - x) * f, sy = y + (ny - y) * f, sz = z + (nz - z) * f;
      let zr = zReal(sx, sy, sz);
      if (extrudindo && zr < -0.01) extrusoesAbaixoDaMesa++;
      if (!extrudindo && zr < Z_MINIMO_DESLOCAMENTO) { zr = Z_MINIMO_DESLOCAMENTO; deslocamentosElevados++; }
      zr = Math.max(zr, 0);
      if (zr < zMin) zMin = zr;
      if (zr > zMax) zMax = zr;
      let linha = `G1 X${fmt(sx, 3)} Y${fmt(sy, 3)} Z${fmt(zr, 3)}`;
      if (p.E !== undefined) {
        // Avalia a espessura no meio do segmento, para compensar o afinamento na transição.
        const fm = (i - 0.5) / n;
        const raioMeio = Math.hypot(x + (nx - x) * fm - centro[0], y + (ny - y) * fm - centro[1]);
        const espessura = extrudindo
          ? espessuraRelativa(params.mapa, raioMeio, z + (nz - z) * fm + params.deslocamentoZ)
          : 1;
        if (eRelativo) linha += ` E${fmt(((eFinal - eInicial) / n) * fatorE * espessura, 5)}`;
        else {
          if (espessura !== 1) semCompensacao++;
          linha += ` E${fmt(eInicial + (eFinal - eInicial) * f, 5)}`;
        }
      }
      if (i === 1 && p.F !== undefined) linha += ` F${fmt(p.F, 0)}`;
      if (i === 1 && comentario) linha += " " + comentario;
      saida.push(linha);
      segmentos++;
    }
    x = nx; y = ny; z = nz; e = eFinal;
  }

  if (fatorE !== 1 && !eRelativo)
    avisos.push("O fator de extrusão só é aplicado com extrusão relativa (M83). Ative \"Use relative E distances\" no fatiador.");
  if (extrusoesAbaixoDaMesa > 0)
    throw new Error(`${extrusoesAbaixoDaMesa} pontos de extrusão ficariam abaixo da mesa. Use --base no passo deformar (recomendado) ou desative saia e brim no fatiador.`);
  if (deslocamentosElevados > 0)
    avisos.push(`${deslocamentosElevados} pontos de deslocamento foram elevados a Z=${Z_MINIMO_DESLOCAMENTO} para o bico não raspar a mesa.`);
  if (semCompensacao > 0)
    avisos.push("A extrusão não foi compensada na zona de transição, onde as camadas ficam mais finas ou mais grossas. Ative \"Use relative E distances\" no fatiador.");
  if (transformadas === 0) avisos.push("Nenhum movimento foi transformado. O G-code tem marcadores ;LAYER_CHANGE?");

  return {
    gcode: saida.join("\n"),
    centro,
    linhasTransformadas: transformadas,
    segmentosGerados: segmentos,
    zMinimo: zMin,
    zMaximo: zMax,
    avisos,
  };
}
