import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buscarPeca, lerPerfil, nomeDaPeca, pecasNoGcode, registrarPeca, salvarPerfil, PERFIL_PADRAO } from "../src/config.ts";
import { criarMapeamento } from "../src/conico.ts";

const pasta = mkdtempSync(join(tmpdir(), "naoplanar-"));
process.env.NAOPLANAR_DIR = pasta;
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const rodar = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NAOPLANAR_DIR: pasta } });

test("nome da peça a partir do STL deformado", () => {
  assert.equal(nomeDaPeca("/x/benchy.naoplanar.stl"), "benchy");
  assert.equal(nomeDaPeca("Minha Peça.naoplanar.STL"), "Minha Peça");
});

test("acha a peça nos formatos de nome do OrcaSlicer e do Klipper", () => {
  const g = [
    "; printing object benchy.naoplanar.stl id:0 copy 0",
    "EXCLUDE_OBJECT_DEFINE NAME=benchy.naoplanar.stl_id_0_copy_0 CENTER=1,1",
    "EXCLUDE_OBJECT_START NAME=benchy_naoplanar_stl_id_0_copy_0",
  ].join("\n");
  assert.deepEqual(pecasNoGcode(g), ["benchy"]);
  assert.deepEqual(pecasNoGcode("; printing object cubo.stl id:0 copy 0"), []);
});

test("nome com espaço é encontrado no registro", () => {
  const params = { versao: 1 as const, anguloGraus: 15, deslocamentoZ: 0, centroRelativo: [0, 0] as [number, number], mapa: criarMapeamento(15, 1, 10) };
  registrarPeca("Minha Peca", params);
  const g = "EXCLUDE_OBJECT_START NAME=Minha_Peca_naoplanar_stl_id_0_copy_0\n; printing object Minha Peca.naoplanar.stl id:0 copy 0";
  const achadas = pecasNoGcode(g).map(buscarPeca).filter(Boolean);
  assert.equal(achadas.length, 1);
  assert.equal(achadas[0]!.params.anguloGraus, 15);
});

test("perfil: padrão sem arquivo, e salvar só muda o que foi informado", () => {
  assert.deepEqual(lerPerfil(), PERFIL_PADRAO);
  salvarPerfil({ folga: 7 });
  salvarPerfil({ zMax: 5 });
  assert.deepEqual(lerPerfil(), { ...PERFIL_PADRAO, folga: 7, zMax: 5 });
});

// G-code mínimo de uma peça "cubo.naoplanar.stl", como o OrcaSlicer exporta com Label objects.
function gcodeDaPeca(nome: string): string {
  const linhas = ["G90", "M83", "G1 X0 Y0 Z5 F600", "EXCLUDE_OBJECT_DEFINE NAME=" + nome + "_id_0_copy_0"];
  for (let c = 1; c <= 3; c++) {
    const z = (c * 0.2).toFixed(1);
    linhas.push(";LAYER_CHANGE", `;Z:${z}`, `G1 Z${z}`, `; printing object ${nome} id:0 copy 0`, ";TYPE:Outer wall",
      "G1 X90 Y90", "G1 X110 Y90 E1", "G1 X110 Y110 E1", "G1 X90 Y110 E1", "G1 X90 Y90 E1");
  }
  linhas.push(";TYPE:Custom", "G1 Z20");
  return linhas.join("\n");
}

test("script do Orca: acha a peça sozinho, transforma uma vez e não transforma de novo", () => {
  const params = { versao: 1 as const, anguloGraus: 10, deslocamentoZ: 3, centroRelativo: [0, 0] as [number, number], mapa: criarMapeamento(10, 0, 15) };
  registrarPeca("cubo", params);
  const arq = join(pasta, "cubo.gcode");
  writeFileSync(arq, gcodeDaPeca("cubo.naoplanar.stl"));
  const r1 = rodar("retransformar", arq);
  assert.equal(r1.status, 0, r1.stderr);
  const depois = readFileSync(arq, "utf8");
  assert.match(depois, /naoplanar: G-code ja transformado/);
  assert.match(depois, /G1 X90 Y90 Z/); // movimentos ganharam Z
  const r2 = rodar("retransformar", arq);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /já foi transformado/);
  assert.equal(readFileSync(arq, "utf8"), depois);
});

test("script do Orca: peça comum passa sem mudanças", () => {
  const arq = join(pasta, "comum.gcode");
  const original = gcodeDaPeca("cubo.stl");
  writeFileSync(arq, original);
  const r = rodar("retransformar", arq);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(arq, "utf8"), original);
});

test("script do Orca: sem nomes de peças, recusa e explica", () => {
  const arq = join(pasta, "sem-nome.gcode");
  writeFileSync(arq, "G90\n;LAYER_CHANGE\nG1 Z0.2\nG1 X1 Y1 E1\n");
  const r = rodar("retransformar", arq);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Label objects/);
});

test("comando perfil salva e mostra", () => {
  const r = rodar("perfil", "--folga", "6.5", "--z-max", "8");
  assert.equal(r.status, 0, r.stderr);
  const salvo = JSON.parse(readFileSync(join(pasta, "perfil.json"), "utf8"));
  assert.equal(salvo.folga, 6.5);
  assert.equal(salvo.zMax, 8);
  assert.match(execFileSync(process.execPath, [CLI, "perfil"], { encoding: "utf8", env: { ...process.env, NAOPLANAR_DIR: pasta } }), /"folga": 6.5/);
  assert.ok(existsSync(join(pasta, "pecas")));
});
