// Confere o G-code final do funil: cada ponto de extrusão deve estar dentro da peça original,
// e gera um corte lateral em SVG (plano Y = centro) com as camadas coloridas.
import { readFileSync, writeFileSync } from "node:fs";

const [arquivo, svgSaida, cx = "125", cy = "105"] = process.argv.slice(2);
const C = [Number(cx), Number(cy)];
const raioPerfil = (z: number) => (z <= 8 ? 6 : 6 + ((z - 8) * 24) / 20);
let tipo = "", x = 0, y = 0, z = 0, ativo = false, camada = 0, fora = 0, total = 0, piorFora = 0;
const corte: { x: number; z: number; c: number }[] = [];
for (const l of readFileSync(arquivo, "utf8").split("\n")) {
  if (l.startsWith(";LAYER_CHANGE")) { ativo = true; camada++; }
  if (l.startsWith(";TYPE:")) tipo = l.slice(6);
  if (tipo === "Custom") ativo = false;
  const m = /^G1 (.*)/.exec(l.split(";")[0]);
  if (!m) continue;
  const g = (k: string) => { const r = new RegExp(k + "(-?[\\d.]+)").exec(m[1]); return r ? Number(r[1]) : undefined; };
  const nx = g("X") ?? x, ny = g("Y") ?? y, nz = g("Z") ?? z, e = g("E");
  if (ativo && e !== undefined && e > 0 && (nx !== x || ny !== y) && tipo !== "Skirt/Brim") {
    total++;
    const r = Math.hypot(nx - C[0], ny - C[1]);
    const excesso = Math.max(r - raioPerfil(Math.min(nz, 28)) - 0.45, nz - 28.3, -nz);
    if (excesso > 0) { fora++; piorFora = Math.max(piorFora, excesso); }
    if (Math.abs(ny - C[1]) < 0.6) corte.push({ x: nx - C[0], z: nz, c: camada });
  }
  x = nx; y = ny; z = nz;
}
console.log(`pontos de extrusão: ${total}, fora da peça: ${fora} (pior: ${piorFora.toFixed(2)} mm), camadas: ${camada}`);
const W = 760, H = 420, esc = 11, ox = W / 2, oz = H - 40;
const pontos = corte.map((p) => `<circle cx="${(ox + p.x * esc).toFixed(1)}" cy="${(oz - p.z * esc).toFixed(1)}" r="1.6" fill="hsl(${(p.c * 7) % 360},70%,45%)"/>`).join("");
const contorno = [[-6, 0], [-6, 8], [-30, 28], [30, 28], [6, 8], [6, 0]].map(([a, b]) => `${ox + a * esc},${oz - b * esc}`).join(" ");
writeFileSync(svgSaida, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff;font-family:sans-serif">
<text x="16" y="24" font-size="15">Corte lateral do G-code final (camadas cônicas de 30°, base plana de 1 mm)</text>
<polygon points="${contorno}" fill="none" stroke="#999" stroke-dasharray="4 3"/>
<line x1="0" y1="${oz}" x2="${W}" y2="${oz}" stroke="#333"/>${pontos}</svg>`);
