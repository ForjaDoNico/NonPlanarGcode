// Interface local do naoplanar: um servidor HTTP só para este computador (127.0.0.1) e uma página
// no navegador. Rode "node src/servidor.ts" (ou "npm run interface") e a página abre sozinha.
//
// Tudo fica na memória, para um usuário só. A configuração do Orca e o perfil do cabeçote ficam
// salvos em ~/.naoplanar, para não precisar carregar de novo na próxima vez.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { lerPerfil, pastaConfig, perfilFoiConfigurado, salvarPerfil, type Perfil } from "./config.ts";
import { acharOrca, configDoArquivo, resumoDaConfig, type ConfigOrca } from "./orca.ts";
import { processar, type ResultadoProcesso } from "./processo.ts";
import { lerStlDeBuffer, type Triangulo } from "./stl.ts";
import type { Ancora } from "./superficie.ts";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const PASTA_INTERFACE = join(RAIZ, "interface");
const caminhoConfigOrca = () => join(pastaConfig(), "orca-config.json");
const caminhoCabecoteStl = () => join(pastaConfig(), "cabecote.stl");

interface Estado {
  pecaNome: string | null;
  peca: Triangulo[] | null;
  config: ConfigOrca | null;
  configOrigem: string | null;
  resultado: ResultadoProcesso | null;
  ocupado: boolean;
}

const estado: Estado = { pecaNome: null, peca: null, config: null, configOrigem: null, resultado: null, ocupado: false };

function carregarConfigSalva() {
  if (!existsSync(caminhoConfigOrca())) return;
  try {
    const salvo = JSON.parse(readFileSync(caminhoConfigOrca(), "utf8")) as { origem: string; config: ConfigOrca };
    estado.config = salvo.config;
    estado.configOrigem = salvo.origem;
  } catch {
    // arquivo corrompido: o usuário carrega de novo
  }
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function corpo(req: IncomingMessage, limite = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((ok, erro) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on("data", (b: Buffer) => {
      total += b.length;
      if (total > limite) { erro(new Error("Arquivo grande demais.")); req.destroy(); return; }
      partes.push(b);
    });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", erro);
  });
}

function json(res: ServerResponse, codigo: number, dados: unknown) {
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dados));
}

function resumoDoEstado() {
  const perfil = lerPerfil();
  return {
    orca: acharOrca(),
    peca: estado.pecaNome,
    config: estado.config ? { origem: estado.configOrigem, ...resumoDaConfig(estado.config) } : null,
    perfil,
    perfilSalvo: perfilFoiConfigurado(),
    temCabecoteStl: !!perfil.cabecoteStl && existsSync(perfil.cabecoteStl),
  };
}

function resumoDoResultado(r: ResultadoProcesso) {
  const c = r.retransformacao.colisao;
  return {
    liberado: r.gcode !== null,
    colisao: c ? { colisoes: c.colisoes, primeira: c.primeira, pior: c.pior, folgaNecessaria: c.folgaNecessaria } : null,
    avisos: r.retransformacao.avisos,
    avisosCodigos: r.retransformacao.avisosCodigos,
    zMinimo: r.retransformacao.zMinimo,
    zMaximo: r.retransformacao.zMaximo,
    segmentos: r.retransformacao.segmentosGerados,
    espessura: { min: r.validacao.espessuraMin, max: r.validacao.espessuraMax },
    estimativa: r.estimativa,
    superficie: r.superficie,
    // Centro da peça na mesa (o eixo do cone menos o deslocamento dele em relação à peça).
    centroPeca: [r.retransformacao.centro[0] - r.centroRelativo[0], r.retransformacao.centro[1] - r.centroRelativo[1]],
  };
}

async function api(req: IncomingMessage, res: ServerResponse, rota: string, url: URL) {
  if (rota === "/api/estado" && req.method === "GET") return json(res, 200, resumoDoEstado());

  if (rota === "/api/peca" && req.method === "POST") {
    const buf = await corpo(req);
    const tris = lerStlDeBuffer(buf);
    if (tris.length === 0) throw new Error("O STL não tem triângulos.");
    estado.peca = tris;
    estado.pecaNome = (url.searchParams.get("nome") ?? "peca").replace(/\.stl$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_") || "peca";
    estado.resultado = null;
    return json(res, 200, resumoDoEstado());
  }

  if (rota === "/api/config" && req.method === "POST") {
    const buf = await corpo(req);
    const config = configDoArquivo(buf);
    estado.config = config;
    estado.configOrigem = url.searchParams.get("nome") ?? "arquivo";
    mkdirSync(pastaConfig(), { recursive: true });
    writeFileSync(caminhoConfigOrca(), JSON.stringify({ origem: estado.configOrigem, config }));
    return json(res, 200, resumoDoEstado());
  }

  if (rota === "/api/perfil" && req.method === "POST") {
    const mud = JSON.parse((await corpo(req)).toString("utf8")) as Partial<Perfil> & { removerCabecoteStl?: boolean };
    const permitidos: (keyof Perfil)[] = ["folga", "raioCabeca", "raioBico", "zMax", "segmento", "bico", "margem"];
    const limpo: Partial<Perfil> = {};
    for (const k of permitidos) if (mud[k] !== undefined) (limpo as Record<string, unknown>)[k] = mud[k];
    if (mud.removerCabecoteStl) { limpo.cabecoteStl = undefined; limpo.bico = undefined; }
    salvarPerfil(limpo);
    return json(res, 200, resumoDoEstado());
  }

  if (rota === "/api/cabecote-stl" && req.method === "POST") {
    const buf = await corpo(req);
    lerStlDeBuffer(buf); // valida
    mkdirSync(pastaConfig(), { recursive: true });
    writeFileSync(caminhoCabecoteStl(), buf);
    salvarPerfil({ cabecoteStl: caminhoCabecoteStl() });
    return json(res, 200, resumoDoEstado());
  }

  if (rota === "/api/cabecote-stl" && req.method === "GET") {
    const p = lerPerfil().cabecoteStl;
    if (!p || !existsSync(p)) return json(res, 404, { erro: "Nenhum STL do cabeçote salvo." });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return res.end(readFileSync(p));
  }

  if (rota === "/api/gerar" && req.method === "POST") {
    const pedido = JSON.parse((await corpo(req)).toString("utf8")) as { ancoras: Ancora[]; base: number; ignorarColisao?: boolean };
    if (!estado.peca) throw new Error("Carregue o STL da peça primeiro.");
    if (!estado.config) throw new Error("Carregue um G-code ou um 3MF do OrcaSlicer para usar as suas configurações.");
    if (estado.ocupado) throw new Error("Já há uma peça sendo processada.");
    estado.ocupado = true;
    estado.resultado = null;
    // Resposta em linhas JSON: uma por etapa e a última com o resultado.
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
    const enviar = (o: unknown) => res.write(JSON.stringify(o) + "\n");
    try {
      const r = await processar({
        tris: estado.peca,
        nome: estado.pecaNome ?? "peca",
        config: estado.config,
        ancoras: pedido.ancoras,
        base: pedido.base,
        perfil: lerPerfil(),
        ignorarColisao: !!pedido.ignorarColisao,
        aoProgredir: (etapa) => enviar({ etapa }),
      });
      estado.resultado = r;
      enviar({ resultado: resumoDoResultado(r) });
    } catch (e) {
      enviar({ erro: (e as Error).message });
    } finally {
      estado.ocupado = false;
      res.end();
    }
    return;
  }

  if (rota === "/api/previa" && req.method === "GET") {
    if (!estado.resultado) return json(res, 404, { erro: "Nada gerado ainda." });
    const p = estado.resultado.previa;
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return res.end(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
  }

  if (rota === "/api/gcode" && req.method === "GET") {
    const g = estado.resultado?.gcode;
    if (!g) return json(res, 404, { erro: "Não há G-code liberado para baixar." });
    const nome = `${estado.pecaNome ?? "peca"}.naoplanar.gcode`;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(nome)}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
    });
    return res.end(g);
  }

  json(res, 404, { erro: "Rota desconhecida." });
}

function arquivoEstatico(res: ServerResponse, rota: string) {
  // Os módulos de cálculo que a página também usa são servidos sem os tipos.
  if (rota === "/src/superficie.ts") {
    const ts = readFileSync(join(RAIZ, "src", "superficie.ts"), "utf8");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    return res.end(stripTypeScriptTypes(ts));
  }
  const relativo = rota === "/" ? "index.html" : rota.replace(/^\/+/, "");
  const caminho = normalize(join(PASTA_INTERFACE, relativo));
  if (!caminho.startsWith(PASTA_INTERFACE) || !existsSync(caminho)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Não encontrado.");
  }
  res.writeHead(200, { "Content-Type": TIPOS[extname(caminho)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(caminho));
}

export function iniciarServidor(porta: number): Promise<string> {
  carregarConfigSalva();
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url.pathname, url);
      else arquivoEstatico(res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { erro: (e as Error).message });
      else res.end();
    }
  });
  return new Promise((ok, erro) => {
    servidor.on("error", erro);
    servidor.listen(porta, "127.0.0.1", () => ok(`http://127.0.0.1:${porta}/`));
  });
}

function abrirNavegador(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* o endereço aparece no terminal */ }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("servidor.ts")) {
  const porta = Number(process.env.NAOPLANAR_PORTA ?? 8642);
  iniciarServidor(porta).then((url) => {
    console.log(`naoplanar: interface em ${url}`);
    console.log("Deixe este terminal aberto enquanto usa a interface. Ctrl+C encerra.");
    if (!process.argv.includes("--sem-abrir")) abrirNavegador(url);
  }).catch((e: Error) => {
    console.error(`Erro: não consegui abrir a interface na porta ${porta}: ${e.message}`);
    process.exit(1);
  });
}
