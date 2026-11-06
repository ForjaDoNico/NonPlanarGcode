# naoplanar

Fatiamento **não planar** (camadas cônicas) para impressoras 3D comuns de 3 eixos, em português, para macOS, Linux e Windows. Funciona junto com o fatiador que você já usa (OrcaSlicer ou PrusaSlicer): o naoplanar deforma o modelo antes e desfaz a deformação no G-code depois.

> Status: protótipo da etapa 1. Testado de ponta a ponta com o PrusaSlicer 2.7 em um modelo de teste. Ainda **não foi testado numa impressora de verdade**.

## Como funciona

1. `deformar`: cada ponto do modelo sobe `r·tan(θ)`, onde `r` é a distância até o eixo do cone.
2. Você fatia a malha deformada no seu fatiador, normalmente, com camadas planas.
3. `retransformar`: no G-code, cada movimento é quebrado em segmentos de até 1 mm e desce `r·tan(θ)`. Cada camada plana vira um cone na peça real.

Com θ positivo as camadas descem para fora, então balanços que abrem para fora (funil, cogumelo, beiral) passam a ser impressos sem suporte. Com θ negativo, as camadas sobem para fora.

A opção `--base` mantém as primeiras camadas planas para a peça grudar na mesa e faz uma transição suave até o cone completo. Use-a sempre com θ positivo: sem ela, as camadas encostam na mesa em ângulo e o bico pode raspar nela. Na transição, o ângulo cresce aos poucos e as camadas ficam mais finas (até a metade da altura configurada, na borda da peça) com θ positivo, ou mais grossas com θ negativo. A extrusão é ajustada para compensar, desde que **Use relative E distances** esteja ativo.

![Corte lateral do G-code final](exemplos/corte-funil.png)

O corte acima é do modelo de teste (`exemplos/funil.stl`): uma haste com um funil a 50° da vertical, que no fatiamento plano precisaria de suporte. A imagem foi gerada antes da correção da transição e ainda mostra a inclinação antiga, de cerca de 4° a 13° na parede. Com `--angulo 30 --base 1`, a inclinação agora vai de 11° no início da parede a 30° a partir de cerca de 18 mm de altura.

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

## Checagem de colisão

Com camadas cônicas, o material do lado de dentro da camada fica mais alto que a ponta do bico. Se ele passar da parte mais baixa do cabeçote (bloco aquecedor, carcaça, duto de ventilação), o cabeçote bate na peça. O `retransformar` simula a impressão inteira com um mapa de alturas e, se houver colisão, **não grava o arquivo** e diz onde ela aconteceria e de quanta folga o arquivo precisa.

A folga depende do seu cabeçote, então meça antes de imprimir:

1. Com a impressora fria, leve o Z para 10 mm.
2. Meça da mesa até a parte mais baixa do cabeçote, sem contar o bico.
3. Subtraia 10. O resultado é a `--folga`.

```sh
node src/cli.ts retransformar peca.gcode --params peca.naoplanar.json --folga 7 --z-max 5
```

Sem `--folga`, o padrão é 5 mm. A checagem considera o cabeçote até 30 mm do bico (`--raio-cabeca`) e ignora o material a menos de 1,5 mm da ponta (`--raio-bico`), onde o bico alisa a linha vizinha.

Referência, com o funil de exemplo e `--base 1`: a 15° ele precisa de 5,8 mm de folga, e a 30° precisa de 9,8 mm. Como regra geral, a folga necessária cresce com `largura da peça × tan(θ)`.

`--z-max` recebe o `max_z_velocity` do firmware e avisa quando o firmware vai desacelerar a impressão porque o Z não acompanha.

Testes: `npm test`. Exemplo completo: `npm run funil`, e depois os comandos acima com `exemplos/funil.stl`.

## Limitações conhecidas

- **Colisão:** a checagem usa um modelo simples do cabeçote (um cilindro fino para o bico e um plano para o resto). Ela não conhece o formato exato do seu cabeçote, então um duto que desce mais de um lado precisa ser medido pelo lado mais baixo.
- **Topos planos ficam em degraus**, porque para a malha deformada eles viram superfícies inclinadas. O próximo modo (camadas de topo que seguem a superfície) resolve isso.
- **Deslocamentos longos sobem e descem** junto com o cone. Não colidem com o que já foi impresso, mas são mais lentos.
- A espessura real da camada, medida perpendicular ao cone, é `altura × cos(θ)`. A extrusão só é compensada na zona de transição da base; esse efeito do cone ainda não é compensado (`--fator-e` existe para testes manuais).
- **Saia e brim sem `--base`:** com θ positivo, o trecho fora da peça ficaria abaixo da mesa, e o `retransformar` recusa o G-code com um erro.
- Um eixo de cone por peça. Várias peças na mesa ainda não são suportadas.

## Comparação com o Boxily (Boxislicer)

O Boxily é um fatiador completo e próprio: fatia por superfícies cônicas ao longo de uma curva (spline) e suporta 5 eixos. Só existe para Windows, e a documentação não diz se é open source. O naoplanar é mais simples de propósito: foca em impressoras de 3 eixos, reaproveita o OrcaSlicer para todo o resto (perímetros, preenchimento, suporte, perfis) e é open source desde o início.

## Licença

MIT.
