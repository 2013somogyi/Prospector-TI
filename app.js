/* ================= CONFIGURAÇÃO ================= */
const CONFIG = {
  GEMINI_API_KEY: "",
  GEMINI_API_ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
  OVERPASS_MIRRORS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ],
  NOMINATIM_ENDPOINT: "https://nominatim.openstreetmap.org/search",
  CACHE_EXPIRATION_DAYS: 7,
  REQUEST_DELAY_MS: 10000 // intervalo entre requisições (evita erro 429)
};

/* ================= UTILIDADES ================= */
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmptyVal = v => !v || /^(não|nao) (identificado|encontrado)/i.test(v.trim());

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type; t.textContent = msg;
  $("toasts").appendChild(t); setTimeout(() => t.remove(), 5000);
}

let results = [];
let stats = { cacheHits: 0 };
let paused = false, abortCtrl = null, running = false;

/* ================= TEMA E CONFIG UI ================= */
function applyTheme(t) { document.documentElement.dataset.theme = t; store.set("theme", t); }
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("btnTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

function getKey() { return store.get("apiKey", CONFIG.GEMINI_API_KEY); }
function getEndpoint() { return store.get("apiEndpoint", CONFIG.GEMINI_API_ENDPOINT); }
$("btnConfig").onclick = () => { $("cfgKey").value = getKey(); $("cfgEndpoint").value = getEndpoint(); $("dlgConfig").showModal(); };
$("cfgClose").onclick = () => $("dlgConfig").close();
$("cfgSave").onclick = () => {
  store.set("apiKey", $("cfgKey").value.trim()); store.set("apiEndpoint", $("cfgEndpoint").value.trim());
  $("dlgConfig").close(); toast("Configurações salvas.", "ok");
};

/* ================= FETCH / ESPERA ================= */
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Cancelado", "AbortError")); }, { once: true });
  });
}
async function waitIfPaused(signal) { while (paused) await sleep(300, signal); }

/* ================= GEOCODING ================= */
async function geocode(address, signal) {
  const url = `${CONFIG.NOMINATIM_ENDPOINT}?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(address)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "pt-BR" }, signal });
  if (!r.ok) throw new Error("Falha no geocoding (HTTP " + r.status + ")");
  const d = await r.json();
  if (!d.length) throw new Error("Endereço não encontrado. Tente incluir cidade e estado.");
  const a = d[0].address || {};
  return { lat: +d[0].lat, lon: +d[0].lon, city: a.city || a.town || a.municipality || a.village || a.county || "" };
}

/* ================= OVERPASS ================= */
const SEGMENTS = {
  office: ['["office"]'],
  industrial: ['["industrial"]', '["man_made"="works"]'],
  logistics: ['["building"="warehouse"]', '["landuse"="industrial"]'],
  health: ['["amenity"="hospital"]', '["amenity"="clinic"]'],
  retail: ['["shop"="supermarket"]', '["shop"="department_store"]'],
  education: ['["amenity"="university"]', '["amenity"="college"]']
};
SEGMENTS.all = Object.values(SEGMENTS).flat();

function buildQuery(seg, radiusM, lat, lon) {
  const parts = SEGMENTS[seg].map(f => `node${f}["name"](around:${radiusM},${lat},${lon});way${f}["name"](around:${radiusM},${lat},${lon});`).join("");
  return `[out:json][timeout:25];(${parts});out center tags;`;
}

async function overpass(query, signal) {
  let lastErr;
  for (const mirror of CONFIG.OVERPASS_MIRRORS) {
    try {
      const r = await fetch(mirror, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).elements || [];
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastErr = e; toast("Servidor Overpass indisponível, tentando o próximo...");
    }
  }
  throw new Error("Todos os servidores Overpass falharam: " + (lastErr?.message || ""));
}

function dedupe(elements) {
  const seen = new Map();
  for (const el of elements) {
    const t = el.tags || {}; if (!t.name) continue;
    const key = norm(t.name); if (seen.has(key)) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    seen.set(key, {
      id: key, empresa: t.name, lat, lon,
      endereco: [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(", "),
      website: t.website || t["contact:website"] || "", telefoneOsm: t.phone || t["contact:phone"] || "",
      maps: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
    });
  }
  return [...seen.values()];
}

/* ================= GEMINI ================= */
const SYSTEM_PROMPT = `Você é um analista de inteligência comercial B2B. Use a pesquisa na web para identificar o Gestor de TI, Gerente de TI, Coordenador de TI, Head de Tecnologia ou CTO da empresa indicada, na região informada. Nunca invente nomes: se não houver fonte confiável, use "Não identificado" / "Não encontrado". Responda ESTRITAMENTE com um objeto JSON válido, sem markdown, neste formato:
{"empresa":"","gestor_nome":"","cargo":"","linkedin":"","email":"","telefone":"","nivel_confianca":"Alto | Médio | Baixo","observacao":""}`;

function parseJson(text) {
  const clean = (text || "").replace(/```json|```/gi, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Resposta sem JSON válido");
  return JSON.parse(clean.slice(a, b + 1));
}

async function callGemini(body, signal) {
  const key = getKey(), endpoint = getEndpoint();
  if (!key || key.startsWith("COLE_")) throw new Error("Chave da API não configurada.");
  if (!endpoint || endpoint.startsWith("COLE_")) throw new Error("Endpoint do Gemini não configurado.");
  const headers = { "Content-Type": "application/json" };
  let url = endpoint;
  if (/[?&]key=/.test(endpoint)) { /* chave já na URL */ }
  else headers["x-goog-api-key"] = key;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
}

async function enrich(c, city, signal) {
  const ctx = [`Empresa: ${c.empresa}`, `Cidade/região: ${city || "não informada"}`, c.endereco && `Endereço OSM: ${c.endereco}`,
    c.website && `Site: ${c.website}`, c.telefoneOsm && `Telefone OSM: ${c.telefoneOsm}`, `Coordenadas: ${c.lat}, ${c.lon}`].filter(Boolean).join("\n");
  const base = { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: "user", parts: [{ text: ctx }] }] };
  let r = await callGemini({ ...base, tools: [{ google_search: {} }] }, signal);
  if (r.status === 400) { // endpoint/modelo pode não aceitar google_search: fallback sem a ferramenta
    r = await callGemini({ ...base, generationConfig: { responseMimeType: "application/json" } }, signal);
  }
  if (r.status === 429) throw Object.assign(new Error("Limite de cota excedido (429)."), { quota: true });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Chave de API inválida ou sem permissão."), { fatal: true });
  if (!r.ok) throw new Error("Erro Gemini HTTP " + r.status);
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  return parseJson(text);
}

/* ================= CACHE ================= */
const cacheKey = (c, city) => "lead:" + norm(c.empresa) + "|" + norm(city);
function cacheGet(c, city) {
  const e = store.get(cacheKey(c, city), null);
  if (!e || Date.now() - e.t > CONFIG.CACHE_EXPIRATION_DAYS * 864e5) return null;
  return e.d;
}
const cacheSet = (c, city, d) => store.set(cacheKey(c, city), { t: Date.now(), d });

/* ================= FILA ================= */
function setProgress(i, total, msg) {
  $("barFill").style.width = (total ? (i / total) * 100 : 0) + "%";
  $("status").textContent = msg;
}

async function processLead(lead, city, force, signal) {
  const cached = !force && cacheGet(lead, city);
  if (cached) { stats.cacheHits++; return { ...lead, ...cached, fromCache: true }; }
  const d = await enrich(lead, city, signal);
  cacheSet(lead, city, d);
  return { ...lead, ...d, fromCache: false };
}

async function startScan() {
  if (running) return;
  const address = $("address").value.trim();
  if (!address) return toast("Informe o endereço base.", "error");
  const limit = Math.min(50, Math.max(1, +$("limit").value || 10));
  const force = $("noCache").checked;
  abortCtrl = new AbortController(); const signal = abortCtrl.signal;
  running = true; paused = false; results = []; stats.cacheHits = 0; render();
  $("progressBox").hidden = false; $("btnStart").disabled = true; $("btnPause").textContent = "Pausar";
  try {
    setProgress(0, 1, "Localizando endereço...");
    const geo = await geocode(address, signal);
    setProgress(0, 1, "Buscando empresas no OpenStreetMap...");
    const radiusM = +$("radius").value * 1000;
    const found = dedupe(await overpass(buildQuery($("segment").value, radiusM, geo.lat, geo.lon), signal)).slice(0, limit);
    if (!found.length) throw new Error("Nenhuma empresa com nome encontrada nesse raio/segmento.");
    window._city = geo.city;
    results = found.map(f => ({ ...f, pending: true })); render();
    for (let i = 0; i < found.length; i++) {
      await waitIfPaused(signal);
      setProgress(i, found.length, `Processando ${i + 1} de ${found.length}: ${found[i].empresa}...`);
      try {
        const res = await processLead(found[i], geo.city, force, signal);
        results[i] = res; render();
        if (!res.fromCache && i < found.length - 1) {
          setProgress(i + 1, found.length, `Processando ${i + 1} de ${found.length}: ${found[i].empresa}... (aguardando intervalo de segurança)`);
          await sleep(CONFIG.REQUEST_DELAY_MS, signal);
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        results[i] = { ...found[i], error: e.message }; render();
        toast(e.message, "error");
        if (e.fatal || e.quota) break;
      }
    }
    setProgress(found.length, found.length, "Varredura concluída.");
    toast("Varredura concluída.", "ok");
  } catch (e) {
    if (e.name === "AbortError") { setProgress(0, 1, "Varredura cancelada."); toast("Varredura cancelada."); }
    else toast(e.message, "error");
  } finally { running = false; $("btnStart").disabled = false; render(); }
}
$("btnStart").onclick = startScan;
$("btnCancel").onclick = () => { abortCtrl?.abort(); paused = false; };
$("btnPause").onclick = () => { paused = !paused; $("btnPause").textContent = paused ? "Retomar" : "Pausar"; };

/* ================= RENDER ================= */
function xray(r) {
  const q = `site:linkedin.com/in/ "${r.empresa}" ("TI" OR "Tecnologia" OR "Gerente de TI")`;
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}
function linkedinUrl(r) { return /^https?:\/\//i.test(r.linkedin || "") ? r.linkedin : xray(r); }

function render() {
  const f = norm($("filter").value);
  const list = results.filter(r => !f || norm([r.empresa, r.gestor_nome, r.nivel_confianca].join(" ")).includes(f));
  const analyzed = results.filter(r => r.gestor_nome !== undefined);
  $("kTotal").textContent = results.length;
  $("kMgr").textContent = analyzed.filter(r => !isEmptyVal(r.gestor_nome)).length;
  $("kContact").textContent = analyzed.filter(r => !isEmptyVal(r.email) || !isEmptyVal(r.telefone)).length;
  $("kCache").textContent = stats.cacheHits;
  if (!list.length) { $("rows").innerHTML = `<tr><td colspan="5" class="empty">Nenhum resultado para exibir.</td></tr>`; return; }
  $("rows").innerHTML = list.map(r => {
    const i = results.indexOf(r);
    const conf = norm(r.nivel_confianca || "baixo"); const cls = conf.startsWith("alt") ? "alto" : conf.startsWith("med") ? "medio" : "baixo";
    const pend = r.pending ? "Aguardando..." : r.error ? "Erro: " + esc(r.error) : null;
    return `<tr>
      <td><b>${esc(r.empresa)}</b><small>${esc(r.endereco || "Endereço não informado no OSM")}</small><small><a href="${r.maps}" target="_blank" rel="noopener">Ver no Google Maps</a></small></td>
      <td>${pend ? `<small>${pend}</small>` : `${esc(r.gestor_nome)}<small>${esc(r.cargo)}</small><small>${esc(r.observacao)}</small>`}</td>
      <td>${pend ? "" : `<small>Tel: ${esc(r.telefone)}</small><small>E-mail: ${esc(r.email)}</small>`}</td>
      <td>${pend ? "" : `<span class="badge ${cls}">${esc(r.nivel_confianca || "Baixo")}</span>${r.fromCache ? "<small>cache</small>" : ""}`}</td>
      <td><div class="acts">
        <button class="small" data-a="li" data-i="${i}">LinkedIn</button>
        <button class="small" data-a="msg" data-i="${i}" ${pend ? "disabled" : ""}>Gerar abordagem</button>
        <button class="small" data-a="redo" data-i="${i}" ${running ? "disabled" : ""}>Reprocessar</button>
      </div></td></tr>`;
  }).join("");
}
$("filter").oninput = render;

$("rows").onclick = async e => {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  const r = results[+b.dataset.i];
  if (b.dataset.a === "li") window.open(linkedinUrl(r), "_blank", "noopener");
  if (b.dataset.a === "msg") openScript(r);
  if (b.dataset.a === "redo") {
    b.disabled = true; b.textContent = "...";
    try {
      const d = await enrich(r, window._city || "", null);
      cacheSet(r, window._city || "", d);
      results[+b.dataset.i] = { ...r, ...d, error: undefined, fromCache: false }; toast("Lead reprocessado.", "ok");
    } catch (err) { toast(err.message, "error"); }
    render();
  }
};

/* ================= ABORDAGEM ================= */
function openScript(r) {
  const nome = isEmptyVal(r.gestor_nome) ? "" : r.gestor_nome.split(" ")[0];
  const cargo = isEmptyVal(r.cargo) ? "responsável por tecnologia" : r.cargo;
  $("scriptText").value = `Olá${nome ? ", " + nome : ""}! Tudo bem?\n\nVi que você atua como ${cargo} na ${r.empresa} e gostaria de me conectar. Trabalho com soluções de TI para empresas da região e acredito que podemos trocar boas ideias sobre infraestrutura, segurança e suporte.\n\nPosso te enviar um resumo rápido, sem compromisso? Se preferir não receber contato, é só me avisar.\n\nAbraço!`;
  $("dlgScript").showModal();
}
$("scriptClose").onclick = () => $("dlgScript").close();
$("scriptCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("scriptText").value); }
  catch { $("scriptText").select(); document.execCommand("copy"); }
  toast("Texto copiado.", "ok");
};

/* ================= EXPORTAÇÃO ================= */
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("btnJson").onclick = () => results.length ? download("leads.json", JSON.stringify(results, null, 2), "application/json") : toast("Nada para exportar.", "error");
$("btnCsv").onclick = () => {
  if (!results.length) return toast("Nada para exportar.", "error");
  const cols = ["empresa", "endereco", "maps", "gestor_nome", "cargo", "linkedin", "email", "telefone", "nivel_confianca", "observacao", "website"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(";"), ...results.map(r => cols.map(c => q(r[c])).join(";"))].join("\r\n");
  download("leads.csv", "\uFEFF" + csv, "text/csv;charset=utf-8");
};
render();
