// Универсальный заливщик прошивок ESP. Всё делает браузер: файл читается
// локально и уходит в плату по USB через Web Serial.
//
// esptool-js 0.7.0 © Espressif Systems, Apache-2.0
// Версия пинуется намеренно: безверсионный bundle.js подтянет следующий
// мажор прямо в продакшен, а он уже ломал формат данных (0.6.0).
import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.7.0/bundle.js";
import { md5 } from "https://unpkg.com/js-md5@0.9.2/build/md5.min.mjs";

const SECTOR = 0x1000;
const MAX_OFFSET = 0x8000000; // 128 МБ — больше любого флеша ESP
const MAX_LOG_LINES = 3000;

const $ = (sel) => document.querySelector(sel);

const el = {
  envNotice: $("#env-notice"),
  connectNotice: $("#connect-notice"),
  partsErrors: $("#parts-errors"),
  result: $("#result"),
  baudrate: $("#baudrate"),
  btnConnect: $("#btn-connect"),
  btnDisconnect: $("#btn-disconnect"),
  chipInfo: $("#chip-info"),
  iChip: $("#i-chip"),
  iMac: $("#i-mac"),
  iFlash: $("#i-flash"),
  iPort: $("#i-port"),
  rowBootloader: $("#row-bootloader"),
  parts: $("#parts"),
  btnAddPart: $("#btn-add-part"),
  flashSize: $("#flash-size"),
  flashMode: $("#flash-mode"),
  flashFreq: $("#flash-freq"),
  optErase: $("#opt-erase"),
  optCompress: $("#opt-compress"),
  optVerify: $("#opt-verify"),
  optReset: $("#opt-reset"),
  btnFlash: $("#btn-flash"),
  btnErase: $("#btn-erase"),
  progressBox: $("#progress-box"),
  progress: $("#progress"),
  progressLabel: $("#progress-label"),
  terminal: $("#terminal"),
  btnClearLog: $("#btn-clear-log"),
};

const S = {
  state: "boot",
  transport: null,
  esploader: null,
  parts: [],
  nextPartId: 1,
  partsValid: false,
  totalBytes: 0,
  startedAt: 0,
};

// --- вывод -----------------------------------------------------------------

function createTerminal(node) {
  let lines = [""];

  const flush = () => {
    const atBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 8;
    node.textContent = lines.join("\n");
    if (atBottom) node.scrollTop = node.scrollHeight;
  };

  const push = (text) => {
    // esptool шлёт и \r, и \n, и «\n\r» — раскладываем по строкам сами
    for (const ch of String(text)) {
      if (ch === "\n") lines.push("");
      else if (ch === "\r") lines[lines.length - 1] = "";
      else lines[lines.length - 1] += ch;
    }
    if (lines.length > MAX_LOG_LINES) {
      lines = lines.slice(lines.length - MAX_LOG_LINES);
    }
    flush();
  };

  return {
    clean() {
      lines = [""];
      flush();
    },
    writeLine(data) {
      push(data + "\n");
    },
    write(data) {
      push(data);
    },
  };
}

const term = createTerminal(el.terminal);

function log(text) {
  term.writeLine(text);
}

// --- плашки ----------------------------------------------------------------

const ICONS = { ok: "✓", error: "✕", warn: "!", info: "i" };

function notice(kind, html) {
  return `<div class="notice notice--${kind}"><span class="notice__icon">${ICONS[kind]}</span><span>${html}</span></div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

// --- формат ----------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function hex(n) {
  return "0x" + n.toString(16).toUpperCase();
}

// --- окружение -------------------------------------------------------------

function checkEnvironment() {
  if (location.protocol === "file:") {
    // на file:// Chrome считает страницу защищённой, но navigator.serial
    // там всё равно нет — без этой ветки человек получит неверный совет
    // «смените браузер»
    el.envNotice.innerHTML = notice(
      "error",
      "Страница открыта как файл на диске. Доступ к порту так не работает — " +
        "нужен адрес по <code>https://</code> или локальный сервер " +
        "(<code>python3 -m http.server</code>).",
    );
    return false;
  }
  if (!window.isSecureContext) {
    el.envNotice.innerHTML = notice(
      "error",
      "Страница открыта не по <code>https://</code>. Браузер разрешает доступ " +
        "к последовательному порту только на защищённых страницах — и ещё на " +
        "<code>localhost</code>.",
    );
    return false;
  }
  if (!("serial" in navigator)) {
    el.envNotice.innerHTML = notice(
      "error",
      "Этот браузер не умеет Web Serial. Нужен <b>Chrome, Edge или Opera</b> " +
        "на компьютере: в Safari и Firefox такого доступа к порту нет, на " +
        "телефоне — тоже.",
    );
    return false;
  }
  return true;
}

// --- состояние -------------------------------------------------------------

function setState(next) {
  S.state = next;
  render();
}

function render() {
  const st = S.state;
  const online = st === "connected" || st === "done" || st === "error";
  const busy = st === "connecting" || st === "flashing" || st === "erasing";
  const dead = st === "unsupported";

  el.baudrate.disabled = dead || online || busy;
  el.btnConnect.disabled = dead || online || busy;
  el.btnConnect.hidden = online;
  el.btnConnect.classList.toggle("is-busy", st === "connecting");
  el.btnDisconnect.hidden = !online;
  el.btnDisconnect.disabled = busy;

  el.chipInfo.hidden = !online;

  el.btnAddPart.disabled = dead || busy;
  for (const input of el.parts.querySelectorAll("input, button")) {
    input.disabled = dead || busy;
  }

  for (const node of [
    el.flashSize,
    el.flashMode,
    el.flashFreq,
    el.optErase,
    el.optCompress,
    el.optVerify,
    el.optReset,
  ]) {
    node.disabled = dead || busy;
  }

  el.btnFlash.disabled = dead || busy || !online || !S.partsValid;
  el.btnFlash.classList.toggle("is-busy", st === "flashing");
  el.btnErase.disabled = dead || busy || !online;
  el.btnErase.classList.toggle("is-busy", st === "erasing");
}

// --- части -----------------------------------------------------------------

function addPart(offset = "0x0") {
  const part = { id: S.nextPartId++, offsetRaw: offset, file: null, data: null };
  S.parts.push(part);

  const row = document.createElement("div");
  row.className = "part";
  row.dataset.id = String(part.id);
  row.innerHTML = `
    <div class="form-row">
      <span class="field-label">Смещение</span>
      <input class="input input--offset" value="${esc(offset)}" spellcheck="false"
             aria-label="Смещение части">
      <span class="form-row__tail">
        <button class="btn btn--outline btn--sm part__remove" type="button">Удалить</button>
      </span>
    </div>
    <div class="form-row">
      <span class="field-label">Файл</span>
      <input class="input" type="file" accept=".bin,application/octet-stream"
             aria-label="Файл части">
      <span class="part__size"></span>
      <p class="part__name"></p>
    </div>`;

  const [offsetInput, fileInput] = row.querySelectorAll("input");
  const sizeNode = row.querySelector(".part__size");
  const nameNode = row.querySelector(".part__name");

  offsetInput.addEventListener("input", () => {
    part.offsetRaw = offsetInput.value;
    validateParts();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0] || null;
    part.file = file;
    part.data = null;
    sizeNode.textContent = file ? "…" : "";
    // Полного пути браузер не отдаёт никогда: в File есть только имя,
    // а input.value подменяется на C:\fakepath\… Показываем имя целиком —
    // в самом поле оно обрезается.
    nameNode.textContent = file ? file.name : "";
    if (file) {
      // сразу Uint8Array: с 0.6.0 writeFlash принимает только его,
      // а 0.7.0 на бинарную строку бросает исключение
      part.data = new Uint8Array(await file.arrayBuffer());
      sizeNode.textContent = formatBytes(part.data.length);
    }
    validateParts();
  });

  row.querySelector(".part__remove").addEventListener("click", () => {
    S.parts = S.parts.filter((p) => p.id !== part.id);
    row.remove();
    if (S.parts.length === 0) addPart("0x0");
    validateParts();
  });

  el.parts.appendChild(row);
  render();
}

function parseOffset(raw) {
  const s = String(raw).trim().replace(/[\s_]/g, "");
  if (!s) return NaN;
  const n = /^0[xX]/.test(s)
    ? (/^0[xX][0-9a-fA-F]+$/.test(s) ? parseInt(s.slice(2), 16) : NaN)
    : (/^[0-9]+$/.test(s) ? parseInt(s, 10) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > MAX_OFFSET) return NaN;
  return n;
}

function validateParts() {
  const errors = [];
  const warns = [];
  const filled = [];

  S.parts.forEach((part, i) => {
    const num = i + 1;
    const offset = parseOffset(part.offsetRaw);
    part.offset = offset;

    if (Number.isNaN(offset)) {
      if (part.offsetRaw.trim() !== "" || part.data) {
        errors.push(`Часть ${num}: смещение «${esc(part.offsetRaw)}» непонятно. ` +
          `Ожидается <code>0x10000</code> или <code>65536</code>.`);
      }
      return;
    }
    if (offset % SECTOR !== 0) {
      errors.push(`Часть ${num}: смещение ${hex(offset)} не кратно ` +
        `<code>0x1000</code>. Запись стирает флеш секторами по 4 КБ, ` +
        `и соседние данные будут затёрты.`);
      return;
    }
    if (part.data) filled.push({ num, offset, len: part.data.length, part });
  });

  if (filled.length === 0) {
    S.partsValid = false;
    el.partsErrors.innerHTML = errors.length
      ? errors.map((e) => notice("error", e)).join("")
      : "";
    render();
    return;
  }

  const sorted = [...filled].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.offset === cur.offset) {
      errors.push(`Части ${prev.num} и ${cur.num} стоят на одном адресе ${hex(cur.offset)}.`);
    } else if (prev.offset + prev.len > cur.offset) {
      errors.push(`Части ${prev.num} и ${cur.num} перекрываются: ` +
        `часть ${prev.num} занимает до ${hex(prev.offset + prev.len)}, ` +
        `а часть ${cur.num} начинается с ${hex(cur.offset)}.`);
    }
  }

  // мягкое: образ с магией 0xE9 — это загрузчик или приложение, и если он
  // лежит не там, куда чип смотрит при старте, плата не поднимется
  const bootOffset = S.esploader?.chip?.BOOTLOADER_FLASH_OFFSET;
  if (bootOffset !== undefined && sorted[0].offset !== bootOffset &&
      sorted[0].part.data[0] === 0xe9 && sorted[0].offset === 0) {
    warns.push(`У этого чипа загрузчик начинается с ${hex(bootOffset)}, ` +
      `а первая часть стоит на 0x0.`);
  }

  S.partsValid = errors.length === 0;
  el.partsErrors.innerHTML =
    errors.map((e) => notice("error", e)).join("") +
    warns.map((w) => notice("warn", w)).join("");
  render();
}

// --- подключение -----------------------------------------------------------

async function connect() {
  el.connectNotice.innerHTML = "";
  el.result.innerHTML = "";

  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e && e.name === "NotFoundError") {
      el.connectNotice.innerHTML = notice("info", "Порт не выбран.");
      return;
    }
    el.connectNotice.innerHTML = notice("error", humanError(e));
    return;
  }

  setState("connecting");
  try {
    S.transport = new Transport(port, false);
    S.transport.setDeviceLostCallback(onDeviceLost);

    S.esploader = new ESPLoader({
      transport: S.transport,
      baudrate: Number(el.baudrate.value),
      romBaudrate: 115200,
      terminal: term,
    });

    const description = await S.esploader.main();
    await fillChipInfo(description);
    populateFlashSelects();
    setState("connected");
    validateParts();
  } catch (e) {
    el.connectNotice.innerHTML = notice("error", humanError(e));
    await safeDisconnect();
    setState("idle");
  }
}

async function fillChipInfo(description) {
  const chip = S.esploader.chip;
  el.iChip.textContent = description || chip.CHIP_NAME || "—";

  try {
    el.iMac.textContent = await chip.readMac(S.esploader);
  } catch {
    el.iMac.textContent = "—";
  }

  try {
    // в 0.7.0 detectFlashSize() может вернуть undefined
    el.iFlash.textContent = (await S.esploader.detectFlashSize()) || "не определился";
  } catch {
    el.iFlash.textContent = "не определился";
  }

  try {
    el.iPort.textContent = S.transport.getInfo() || "—";
  } catch {
    el.iPort.textContent = "—";
  }

  if (chip.BOOTLOADER_FLASH_OFFSET !== undefined) {
    el.rowBootloader.textContent = hex(chip.BOOTLOADER_FLASH_OFFSET);
  }
}

function populateFlashSelects() {
  const chip = S.esploader.chip;

  const fill = (node, keys, head) => {
    const chosen = node.value;
    node.innerHTML = "";
    for (const [value, label] of head) {
      node.append(new Option(label, value));
    }
    for (const key of keys) {
      if (!head.some(([v]) => v === key)) node.append(new Option(key, key));
    }
    node.value = head.some(([v]) => v === chosen) ? chosen : head[0][0];
  };

  fill(el.flashSize, Object.keys(chip.FLASH_SIZES || {}), [
    ["keep", "keep — как в образе"],
    ["detect", "detect — определить"],
  ]);
  fill(el.flashFreq, Object.keys(chip.FLASH_FREQUENCY || {}), [["keep", "keep"]]);
}

function onDeviceLost() {
  if (S.state === "flashing" || S.state === "erasing") {
    el.result.innerHTML = notice(
      "error",
      "Устройство отключилось во время записи. Прошивка не завершена, " +
        "во флеше сейчас каша — подключить заново и повторить с начала.",
    );
  }
  S.transport = null;
  S.esploader = null;
  setState("idle");
}

async function safeDisconnect() {
  try {
    await S.transport?.disconnect();
  } catch {
    /* порт мог уже закрыться сам */
  }
  S.transport = null;
  S.esploader = null;
}

async function disconnect() {
  await safeDisconnect();
  el.connectNotice.innerHTML = "";
  setState("idle");
}

// --- прошивка --------------------------------------------------------------

function makeProgressReporter(sizes) {
  const before = [];
  let sum = 0;
  for (const size of sizes) {
    before.push(sum);
    sum += size;
  }
  let lastPaint = 0;

  return (fileIndex, written, total) => {
    const done = (before[fileIndex] ?? 0) + written;
    const now = performance.now();
    // на 8 МБ перерисовка на каждый пакет съедает заметную долю времени
    if (now - lastPaint < 100 && written !== total) return;
    lastPaint = now;

    const percent = S.totalBytes ? Math.round((done / S.totalBytes) * 100) : 0;
    el.progress.value = percent;
    el.progressLabel.textContent =
      `Часть ${fileIndex + 1} из ${sizes.length} · ` +
      `${formatBytes(done)} из ${formatBytes(S.totalBytes)} · ${percent}%`;
  };
}

async function flash() {
  el.result.innerHTML = "";
  validateParts();
  if (!S.partsValid) return;

  const fileArray = S.parts
    .filter((p) => p.data)
    .sort((a, b) => a.offset - b.offset)
    .map((p) => ({ data: p.data, address: p.offset }));

  S.totalBytes = fileArray.reduce((n, f) => n + f.data.length, 0);
  S.startedAt = performance.now();

  el.progressBox.hidden = false;
  el.progress.value = 0;
  el.progressLabel.textContent = "Подготовка…";
  setState("flashing");

  try {
    await S.esploader.writeFlash({
      fileArray,
      flashSize: el.flashSize.value,
      flashMode: el.flashMode.value,
      flashFreq: el.flashFreq.value,
      eraseAll: el.optErase.checked,
      compress: el.optCompress.checked,
      reportProgress: makeProgressReporter(fileArray.map((f) => f.data.length)),
      ...(el.optVerify.checked ? { calculateMD5Hash: (image) => md5(image) } : {}),
    });

    const spent = formatDuration(performance.now() - S.startedAt);
    const reset = el.optReset.checked;
    if (reset) await S.esploader.after("hard_reset");

    el.progress.value = 100;
    el.progressLabel.textContent = "Готово";
    el.result.innerHTML = notice(
      "ok",
      `Прошито: ${formatBytes(S.totalBytes)} ` +
        `${fileArray.length === 1 ? "одной частью" : `за ${fileArray.length} части`} ` +
        `за ${spent}.` +
        (reset
          ? " Плата перезагружена и уже не в режиме загрузчика — чтобы " +
            "прошить ещё раз, подключиться заново."
          : ""),
    );

    if (reset) {
      // после hard_reset плата ушла в приложение, и загрузчика на том конце
      // больше нет: держать «подключено» — врать
      await safeDisconnect();
      setState("idle");
    } else {
      setState("done");
    }
  } catch (e) {
    el.result.innerHTML = notice("error", humanError(e));
    log("Ошибка: " + (e?.message || e));
    setState("error");
  }
}

async function eraseAll() {
  if (!confirm(
    "Стереть всю флеш-память?\n\n" +
    "Исчезнет всё: прошивка, настройки, сохранённые данные. " +
    "Отменить это будет нельзя.",
  )) return;

  el.result.innerHTML = "";
  el.progressBox.hidden = false;
  el.progress.removeAttribute("value"); // неопределённый прогресс
  el.progressLabel.textContent = "Стирание — это надолго…";
  setState("erasing");

  try {
    await S.esploader.eraseFlash();
    el.progress.value = 100;
    el.progressLabel.textContent = "Готово";
    el.result.innerHTML = notice("ok", "Флеш-память стёрта.");
    setState("done");
  } catch (e) {
    el.progress.value = 0;
    el.result.innerHTML = notice("error", humanError(e));
    setState("error");
  }
}

// --- ошибки ----------------------------------------------------------------

const ERROR_HINTS = [
  ["Failed to connect with the device",
    "Плата не отозвалась. Перевести её в режим загрузчика: зажать <b>BOOT</b>, " +
    "коротко нажать <b>RESET</b>, отпустить <b>BOOT</b> — и подключиться заново."],
  ["Invalid head of packet",
    "Мусор вместо ответа. Обычно это слишком высокая скорость — попробовать 115200."],
  ["Unable to verify flash chip connection",
    "Не удалось поговорить с микросхемой флеша. Проверить пайку и питание платы."],
  ["Could not auto-detect Flash size",
    "Размер флеша не определился. Выбрать его вручную в «Параметрах флеша»."],
  ["doesn't fit in the available flash",
    "Образ не влезает во флеш платы. Проверить, что прошивка собрана под эту плату."],
  ["MD5 of file does not match",
    "Записанное не совпало с файлом. Повторить, снизив скорость."],
  ["must be a Uint8Array",
    "Файл прочитался неправильно — перевыбрать его."],
  ["Timeout",
    "Плата перестала отвечать. Переподключить кабель и начать заново."],
];

const DOM_HINTS = {
  NotFoundError: "Порт не выбран.",
  SecurityError: "Браузер запретил доступ к последовательному порту.",
  NetworkError: "Порт занят другой программой — закрыть монитор порта или IDE.",
  InvalidStateError: "Порт уже открыт. Перезагрузить страницу.",
};

function humanError(e) {
  const message = e?.message || String(e);

  if (e instanceof DOMException && DOM_HINTS[e.name]) {
    return DOM_HINTS[e.name];
  }
  for (const [needle, hint] of ERROR_HINTS) {
    if (message.includes(needle)) return hint;
  }
  return `Не получилось: <code>${esc(message)}</code>`;
}

// --- запуск ----------------------------------------------------------------

el.btnConnect.addEventListener("click", connect);
el.btnDisconnect.addEventListener("click", disconnect);
el.btnAddPart.addEventListener("click", () => addPart("0x0"));
el.btnFlash.addEventListener("click", flash);
el.btnErase.addEventListener("click", eraseAll);
el.btnClearLog.addEventListener("click", () => term.clean());

const years = new Date().getFullYear() - 2019;
$("#copyright").textContent =
  `© Ватериус. Автоматизируем отправку показаний воды уже ${years} лет.`;

addPart("0x0");

if (checkEnvironment()) {
  setState("idle");
  log("Готов к работе. Подключите плату и нажмите «Подключить».");
} else {
  setState("unsupported");
}

// снимает заглушку «скрипт не загрузился», которую ставит index.html
window.__flasherReady = true;
