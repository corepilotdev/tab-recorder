// Offscreen document: onde a captura e a codificacao realmente acontecem.
// Roda independente do service worker, entao a gravacao continua mesmo que o SW
// seja encerrado e mesmo que a tab capturada perca o foco.

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let audioCtx = null;
let lastUrl = null;
let activeMime = "";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "start-recording":
          await startRecording(msg.streamId, msg.options || {});
          sendResponse({ ok: true });
          break;
        case "stop-recording":
          stopRecording();
          sendResponse({ ok: true });
          break;
        case "revoke":
          if (lastUrl) {
            URL.revokeObjectURL(lastUrl);
            lastUrl = null;
          }
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false });
      }
    } catch (e) {
      report(String(e));
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});

function report(error) {
  chrome.runtime.sendMessage({ type: "recording-error", error });
}

// Escolhe o melhor container disponivel: MP4 (H.264/AAC) e a prioridade;
// cai para WebM se o navegador nao suportar gravacao em MP4.
function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function startRecording(streamId, options) {
  recordedChunks = [];
  const fps = Number(options.fps) || 30;

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: fps,
      },
    },
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  // Reconecta o audio capturado a saida, para o usuario continuar ouvindo a tab.
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  activeMime = pickMime();
  const videoBitsPerSecond = fps >= 60 ? 12_000_000 : 8_000_000;

  const recorderOpts = { videoBitsPerSecond, audioBitsPerSecond: 128_000 };
  if (activeMime) recorderOpts.mimeType = activeMime;

  mediaRecorder = new MediaRecorder(stream, recorderOpts);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = onStop;
  mediaRecorder.onerror = (e) => report("MediaRecorder: " + String(e.error || e));

  // Se a tab/stream for encerrada (ex: tab fechada), finaliza a gravacao.
  stream.getVideoTracks()[0].addEventListener("ended", () => stopRecording());

  // Countdown: o stream ja esta ativo, mas so comecamos a gravar ao final.
  const countdown = Number(options.countdown) || 0;
  if (countdown > 0) {
    await runCountdown(countdown);
    // Se o usuario cancelou (parou) durante a contagem, nao inicia.
    if (!stream || !stream.active) return;
  }

  notify({ type: "recording-started" });
  mediaRecorder.start(1000); // gera chunks a cada 1s
}

function notify(message) {
  // Mensagens informativas (badge/popup). Ignora ausencia de receptor.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    let remaining = seconds;
    notify({ type: "countdown-tick", remaining });
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0 || !stream || !stream.active) {
        clearInterval(timer);
        resolve();
        return;
      }
      notify({ type: "countdown-tick", remaining });
    }, 1000);
  });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // onStop cuida da limpeza e do salvamento
    return;
  }
  // Parado durante o countdown: cancela sem salvar.
  if (stream) stream.getTracks().forEach((t) => t.stop()); // encerra a contagem
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch (_) {}
    audioCtx = null;
  }
  notify({ type: "recording-canceled" });
}

async function onStop() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch (_) {}
    audioCtx = null;
  }

  const isMp4 = activeMime.startsWith("video/mp4");
  const ext = isMp4 ? "mp4" : "webm";
  const blobType = activeMime ? activeMime.split(";")[0] : "video/webm";
  const blob = new Blob(recordedChunks, { type: blobType });
  lastUrl = URL.createObjectURL(blob);

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  chrome.runtime.sendMessage({
    type: "recording-complete",
    url: lastUrl,
    filename: `tab-recording-${ts}.${ext}`,
  });
}
