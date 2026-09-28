// Консоль LoRa: прошивка платы через esptool-js и терминал консоли платы по
// Web Serial. Команды и формат ответов задаёт прошивка хаба (waterius.hub,
// src/core/console): строку «Консоль: lora ready=…» страница разбирает, и
// менять её формат можно только вместе с прошивкой.
//
// Версия esptool-js закреплена намеренно, как в /update/: 0.6 и 0.7 уже
// ломали формат данных writeFlash. Грузится только для прошивки: без CDN
// терминал и команды продолжают работать.
const ESPTOOL_URL = "https://unpkg.com/esptool-js@0.7.0/bundle.js";

const $ = (id) => document.getElementById(id);

const BAUD = 115200;         // USB-Serial/JTAG скорость не использует, но open() её требует
const FLASH_BAUD = 460800;
const WINDOW_LINES = 5000;   // в окне; в файл лога идут все строки сеанса
const REPLY_MS = 2000;       // ответ консоли на lora
const PARAMS_RE =
  /Консоль: lora ready=([01]) freq=([\d.]+) bw=(\d+) sf=(\d+) cr=(\d+) power=(-?\d+) sync_word=0x([0-9A-Fa-f]{2}) preamble=(\d+)/;
const ERROR_RE = /Консоль: ошибка: (.*)$/;

const S = {
  port: null,
  open: false,        // терминал читает порт
  reader: null,
  piped: null,        // promise конвейера порт → декодер
  partial: "",        // хвост без перевода строки
  lines: [],          // весь лог сеанса
  shown: 0,           // строк в окне
  waiters: [],        // ожидания строки ответа
  busy: false,        // идёт прошивка
  reopen: false,      // после прошивки плата переподключилась: открыть терминал, когда вернётся
  history: [],
  historyPos: 0,
};

const logEl = $("log");
const encoder = new TextEncoder();

// --- лог --------------------------------------------------------------------

function addLine(line) {
  S.lines.push(line);
  logEl.append(line + "\n");
  if (++S.shown > WINDOW_LINES + 500) {
    logEl.textContent = S.lines.slice(-WINDOW_LINES).join("\n") + "\n";
    S.shown = WINDOW_LINES;
  }
  if ($("log-follow").checked) logEl.scrollTop = logEl.scrollHeight;
  for (const w of [...S.waiters]) {
    if (w.match(line)) w.done(line);
  }
}

// Сообщения самой страницы — в том же логе, чтобы файл лога был полным
function note(text) {
  addLine(`[страница] ${text}`);
}

function feed(chunk) {
  const parts = (S.partial + chunk).split("\n");
  S.partial = parts.pop();
  for (const p of parts) addLine(p.replace(/\r$/, ""));
}

// Первая строка, для которой match() истинно, или null через ms
function waitFor(match, ms) {
  return new Promise((resolve) => {
    const w = {
      match,
      done: (line) => {
        clearTimeout(w.timer);
        S.waiters = S.waiters.filter((x) => x !== w);
        resolve(line);
      },
    };
    w.timer = setTimeout(() => w.done(null), ms);
    S.waiters.push(w);
  });
}

function saveLog() {
  const text = S.lines.join("\n") + (S.partial ? "\n" + S.partial : "") + "\n";
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `lora-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- порт и терминал ----------------------------------------------------------

async function openTerminal() {
  await S.port.open({ baudRate: BAUD });
  S.open = true;
  const decoder = new TextDecoderStream();
  S.piped = S.port.readable.pipeTo(decoder.writable).catch(() => {});
  S.reader = decoder.readable.getReader();
  setControls();
  readLoop();
}

async function readLoop() {
  try {
    for (;;) {
      const { value, done } = await S.reader.read();
      if (done) break;
      if (value) feed(value);
    }
  } catch (e) {
    note(`порт закрылся: ${e.message || e}`);
  } finally {
    try { S.reader?.releaseLock(); } catch { /* уже отпущен */ }
    S.reader = null;
  }
}

async function closeTerminal() {
  if (!S.open) return;
  S.open = false;
  try { await S.reader?.cancel(); } catch { /* порт мог уйти сам */ }
  await S.piped;
  try { await S.port.close(); } catch { /* уже закрыт */ }
  setControls();
}

async function send(line) {
  if (!S.open) return false;
  const writer = S.port.writable.getWriter();
  try {
    await writer.write(encoder.encode(line + "\n"));
    return true;
  } catch (e) {
    note(`команда не отправлена: ${e.message || e}`);
    return false;
  } finally {
    writer.releaseLock();
  }
}

// Команда и первая строка ответа, подходящая под match; null — ответа нет
async function ask(line, match, ms = REPLY_MS) {
  const reply = waitFor(match, ms);
  if (!(await send(line))) return null;
  return reply;
}

async function connect() {
  try {
    S.port = await navigator.serial.requestPort();
  } catch (e) {
    if (e?.name !== "NotFoundError") note(`порт не открыт: ${e.message || e}`);
    return;
  }
  try {
    await openTerminal();
    note("плата подключена");
  } catch (e) {
    note(`порт не открылся: ${e.message || e}. Порт занят другой программой?`);
    S.port = null;
    setControls();
  }
}

async function disconnect() {
  await closeTerminal();
  S.port = null;
  S.reopen = false;
  note("плата отключена");
  setControls();
}

// Hard reset esptool для USB-Serial/JTAG: RTS вверх при DTR внизу
async function resetBoard() {
  try {
    await S.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise((r) => setTimeout(r, 100));
    await S.port.setSignals({ requestToSend: false });
    note("плата перезагружается");
  } catch (e) {
    note(`перезагрузка не удалась: ${e.message || e}`);
  }
}

// --- прошивка -----------------------------------------------------------------

const espTerminal = {
  clean() {},
  writeLine(text) { addLine(`esptool: ${text}`); },
  write(text) { addLine(`esptool: ${text}`); },
};

function fwResult(kind, html) {
  $("fw-result").innerHTML = html ? `<div class="notice notice--${kind}">${html}</div>` : "";
}

async function flash() {
  const file = $("fw-file").files[0];
  if (!file) return;
  if (!S.port) {
    try {
      S.port = await navigator.serial.requestPort();
    } catch {
      return;
    }
  }
  const data = new Uint8Array(await file.arrayBuffer());
  S.busy = true;
  setControls();
  fwResult("", "");
  $("fw-progress").hidden = false;
  $("fw-bar").value = 0;
  $("fw-label").textContent = "подключаемся к загрузчику…";
  await closeTerminal();
  note(`прошивка ${file.name}, ${data.length} байт, с адреса 0x0`);

  let transport = null;
  let ok = false;
  try {
    const { ESPLoader, Transport } = await import(ESPTOOL_URL);
    transport = new Transport(S.port, false);
    const loader = new ESPLoader({ transport, baudrate: FLASH_BAUD, romBaudrate: BAUD, terminal: espTerminal });
    const chip = await loader.main();
    note(`чип: ${chip}`);
    await loader.writeFlash({
      fileArray: [{ data, address: 0 }],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_, written, total) => {
        const pct = total ? Math.round((written / total) * 100) : 0;
        $("fw-bar").value = pct;
        $("fw-label").textContent = `${pct}%`;
      },
    });
    // Перезагрузка только после полной записи: полуписанную прошивку не запускаем
    await loader.after("hard_reset");
    ok = true;
    $("fw-bar").value = 100;
    $("fw-label").textContent = "100%";
    fwResult("ok", "Записано, плата перезагружена. Лог новой прошивки — ниже.");
    note("записано, плата перезагружена");
  } catch (e) {
    fwResult("error",
      `Не получилось: <code>${escapeHtml(e.message || String(e))}</code>. Если плата не отвечает загрузчику, ` +
      `подключите её с зажатой кнопкой <b>BOOT</b> и нажмите «Прошить» ещё раз.`);
    note(`прошивка не удалась: ${e.message || e}`);
  } finally {
    try { await transport?.disconnect(); } catch { /* порт мог уйти вместе с платой */ }
    S.busy = false;
    try {
      await openTerminal();
    } catch {
      // Плата после перезагрузки появилась заново: терминал откроется, когда порт вернётся
      S.reopen = ok;
      note("порт платы переподключается; если лог не пошёл — «Подключить»");
    }
    setControls();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// --- параметры радио ------------------------------------------------------------

const form = document.forms.radio;
const FIELDS = ["freq", "bw", "sf", "cr", "power", "sync_word", "preamble"];

// Мощность на выходе чипа в мВт, без учёта антенны: 10^(дБм/10)
function showMw() {
  const v = parseFloat(form.power.value);
  if (isNaN(v)) {
    $("f-mw").textContent = "";
    return;
  }
  const mw = Math.pow(10, v / 10);
  $("f-mw").textContent =
    mw.toLocaleString("ru-RU", { maximumFractionDigits: mw < 1 ? 2 : mw < 10 ? 1 : 0 }) + " мВт на выходе чипа";
}

function clearFieldErrors() {
  form.querySelectorAll("label").forEach((l) => {
    l.classList.remove("field-error");
    l.querySelector(".err").textContent = "";
  });
}

function radioResult(kind, text) {
  $("radio-result").innerHTML = text ? `<span class="${kind}">${escapeHtml(text)}</span>` : "";
}

function fillForm(m) {
  form.freq.value = m[2];
  form.bw.value = m[3];
  form.sf.value = m[4];
  form.cr.value = m[5];
  form.power.value = m[6];
  form.sync_word.value = m[7].toUpperCase();
  form.preamble.value = m[8];
  showMw();
}

// Ответ на lora: строка параметров или ошибка
const radioReply = (line) => PARAMS_RE.test(line) || ERROR_RE.test(line);

function showReply(line, okText) {
  if (!line) {
    radioResult("bad", "плата не ответила — прошивка без консоли, ниже 0.2.5?");
    return;
  }
  const m = line.match(PARAMS_RE);
  if (m) {
    fillForm(m);
    radioResult("ok", okText + (m[1] === "1" ? "" : ", но радио не работает"));
    return;
  }
  const err = line.match(ERROR_RE)[1];
  radioResult("bad", err);
  // «sf: …; power: …» — подсветить поля
  for (const part of err.split("; ")) {
    const name = part.split(":")[0];
    const label = form.querySelector(`label[data-f="${name}"]`);
    if (label) {
      label.classList.add("field-error");
      label.querySelector(".err").textContent = part.slice(name.length + 2);
    }
  }
}

async function readRadio() {
  clearFieldErrors();
  radioResult("", "читаем…");
  showReply(await ask("lora", radioReply), "прочитано с платы");
}

async function writeRadio() {
  clearFieldErrors();
  const v = Object.fromEntries(FIELDS.map((f) => [f, form[f].value.trim()]));
  const empty = FIELDS.filter((f) => !v[f]);
  if (empty.length) {
    radioResult("bad", "заполните поля: " + empty.join(", ") + " — или «Прочитать с платы»");
    return;
  }
  radioResult("", "записываем…");
  const cmd = `lora freq=${v.freq} bw=${v.bw} sf=${v.sf} cr=${v.cr} power=${v.power} ` +
    `sync_word=0x${v.sync_word} preamble=${v.preamble}`;
  showReply(await ask(cmd, radioReply), "записано в плату");
}

// --- передача и замеры ------------------------------------------------------------

function hexOrWarn() {
  const hex = $("tx-hex").value.trim();
  if (!hex) note("введите кадр в hex");
  return hex;
}

function remember(id) {
  try { localStorage.setItem("lora-" + id, $(id).value); } catch { /* приватный режим */ }
}
function restore(id) {
  try {
    const v = localStorage.getItem("lora-" + id);
    if (v) $(id).value = v;
  } catch { /* приватный режим */ }
}

// --- кнопки ---------------------------------------------------------------------

function setControls() {
  const supported = "serial" in navigator;
  const live = S.open && !S.busy;
  $("btn-connect").hidden = !!S.port;
  $("btn-disconnect").hidden = !S.port;
  $("btn-connect").disabled = !supported || S.busy;
  $("btn-disconnect").disabled = S.busy;
  $("btn-reset").disabled = !live;
  $("btn-flash").disabled = !supported || S.busy || !$("fw-file").files.length;
  for (const id of ["btn-read", "btn-write", "btn-tx", "btn-every", "btn-stop", "btn-rssi", "btn-cw",
    "btn-cw-stop", "btn-send", "cmd"]) {
    $(id).disabled = !live;
  }
  const state = $("port-state");
  state.textContent = S.busy ? "идёт прошивка" : S.open ? "подключена" : S.port ? "порт закрыт" : "не подключена";
  state.className = "state" + (S.open && !S.busy ? " state--ok" : "");
}

function on(id, fn) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    fn();
  });
}

if (!("serial" in navigator)) {
  $("no-serial").hidden = false;
} else {
  navigator.serial.addEventListener("disconnect", (e) => {
    if (e.target !== S.port) return;
    S.open = false;
    note("плата отключилась от USB");
    setControls();
  });
  navigator.serial.addEventListener("connect", async (e) => {
    if (!S.reopen) return;
    S.reopen = false;
    S.port = e.target;
    try {
      await openTerminal();
      note("плата вернулась, терминал открыт");
    } catch (err) {
      note(`терминал не открылся: ${err.message || err}`);
    }
    setControls();
  });
}

on("btn-connect", connect);
on("btn-disconnect", disconnect);
on("btn-reset", resetBoard);
on("btn-flash", flash);
$("fw-file").addEventListener("change", setControls);
on("btn-read", readRadio);
on("btn-write", writeRadio);
form.power.addEventListener("input", showMw);
on("btn-tx", () => {
  const hex = hexOrWarn();
  if (hex) send(`tx ${hex}`);
});
on("btn-every", () => {
  const hex = hexOrWarn();
  if (!hex) return;
  remember("tx-every");
  send(`tx every ${$("tx-every").value} ${hex}`);
});
on("btn-stop", () => send("tx stop"));
on("btn-rssi", () => send("rssi"));
on("btn-cw", () => {
  remember("cw-sec");
  send(`cw ${$("cw-sec").value}`);
});
on("btn-cw-stop", () => send("cw stop"));
on("btn-save", saveLog);
on("btn-clear", () => {
  logEl.textContent = "";
  S.shown = 0;
});

$("cmd-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const line = $("cmd").value.trim();
  if (!line) return;
  send(line);
  if (S.history[S.history.length - 1] !== line) S.history.push(line);
  if (S.history.length > 50) S.history.shift();
  S.historyPos = S.history.length;
  $("cmd").value = "";
});
// Стрелки вверх и вниз — прежние команды
$("cmd").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  S.historyPos = Math.max(0, Math.min(S.history.length, S.historyPos + (e.key === "ArrowUp" ? -1 : 1)));
  $("cmd").value = S.history[S.historyPos] || "";
});

restore("tx-every");
restore("cw-sec");
setControls();
