#!/usr/bin/env node
// Linha de comando do naoplanar.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lerStl, escreverStl } from "./stl.ts";
import { deformarMalha, type Mapeamento } from "./conico.ts";
import { retransformarGcode } from "./gcode.ts";

const AJUDA = `naoplanar: fatiamento cônico (não planar) para impressoras de 3 eixos

Fluxo:
  1. naoplanar deformar peca.stl --angulo 20 [--base 1]
       Gera peca.naoplanar.stl e peca.naoplanar.json
  2. Fatie peca.naoplanar.stl no OrcaSlicer ou PrusaSlicer como uma peça normal
       (desative "Arc fitting"; prefira extrusão relativa, M83)
  3. naoplanar retransformar peca.gcode --params peca.naoplanar.json [--saida final.gcode]
       Sem --saida, o arquivo é sobrescrito (útil como script de pós-processamento)

Opções de deformar:
  --angulo   graus do cone. Positivo: camadas descem para fora (balanços para fora).
             Negativo: camadas sobem para fora (balanços para dentro).
  --base     altura em mm das primeiras camadas planas, para aderir à mesa (padrão 0)
  --aresta   tamanho máximo de aresta após subdividir a malha, em mm (padrão 1)
  --centro   eixo do cone x,y em coordenadas do modelo (padrão: centro da peça)
  --saida    nome do STL deformado

Opções de retransformar:
  --params   arquivo .naoplanar.json gerado no passo 1 (obrigatório)
  --centro   eixo do cone x,y na mesa (padrão: detectado no G-code)
  --segmento comprimento máximo de cada segmento em mm (padrão 1)
  --fator-e  multiplicador de extrusão (padrão 1)
  --saida    arquivo de saída
`;

interface ArquivoParametros {
  versao: 1;
  anguloGraus: number;
  deslocamentoZ: number;
  centroRelativo: [number, number];
  mapa: Mapeamento;
}

function lerPar(txt: string | undefined): [number, number] | undefined {
  if (!txt) return undefined;
  const [a, b] = txt.split(",").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Valor inválido para --centro: ${txt} (use x,y)`);
  return [a, b];
}

function numero(txt: string | undefined, nome: string, padrao?: number): number {
  if (txt === undefined) {
    if (padrao === undefined) throw new Error(`Informe --${nome}.`);
    return padrao;
  }
  const n = Number(txt);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido para --${nome}: ${txt}`);
  return n;
}

function principal(argv: string[]): void {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      angulo: { type: "string" }, base: { type: "string" }, aresta: { type: "string" },
      centro: { type: "string" }, saida: { type: "string" }, params: { type: "string" },
      segmento: { type: "string" }, "fator-e": { type: "string" }, ajuda: { type: "boolean", short: "h" },
    },
  });
  const [comando, arquivo] = positionals;
  if (o.ajuda || !comando) { console.log(AJUDA); return; }
  if (!arquivo) throw new Error("Informe o arquivo de entrada.");

  if (comando === "deformar") {
    const angulo = numero(o.angulo, "angulo");
    if (Math.abs(angulo) >= 60) throw new Error("Use um ângulo entre -60 e 60 graus.");
    const baseMm = numero(o.base, "base", 0);
    if (angulo > 0 && baseMm <= 0)
      console.warn("Aviso: sem --base, as camadas encostam na mesa em ângulo e o bico pode raspar nela. Use --base 1, por exemplo.");
    const tris = lerStl(arquivo);
    const r = deformarMalha(tris, angulo, {
      base: baseMm,
      maxAresta: numero(o.aresta, "aresta", 1),
      centro: lerPar(o.centro),
    });
    const base = arquivo.replace(/\.stl$/i, "");
    const saida = o.saida ?? `${base}.naoplanar.stl`;
    const json = saida.replace(/\.stl$/i, "") + ".json";
    escreverStl(saida, r.triangulos);
    const params: ArquivoParametros = {
      versao: 1, anguloGraus: angulo, deslocamentoZ: r.deslocamentoZ,
      centroRelativo: r.centroRelativo, mapa: r.mapa,
    };
    writeFileSync(json, JSON.stringify(params, null, 2));
    console.log(`Malha deformada: ${saida} (${tris.length} → ${r.triangulos.length} triângulos)`);
    console.log(`Parâmetros: ${json}`);
    console.log("Agora fatie a malha deformada e rode \"naoplanar retransformar\" no G-code.");
    return;
  }

  if (comando === "retransformar") {
    if (!o.params) throw new Error("Informe --params com o arquivo .naoplanar.json do passo deformar.");
    const params = JSON.parse(readFileSync(o.params, "utf8")) as ArquivoParametros;
    const r = retransformarGcode(readFileSync(arquivo, "utf8"), {
      mapa: params.mapa,
      deslocamentoZ: params.deslocamentoZ,
      centroRelativo: params.centroRelativo,
      centro: lerPar(o.centro),
      segmento: numero(o.segmento, "segmento", 1),
      fatorExtrusao: numero(o["fator-e"], "fator-e", 1),
    });
    const saida = o.saida ?? arquivo;
    writeFileSync(saida, r.gcode);
    console.log(`G-code não planar: ${saida}`);
    console.log(`Centro do cone na mesa: X${r.centro[0].toFixed(2)} Y${r.centro[1].toFixed(2)}`);
    console.log(`${r.linhasTransformadas} movimentos viraram ${r.segmentosGerados} segmentos; Z de ${r.zMinimo.toFixed(2)} a ${r.zMaximo.toFixed(2)} mm`);
    for (const a of r.avisos) console.warn(`Aviso: ${a}`);
    return;
  }

  throw new Error(`Comando desconhecido: ${comando}. Use "deformar" ou "retransformar".`);
}

try {
  principal(process.argv.slice(2));
} catch (e) {
  console.error(`Erro: ${(e as Error).message}`);
  process.exit(1);
}
