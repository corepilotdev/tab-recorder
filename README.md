# Tab Recorder

Extensao Chrome/Edge (Manifest V3) que grava **audio + video de uma tab especifica**,
sem capturar a tela. Por usar `chrome.tabCapture` (e nao captura de tela), nenhuma
janela ou programa aberto por cima atrapalha a gravacao, e a tab continua sendo
gravada mesmo em segundo plano.

## Estado atual (MVP)

Entregues nesta versao:

| # | Requisito | Status |
|---|-----------|--------|
| 1 | Definir a tab a gravar (1 por vez) | ✅ lista de tabs no popup |
| 2 | Gravar audio da tab | ✅ |
| 3 | Video 1080p 30/60 fps em MP4 | ✅ MP4 (H.264/AAC); fallback WebM |
| 5 | Countdown (3/5/10s) antes de iniciar | ✅ contagem no badge/popup, sem overlay na tab |
| 6 | Sem overlay / outros apps nao atrapalham | ✅ inerente ao tabCapture |
| 7 | Tab em segundo plano ainda e gravada | ✅ MediaRecorder roda no offscreen document |

### Recorte de area (req 4) — via pos-producao

Em vez de embutir um editor na extensao, o recorte de regiao e feito em uma
ferramenta dedicada sobre o MP4 gerado (mantem a extensao enxuta):

- **Shotcut** (recomendado): filtro "Tamanho, Posicao e Rotacao" / "Cortar: Retangulo"
  — arrasta um retangulo sobre o video e exporta MP4.
- **Avidemux**: leve, filtro "Crop" com preview.
- **ffmpeg** (precisao/automacao):

  ```bash
  ffmpeg -i entrada.mp4 -filter:v "crop=largura:altura:x:y" -c:a copy saida.mp4
  ```

> Observacao: o recorte pos-gravacao nunca tem mais detalhe do que a fonte. Forcar
> 1080p num recorte menor (ex: `-vf scale=1920:1080`) e upscale, sem ganho de nitidez.

### Countdown

Ao iniciar, se um countdown for escolhido, a captura ja fica ativa mas o
`MediaRecorder` so comeca ao final da contagem. Durante a contagem aparece um
**overlay grande na tela da tab** (10, 9, 8...) alem dos numeros no badge do icone.

Como a gravacao so comeca quando a contagem chega a zero **e o overlay se remove
antes disso**, ele **nao aparece no video final** — a regra de "sem overlay durante
a gravacao" continua respeitada. Parar durante a contagem cancela sem salvar arquivo.

> O overlay na tela exige as permissoes `scripting` + `host_permissions` (acesso aos
> sites). Por isso o navegador pede "ler e alterar dados nos sites" na instalacao.

## Sobre o formato

A extensao tenta gravar direto em **MP4 (H.264 + AAC)**, que toca tanto no
**Media Player nativo do Windows** quanto no **VLC**. Se a versao do navegador nao
suportar gravacao em MP4, ela cai automaticamente para **WebM (VP9/Opus)** —
o VLC toca WebM sem problema; o player nativo do Windows pode nao tocar.

## Como instalar (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactacao** e selecione esta pasta
   (`tab-recorder`). No WSL, o caminho aparece em `\\wsl.localhost\Ubuntu\home\jacks\projects\tab-recorder`.
4. Fixe a extensao na barra (opcional).

## Como usar

1. Abra a tab que quer gravar (uma pagina normal — `http`/`https`).
2. Clique no icone da extensao.
3. Escolha a qualidade (30 ou 60 fps) e selecione a tab na lista.
4. Clique em **Gravar**. Um badge vermelho "REC" aparece no icone.
5. Pode trocar de tab, abrir outros programas etc. — a gravacao continua.
6. Clique no icone e em **Parar gravacao**. Uma caixa de dialogo de download
   pergunta onde salvar o arquivo `.mp4` (ou `.webm`).

## Notas tecnicas / limitacoes a validar no teste

- **Resolucao 1080p:** o `tabCapture` renderiza no tamanho do viewport da tab.
  Para 1080p reais, a janela do navegador precisa estar grande o suficiente.
  Constraints de `maxWidth/maxHeight/maxFrameRate` sao aplicadas.
- **Tabs internas** (`chrome://`, `edge://`, Web Store, paginas de extensao)
  nao podem ser capturadas e aparecem desabilitadas na lista.
- **Audio audivel:** durante a captura, o audio e reconectado a saida via
  `AudioContext`, entao voce continua ouvindo a tab normalmente.
- A 60 fps o bitrate de video sobe para ~12 Mbps (8 Mbps a 30 fps).

## Arquitetura

```
popup (UI: lista de tabs, start/stop)
   │  mensagens runtime
   ▼
background.js (service worker)
   │  chrome.tabCapture.getMediaStreamId({ targetTabId })
   │  cria/encerra offscreen, dispara chrome.downloads
   ▼
offscreen.js (offscreen document — roda independente do SW)
   getUserMedia(chromeMediaSource: 'tab') → MediaRecorder → Blob
```
