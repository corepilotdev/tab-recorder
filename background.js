// Service worker: orquestra a captura.
// O service worker pode ser encerrado pelo Chrome a qualquer momento; por isso o
// estado de gravacao fica em chrome.storage.session e o MediaRecorder roda no
// offscreen document (que NAO e encerrado), garantindo a gravacao continua mesmo
// quando a tab perde o foco.

const OFFSCREEN_URL = "offscreen.html";

async function getState() {
  const s = await chrome.storage.session.get(["recording", "tabId", "tabTitle"]);
  return { recording: !!s.recording, tabId: s.tabId ?? null, tabTitle: s.tabTitle ?? null };
}

async function setState(partial) {
  await chrome.storage.session.set(partial);
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Gravar audio e video da tab via MediaRecorder.",
  });
}

// ---- Overlay de countdown injetado na tab (some antes da gravacao comecar) ----

// Funcao executada NO contexto da pagina.
function countdownOverlay(seconds) {
  const ID = "__tabrec_countdown__";
  const old = document.getElementById(ID);
  if (old) old.remove();

  const wrap = document.createElement("div");
  wrap.id = ID;
  wrap.style.cssText = [
    "position:fixed", "inset:0", "z-index:2147483647", "pointer-events:none",
    "display:flex", "align-items:center", "justify-content:center",
    "background:rgba(0,0,0,0.35)", "backdrop-filter:blur(2px)",
    "font-family:system-ui,'Segoe UI',sans-serif",
  ].join(";");

  const circle = document.createElement("div");
  circle.style.cssText = [
    "width:220px", "height:220px", "border-radius:50%",
    "display:flex", "align-items:center", "justify-content:center",
    "background:rgba(20,22,30,0.85)", "border:6px solid #2b6cff",
    "box-shadow:0 12px 48px rgba(0,0,0,0.5)",
    "color:#fff", "font-size:120px", "font-weight:700", "line-height:1",
    "transition:transform .15s ease",
  ].join(";");

  wrap.appendChild(circle);
  (document.body || document.documentElement).appendChild(wrap);

  let remaining = seconds;
  circle.textContent = String(remaining);

  const timer = setInterval(() => {
    remaining -= 1;
    const cur = document.getElementById(ID);
    if (!cur) {
      clearInterval(timer);
      return;
    }
    if (remaining <= 0) {
      clearInterval(timer);
      cur.remove();
      return;
    }
    circle.textContent = String(remaining);
    circle.style.transform = "scale(1.18)";
    setTimeout(() => (circle.style.transform = "scale(1)"), 130);
  }, 1000);
}

function removeCountdownOverlay() {
  const el = document.getElementById("__tabrec_countdown__");
  if (el) el.remove();
}

async function showOverlay(tabId, seconds) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: countdownOverlay,
      args: [seconds],
    });
  } catch (e) {
    console.warn("Nao foi possivel injetar o overlay de countdown:", e);
  }
}

async function clearOverlay(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: removeCountdownOverlay,
    });
  } catch (_) {}
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#d33" });
}

async function waitDownloadDone(downloadId) {
  return new Promise((resolve) => {
    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Mensagens destinadas ao offscreen sao ignoradas aqui.
  if (msg && msg.target === "offscreen") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "get-state": {
          sendResponse(await getState());
          break;
        }

        case "start": {
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: msg.tabId,
          });
          await ensureOffscreen();
          await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "start-recording",
            streamId,
            options: msg.options || {},
          });
          await setState({ recording: true, tabId: msg.tabId, tabTitle: msg.tabTitle || null });
          const countdown = msg.options && Number(msg.options.countdown);
          if (countdown > 0) {
            // Badge mostra os numeros (via countdown-tick) e a tela mostra o overlay grande.
            showOverlay(msg.tabId, countdown);
          } else {
            setBadge(true);
          }
          sendResponse({ ok: true });
          break;
        }

        case "stop": {
          await chrome.runtime.sendMessage({ target: "offscreen", type: "stop-recording" });
          sendResponse({ ok: true });
          break;
        }

        case "recording-complete": {
          // Vem do offscreen quando o blob esta pronto.
          let downloadId;
          try {
            downloadId = await chrome.downloads.download({
              url: msg.url,
              filename: msg.filename,
              saveAs: true,
            });
          } catch (e) {
            console.error("Falha no download:", e);
          }
          await setState({ recording: false, tabId: null, tabTitle: null });
          setBadge(false);

          if (downloadId !== undefined) {
            await waitDownloadDone(downloadId);
          }
          // Libera o blob no offscreen e encerra o documento.
          try {
            await chrome.runtime.sendMessage({ target: "offscreen", type: "revoke" });
          } catch (_) {}
          if (await hasOffscreen()) await chrome.offscreen.closeDocument();
          sendResponse({ ok: true });
          break;
        }

        case "countdown-tick": {
          chrome.action.setBadgeText({ text: String(msg.remaining) });
          chrome.action.setBadgeBackgroundColor({ color: "#2b6cff" });
          break;
        }

        case "recording-started": {
          // Garante que o overlay sumiu antes de a gravacao realmente comecar.
          const { tabId } = await getState();
          await clearOverlay(tabId);
          setBadge(true);
          break;
        }

        case "recording-canceled": {
          const { tabId } = await getState();
          await clearOverlay(tabId);
          await setState({ recording: false, tabId: null, tabTitle: null });
          setBadge(false);
          if (await hasOffscreen()) await chrome.offscreen.closeDocument();
          sendResponse({ ok: true });
          break;
        }

        case "recording-error": {
          console.error("Erro de gravacao:", msg.error);
          await setState({ recording: false, tabId: null, tabTitle: null });
          setBadge(false);
          if (await hasOffscreen()) await chrome.offscreen.closeDocument();
          sendResponse({ ok: false, error: msg.error });
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // resposta assincrona
});
