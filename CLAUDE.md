# naoplanar: context for Claude Code

Open source non-planar slicing for 3-axis 3D printers, focused on macOS. The interface is in English and Portuguese (PT-BR); the CLI, code, names, messages and comments are in Portuguese.

## How it works
1. `src/conico.ts`: deforms the STL (z' = z + r·tan θ, with an optional flat base) and has the inverse mapping. `deformarComSuperficie` does the same with any surface from `superficie.ts`.
2. The mesh is sliced flat by OrcaSlicer (through its GUI, or its CLI via `orca.ts`).
3. `src/gcode.ts`: undoes the deformation in the G-code, splitting each move into segments of at most 1 mm.
- `src/superficie.ts`: layer surfaces (cone, pyramid, wedge, tilted, dome) and anchors by height. Between anchors it blends the height H, never the angle (blending angles makes neighbouring layers cross). Validation keeps real layers between 0.5× and 2× the configured height. No Node imports: the web page imports the same file (the server strips types with `stripTypeScriptTypes`). Saved parameters version 2 (`superficie`); version 1 (`mapa`) still works.
- `src/colisao.ts`: print head collision check (height map) and Z speed warning, called by `retransformar`.
- `src/cabecote.ts`: real shape of part of the print head from an STL (`perfil --cabecote-stl --bico x,y,z`). Each neighbour uses min(general clearance, shape clearance). `processo.ts: cabecoteDoPerfil` applies the safety margin (`margem`) to both.
- `src/topo.ts`: smooth top mode (`--topo-liso`).
- `src/config.ts`: printer profile (`~/.naoplanar/perfil.json`) and registry of deformed parts (`~/.naoplanar/pecas/<name>.json`), which lets `retransformar` run as an OrcaSlicer post-processing script. Folder overridden by `NAOPLANAR_DIR` (used in tests).
- `src/orca.ts`: reads the settings from a G-code (CONFIG_BLOCK, values kept as text) or a 3MF, builds a 3MF (own zip with zlib; vertices rounded to float32 and welded at 0.001 mm; the `OrcaSlicer` metadata line is required or Orca refuses the file) and slices with `OrcaSlicer --datadir <tmp> --slice 0`, run from a temp folder because Orca writes a log into the current directory. Forces arc fitting off, relative E and object labels.
- `src/processo.ts`: STL → deform → 3MF → Orca → transform back → collision → preview. Progress steps and warnings are sent as codes so the interface can translate them.
- `src/servidor.ts` + `interface/`: local page (`npm run interface`, port 8642, 127.0.0.1 only), no dependencies; own WebGL viewer and a side cut showing the layers. Texts in `interface/textos.js` (keys identical for `pt-BR` and `en`; language dropdown stored in localStorage).
- `src/cli.ts`: commands `deformar`, `retransformar` and `perfil`. `src/stl.ts`: STL read/write.
- `ferramentas/`: test model generator (funnel) and a checker that draws a side cut as SVG.

## Conventions
- TypeScript run directly by Node 22.18+ (type stripping), no build and no dependencies. Erasable syntax only (no enum, no namespace).
- Code names, CLI messages and comments in Portuguese. Documentation (README, this file) in English. Every interface text goes through `textos.js` in both languages.
- Tests: `npm test` (node:test). The interface was checked with headless Chrome over the DevTools protocol (the Chrome extension was not connected).

## Plan
1. Research and command-line prototype: **done**.
2. Core: collision check, printer profile, automatic OrcaSlicer script and smooth top: **done** (PRs #2 to #5). No cos θ compensation is needed: the volume between non-planar layers equals that of flat ones.
3. Interface: **done** on branch `etapa3/interface` (local page + Orca CLI + surfaces with anchors + EN/PT). Next: real print tests, .dmg app.
4. Open source release: GitHub, MIT license, .dmg installer.

## Current limitations
No G2/G3 arcs, no G91 inside layers, one surface axis per part (vertical only), travel moves rise and fall with the surface. The collision check models the head as a thin nozzle plus a plane at `--folga` mm (or the duct STL), up to `--raio-cabeca` mm.

## Fixed behaviour (do not revert without a reason)
- `fmt` only strips zeros after the decimal point. It used to turn `F1200` into `F12`.
- Base transition: T = r·|tan| for θ > 0 and 2·r·|tan| for θ < 0, with r = real vertex radius. A shorter T thins the layer (down to half at the edge), so extrusion is compensated (relative E only).
- The transformation ends at the first end-code marker after the last layer that is not followed by another feature type. `;TYPE:Custom` mid-print does not end anything.
- Extrusion below the bed is an error. Travel below 0.2 mm is raised to 0.2 mm with a warning.
- Moves are copied unchanged until X, Y and Z are known, because the nozzle is wherever the `PRINT_START` macro left it.
- `deformar` warns when θ > 0 without `--base`.

## User's printer and profile
Ender-3 V3 SE with Klipper, custom print head with a wide printed shroud and a side duct ("5015 selftap", side outlets with a 27 × 14 mm gap around the nozzle; STL in `~/Downloads/5015 selftap.stl`). OrcaSlicer 2.5: machine `Ender Klipper`, process `0.20mm Klipper RAPIDAO Cotrim`, filament `ABS Cotrim` (fan up to 80%). Z limited to 5 mm/s in the profile. G-code uses `PRINT_START`/`PRINT_END` macros and `EXCLUDE_OBJECT`. Source G-codes and 3MFs are in `~/Downloads`. The real `~/.naoplanar` profile has not been created yet.

## Duct calibration (2026-11-08)
- First real print: 15° funnel, the duct touched at Z 17.67 mm.
- With the nozzle at (10.9, 6.2, −27.65) in the duct STL, the current code predicts first contact at Z 21.8, not 17.6 as PR #5 and the old README claimed. Matching 17.67 needs the nozzle at Z −27.4 (effective clearance 3.85 mm). The prediction is very sensitive: 0.3 mm less moves first contact to Z 17.
- With the calibrated nozzle, funnel margins to the duct: 14° collides (Z 23.6); 10° 1.1 mm; 9° 1.3 mm; 8° 1.5 mm; 7° 1.75 mm.
- The 15° print went through 3.37 mm of material above the tip (30 mm radius) without the rest of the head touching.
- **The 8° funnel (`exemplos/funil-8graus.final.gcode`, checked with nozzle Z −25.9 = calibrated + 1.5 mm, `--folga 3.4`) also collided in the real print.** The user has not said where (Z, which part, which side). Until then the duct model is not trustworthy. The user is considering removing the duct and printing ABS without the fan.

## Files in `exemplos/` (all with `--base 1`; `.gcode` files are not tracked)
- `funil-8graus.final.gcode`: collided in the real print (see above).
- `funil-15graus.final.gcode`: printed, hit the duct at Z 17.67.
- `funil-30graus.final.gcode`: needs more than 12 mm of clearance.
- `benchy-15graus.final.gcode`: correct shape. `benchy-15graus-SO-VISUALIZAR.gcode`: flat Benchy transformed without `deformar`, distorted. **Do not print.**
- `colaquente-0graus.gcode` / `colaquente-25graus.gcode`: glue-gun snap clip (18 × 7 × 8 mm, two 4 mm split pins) from `~/Downloads/colaquente.3mf`, flat and 25° cone, same settings, for a break test. 25° passes the check with at most 1.8 mm of material above the tip. Expected gain is modest (~18% by a 40%-joint-strength estimate, not measured); more walls (pins are 4 mm, profile has 2 walls), less fan and printing on its side would matter more.

## Measured results (older)
| | Funnel 30° | Funnel 15° | Benchy 15° |
|---|---|---|---|
| Extrusion points outside the part | 0 of 162,636 | 0 of 135,636 | 15 of 187,684, up to 0.1 mm |
| Max slope | 30.3° | 15.5° | 20.2° |
| Material above the nozzle tip (max) | 9.9 mm | 6.0 mm | 6.8 mm (measured up to 30 mm from the nozzle) |
| Total extrusion after compensation | 94.0% | 99.4% | 92.4% |

## To do, in order
1. Find out where the 8° funnel collided and fix the duct model, or drop the duct (fan off for ABS) and measure the rest of the head: printer cold, Z at 10 mm, measure from the bed to the lowest part excluding the nozzle, subtract 10.
2. User to report `max_z_velocity` from `printer.cfg`.
3. Break test of the glue clip, flat vs. 25°.
4. Replace the side-cut image in the README (needs the user's approval).
5. .dmg app.
