import { IDIOMAS, criarTradutor, idiomaInicial, textos } from "./textos.js";
import { criarVisor3d } from "./visor3d.js";
import { FORMAS, criarCampo, transicaoAutomatica, validarSuperficie } from "/src/superficie.ts";

let idioma = idiomaInicial();
let t = criarTradutor(idioma);
const $ = (id) => document.getElementById(id);

const estado = {
  peca: null, // { tris: Float32Array (9 por triângulo, coordenadas do modelo), min, max, centro, raio, amostras, nome }
  servidor: null,
  ancoras: [{ z: 0, forma: "cone", angulo: 8, direcao: 0 }],
  resultado: null,
  pecaInfo: null,
};

const visor = criarVisor3d($("canvas3d"));

// ---------- utilidades ----------

const fmt = (n, c = 1) => Number(n).toLocaleString(idioma === "pt-BR" ? "pt-BR" : "en-US", { minimumFractionDigits: c, maximumFractionDigits: c });

function mensagem(el, tipo, texto) {
  el.innerHTML = "";
  if (!texto) return;
  const d = document.createElement("div");
  d.className = `msg ${tipo}`;
  d.textContent = texto;
  el.appendChild(d);
}

async function chamar(rota, opcoes = {}) {
  let r;
  try { r = await fetch(rota, opcoes); } catch { throw new Error(t("erro.rede")); }
  const dados = await r.json();
  if (!r.ok) throw new Error(dados.erro ?? r.statusText);
  return dados;
}

function zonaDeArquivo(zona, entrada, aoEscolher) {
  zona.addEventListener("click", () => entrada.click());
  entrada.addEventListener("change", () => entrada.files[0] && aoEscolher(entrada.files[0]));
  zona.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("sobre"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("sobre"));
  zona.addEventListener("drop", (e) => {
    e.preventDefault();
    zona.classList.remove("sobre");
    if (e.dataTransfer.files[0]) aoEscolher(e.dataTransfer.files[0]);
  });
}

// ---------- STL no navegador ----------

function lerStl(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84 && 84 + 50 * dv.getUint32(80, true) === buf.byteLength) {
    const n = dv.getUint32(80, true);
    const tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
    return tris;
  }
  const texto = new TextDecoder().decode(buf);
  const nums = [...texto.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  return new Float32Array(nums);
}

function prepararPeca(tris, nome) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let e = 0; e < 3; e++) { min[e] = Math.min(min[e], tris[i + e]); max[e] = Math.max(max[e], tris[i + e]); }
  const centro = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  // Mesmas amostras que o servidor usa (conico.ts: amostrasDaPeca), para a transição e a validação baterem.
  let raio = 0;
  const vistos = new Set(), amostras = [];
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    raio = Math.max(raio, Math.hypot(x - centro[0], y - centro[1]));
    const k = `${Math.round(x * 2)},${Math.round(y * 2)}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    amostras.push([x - centro[0], y - centro[1]]);
  }
  const lim = 4000;
  const amostrasFinais = amostras.length <= lim ? amostras : Array.from({ length: lim }, (_, i) => amostras[Math.floor((i * amostras.length) / lim)]);
  return { tris, min, max, centro, raio, amostras: amostrasFinais, nome };
}

// ---------- superfície ----------

function lerBase() { return Math.max(0, Number($("base").value) || 0); }

function superficieAtual() {
  const p = estado.peca;
  if (!p) return null;
  const ancoras = estado.ancoras.map((a) => ({ ...a }));
  const base = lerBase();
  const primeira = [...ancoras].sort((a, b) => a.z - b.z)[0];
  const transicao = base > 0 ? transicaoAutomatica(primeira, p.raio, p.amostras) : 0;
  return { versao: 2, ancoras, base, transicao, raioPeca: p.raio };
}

function validar() {
  const el = $("validacao");
  const sup = superficieAtual();
  if (!sup) return mensagem(el, "aviso", t("validacao.semPeca"));
  const v = validarSuperficie(sup, estado.peca.amostras, estado.peca.max[2] - estado.peca.min[2]);
  if (!v.ok) mensagem(el, "erro", t(`validacao.${v.codigo}`, v.valores));
  else mensagem(el, "ok", t("validacao.ok", { min: fmt(v.espessuraMin * 100, 0), max: fmt(v.espessuraMax * 100, 0) }));
  return v.ok;
}

function desenharAncoras() {
  const corpo = $("ancoras");
  corpo.innerHTML = "";
  estado.ancoras.forEach((a, i) => {
    const tr = document.createElement("tr");
    const celula = (el) => { const td = document.createElement("td"); td.appendChild(el); tr.appendChild(td); return el; };
    const num = (valor, passo, aoMudar, largura = "58px") => {
      const inp = document.createElement("input");
      inp.type = "number"; inp.step = passo; inp.value = valor; inp.style.width = largura;
      inp.addEventListener("input", () => { aoMudar(Number(inp.value) || 0); atualizar(); });
      return inp;
    };
    celula(num(a.z, 1, (v) => { a.z = v; }));
    const sel = document.createElement("select");
    for (const f of FORMAS) { const o = document.createElement("option"); o.value = f; o.textContent = t(`forma.${f}`); sel.appendChild(o); }
    sel.value = a.forma;
    sel.addEventListener("change", () => { a.forma = sel.value; desenharAncoras(); atualizar(); });
    celula(sel);
    celula(num(a.angulo, 1, (v) => { a.angulo = Math.max(-45, Math.min(45, v)); }, "50px"));
    const dir = celula(num(a.direcao ?? 0, 15, (v) => { a.direcao = v; }, "50px"));
    dir.disabled = !["piramide", "cunha", "inclinado"].includes(a.forma);
    const rem = document.createElement("button");
    rem.className = "mini"; rem.textContent = "×"; rem.title = t("ancora.remover");
    rem.disabled = estado.ancoras.length === 1;
    rem.addEventListener("click", () => { estado.ancoras.splice(i, 1); desenharAncoras(); atualizar(); });
    celula(rem);
    corpo.appendChild(tr);
  });
}

const PREDEFINICOES = {
  cone8: () => ({ base: 1, ancoras: [{ z: 0, forma: "cone", angulo: 8, direcao: 0 }] }),
  cone15: () => ({ base: 1, ancoras: [{ z: 0, forma: "cone", angulo: 15, direcao: 0 }] }),
  plano: () => ({ base: 0, ancoras: [{ z: 0, forma: "cone", angulo: 0, direcao: 0 }] }),
  funil: () => {
    const h = estado.peca ? estado.peca.max[2] - estado.peca.min[2] : 30;
    return { base: 1, ancoras: [{ z: Math.round(h * 0.25), forma: "cone", angulo: 0, direcao: 0 }, { z: Math.round(h * 0.75), forma: "cone", angulo: 10, direcao: 0 }] };
  },
};

function montarPredefinicoes() {
  const sel = $("predefinicao");
  sel.innerHTML = "";
  const vazio = document.createElement("option"); vazio.value = ""; vazio.textContent = t("predef.titulo"); sel.appendChild(vazio);
  for (const k of Object.keys(PREDEFINICOES)) { const o = document.createElement("option"); o.value = k; o.textContent = t(`predef.${k}`); sel.appendChild(o); }
}

function ligarPredefinicoes() {
  const sel = $("predefinicao");
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    const p = PREDEFINICOES[sel.value]();
    estado.ancoras = p.ancoras;
    $("base").value = p.base;
    sel.value = "";
    desenharAncoras();
    atualizar();
  });
}

// ---------- corte lateral ----------

function desenharCorte() {
  const canvas = $("canvasCorte");
  const w = canvas.clientWidth * devicePixelRatio, h = canvas.clientHeight * devicePixelRatio;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const escuro = matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.fillStyle = escuro ? "#1f1f1d" : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const p = estado.peca;
  if (!p) return;
  const fi = (Number($("direcaoCorte").value) * Math.PI) / 180;
  const ux = Math.cos(fi), uy = Math.sin(fi);
  const nx = -uy, ny = ux;
  // Segmentos do contorno: triângulos cortados pelo plano vertical que passa pelo eixo.
  const segs = [];
  const tr = p.tris;
  for (let i = 0; i < tr.length; i += 9) {
    const pts = [0, 1, 2].map((k) => {
      const x = tr[i + k * 3] - p.centro[0], y = tr[i + k * 3 + 1] - p.centro[1], z = tr[i + k * 3 + 2] - p.min[2];
      // O deslocamento mínimo evita que o plano passe exatamente pelos vértices (comum em peças
      // de revolução, com vértices em y = 0), o que faria triângulos sumirem do corte.
      return { d: x * nx + y * ny + 1e-4, s: x * ux + y * uy, z };
    });
    const cruzam = [];
    for (let k = 0; k < 3; k++) {
      const a = pts[k], b = pts[(k + 1) % 3];
      if ((a.d < 0) !== (b.d < 0)) { const f = a.d / (a.d - b.d); cruzam.push([a.s + (b.s - a.s) * f, a.z + (b.z - a.z) * f]); }
    }
    if (cruzam.length === 2) segs.push(cruzam);
  }
  const R = p.raio * 1.05 || 1, H = p.max[2] - p.min[2];
  const margem = 30 * devicePixelRatio;
  const escala = Math.min((w - 2 * margem) / (2 * R), (h - 2 * margem) / (H * 1.15 || 1));
  const X = (s) => w / 2 + s * escala, Y = (z) => h - margem - z * escala;

  // Mesa
  ctx.strokeStyle = escuro ? "#55554f" : "#c9c9c2";
  ctx.lineWidth = 1 * devicePixelRatio;
  ctx.beginPath(); ctx.moveTo(X(-R * 1.1), Y(0)); ctx.lineTo(X(R * 1.1), Y(0)); ctx.stroke();

  // Camadas, só onde há material (paridade dos cruzamentos de cada coluna).
  const sup = superficieAtual();
  const v = sup && validarSuperficie(sup, p.amostras, H);
  if (sup && v.ok) {
    const campo = criarCampo(sup);
    const colunas = 320;
    const cruzamentos = [];
    for (let c = 0; c <= colunas; c++) {
      const s = -R + (2 * R * c) / colunas;
      const zs = [];
      for (const [[s1, z1], [s2, z2]] of segs) if ((s1 <= s) !== (s2 <= s)) zs.push(z1 + ((z2 - z1) * (s - s1)) / (s2 - s1));
      zs.sort((a, b) => a - b);
      cruzamentos.push({ s, zs });
    }
    const dentro = (zs, z) => { let n = 0; for (const q of zs) if (q > z) n++; return n % 2 === 1; };
    let zlMin = Infinity, zlMax = -Infinity;
    for (const [dx, dy] of p.amostras) {
      zlMin = Math.min(zlMin, campo.paraDeformado(dx, dy, 0));
      zlMax = Math.max(zlMax, campo.paraDeformado(dx, dy, H));
    }
    const alturaCamada = Number(estado.servidor?.config?.alturaCamada) || 0.2;
    const cada = Math.max(1, Math.ceil((zlMax - zlMin) / alturaCamada / 70));
    ctx.strokeStyle = escuro ? "#6fbf93" : "#2f6f4f";
    ctx.lineWidth = 1 * devicePixelRatio;
    for (let zl = Math.ceil(zlMin / alturaCamada) * alturaCamada; zl <= zlMax; zl += alturaCamada * cada) {
      ctx.beginPath();
      let aberto = false;
      for (const { s, zs } of cruzamentos) {
        const z = campo.paraReal(s * ux, s * uy, zl);
        if (zs.length && dentro(zs, z)) {
          if (aberto) ctx.lineTo(X(s), Y(z)); else { ctx.moveTo(X(s), Y(z)); aberto = true; }
        } else aberto = false;
      }
      ctx.stroke();
    }
    $("legendaCorte").textContent = t("vista.legendaCorte", { n: cada, mm: fmt(alturaCamada * cada, 1) });
  }

  // Contorno da peça
  ctx.strokeStyle = escuro ? "#ececea" : "#1d1d1b";
  ctx.lineWidth = 1.6 * devicePixelRatio;
  ctx.beginPath();
  for (const [[s1, z1], [s2, z2]] of segs) { ctx.moveTo(X(s1), Y(z1)); ctx.lineTo(X(s2), Y(z2)); }
  ctx.stroke();
}

let pendente = 0;
function atualizar() {
  validar();
  cancelAnimationFrame(pendente);
  pendente = requestAnimationFrame(desenharCorte);
}

// ---------- servidor: estado, peça, configuração, perfil ----------

function mostrarEstado(s) {
  estado.servidor = s;
  $("infoConfig").innerHTML = s.config
    ? `${t("config.info", s.config)}<br>${t("config.origem", { origem: s.config.origem })}`
    : t("config.falta");
  mensagem($("infoOrca"), s.orca ? "ok" : "erro", s.orca ? t("orca.achado", { caminho: s.orca }) : t("orca.falta"));
  const pf = s.perfil;
  for (const k of ["folga", "raioCabeca", "raioBico", "zMax"]) $(k).value = pf[k];
  $("margem").value = pf.margem ?? 0;
  $("bico").value = pf.bico ? pf.bico.join(", ") : "";
  $("infoDuto").textContent = s.temCabecoteStl ? pf.cabecoteStl : "";
  $("resumoCabecote").textContent = s.perfilSalvo
    ? t("cabecote.resumo", { folga: fmt(pf.folga), margem: fmt(pf.margem ?? 0), duto: s.temCabecoteStl && pf.bico ? t("cabecote.comDuto") : "" })
    : t("cabecote.semPerfil");
  if (!s.perfilSalvo) $("detalhesCabecote").open = true;
}

async function carregarPeca(arquivo) {
  const buf = await arquivo.arrayBuffer();
  const tris = lerStl(buf);
  estado.peca = prepararPeca(tris, arquivo.name);
  const p = estado.peca;
  estado.pecaInfo = { nome: arquivo.name, x: p.max[0] - p.min[0], y: p.max[1] - p.min[1], z: p.max[2] - p.min[2], tris: tris.length / 9 };
  mostrarPecaInfo();
  visor?.definirMalha(tris);
  visor?.limparLinhas();
  $("resultado").innerHTML = "";
  atualizar();
  try {
    mostrarEstado(await chamar(`/api/peca?nome=${encodeURIComponent(arquivo.name)}`, { method: "POST", body: buf }));
  } catch (e) { mensagem($("infoPeca"), "erro", e.message); }
}

function mostrarPecaInfo() {
  if (estado.pecaInfo) $("infoPeca").textContent = t("peca.info", estado.pecaInfo);
}

async function carregarConfig(arquivo) {
  try {
    mostrarEstado(await chamar(`/api/config?nome=${encodeURIComponent(arquivo.name)}`, { method: "POST", body: await arquivo.arrayBuffer() }));
    atualizar();
  } catch (e) { mensagem($("infoConfig"), "erro", e.message); }
}

async function carregarDuto(arquivo) {
  try {
    mostrarEstado(await chamar("/api/cabecote-stl", { method: "POST", body: await arquivo.arrayBuffer() }));
    mensagem($("msgPerfil"), "ok", t("cabecote.duto.ok"));
  } catch (e) { mensagem($("msgPerfil"), "erro", e.message); }
}

async function salvarPerfil(extra = {}) {
  const bicoTxt = $("bico").value.trim();
  const bico = bicoTxt ? bicoTxt.split(/[,;\s]+/).map(Number) : undefined;
  if (bico && (bico.length !== 3 || !bico.every(Number.isFinite))) return mensagem($("msgPerfil"), "erro", "x, y, z");
  const dados = {
    folga: Number($("folga").value), margem: Number($("margem").value), raioCabeca: Number($("raioCabeca").value),
    raioBico: Number($("raioBico").value), zMax: Number($("zMax").value), ...(bico ? { bico } : {}), ...extra,
  };
  try {
    mostrarEstado(await chamar("/api/perfil", { method: "POST", body: JSON.stringify(dados) }));
    mensagem($("msgPerfil"), "ok", t("cabecote.salvo"));
  } catch (e) { mensagem($("msgPerfil"), "erro", e.message); }
}

// ---------- gerar ----------

async function gerar(ignorarColisao = false) {
  const res = $("resultado");
  res.innerHTML = "";
  if (!estado.peca) return mensagem(res, "erro", t("gerar.faltaPeca"));
  if (!estado.servidor?.config) return mensagem(res, "erro", t("gerar.faltaConfig"));
  if (!validar()) return;
  $("gerar").disabled = true;
  $("progresso").textContent = "";
  try {
    const r = await fetch("/api/gerar", { method: "POST", body: JSON.stringify({ ancoras: estado.ancoras, base: lerBase(), ignorarColisao }) });
    if (!r.ok) throw new Error((await r.json()).erro);
    const leitor = r.body.getReader();
    const dec = new TextDecoder();
    let resto = "", final = null;
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      resto += dec.decode(value, { stream: true });
      const linhas = resto.split("\n");
      resto = linhas.pop();
      for (const l of linhas) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.etapa) $("progresso").textContent = `${t(`etapa.${m.etapa}`)}…`;
        if (m.erro) throw new Error(m.erro);
        if (m.resultado) final = m.resultado;
      }
    }
    $("progresso").textContent = "";
    if (final) { estado.resultado = final; mostrarResultado(final); await carregarPrevia(final); }
  } catch (e) {
    $("progresso").textContent = "";
    mensagem(res, "erro", e.message ?? t("erro.rede"));
  } finally {
    $("gerar").disabled = false;
  }
}

function mostrarResultado(r) {
  const res = $("resultado");
  res.innerHTML = "";
  const c = r.colisao;
  if (!c) mensagem(res, "aviso", t("res.semChecagem"));
  else if (c.colisoes === 0) mensagem(res, "ok", t("res.semColisao"));
  else {
    const caixa = document.createElement("div");
    res.appendChild(caixa);
    mensagem(caixa, "erro", t("res.colisao", { n: c.colisoes, z: c.primeira.z, dist: c.primeira.distancia }));
  }
  for (const a of r.avisosCodigos) { const d = document.createElement("div"); res.appendChild(d); mensagem(d, "aviso", t(`aviso.${a.codigo}`, a.valores)); }
  const dl = document.createElement("dl");
  const item = (rotulo, valor) => { const dt = document.createElement("dt"); dt.textContent = rotulo; const dd = document.createElement("dd"); dd.textContent = valor; dl.append(dt, dd); };
  item(t("res.altura"), t("res.alturaValor", { min: fmt(r.zMinimo, 2), max: fmt(r.zMaximo, 2) }));
  item(t("res.camadas"), t("res.camadasValor", { min: fmt(r.espessura.min * 100, 0), max: fmt(r.espessura.max * 100, 0) }));
  if (r.estimativa.tempo) item(t("res.estimativa"), t("res.estimativaValor", { tempo: r.estimativa.tempo, fil: fmt((r.estimativa.filamentoMm ?? 0) / 1000, 2) }));
  item(t("res.segmentos"), fmt(r.segmentos, 0));
  res.appendChild(dl);
  const botoes = document.createElement("div");
  botoes.className = "linha-botoes";
  if (r.liberado) {
    const a = document.createElement("a");
    a.href = "/api/gcode";
    const b = document.createElement("button");
    b.className = "principal"; b.textContent = t("res.baixar");
    a.appendChild(b); a.style.flex = "1";
    botoes.appendChild(a);
  } else if (c && c.colisoes > 0) {
    const b = document.createElement("button");
    b.textContent = t("gerar.ignorar");
    b.addEventListener("click", () => gerar(true));
    botoes.appendChild(b);
  }
  res.appendChild(botoes);
}

async function carregarPrevia(r) {
  // Prévia do caminho no 3D, com a peça na posição da mesa.
  try {
    const bin = await fetch("/api/previa").then((x) => x.arrayBuffer());
    const segs = new Float32Array(bin);
    if (visor && estado.peca && segs.length) {
      const p = estado.peca;
      const dx = r.centroPeca[0] - p.centro[0], dy = r.centroPeca[1] - p.centro[1], dz = -p.min[2];
      const movida = new Float32Array(p.tris.length);
      for (let i = 0; i < movida.length; i += 3) { movida[i] = p.tris[i] + dx; movida[i + 1] = p.tris[i + 1] + dy; movida[i + 2] = p.tris[i + 2] + dz; }
      visor.definirMalha(movida);
      visor.definirLinhas(segs);
      trocarAba("3d");
    }
  } catch { /* a prévia é opcional */ }
}

// ---------- abas ----------

function trocarAba(qual) {
  const corte = qual === "corte";
  $("abaCorte").classList.toggle("ativa", corte);
  $("aba3d").classList.toggle("ativa", !corte);
  $("telaCorte").classList.toggle("oculto", !corte);
  $("tela3d").classList.toggle("oculto", corte);
  $("controleCorte").classList.toggle("oculto", !corte);
  $("controle3d").classList.toggle("oculto", corte);
  if (corte) desenharCorte(); else visor?.desenhar();
}

// ---------- ligações ----------

zonaDeArquivo($("soltarPeca"), $("arquivoPeca"), carregarPeca);
zonaDeArquivo($("soltarConfig"), $("arquivoConfig"), carregarConfig);
zonaDeArquivo($("soltarDuto"), $("arquivoDuto"), carregarDuto);
$("novaAncora").addEventListener("click", () => {
  const ult = estado.ancoras[estado.ancoras.length - 1];
  estado.ancoras.push({ ...ult, z: ult.z + 10 });
  desenharAncoras();
  atualizar();
});
$("base").addEventListener("input", atualizar);
$("salvarPerfil").addEventListener("click", () => salvarPerfil());
$("removerDuto").addEventListener("click", () => salvarPerfil({ removerCabecoteStl: true }));
$("gerar").addEventListener("click", () => gerar(false));
$("abaCorte").addEventListener("click", () => trocarAba("corte"));
$("aba3d").addEventListener("click", () => trocarAba("3d"));
$("direcaoCorte").addEventListener("input", () => { $("direcaoValor").textContent = `${$("direcaoCorte").value}°`; desenharCorte(); });
$("mostrarCaminho").addEventListener("change", () => visor?.mostrar($("mostrarPeca").checked, $("mostrarCaminho").checked));
$("mostrarPeca").addEventListener("change", () => visor?.mostrar($("mostrarPeca").checked, $("mostrarCaminho").checked));
new ResizeObserver(() => { if (!$("telaCorte").classList.contains("oculto")) desenharCorte(); }).observe($("telaCorte"));

// ---------- idioma ----------

function aplicarIdioma(novo) {
  idioma = novo;
  t = criarTradutor(idioma);
  localStorage.setItem("naoplanar.idioma", idioma);
  document.documentElement.lang = idioma;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  $("subtitulo").textContent = t("subtitulo");
  $("legenda3d").textContent = t("vista.legenda3d");
  $("rotuloIdioma").textContent = t("idioma");
  montarPredefinicoes();
  desenharAncoras();
  mostrarPecaInfo();
  if (estado.servidor) mostrarEstado(estado.servidor);
  if (estado.resultado) mostrarResultado(estado.resultado);
  atualizar();
}

const seletorIdioma = $("idioma");
for (const id of IDIOMAS) { const o = document.createElement("option"); o.value = id; o.textContent = textos[id].nomeDoIdioma; seletorIdioma.appendChild(o); }
seletorIdioma.value = idioma;
seletorIdioma.addEventListener("change", () => aplicarIdioma(seletorIdioma.value));

ligarPredefinicoes();
aplicarIdioma(idioma);
chamar("/api/estado").then(mostrarEstado).catch((e) => mensagem($("infoOrca"), "erro", e.message));
atualizar();
