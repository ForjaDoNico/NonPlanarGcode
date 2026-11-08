// Fatiamento automático pelo OrcaSlicer, pela linha de comando.
//
// O CLI do Orca não consegue carregar presets de usuário soltos (eles herdam de perfis empacotados),
// mas fatia um projeto 3MF com a configuração completa dentro. Então o naoplanar monta esse 3MF:
//   - a malha deformada, com vértices soldados (a malha subdividida tem vértices quase iguais,
//     que a interface do Orca conserta sozinha e o leitor de 3MF não);
//   - a configuração copiada de um G-code que o usuário já exportou do Orca (o bloco
//     CONFIG_BLOCK no fim do arquivo) ou de um projeto 3MF dele.
// O Orca aceita os valores como texto, do jeito que aparecem no G-code. Sem a linha de metadados
// "OrcaSlicer" no modelo, ele trata o arquivo como do Bambu Studio e se recusa a fatiar.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { Triangulo } from "./stl.ts";

export type ConfigOrca = Record<string, string | string[]>;

/** Ajustes que o naoplanar precisa e que são forçados na configuração, seja qual for o perfil. */
export const AJUSTES_OBRIGATORIOS: Record<string, string> = {
  enable_arc_fitting: "0", // sem arcos G2/G3
  use_relative_e_distances: "1", // a compensação de extrusão só funciona com E relativo
  gcode_label_objects: "1", // nome da peça no G-code
  post_process: "", // o naoplanar já faz o pós-processamento
};

/** Configuração gravada no fim de um G-code do OrcaSlicer (ou PrusaSlicer, Bambu Studio). */
export function configDoGcode(texto: string): ConfigOrca {
  const ini = texto.lastIndexOf("; CONFIG_BLOCK_START");
  const fim = texto.lastIndexOf("; CONFIG_BLOCK_END");
  if (ini < 0 || fim < ini)
    throw new Error("Este G-code não tem a configuração do fatiador no fim (CONFIG_BLOCK). Exporte um G-code pelo OrcaSlicer.");
  const cfg: ConfigOrca = {};
  for (const linha of texto.slice(ini, fim).split(/\r?\n/)) {
    const m = /^; ([A-Za-z0-9_]+) = ?(.*)$/.exec(linha);
    if (m) cfg[m[1]] = m[2];
  }
  if (!cfg.printer_settings_id && !cfg.nozzle_diameter) throw new Error("A configuração do G-code está incompleta.");
  return cfg;
}

// ---- zip mínimo (3MF é um zip) ----

export interface ArquivoZip { nome: string; dados: Buffer }

export function lerZip(buf: Buffer): ArquivoZip[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Arquivo 3MF inválido (não é um zip).");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const saida: ArquivoZip[] = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Arquivo 3MF corrompido.");
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + nLen);
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const comp = buf.subarray(inicio, inicio + tamComp);
    if (!nome.endsWith("/")) saida.push({ nome, dados: metodo === 0 ? Buffer.from(comp) : inflateRawSync(comp) });
    p += 46 + nLen + xLen + cLen;
  }
  return saida;
}

export function escreverZip(arquivos: ArquivoZip[]): Buffer {
  const partes: Buffer[] = [], central: Buffer[] = [];
  let pos = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, "utf8");
    const comp = deflateRawSync(a.dados);
    const crc = crc32(a.dados) >>> 0;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(a.dados.length, 22); loc.writeUInt16LE(nome.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(a.dados.length, 24); cen.writeUInt16LE(nome.length, 28);
    cen.writeUInt32LE(pos, 42);
    partes.push(loc, nome, comp);
    central.push(cen, nome);
    pos += 30 + nome.length + comp.length;
  }
  const tamCentral = central.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12); fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...partes, ...central, fim]);
}

/** Configuração de um projeto 3MF salvo pelo OrcaSlicer ou Bambu Studio. */
export function configDo3mf(buf: Buffer): ConfigOrca {
  const cfg = lerZip(buf).find((a) => a.nome === "Metadata/project_settings.config");
  if (!cfg) throw new Error("Este 3MF não tem configuração do OrcaSlicer (Metadata/project_settings.config). Salve o projeto pelo OrcaSlicer.");
  return JSON.parse(cfg.dados.toString("utf8")) as ConfigOrca;
}

/** Lê a configuração de um G-code ou de um 3MF, pelo conteúdo. */
export function configDoArquivo(buf: Buffer): ConfigOrca {
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return configDo3mf(buf);
  return configDoGcode(buf.toString("utf8"));
}

/** Resumo legível da configuração, para a interface mostrar o que foi carregado. */
export function resumoDaConfig(cfg: ConfigOrca): Record<string, string> {
  const v = (k: string) => {
    const x = cfg[k];
    const s = Array.isArray(x) ? x[0] ?? "" : x ?? "";
    return s.split(";")[0].replace(/^"|"$/g, "");
  };
  return {
    impressora: v("printer_settings_id"),
    processo: v("print_settings_id"),
    filamento: v("filament_settings_id"),
    alturaCamada: v("layer_height"),
    bico: v("nozzle_diameter"),
    mesa: (Array.isArray(cfg.printable_area) ? cfg.printable_area.join(",") : cfg.printable_area ?? ""),
  };
}

// ---- montagem do 3MF ----

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Centro da área de impressão, a partir de printable_area ("0x0,220x0,220x220,0x220"). */
export function centroDaMesa(cfg: ConfigOrca): [number, number] {
  const bruto = cfg.printable_area ?? cfg.bed_shape;
  const txt = Array.isArray(bruto) ? bruto.join(",") : bruto ?? "";
  const pts = txt.split(",").map((p) => p.split("x").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 3) return [110, 110];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function montar3mf(tris: Triangulo[], nome: string, cfg: ConfigOrca, posicao?: [number, number]): Buffer {
  // Arredonda para float32, como um STL guarda os vértices: o resultado do fatiamento fica igual ao
  // de abrir o STL na interface do Orca (a detecção de pontes é sensível a diferenças mínimas).
  tris = tris.map((t) => t.map((p) => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])]) as Triangulo);
  // Solda vértices a 0,001 mm e descarta triângulos que ficaram degenerados.
  const indice = new Map<string, number>();
  const vert: string[] = [];
  const faces: string[] = [];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  for (const t of tris) {
    const ids = t.map((p) => {
      const k = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
      let i = indice.get(k);
      if (i === undefined) {
        i = vert.length;
        indice.set(k, i);
        vert.push(`<vertex x="${p[0] - c[0]}" y="${p[1] - c[1]}" z="${p[2] - c[2]}"/>`);
      }
      return i;
    });
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) faces.push(`<triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"/>`);
  }
  const [px, py] = posicao ?? centroDaMesa(cfg);
  const objeto = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n<resources>\n<object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">\n<mesh>\n<vertices>\n${vert.join("\n")}\n</vertices>\n<triangles>\n${faces.join("\n")}\n</triangles>\n</mesh>\n</object>\n</resources>\n<build/>\n</model>\n`;
  const modelo = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n<metadata name="Application">BambuStudio-02.08.01.55</metadata>\n<metadata name="OrcaSlicer">2.5.0</metadata>\n<metadata name="BambuStudio:3mfVersion">1</metadata>\n<resources>\n<object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n<components>\n<component p:path="/3D/Objects/peca.model" objectid="1" p:UUID="00010000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n</components>\n</object>\n</resources>\n<build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n<item objectid="2" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 ${px} ${py} ${c[2] - mn[2]}" printable="1"/>\n</build>\n</model>\n`;
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n<object id="2">\n<metadata key="name" value="${esc(nome)}"/>\n<metadata key="extruder" value="1"/>\n<part id="1" subtype="normal_part">\n<metadata key="name" value="${esc(nome)}"/>\n<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n</part>\n</object>\n<plate>\n<metadata key="plater_id" value="1"/>\n<metadata key="plater_name" value=""/>\n<metadata key="locked" value="false"/>\n<model_instance>\n<metadata key="object_id" value="2"/>\n<metadata key="instance_id" value="0"/>\n<metadata key="identify_id" value="100"/>\n</model_instance>\n</plate>\n</config>\n`;
  const config = { ...cfg };
  for (const [k, v] of Object.entries(AJUSTES_OBRIGATORIOS)) config[k] = Array.isArray(config[k]) ? (v === "" ? [] : [v]) : v;
  const arquivos: ArquivoZip[] = [
    { nome: "[Content_Types].xml", dados: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n<Default Extension="png" ContentType="image/png"/>\n<Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n`) },
    { nome: "_rels/.rels", dados: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`) },
    { nome: "3D/3dmodel.model", dados: Buffer.from(modelo) },
    { nome: "3D/_rels/3dmodel.model.rels", dados: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Target="/3D/Objects/peca.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`) },
    { nome: "3D/Objects/peca.model", dados: Buffer.from(objeto) },
    { nome: "Metadata/model_settings.config", dados: Buffer.from(modelSettings) },
    { nome: "Metadata/project_settings.config", dados: Buffer.from(JSON.stringify(config, null, 1)) },
  ];
  return escreverZip(arquivos);
}

// ---- execução ----

export function acharOrca(): string | null {
  const candidatos = [
    process.env.NAOPLANAR_ORCA,
    "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
    join(process.env.HOME ?? "", "Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"),
    "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe",
    "/usr/bin/orca-slicer",
    "/usr/local/bin/orca-slicer",
  ];
  for (const c of candidatos) if (c && existsSync(c)) return c;
  return null;
}

/** Fatia o 3MF e devolve o texto do G-code. */
export async function fatiarComOrca(arquivo3mf: Buffer, opcoes: { orca?: string; aoProgredir?: (linha: string) => void } = {}): Promise<string> {
  const orca = opcoes.orca ?? acharOrca();
  if (!orca) throw new Error("Não achei o OrcaSlicer. Instale em /Applications ou informe o caminho na variável NAOPLANAR_ORCA.");
  const pasta = mkdtempSync(join(tmpdir(), "naoplanar-"));
  try {
    const entrada = join(pasta, "peca.3mf");
    writeFileSync(entrada, arquivo3mf);
    const saida = join(pasta, "saida");
    mkdirSync(saida);
    // Pasta de dados própria, para não mexer na configuração do Orca do usuário.
    const dados = join(tmpdir(), "naoplanar-orca-dados");
    const log: string[] = [];
    const codigo = await new Promise<number | null>((ok, erro) => {
      const p = spawn(orca, ["--datadir", dados, "--slice", "0", "--outputdir", saida, entrada], { cwd: pasta, stdio: ["ignore", "pipe", "pipe"] }); // o Orca grava um log na pasta atual
      const ler = (b: Buffer) => {
        for (const l of b.toString().split("\n")) {
          if (!l.trim() || /^-?[\d.e-]+,-?[\d.e-]+ - /.test(l)) continue; // ruído de depuração do Orca
          log.push(l);
          opcoes.aoProgredir?.(l);
        }
      };
      p.stdout.on("data", ler);
      p.stderr.on("data", ler);
      p.on("error", erro);
      p.on("close", ok);
    });
    const gcodes = existsSync(saida) ? readdirSync(saida).filter((f) => f.endsWith(".gcode")) : [];
    if (codigo !== 0 || gcodes.length === 0) {
      const motivo = log.filter((l) => !/^Warning: inherits_group/.test(l)).slice(-4).join(" ").trim();
      throw new Error(`O OrcaSlicer não conseguiu fatiar a peça${motivo ? `: ${motivo}` : ` (código ${codigo})`}.`);
    }
    return readFileSync(join(saida, gcodes[0]), "utf8");
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}
