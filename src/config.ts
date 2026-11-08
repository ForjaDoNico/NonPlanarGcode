// Arquivos de configuração do usuário: o perfil da impressora e o registro das peças deformadas.
//
// Tudo fica em ~/.naoplanar (ou na pasta da variável NAOPLANAR_DIR):
//   perfil.json         geometria do cabeçote e limites da impressora
//   pecas/<nome>.json   parâmetros de cada peça deformada, para o retransformar achar sozinho
//
// O registro existe para o OrcaSlicer poder chamar o naoplanar como script de pós-processamento
// sem nenhum argumento além do arquivo: o nome da peça aparece no próprio G-code.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Mapeamento } from "./conico.ts";
import type { Superficie } from "./superficie.ts";
import { CABECOTE_PADRAO } from "./colisao.ts";

export interface Perfil {
  /** Altura livre entre a ponta do bico e a parte mais baixa do cabeçote, em mm. */
  folga: number;
  raioCabeca: number;
  raioBico: number;
  /** max_z_velocity do firmware, em mm/s. 0 desliga o aviso. */
  zMax: number;
  /** Comprimento máximo dos segmentos, em mm. */
  segmento: number;
  /** STL de uma parte do cabeçote (por exemplo, o duto do fan), com Z para cima. Opcional. */
  cabecoteStl?: string;
  /** Posição da ponta do bico nas coordenadas desse STL. */
  bico?: [number, number, number];
  /** Margem de segurança da checagem de colisão, em mm: o cabeçote é tratado como mais baixo. */
  margem?: number;
}

export const PERFIL_PADRAO: Perfil = { ...CABECOTE_PADRAO, zMax: 0, segmento: 1 };

export interface ParametrosPeca {
  /** 1: só cone (`mapa`). 2: superfície com formas e âncoras por altura (`superficie`). */
  versao: 1 | 2;
  /** Ângulo da primeira âncora, para referência. */
  anguloGraus: number;
  deslocamentoZ: number;
  centroRelativo: [number, number];
  mapa?: Mapeamento;
  superficie?: Superficie;
  /** Modo de topo liso: a última camada de topo segue a superfície do STL original. */
  topoLiso?: boolean;
  /** Caminho absoluto do STL original, usado pelo modo de topo liso. */
  stlOriginal?: string;
}

export function pastaConfig(): string {
  return process.env.NAOPLANAR_DIR || join(homedir(), ".naoplanar");
}

const caminhoPerfil = () => join(pastaConfig(), "perfil.json");
const pastaPecas = () => join(pastaConfig(), "pecas");

export function lerPerfil(): Perfil {
  const c = caminhoPerfil();
  if (!existsSync(c)) return { ...PERFIL_PADRAO };
  return { ...PERFIL_PADRAO, ...(JSON.parse(readFileSync(c, "utf8")) as Partial<Perfil>) };
}

export function perfilFoiConfigurado(): boolean {
  return existsSync(caminhoPerfil());
}

export function salvarPerfil(mudancas: Partial<Perfil>): { perfil: Perfil; caminho: string } {
  const perfil = { ...lerPerfil(), ...mudancas };
  mkdirSync(pastaConfig(), { recursive: true });
  writeFileSync(caminhoPerfil(), JSON.stringify(perfil, null, 2));
  return { perfil, caminho: caminhoPerfil() };
}

/** Chave usada para comparar nomes: o Orca troca espaços e símbolos por "_" em alguns lugares. */
export function normalizarNome(nome: string): string {
  return nome.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Nome da peça a partir do STL deformado: "pasta/benchy.naoplanar.stl" → "benchy". */
export function nomeDaPeca(stlDeformado: string): string {
  return basename(stlDeformado).replace(/\.stl$/i, "").replace(/\.naoplanar$/i, "");
}

export function registrarPeca(nome: string, params: ParametrosPeca): string {
  mkdirSync(pastaPecas(), { recursive: true });
  const c = join(pastaPecas(), `${nome}.json`);
  writeFileSync(c, JSON.stringify(params, null, 2));
  return c;
}

/**
 * Procura no G-code os nomes de peças deformadas pelo naoplanar ("<nome>.naoplanar").
 * O OrcaSlicer escreve o nome do objeto em comentários "; printing object ..." e nos comandos
 * EXCLUDE_OBJECT do Klipper.
 */
export function pecasNoGcode(gcode: string): string[] {
  const nomes = new Set<string>();
  for (const m of gcode.matchAll(/([^\s;:=/\\"']+?)[._ ]naoplanar(?=[._\s"']|$)/gim)) nomes.add(normalizarNome(m[1]));
  return [...nomes];
}

export function buscarPeca(nomeNormalizado: string): { params: ParametrosPeca; caminho: string } | null {
  const pasta = pastaPecas();
  if (!existsSync(pasta)) return null;
  for (const arq of readdirSync(pasta)) {
    if (!arq.endsWith(".json")) continue;
    if (normalizarNome(arq.slice(0, -5)) !== nomeNormalizado) continue;
    const caminho = join(pasta, arq);
    return { params: JSON.parse(readFileSync(caminho, "utf8")) as ParametrosPeca, caminho };
  }
  return null;
}
