// O processo completo, do STL ao G-code não planar, usado pela interface:
//   1. deforma a malha com a superfície escolhida (formas e âncoras por altura);
//   2. monta um 3MF com a configuração do Orca do usuário e fatia pelo CLI do OrcaSlicer;
//   3. desfaz a deformação no G-code, checa a colisão do cabeçote e a velocidade do Z;
//   4. prepara uma prévia do caminho do bico para a interface desenhar.

import { deformarComSuperficie } from "./conico.ts";
import { folgaDoStl } from "./cabecote.ts";
import type { Cabecote } from "./colisao.ts";
import type { Perfil } from "./config.ts";
import { retransformarGcode, type RelatorioRetransformacao } from "./gcode.ts";
import { fatiarComOrca, montar3mf, type ConfigOrca } from "./orca.ts";
import { lerStl, type Triangulo } from "./stl.ts";
import type { Ancora, Superficie, Validacao } from "./superficie.ts";

/**
 * Geometria do cabeçote a partir do perfil. A margem trata o cabeçote como mais baixo: tira da
 * folga geral e sobe o bico dentro do STL do duto (que fica mais perto da ponta).
 */
export function cabecoteDoPerfil(perfil: Perfil, margem = perfil.margem ?? 0): Cabecote {
  const bico = perfil.bico;
  return {
    folga: perfil.folga - margem,
    raioCabeca: perfil.raioCabeca,
    raioBico: perfil.raioBico,
    formato: perfil.cabecoteStl && bico ? folgaDoStl(lerStl(perfil.cabecoteStl), [bico[0], bico[1], bico[2] + margem]) : undefined,
  };
}

export type EtapaProcesso = "deformar" | "fatiar" | "retransformar" | "previa";

export interface PedidoProcesso {
  tris: Triangulo[];
  /** Nome da peça, sem extensão. */
  nome: string;
  config: ConfigOrca;
  ancoras: Ancora[];
  /** Altura das camadas planas na base, em mm. */
  base: number;
  perfil: Perfil;
  /** Grava o G-code mesmo com colisão prevista. */
  ignorarColisao?: boolean;
  /** Desliga a checagem de colisão. */
  semChecarColisao?: boolean;
  /** Etapa atual, para a interface mostrar o progresso (código traduzido pela interface). */
  aoProgredir?: (etapa: EtapaProcesso) => void;
  /** Troca o fatiamento (usado nos testes, que não têm o OrcaSlicer). */
  fatiar?: (arquivo3mf: Buffer) => Promise<string>;
}

export interface ResultadoProcesso {
  /** G-code final, ou null se houve colisão e ela não foi ignorada. */
  gcode: string | null;
  superficie: Superficie;
  validacao: Validacao;
  deslocamentoZ: number;
  centroRelativo: [number, number];
  retransformacao: Omit<RelatorioRetransformacao, "gcode">;
  /** Estimativas do Orca para o G-code plano (o não planar leva um pouco mais). */
  estimativa: { tempo: string; filamentoMm: number | null };
  /** Pontos de extrusão (x, y, z em pares de segmentos) para a prévia 3D. */
  previa: Float32Array;
}

/** Segmentos de extrusão do G-code, com no máximo `limite` segmentos (os demais são pulados de forma uniforme). */
export function previaDoGcode(gcode: string, limite = 250_000): Float32Array {
  const segs: number[] = [];
  let x = NaN, y = NaN, z = NaN;
  for (const linha of gcode.split("\n")) {
    if (linha.charCodeAt(0) !== 71 /* G */ || !/^G[01] /.test(linha)) continue;
    const pega = (c: string) => { const m = new RegExp(` ${c}(-?[\\d.]+)`).exec(linha); return m ? Number(m[1]) : NaN; };
    const nx = pega("X"), ny = pega("Y"), nz = pega("Z"), e = pega("E");
    const px = Number.isNaN(nx) ? x : nx, py = Number.isNaN(ny) ? y : ny, pz = Number.isNaN(nz) ? z : nz;
    if (e > 0 && !Number.isNaN(x) && !Number.isNaN(z) && (px !== x || py !== y)) segs.push(x, y, z, px, py, pz);
    x = px; y = py; z = pz;
  }
  const total = segs.length / 6;
  if (total <= limite) return new Float32Array(segs);
  const saida = new Float32Array(limite * 6);
  for (let i = 0; i < limite; i++) {
    const k = Math.floor((i * total) / limite) * 6;
    for (let j = 0; j < 6; j++) saida[i * 6 + j] = segs[k + j];
  }
  return saida;
}

function estimativaDoGcode(gcode: string): { tempo: string; filamentoMm: number | null } {
  const tempo = /estimated printing time \(normal mode\) = (.+)/.exec(gcode)?.[1]?.trim() ?? "";
  const fil = /filament used \[mm\] = ([\d.]+)/.exec(gcode)?.[1];
  return { tempo, filamentoMm: fil ? Number(fil) : null };
}

export async function processar(p: PedidoProcesso): Promise<ResultadoProcesso> {
  const etapa = p.aoProgredir ?? (() => {});
  etapa("deformar");
  const def = deformarComSuperficie(p.tris, p.ancoras, { base: p.base });

  etapa("fatiar");
  const arquivo3mf = montar3mf(def.triangulos, `${p.nome}.naoplanar`, p.config);
  const plano = await (p.fatiar ?? ((a: Buffer) => fatiarComOrca(a)))(arquivo3mf);

  etapa("retransformar");
  const r = retransformarGcode(plano, {
    superficie: def.superficie,
    deslocamentoZ: def.deslocamentoZ,
    centroRelativo: def.centroRelativo,
    segmento: p.perfil.segmento,
    cabecote: p.semChecarColisao ? null : cabecoteDoPerfil(p.perfil),
    zMaximo: p.perfil.zMax > 0 ? p.perfil.zMax : undefined,
  });
  const colidiu = !!r.colisao && r.colisao.colisoes > 0;
  const { gcode, ...retransformacao } = r;

  etapa("previa");
  return {
    gcode: colidiu && !p.ignorarColisao ? null : gcode,
    superficie: def.superficie,
    validacao: def.validacao,
    deslocamentoZ: def.deslocamentoZ,
    centroRelativo: def.centroRelativo,
    retransformacao,
    estimativa: estimativaDoGcode(plano),
    previa: previaDoGcode(gcode),
  };
}
