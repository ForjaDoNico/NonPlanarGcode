#!/usr/bin/env node
// Linha de comando do naoplanar.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { alturaDeCamada, criarMapaTopo } from "./topo.ts";
import { parseArgs } from "node:util";
import { lerStl, escreverStl } from "./stl.ts";
import { deformarMalha, type Mapeamento } from "./conico.ts";
import { jaTransformado, retransformarGcode } from "./gcode.ts";
import { buscarPeca, lerPerfil, nomeDaPeca, pecasNoGcode, perfilFoiConfigurado, registrarPeca, salvarPerfil, type ParametrosPeca, type Perfil } from "./config.ts";

const AJUDA = `naoplanar: fatiamento cônico (não planar) para impressoras de 3 eixos

Fluxo:
  1. naoplanar deformar peca.stl --angulo 20 [--base 1]
       Gera peca.naoplanar.stl e peca.naoplanar.json
  2. Fatie peca.naoplanar.stl no OrcaSlicer ou PrusaSlicer como uma peça normal
       (desative "Arc fitting"; prefira extrusão relativa, M83)
  3. naoplanar retransformar peca.gcode [--saida final.gcode]
       Acha os parâmetros da peça pelo nome dentro do G-code. Sem --saida, o arquivo é
       sobrescrito, então o OrcaSlicer pode chamar este comando como script de
       pós-processamento e o passo 3 acontece sozinho ao exportar (veja o README).
       G-code sem peça do naoplanar passa sem mudanças.

Perfil da impressora (salvo em ~/.naoplanar/perfil.json, usado pelo retransformar):
  naoplanar perfil                          mostra o perfil atual
  naoplanar perfil --folga 7 --z-max 5      salva os valores informados

Opções de deformar:
  --angulo   graus do cone. Positivo: camadas descem para fora (balanços para fora).
             Negativo: camadas sobem para fora (balanços para dentro).
  --base     altura em mm das primeiras camadas planas, para aderir à mesa (padrão 0)
  --aresta   tamanho máximo de aresta após subdividir a malha, em mm (padrão 1)
  --centro   eixo do cone x,y em coordenadas do modelo (padrão: centro da peça)
  --topo-liso  a última camada de topo segue a superfície real da peça, sem degraus.
             O retransformar vai precisar do STL original no mesmo lugar.
  --saida    nome do STL deformado

Opções de retransformar:
  --params   arquivo .naoplanar.json gerado no passo 1 (opcional: sem ele, a peça é
             procurada pelo nome no G-code)
  --centro   eixo do cone x,y na mesa (padrão: detectado no G-code)
  --segmento comprimento máximo de cada segmento em mm (padrão 1)
  --fator-e  multiplicador de extrusão (padrão 1)
  --sem-topo-liso  ignora o modo de topo liso escolhido no deformar
  --saida    arquivo de saída

Checagem de colisão (feita no retransformar; se houver colisão, nada é gravado).
Estas opções sobrepõem o perfil salvo só nesta execução; no comando perfil, elas são salvas:
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
      "z-max": { type: "string" }, "topo-liso": { type: "boolean" }, "sem-topo-liso": { type: "boolean" }, "ignorar-colisao": { type: "boolean" }, "sem-checar-colisao": { type: "boolean" },
    },
  });
  const [comando, arquivo] = positionals;
  if (o.ajuda || !comando) { console.log(AJUDA); return; }

  if (comando === "perfil") {
    const mudancas: Partial<Perfil> = {};
    if (o.folga !== undefined) mudancas.folga = numero(o.folga, "folga");
    if (o["raio-cabeca"] !== undefined) mudancas.raioCabeca = numero(o["raio-cabeca"], "raio-cabeca");
    if (o["raio-bico"] !== undefined) mudancas.raioBico = numero(o["raio-bico"], "raio-bico");
    if (o["z-max"] !== undefined) mudancas.zMax = numero(o["z-max"], "z-max");
    if (o.segmento !== undefined) mudancas.segmento = numero(o.segmento, "segmento");
    if (Object.keys(mudancas).length) {
      const { perfil, caminho } = salvarPerfil(mudancas);
      console.log(`Perfil salvo em ${caminho}:`);
      console.log(JSON.stringify(perfil, null, 2));
    } else {
      console.log(perfilFoiConfigurado() ? "Perfil atual:" : "Nenhum perfil salvo ainda. Valores padrão:");
      console.log(JSON.stringify(lerPerfil(), null, 2));
    }
    return;
  }

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
    const params: ParametrosPeca = {
      versao: 1, anguloGraus: angulo, deslocamentoZ: r.deslocamentoZ,
      centroRelativo: r.centroRelativo, mapa: r.mapa,
      ...(o["topo-liso"] ? { topoLiso: true, stlOriginal: resolve(arquivo) } : {}),
    };
    writeFileSync(json, JSON.stringify(params, null, 2));
    const registro = registrarPeca(nomeDaPeca(saida), params);
    console.log(`Malha deformada: ${saida} (${tris.length} → ${r.triangulos.length} triângulos)`);
    console.log(`Parâmetros: ${json} (também registrados em ${registro})`);
    console.log("Agora fatie a malha deformada no OrcaSlicer. Com o script de pós-processamento configurado,");
    console.log("o G-code exportado já sai não planar. Sem ele, rode \"naoplanar retransformar\" no G-code.");
    return;
  }

  if (comando === "retransformar") {
    const texto = readFileSync(arquivo, "utf8");
    if (jaTransformado(texto)) {
      console.log("Este G-code já foi transformado pelo naoplanar. Arquivo mantido sem mudanças.");
      return;
    }
    let params: ParametrosPeca;
    if (o.params) params = JSON.parse(readFileSync(o.params, "utf8")) as ParametrosPeca;
    else {
      // Sem --params: procura a peça pelo nome dentro do G-code (uso como script do OrcaSlicer).
      const nomes = pecasNoGcode(texto);
      if (nomes.length === 0) {
        if (!/printing object|EXCLUDE_OBJECT/i.test(texto))
          throw new Error(
            "O G-code não tem os nomes das peças, então não dá para saber se alguma foi deformada pelo naoplanar. " +
            "Ative \"Label objects\" no OrcaSlicer (Processo > Outros), ou use --params.",
          );
        console.log("Nenhuma peça do naoplanar neste G-code. Arquivo mantido sem mudanças.");
        return;
      }
      const achadas = new Map<string, { params: ParametrosPeca; caminho: string }>();
      for (const n of nomes) {
        const a = buscarPeca(n);
        if (a) achadas.set(a.caminho, a);
      }
      if (achadas.size === 0)
        throw new Error(`O G-code tem a peça "${nomes[0]}", mas ela não está registrada. Rode "naoplanar deformar" de novo ou use --params.`);
      if (achadas.size > 1)
        throw new Error("O G-code tem mais de uma peça do naoplanar. Por enquanto, imprima uma peça por vez.");
      const [a] = achadas.values();
      params = a.params;
      console.log(`Parâmetros da peça: ${a.caminho}`);
    }
    let topo: { mapa: ReturnType<typeof criarMapaTopo>; alturaCamada: number } | undefined;
    if (params.topoLiso && !o["sem-topo-liso"]) {
      const h = alturaDeCamada(texto);
      if (!params.stlOriginal || !existsSync(params.stlOriginal))
        throw new Error(`O modo de topo liso precisa do STL original, que não está mais em ${params.stlOriginal}. Rode o deformar de novo ou use --sem-topo-liso.`);
      if (!h) throw new Error("Não achei a altura de camada (layer_height) no G-code, que o modo de topo liso precisa. Use --sem-topo-liso.");
      topo = { mapa: criarMapaTopo(lerStl(params.stlOriginal)), alturaCamada: h };
    }
    const perfil = lerPerfil();
    const folga = numero(o.folga, "folga", perfil.folga);
    const zMax = numero(o["z-max"], "z-max", perfil.zMax);
    const r = retransformarGcode(texto, {
      mapa: params.mapa,
      deslocamentoZ: params.deslocamentoZ,
      centroRelativo: params.centroRelativo,
      centro: lerPar(o.centro),
      segmento: numero(o.segmento, "segmento", perfil.segmento),
      fatorExtrusao: numero(o["fator-e"], "fator-e", 1),
      cabecote: o["sem-checar-colisao"] ? null : {
        folga,
        raioCabeca: numero(o["raio-cabeca"], "raio-cabeca", perfil.raioCabeca),
        raioBico: numero(o["raio-bico"], "raio-bico", perfil.raioBico),
      },
      zMaximo: zMax > 0 ? zMax : undefined,
      topo,
    });
    const c = r.colisao;
    if (c && c.colisoes > 0) {
      const p = c.primeira!, pior = c.pior!;
      const msg =
        `O cabeçote bateria na peça em ${c.colisoes} pontos. ` +
        `A primeira colisão é em X${p.x.toFixed(1)} Y${p.y.toFixed(1)} Z${p.z.toFixed(1)}, com material ${p.invasao.toFixed(1)} mm ` +
        `acima da parte mais baixa do cabeçote, a ${p.distancia.toFixed(1)} mm do bico (a pior passa ${pior.invasao.toFixed(1)} mm). ` +
        `Este arquivo precisa de pelo menos ${c.folgaNecessaria.toFixed(1)} mm de folga, e a configurada é ` +
        `${folga} mm${perfilFoiConfigurado() ? "" : " (valor padrão, sem perfil salvo)"}. Diminua o --angulo no passo deformar, ` +
        `ou salve a folga real do seu cabeçote com "naoplanar perfil --folga N".`;
      if (!o["ignorar-colisao"]) throw new Error(msg + " Nada foi gravado. Use --ignorar-colisao para gravar mesmo assim.");
      console.warn(`Aviso: ${msg}`);
    }
    const saida = o.saida ?? arquivo;
    writeFileSync(saida, r.gcode);
    console.log(`G-code não planar: ${saida}`);
    console.log(`Centro do cone na mesa: X${r.centro[0].toFixed(2)} Y${r.centro[1].toFixed(2)}`);
    console.log(`${r.linhasTransformadas} movimentos viraram ${r.segmentosGerados} segmentos; Z de ${r.zMinimo.toFixed(2)} a ${r.zMaximo.toFixed(2)} mm`);
    if (topo) console.log(`Topo liso: ${r.pontosDeTopoAjustados} pontos do topo subiram até a superfície da peça`);
    if (c) console.log(`Folga necessária no cabeçote: ${c.folgaNecessaria.toFixed(1)} mm${c.colisoes ? "" : " (sem colisões)"}`);
    for (const a of r.avisos) console.warn(`Aviso: ${a}`);
    return;
  }

  throw new Error(`Comando desconhecido: ${comando}. Use "deformar", "retransformar" ou "perfil".`);
}

try {
  principal(process.argv.slice(2));
} catch (e) {
  console.error(`Erro: ${(e as Error).message}`);
  process.exit(1);
}
