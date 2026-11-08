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
node src/cli.ts retransformar peca.gcode --saida peca.final.gcode
```

No fatiador:
- desative **Arc fitting** (arcos G2/G3 não são suportados);
- ative **Use relative E distances** (recomendado);
- pode posicionar a peça onde quiser na mesa, mas não gire: o centro do cone é detectado no G-code.

### Retransformar automático no OrcaSlicer

Configure uma vez e o passo 3 acontece sozinho sempre que você exportar ou enviar o G-code:

1. No Terminal, descubra onde está o Node com `which node` (no Mac costuma ser `/opt/homebrew/bin/node` ou `/usr/local/bin/node`).
2. No OrcaSlicer, em **Processo > Outros > Scripts de pós-processamento** (Post-processing Scripts), coloque uma linha com o caminho do Node, o caminho do `cli.ts` e a palavra `retransformar`:

   ```
   /opt/homebrew/bin/node /Users/voce/NonPlanarGcode/src/cli.ts retransformar
   ```

3. Deixe **Label objects** ligado (Processo > Outros). É pelo nome da peça no G-code que o naoplanar sabe quais parâmetros usar.
4. Salve o processo. Pode deixar o script sempre ligado:
   - peças comuns passam sem nenhuma mudança;
   - peças `*.naoplanar.stl` são transformadas com os parâmetros que o `deformar` registrou em `~/.naoplanar/pecas/`;
   - um arquivo já transformado nunca é transformado de novo;
   - se houver colisão, o Orca mostra o erro e não exporta.

Não renomeie a peça dentro do Orca: o nome precisa continuar terminando em `.naoplanar`.

### Perfil da impressora

Os ajustes da impressora ficam salvos em `~/.naoplanar/perfil.json` e valem para todo `retransformar`, inclusive o automático:

```sh
node src/cli.ts perfil --folga 7 --z-max 5   # salva
node src/cli.ts perfil                       # mostra
```

Opções passadas direto no `retransformar` valem só naquela execução.

## Topo liso

Com camadas cônicas, um topo plano (ou qualquer topo que não tenha o formato do cone) sai em degraus da altura de uma camada. Com `--topo-liso` no `deformar`, a última camada de topo sobe até a superfície real da peça, e a extrusão aumenta na mesma proporção para preencher a camada mais grossa. Os deslocamentos sobre o topo passam por cima dele.

```sh
node src/cli.ts deformar peca.stl --angulo 15 --base 1 --topo-liso
```

O `retransformar` lê o STL original para conhecer a superfície, então não mova nem apague esse arquivo. Ele também lê a altura de camada que o fatiador grava no G-code. Funciona com os tipos "Top surface" (OrcaSlicer), "Top solid infill" (PrusaSlicer) e "Ironing". `--sem-topo-liso` desliga o modo numa execução.

No funil de exemplo a 15°, a última camada do topo variava 0,15 mm de altura e passou a ficar toda a 28,00 mm. A extrusão do topo aumentou 22%.

## Checagem de colisão

Com camadas cônicas, o material do lado de dentro da camada fica mais alto que a ponta do bico. Se ele passar da parte mais baixa do cabeçote (bloco aquecedor, carcaça, duto de ventilação), o cabeçote bate na peça. O `retransformar` simula a impressão inteira com um mapa de alturas e, se houver colisão, **não grava o arquivo** e diz onde ela aconteceria e de quanta folga o arquivo precisa.

A folga depende do seu cabeçote, então meça antes de imprimir:

1. Com a impressora fria, leve o Z para 10 mm.
2. Meça da mesa até a parte mais baixa do cabeçote, sem contar o bico.
3. Subtraia 10. O resultado é a `--folga`.

Salve o valor no perfil (`node src/cli.ts perfil --folga 7`). Sem perfil, o padrão é 5 mm. A checagem considera o cabeçote até 30 mm do bico (`--raio-cabeca`) e ignora o material a menos de 1,5 mm da ponta (`--raio-bico`), onde o bico alisa a linha vizinha.

Referência, com o funil de exemplo e `--base 1`: a 15° ele precisa de 5,8 mm de folga, e a 30° precisa de 9,8 mm. Como regra geral, a folga necessária cresce com `largura da peça × tan(θ)`.

### Formato real do cabeçote

O modelo padrão trata o cabeçote como um disco plano em volta do bico. Se uma parte baixa do cabeçote tem formato irregular (por exemplo, um duto de fan com saídas só dos lados), dá para usar o STL dela:

```sh
node src/cli.ts perfil --cabecote-stl duto.stl --bico 10.9,6.2,-27.65 --folga 8
```

- O STL precisa estar com Z para cima, na orientação em que está montado.
- `--bico` é a posição da ponta do bico nas coordenadas desse STL: no centro entre as saídas, abaixo da parte mais baixa do duto pela folga medida.
- `--folga` passa a valer para o resto do cabeçote (bloco aquecedor, carcaça), e em cada ponto vale a menor das duas.

Com o duto 5015 da Ender-3 V3 SE do autor, o funil passou de 9° no modelo de disco para 14° sem colisão. A 15°, a primeira colisão prevista foi em Z 17,6 mm, e na impressão real o fan encostou em Z 17,67 mm.

`--z-max` recebe o `max_z_velocity` do firmware e avisa quando o firmware vai desacelerar a impressão porque o Z não acompanha.

Testes: `npm test`. Exemplo completo: `npm run funil`, e depois os comandos acima com `exemplos/funil.stl`.

## Limitações conhecidas

- **Colisão:** a checagem usa um modelo simples do cabeçote (um cilindro fino para o bico e um plano para o resto). Ela não conhece o formato exato do seu cabeçote, então um duto que desce mais de um lado precisa ser medido pelo lado mais baixo.
- **Topos ficam em degraus** sem `--topo-liso`. Com ele, só a última camada sobe até a superfície, então a camada de baixo ainda tem degraus, que ficam escondidos.
- **Deslocamentos longos sobem e descem** junto com o cone. Não colidem com o que já foi impresso, mas são mais lentos.
- A camada cônica é mais fina na perpendicular (`altura × cos θ`), mas o volume entre duas camadas é o mesmo das camadas planas, então a extrusão do fatiador já está certa. Só a zona de transição da base precisa de compensação, e ela é feita (`--fator-e` existe para testes manuais).
- **Saia e brim sem `--base`:** com θ positivo, o trecho fora da peça ficaria abaixo da mesa, e o `retransformar` recusa o G-code com um erro.
- Um eixo de cone por peça. Várias peças na mesa ainda não são suportadas.

## Comparação com o Boxily (Boxislicer)

O Boxily é um fatiador completo e próprio: fatia por superfícies cônicas ao longo de uma curva (spline) e suporta 5 eixos. Só existe para Windows, e a documentação não diz se é open source. O naoplanar é mais simples de propósito: foca em impressoras de 3 eixos, reaproveita o OrcaSlicer para todo o resto (perímetros, preenchimento, suporte, perfis) e é open source desde o início.

## Licença

MIT.
