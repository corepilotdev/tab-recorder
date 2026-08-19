const tabListEl = document.getElementById("tabList");
const recordBtn = document.getElementById("recordBtn");
const fpsSel = document.getElementById("fps");
const countdownSel = document.getElementById("countdown");
const statusEl = document.getElementById("status");
const recDot = document.getElementById("recDot");

let selectedTabId = null;
let recording = false;

// Tabs que o chrome.tabCapture nao consegue capturar.
function isCapturable(tab) {
  const url = tab.url || "";
  return !(
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.includes("chrome.google.com/webstore") ||
    url.includes("microsoftedge.microsoft.com")
  );
}

async function init() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  recording = state.recording;
  selectedTabId = state.tabId;
  await renderTabs();
  updateUI();

  recordBtn.addEventListener("click", onRecordClick);

  // Atualiza o popup durante a contagem regressiva, caso esteja aberto.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "countdown-tick") {
      statusEl.textContent = `Iniciando em ${msg.remaining}s...`;
    } else if (msg.type === "recording-started") {
      statusEl.textContent = "Gravando...";
    }
  });
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({});
  tabListEl.innerHTML = "";

  for (const tab of tabs) {
    const capturable = isCapturable(tab);

    const item = document.createElement("label");
    item.className = "tab-item" + (capturable ? "" : " disabled");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "tab";
    radio.value = String(tab.id);
    radio.checked = tab.id === selectedTabId;
    radio.disabled = recording || !capturable;
    radio.addEventListener("change", () => {
      selectedTabId = tab.id;
      updateUI();
    });

    const img = document.createElement("img");
    img.src = tab.favIconUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23ccd'/%3E%3C/svg%3E";
    img.addEventListener("error", () => {
      img.style.visibility = "hidden";
    });

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || tab.url || "(sem titulo)";
    title.title = tab.title || "";

    item.append(radio, img, title);
    tabListEl.append(item);
  }
}

function selectedTabTitle() {
  const tabs = tabListEl.querySelectorAll(".tab-item");
  for (const item of tabs) {
    const r = item.querySelector("input");
    if (r && Number(r.value) === selectedTabId) {
      return item.querySelector(".title").textContent;
    }
  }
  return null;
}

function updateUI() {
  recDot.classList.toggle("hidden", !recording);
  fpsSel.disabled = recording;
  countdownSel.disabled = recording;

  if (recording) {
    recordBtn.textContent = "Parar gravacao";
    recordBtn.classList.add("recording");
    recordBtn.disabled = false;
    statusEl.textContent = "Gravando...";
  } else {
    recordBtn.textContent = "Gravar";
    recordBtn.classList.remove("recording");
    recordBtn.disabled = selectedTabId == null;
    statusEl.textContent = "";
  }
}

async function onRecordClick() {
  recordBtn.disabled = true;

  if (recording) {
    await chrome.runtime.sendMessage({ type: "stop" });
    statusEl.textContent = "Finalizando e salvando...";
    // O download abre uma caixa de dialogo; fechamos o popup depois de um instante.
    setTimeout(() => window.close(), 400);
    return;
  }

  const resp = await chrome.runtime.sendMessage({
    type: "start",
    tabId: selectedTabId,
    tabTitle: selectedTabTitle(),
    options: { fps: Number(fpsSel.value), countdown: Number(countdownSel.value) },
  });

  if (resp && resp.ok) {
    recording = true;
    updateUI();
    if (Number(countdownSel.value) > 0) {
      statusEl.textContent = `Iniciando em ${Number(countdownSel.value)}s...`;
    }
  } else {
    statusEl.textContent = "Erro: " + (resp && resp.error ? resp.error : "desconhecido");
    recordBtn.disabled = false;
  }
}

init();
