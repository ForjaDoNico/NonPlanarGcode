import { test } from "node:test";
import assert from "node:assert/strict";
import { centroDaMesa, configDoArquivo, configDoGcode, escreverZip, lerZip, montar3mf } from "../src/orca.ts";
import { previaDoGcode, processar } from "../src/processo.ts";
import type { Triangulo, Vec3 } from "../src/stl.ts";
import { PERFIL_PADRAO } from "../src/config.ts";

const gcodeComConfig = [
  "G1 X0 Y0", "; CONFIG_BLOCK_START", "; layer_height = 0.2", "; printer_settings_id = Ender Klipper",
  "; nozzle_diameter = 0.4,0.4", "; printable_area = 0x0,220x0,220x220,0x220", "; post_process = ", "; CONFIG_BLOCK_END",
].join("\n");

test("lê a configuração do fim de um G-code do Orca", () => {
  const c = configDoGcode(gcodeComConfig);
  assert.equal(c.layer_height, "0.2");
  assert.equal(c.nozzle_diameter, "0.4,0.4");
  assert.equal(c.post_process, "");
  assert.deepEqual(centroDaMesa(c), [110, 110]);
  assert.throws(() => configDoGcode("G1 X0"), /CONFIG_BLOCK/);
});

test("zip: o que é escrito é lido de volta", () => {
  const arquivos = [{ nome: "a.txt", dados: Buffer.from("olá ".repeat(100)) }, { nome: "pasta/b.bin", dados: Buffer.from([0, 1, 2, 255]) }];
  const lidos = lerZip(escreverZip(arquivos));
  assert.deepEqual(lidos.map((a) => a.nome), ["a.txt", "pasta/b.bin"]);
  assert.ok(lidos[0].dados.equals(arquivos[0].dados));
  assert.ok(lidos[1].dados.equals(arquivos[1].dados));
});

test("3MF: solda vértices quase iguais, força os ajustes e se identifica como do Orca", () => {
  const tris: Triangulo[] = [
    [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    [[10.0000001, 0, 0], [10, 10, 0], [0, 10.0000002, 0]],
  ];
  const zip = lerZip(montar3mf(tris, "peca.naoplanar", configDoGcode(gcodeComConfig)));
  const objeto = zip.find((a) => a.nome === "3D/Objects/peca.model")!.dados.toString();
  assert.equal(objeto.match(/<vertex /g)!.length, 4);
  assert.equal(objeto.match(/<triangle /g)!.length, 2);
  assert.match(zip.find((a) => a.nome === "3D/3dmodel.model")!.dados.toString(), /name="OrcaSlicer"/);
  const cfg = JSON.parse(zip.find((a) => a.nome === "Metadata/project_settings.config")!.dados.toString());
  assert.equal(cfg.enable_arc_fitting, "0");
  assert.equal(cfg.use_relative_e_distances, "1");
  assert.equal(cfg.gcode_label_objects, "1");
  assert.match(zip.find((a) => a.nome === "Metadata/model_settings.config")!.dados.toString(), /value="peca.naoplanar"/);
  // O próprio 3MF também serve de fonte de configuração.
  assert.equal(configDoArquivo(montar3mf(tris, "x", configDoGcode(gcodeComConfig))).layer_height, "0.2");
});

function caixa(l: number, h: number): Triangulo[] {
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const p = [v(0, 0, 0), v(l, 0, 0), v(l, l, 0), v(0, l, 0), v(0, 0, h), v(l, 0, h), v(l, l, h), v(0, l, h)];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.map(([a, b, c]) => [p[a], p[b], p[c]] as Triangulo);
}

test("processo completo com um fatiador falso: deforma, fatia, desfaz e checa colisão", async () => {
  let recebido: Buffer | null = null;
  // "Fatiador" que devolve um quadrado de 20 mm por camada, centrado na mesa, como o Orca faria.
  const fatiar = async (b: Buffer) => {
    recebido = b;
    const linhas = ["G90", "M83", "G1 Z0.2 F600", "G1 X100 Y100"];
    for (let z = 0.2; z <= 10.01; z += 0.2) {
      linhas.push(";LAYER_CHANGE", `;Z:${z.toFixed(1)}`, `G1 Z${z.toFixed(2)}`, ";TYPE:Outer wall",
        "G1 X100 Y100", "G1 X120 Y100 E1", "G1 X120 Y120 E1", "G1 X100 Y120 E1", "G1 X100 Y100 E1");
    }
    linhas.push(";TYPE:Custom", "; filament used [mm] = 123.4", "; estimated printing time (normal mode) = 5m 0s");
    return linhas.join("\n");
  };
  const etapas: string[] = [];
  const r = await processar({
    tris: caixa(20, 10), nome: "caixa", config: configDoGcode(gcodeComConfig),
    ancoras: [{ z: 0, forma: "cone", angulo: 10 }], base: 1,
    perfil: { ...PERFIL_PADRAO, folga: 20 }, fatiar, aoProgredir: (e) => etapas.push(e),
  });
  assert.ok(recebido, "o fatiador recebeu o 3MF");
  assert.equal(etapas.length, 4);
  assert.ok(r.gcode, "sem colisão, o G-code é liberado");
  assert.equal(r.retransformacao.colisao!.colisoes, 0);
  assert.equal(r.estimativa.filamentoMm, 123.4);
  assert.ok(r.previa.length > 0 && r.previa.length % 6 === 0);
  // Com folga mínima, a mesma peça colide e o G-code fica retido.
  const preso = await processar({
    tris: caixa(20, 10), nome: "caixa", config: configDoGcode(gcodeComConfig),
    ancoras: [{ z: 0, forma: "cone", angulo: 30 }], base: 1, perfil: { ...PERFIL_PADRAO, folga: 0.3 }, fatiar,
  });
  assert.equal(preso.gcode, null);
  assert.ok(preso.retransformacao.colisao!.colisoes > 0);
});

test("prévia limita o número de segmentos", () => {
  const linhas = ["G1 X0 Y0 Z0.2"];
  for (let i = 1; i <= 1000; i++) linhas.push(`G1 X${i} Y0 E0.1`);
  assert.equal(previaDoGcode(linhas.join("\n")).length / 6, 1000);
  assert.equal(previaDoGcode(linhas.join("\n"), 100).length / 6, 100);
});
