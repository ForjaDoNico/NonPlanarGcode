// Leitura e escrita de arquivos STL (binário e ASCII).
import { readFileSync, writeFileSync } from "node:fs";

export type Vec3 = [number, number, number];
export type Triangulo = [Vec3, Vec3, Vec3];

export function lerStl(caminho: string): Triangulo[] {
  return lerStlDeBuffer(readFileSync(caminho));
}

export function lerStlDeBuffer(buf: Buffer): Triangulo[] {
  if (ehBinario(buf)) return lerBinario(buf);
  return lerAscii(buf.toString("utf8"));
}

function ehBinario(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  // Um STL binário tem tamanho exato 84 + 50 * n. Arquivos ASCII começam com "solid",
  // mas alguns binários também, então o tamanho é o critério confiável.
  return buf.length === 84 + 50 * n;
}

function lerBinario(buf: Buffer): Triangulo[] {
  const n = buf.readUInt32LE(80);
  const tris: Triangulo[] = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // pula a normal
    const v = (k: number): Vec3 => [
      buf.readFloatLE(o + k * 12),
      buf.readFloatLE(o + k * 12 + 4),
      buf.readFloatLE(o + k * 12 + 8),
    ];
    tris.push([v(0), v(1), v(2)]);
  }
  return tris;
}

function lerAscii(txt: string): Triangulo[] {
  const nums = [...txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Vec3,
  );
  if (nums.length % 3 !== 0) throw new Error("STL ASCII inválido: número de vértices não é múltiplo de 3");
  const tris: Triangulo[] = [];
  for (let i = 0; i < nums.length; i += 3) tris.push([nums[i], nums[i + 1], nums[i + 2]]);
  return tris;
}

export function escreverStl(caminho: string, tris: Triangulo[]): void {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write("naoplanar", 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const nrm = normal(t);
    nrm.forEach((c, k) => buf.writeFloatLE(c, o + k * 4));
    t.forEach((v, j) => v.forEach((c, k) => buf.writeFloatLE(c, o + 12 + j * 12 + k * 4)));
  });
  writeFileSync(caminho, buf);
}

function normal([a, b, c]: Triangulo): Vec3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

export function caixa(tris: Triangulo[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris)
    for (const v of t)
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
  return { min, max };
}
