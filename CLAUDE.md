# naoplanar: contexto para o Claude Code

Projeto open source de fatiamento não planar (camadas cônicas) para impressoras 3D de 3 eixos, em português (PT-BR), com foco em macOS. Inspirado no Boxily (boxily.at), que só roda no Windows e tem problemas de tradução.

## Como funciona
1. `src/conico.ts`: deforma o STL (z' = z + r·tan θ, com base plana opcional) e tem o mapeamento inverso.
2. O usuário fatia a malha deformada no OrcaSlicer (camadas planas).
3. `src/gcode.ts`: desfaz a deformação no G-code, quebrando cada movimento em segmentos de até 1 mm.
- `src/colisao.ts`: checagem de colisão do cabeçote (mapa de alturas) e aviso de velocidade do Z, chamada pelo `retransformar`.
- `src/config.ts`: perfil da impressora (`~/.naoplanar/perfil.json`) e registro das peças deformadas (`~/.naoplanar/pecas/<nome>.json`). O `retransformar` sem `--params` acha a peça pelo nome `<nome>.naoplanar` no G-code, o que permite usá-lo como script de pós-processamento do OrcaSlicer. Pasta sobreposta por `NAOPLANAR_DIR` (usado nos testes).
- `src/cli.ts`: comandos `deformar`, `retransformar` e `perfil`. `src/stl.ts`: leitura e escrita de STL.
- `ferramentas/`: gerador do modelo de teste (funil) e verificador que gera um corte lateral em SVG.

## Convenções
- TypeScript executado direto pelo Node 22.18+ (type stripping), sem build e sem dependências. Use só sintaxe apagável (sem enum, sem namespace).
- Nomes, mensagens e comentários em português.
- Testes: `npm test` (node:test).

## Plano
1. Pesquisa e protótipo de linha de comando: **feito**, testado com G-code real do OrcaSlicer, ainda sem teste em impressora real.
2. Motor principal: checagem de colisão do bico, perfis de impressora, modo de topo que segue a superfície (hoje topos planos saem em degraus), compensação de extrusão do efeito cos θ (a da transição já existe).
3. App para Mac em PT-BR (i18n desde o início) e integração como script de pós-processamento do OrcaSlicer.
4. Lançamento open source: GitHub, licença MIT, instalador .dmg, documentação em PT-BR.

## Limitações atuais
Sem arcos G2/G3 (desativar Arc fitting), sem G91 dentro das camadas, um eixo de cone por peça, travels sobem e descem junto com o cone. A checagem de colisão modela o cabeçote como bico fino + plano a `--folga` mm, até `--raio-cabeca` mm.

## Estado em 2026-11-06
Nada desta sessão foi commitado: há mudanças em `src/`, `test/`, `README.md` e `exemplos/funil.naoplanar.json`, além de `CLAUDE.md` e `exemplos/funil15.naoplanar.json` sem rastreio. `corte-funil.png` e `corte-funil.svg` já tinham alterações antes da sessão e não foram mexidos; a imagem ainda mostra as camadas antigas. O README ainda cita só o teste com PrusaSlicer 2.7 e chama 30° a 40° de limite seguro, valor sem medição por trás.

### Comportamento corrigido (não reverter sem motivo)
- `fmt` só apaga zeros depois da vírgula. Antes, `F1200` virava `F12`.
- Transição da base: T = r·|tan| para θ > 0 e 2·r·|tan| para θ < 0, com r = raio real dos vértices, não o canto da caixa. T mais curto aumenta o ângulo, mas afina a camada (até a metade na borda), por isso a extrusão é compensada por `espessuraRelativa`, só com E relativo.
- O fim da transformação é o primeiro marcador de código final depois da última camada, sem outro tipo de trecho em seguida. `;TYPE:Custom` no meio da impressão não encerra mais nada.
- Extrusão abaixo da mesa é erro. Deslocamento abaixo de 0,2 mm é elevado a 0,2 mm, com aviso (valor fixo; pode precisar de ajuste conforme a primeira camada).
- Movimentos são copiados sem mudança até X, Y e Z serem conhecidos, porque o bico está onde a macro `PRINT_START` o deixou. Antes, o código assumia X0 Y0 Z0.
- `deformar` avisa quando θ > 0 sem `--base`.

### Impressora e perfil do usuário
Ender-3 V3 SE com Klipper, cabeçote personalizado com carcaça impressa larga e duto lateral. No OrcaSlicer 2.5.0-rc: máquina `Ender Klipper`, processo `0.20mm Klipper RAPIDAO Cotrim`, filamento `ABS Cotrim`. Arc fitting já desligado e E relativo já ligado. O perfil limita o Z a 5 mm/s e vai até 300 mm/s. O G-code usa macros `PRINT_START`/`PRINT_END` e `EXCLUDE_OBJECT`.

### Fatiamento
Fatiar sempre pela interface do OrcaSlicer, sem girar nem redimensionar a peça. O CLI falhou: os JSON de usuário herdam de perfis empacotados em `Resources/profiles/*.opc` ("Preset was not found in the loaded bundle"). Os G-codes de origem estão em `~/Downloads`, e o STL do Benchy em `~/Downloads/benchy.stl`.

### Arquivos gerados em `exemplos/`
Todos com `--base 1`.
- `funil-15graus.final.gcode`: **melhor candidato para a primeira impressão real**.
- `funil-30graus.final.gcode`: exige folga maior que 12 mm.
- `benchy-15graus.final.gcode`: forma correta.
- `benchy-15graus-SO-VISUALIZAR.gcode`: Benchy plano transformado sem `deformar`, deformado. **Não imprimir.**

### Resultados medidos
| | Funil 30° | Funil 15° | Benchy 15° |
|---|---|---|---|
| Pontos de extrusão fora da peça | 0 de 162.636 | 0 de 135.636 | 15 de 187.684, até 0,1 mm |
| Inclinação máxima | 30,3° | 15,5° | 20,2° |
| Material acima da ponta do bico (máx.) | 9,9 mm | 6,0 mm | 6,8 mm (só medido até 30 mm do bico) |
| Folga mínima para imprimir | mais de 12 mm | 7 mm | 8 mm |
| Extrusão total após compensação | 94,0% | 99,4% | 92,4% |
| Tempo estimado sem aceleração, Z a 5 mm/s | 61,5 min | 38,2 min | 63,3 min |

No Benchy, os controles deram 4 pontos fora de 85.474 no G-code plano e 32,75% fora no arquivo só para visualizar. Os scripts dessas medições estavam em pasta temporária, não no projeto: teste de dentro/fora contra o STL com raio vertical, e perfil de folga com mapa de alturas em grade de 1 mm, medindo o material acima da ponta por distância horizontal.

### Pendências, nesta ordem
1. Usuário medir a folga do cabeçote: com a impressora fria e Z em 10 mm, medir da mesa até a parte mais baixa sem contar o bico e subtrair 10. Se der entre 5 e 7 mm, medir também as distâncias horizontais até o bico.
2. Usuário informar `max_z_velocity` do `printer.cfg`.
3. ~~Implementar a checagem de colisão no `retransformar` e aviso de velocidade do Z~~: feito (PR da etapa 2). Falta só usar a folga medida como `--folga`.
4. Primeira impressão real: funil a 15°, velocidade a 50%, acompanhando de perto, sobretudo a partir de 8 mm, onde o funil abre.
5. Depois do teste: atualizar o README, substituir a imagem do corte (com aprovação do usuário) e fazer o commit.
