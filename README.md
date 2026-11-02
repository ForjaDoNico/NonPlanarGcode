# naoplanar

Fatiamento **não planar** (camadas cônicas) para impressoras 3D comuns de 3 eixos, em português, para macOS, Linux e Windows. Funciona junto com o fatiador que você já usa (OrcaSlicer ou PrusaSlicer): o naoplanar deforma o modelo antes e desfaz a deformação no G-code depois.

> Status: protótipo da etapa 1. Testado de ponta a ponta com o PrusaSlicer 2.7 em um modelo de teste. Ainda **não foi testado numa impressora de verdade**.

## Como funciona

1. `deformar`: cada ponto do modelo sobe `r·tan(θ)`, onde `r` é a distância até o eixo do cone.
2. Você fatia a malha deformada no seu fatiador, normalmente, com camadas planas.
3. `retransformar`: no G-code, cada movimento é quebrado em segmentos de até 1 mm e desce `r·tan(θ)`. Cada camada plana vira um cone na peça real.

Com θ positivo as camadas descem para fora, então balanços que abrem para fora (funil, cogumelo, beiral) passam a ser impressos sem suporte. Com θ negativo, as camadas sobem para fora.

A opção `--base` mantém as primeiras camadas planas para a peça grudar na mesa e faz uma transição suave até o cone completo.

![Corte lateral do G-code final](exemplos/corte-funil.png)

O corte acima é do modelo de teste (`exemplos/funil.stl`): uma haste com um funil a 50° da vertical, que no fatiamento plano precisaria de suporte. Com camadas de 30°, os perímetros seguem a parede inclinada. O verificador confirmou que todos os 151 mil pontos de extrusão ficam dentro da peça original.

## Uso

Requer Node.js 22.18 ou mais novo (roda TypeScript direto, sem compilar).

```sh
node src/cli.ts deformar peca.stl --angulo 30 --base 1
# fatie peca.naoplanar.stl no OrcaSlicer e exporte o G-code
node src/cli.ts retransformar peca.gcode --params peca.naoplanar.json --saida peca.final.gcode
```

No fatiador:
- desative **Arc fitting** (arcos G2/G3 não são suportados);
- ative **Use relative E distances** (recomendado);
- pode posicionar a peça onde quiser na mesa, mas não gire: o centro do cone é detectado no G-code.

Também dá para usar como script de pós-processamento do OrcaSlicer (sem `--saida` o arquivo é sobrescrito):

```
node /caminho/naoplanar/src/cli.ts retransformar --params /caminho/peca.naoplanar.json
```

Testes: `npm test`. Exemplo completo: `npm run funil`, e depois os comandos acima com `exemplos/funil.stl`.

## Limitações conhecidas

- **Colisão:** o bico precisa caber no ângulo. Use θ menor que o ângulo do cone do bico/hotend (em geral 30° a 40° é o limite seguro). Ainda não há verificação automática.
- **Topos planos ficam em degraus**, porque para a malha deformada eles viram superfícies inclinadas. O próximo modo (camadas de topo que seguem a superfície) resolve isso.
- **Deslocamentos longos sobem e descem** junto com o cone. Não colidem com o que já foi impresso, mas são mais lentos.
- A espessura real da camada, medida perpendicular ao cone, é `altura × cos(θ)`. A extrusão ainda não é compensada (`--fator-e` existe para testes manuais).
- Um eixo de cone por peça. Várias peças na mesa ainda não são suportadas.

## Comparação com o Boxily (Boxislicer)

O Boxily é um fatiador completo e próprio: fatia por superfícies cônicas ao longo de uma curva (spline) e suporta 5 eixos. Só existe para Windows, e a documentação não diz se é open source. O naoplanar é mais simples de propósito: foca em impressoras de 3 eixos, reaproveita o OrcaSlicer para todo o resto (perímetros, preenchimento, suporte, perfis) e é open source desde o início.

## Licença

MIT.
