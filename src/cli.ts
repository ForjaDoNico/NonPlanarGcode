#!/usr/bin/env node
// Linha de comando do naoplanar.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lerStl, escreverStl } from "./stl.ts";
import { deformarMalha, type Mapeamento } from "./conico.ts";
import { retransformarGcode } from "./gcode.ts";
import { CABECOTE_PADRAO } from "./colisao.ts";

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

Checagem de colisão (feita no retransformar; se houver colisão, nada é gravado):
  --folga        altura livre, em mm, entre a ponta do bico e a parte mais baixa do
                 cabeçote (padrão 5). Meça na sua impressora: veja o README.
  --raio-cabeca  até quantos mm do bico o cabeçote se estende na horizontal (padrão 30)
  --raio-bico    raio em volta da ponta que é ignorado, onde o bico alisa o material
                 vizinho (padrão 1,5)
  --ignorar-colisao     grava o arquivo mesmo com colisão (por sua conta e risco)
  --sem-checar-colisao  não faz a checagem
  --z-max        velocidade máxima do eixo Z no firmware, em mm/s (max_z_velocity).
                 Avisa quando o firmware vai desacelerar a impressão.
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
      folga: { type: "string" }, "raio-cabeca": { type: "string" }, "raio-bico": { type: "string" },
      "z-max": { type: "string" }, "ignorar-colisao": { type: "boolean" }, "sem-checar-colisao": { type: "boolean" },
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
      cabecote: o["sem-checar-colisao"] ? null : {
        folga: numero(o.folga, "folga", CABECOTE_PADRAO.folga),
        raioCabeca: numero(o["raio-cabeca"], "raio-cabeca", CABECOTE_PADRAO.raioCabeca),
        raioBico: numero(o["raio-bico"], "raio-bico", CABECOTE_PADRAO.raioBico),
      },
      zMaximo: o["z-max"] === undefined ? undefined : numero(o["z-max"], "z-max"),
    });
    const c = r.colisao;
    if (c && c.colisoes > 0) {
      const p = c.primeira!, pior = c.pior!;
      const msg =
        `O cabeçote bateria na peça em ${c.colisoes} pontos. ` +
        `A primeira colisão é em X${p.x.toFixed(1)} Y${p.y.toFixed(1)} Z${p.z.toFixed(1)}, com material ${p.invasao.toFixed(1)} mm ` +
        `acima da parte mais baixa do cabeçote, a ${p.distancia.toFixed(1)} mm do bico (a pior passa ${pior.invasao.toFixed(1)} mm). ` +
        `Este arquivo precisa de pelo menos ${c.folgaNecessaria.toFixed(1)} mm de folga, e a configurada é ` +
        `${numero(o.folga, "folga", CABECOTE_PADRAO.folga)} mm. Diminua o --angulo no passo deformar, ` +
        `ou informe a folga real do seu cabeçote com --folga.`;
      if (!o["ignorar-colisao"]) throw new Error(msg + " Nada foi gravado. Use --ignorar-colisao para gravar mesmo assim.");
      console.warn(`Aviso: ${msg}`);
    }
    const saida = o.saida ?? arquivo;
    writeFileSync(saida, r.gcode);
    console.log(`G-code não planar: ${saida}`);
    console.log(`Centro do cone na mesa: X${r.centro[0].toFixed(2)} Y${r.centro[1].toFixed(2)}`);
    console.log(`${r.linhasTransformadas} movimentos viraram ${r.segmentosGerados} segmentos; Z de ${r.zMinimo.toFixed(2)} a ${r.zMaximo.toFixed(2)} mm`);
    if (c) console.log(`Folga necessária no cabeçote: ${c.folgaNecessaria.toFixed(1)} mm${c.colisoes ? "" : " (sem colisões)"}`);
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
