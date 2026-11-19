/* ================= CONFIGURAÇÃO ================= */
const ENV = window.ENV || {};
const CONFIG = {
  GEMINI_API_KEY: ENV.GEMINI_API_KEY || "",
  GEMINI_API_ENDPOINT: ENV.GEMINI_API_ENDPOINT,
  GEOAPIFY_API_KEY: ENV.GEOAPIFY_API_KEY || "",
  GEOAPIFY_ENDPOINT: "https://api.geoapify.com/v2/places",
  OVERPASS_MIRRORS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ],
  NOMINATIM_ENDPOINT: "https://nominatim.openstreetmap.org/search",
  CACHE_EXPIRATION_DAYS: 7,
  HTTP_TIMEOUT_MS: 15000,
  OVERPASS_TIMEOUT_MS: 10000,
  OVERPASS_TOTAL_TIMEOUT_MS: 20000,
  GEMINI_TIMEOUT_MS: 60000,
  REQUEST_DELAY_MS: 750
};

/* ================= UTILIDADES ================= */
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmptyVal = v => {
  const value = String(v ?? "").trim();
  return !value || /^(?:(?:não|nao) (?:identificado|encontrado)|not (?:identified|found))\b/i.test(value);
};

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type; t.textContent = msg;
  $("toasts").appendChild(t); setTimeout(() => t.remove(), 5000);
}

let results = [];
let stats = { cacheHits: 0 };
let paused = false, abortCtrl = null, running = false;

/* ================= TEMA ================= */
function applyTheme(t) {
  document.documentElement.dataset.theme = t; store.set("theme", t);
  $("btnTheme").textContent = t === "dark" ? "Modo claro" : "Modo escuro";
}
applyTheme(store.get("theme", "dark"));
$("btnTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ================= FETCH / ESPERA ================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.HTTP_TIMEOUT_MS) {
  const signal = options.signal;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timedOut) throw new Error(`Tempo limite excedido (${Math.ceil(timeoutMs / 1000)} s).`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Cancelado", "AbortError")); }, { once: true });
  });
}
async function waitIfPaused(signal) { while (paused) await sleep(300, signal); }

/* ================= ENDEREÇO: VIACEP + NOMINATIM ================= */
const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const ABBR = { av: "Avenida", r: "Rua", al: "Alameda", tv: "Travessa", rod: "Rodovia", pca: "Praça", estr: "Estrada", lgo: "Largo" };
const joinParts = a => a.filter(Boolean).join(", ");
const cleanStreet = s => s.replace(/^\s*([A-Za-zÀ-ú]+)\.?\s+/, (m, a) => ABBR[norm(a)] ? ABBR[norm(a)] + " " : m).replace(/\s+/g, " ").trim();

// Extrai rua, número, cidade e UF de textos como "Av. Paulista, 1000 - São Paulo, SP"
function parseAddress(raw) {
  let t = raw.replace(/\s+/g, " ").trim(), uf = "";
  const m = t.match(/[\s,\-–\/]([A-Za-z]{2})\s*$/);
  if (m && UFS.has(m[1].toUpperCase())) { uf = m[1].toUpperCase(); t = t.slice(0, m.index).trim(); }
  const parts = t.split(/\s*[,\-–\/]\s*/).filter(Boolean);
  let number = "", city = "";
  for (const p of parts.slice(1)) {
    if (!number && /^(n[º°o.]?\s*)?\d+[a-z]?$/i.test(p)) number = p.replace(/\D/g, "");
    else city = p;
  }
  return { street: cleanStreet(parts[0] || ""), number, city, uf };
}

async function getJson(url, signal) {
  const r = await fetchWithTimeout(url, { signal });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function viaCep(url, signal, pick) {
  try { return pick(await getJson(url, signal)); }
  catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Falha na consulta ao ViaCEP: " + e.message);
  }
}
const viaCepByCep = (cep, signal) => viaCep(`https://viacep.com.br/ws/${cep}/json/`, signal, d => d.erro ? null : d);
const viaCepByAddr = (p, signal) => viaCep(`https://viacep.com.br/ws/${p.uf}/${encodeURIComponent(p.city)}/${encodeURIComponent(p.street)}/json/`, signal, d => Array.isArray(d) && d.length ? d[0] : null);

async function nominatim(q, signal) {
  const r = await fetchWithTimeout(`${CONFIG.NOMINATIM_ENDPOINT}?format=json&limit=1&addressdetails=1&countrycodes=br&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "pt-BR" }, signal });
  if (!r.ok) throw new Error("Falha na localização (HTTP " + r.status + ")");
  return (await r.json())[0] || null;
}

// Aceita CEP ou endereço (com ou sem cidade/UF), padroniza via ViaCEP e geocodifica
async function resolveAddress(input, signal) {
  const raw = input.replace(/\s+/g, " ").trim();
  const cepM = raw.match(/\b(\d{5})-?(\d{3})\b/);
  let via = null, number = "";
  if (cepM) {
    via = await viaCepByCep(cepM[1] + cepM[2], signal);
    if (!via) throw new Error("CEP não encontrado. Confira os números ou informe o endereço completo.");
    number = (raw.replace(cepM[0], "").match(/\b\d{1,5}\b/) || [""])[0];
  } else {
    const p = parseAddress(raw); number = p.number;
    if (p.uf && p.city && p.street.length >= 3) via = await viaCepByAddr(p, signal);
  }
  const tries = new Set();
  if (via) {
    if (via.logradouro) {
      tries.add(joinParts([via.logradouro + (number ? ", " + number : ""), via.bairro, via.localidade, via.uf, "Brasil"]));
      tries.add(joinParts([via.logradouro, via.bairro, via.localidade, via.uf, "Brasil"]));
    }
    tries.add(joinParts([via.bairro, via.localidade, via.uf, "Brasil"]));
  } else tries.add(/brasil/i.test(raw) ? raw : raw + ", Brasil");
  let i = 0;
  for (const q of tries) {
    if (i++) await sleep(1100, signal); // respeita o limite de 1 req/s do Nominatim
    const g = await nominatim(q, signal);
    if (g) {
      const a = g.address || {};
      return {
        lat: +g.lat, lon: +g.lon,
        city: via?.localidade || a.city || a.town || a.municipality || a.village || a.county || "",
        label: via ? joinParts([via.logradouro, number, via.bairro, `${via.localidade}/${via.uf}`, via.cep && "CEP " + via.cep]) : g.display_name
      };
    }
  }
  throw new Error("Endereço não encontrado. Tente informar o CEP ou incluir cidade e UF.");
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

const GEOAPIFY_SEGMENTS = {
  office: ["office"],
  industrial: ["production", "power.plant"],
  logistics: ["office.logistics", "rental.storage"],
  health: ["healthcare.hospital", "healthcare.clinic_or_praxis"],
  retail: ["commercial.supermarket", "commercial.department_store"],
  education: ["education.university", "education.college"]
};
GEOAPIFY_SEGMENTS.all = [...new Set(Object.values(GEOAPIFY_SEGMENTS).flat())];

function buildQuery(seg, radiusM, lat, lon, limit) {
  const parts = SEGMENTS[seg].map(f => `node${f}["name"](around:${radiusM},${lat},${lon});way${f}["name"](around:${radiusM},${lat},${lon});`).join("");
  const resultLimit = Math.max(50, Math.min(500, limit * 10));
  return `[out:json][timeout:10];(${parts});out center tags qt ${resultLimit};`;
}

async function overpass(query, signal, onAttempt = () => {}) {
  let lastErr;
  const deadline = Date.now() + CONFIG.OVERPASS_TOTAL_TIMEOUT_MS;
  for (let i = 0; i < CONFIG.OVERPASS_MIRRORS.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const mirror = CONFIG.OVERPASS_MIRRORS[i];
    onAttempt(i + 1, CONFIG.OVERPASS_MIRRORS.length);
    try {
      const r = await fetchWithTimeout(mirror, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal }, Math.min(CONFIG.OVERPASS_TIMEOUT_MS, remaining));
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).elements || [];
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastErr = e;
    }
  }
  if (Date.now() >= deadline) throw new Error(`Consulta ao Overpass excedeu ${Math.ceil(CONFIG.OVERPASS_TOTAL_TIMEOUT_MS / 1000)} s. Tente novamente.`);
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

function geoapifyElements(features) {
  return features.map(feature => {
    const properties = feature.properties || {};
    const [lon, lat] = feature.geometry?.coordinates || [];
    const raw = properties.datasource?.raw || {};
    return {
      lat: Number(properties.lat ?? lat),
      lon: Number(properties.lon ?? lon),
      tags: {
        name: properties.name || "",
        "addr:street": properties.street || properties.address_line1 || properties.formatted || "",
        "addr:housenumber": properties.housenumber || "",
        website: properties.website || properties.contact?.website || raw.website || raw["contact:website"] || "",
        phone: properties.phone || properties.contact?.phone || raw.phone || raw["contact:phone"] || ""
      }
    };
  }).filter(place => place.tags.name && Number.isFinite(place.lat) && Number.isFinite(place.lon));
}

async function geoapifyPlaces(segment, radiusM, lat, lon, limit, signal) {
  if (!CONFIG.GEOAPIFY_API_KEY || CONFIG.GEOAPIFY_API_KEY.startsWith("COLE_")) throw new Error("Configure GEOAPIFY_API_KEY no env.js para usar Geoapify Places.");
  const categories = GEOAPIFY_SEGMENTS[segment];
  const r = await fetchWithTimeout(`${CONFIG.GEOAPIFY_ENDPOINT}?lang=pt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CONFIG.GEOAPIFY_API_KEY },
    body: JSON.stringify({
      categories,
      filter: { type: "circle", lon, lat, radius: radiusM },
      bias: { type: "proximity", lon, lat },
      limit: Math.min(500, Math.max(limit, limit * 3)),
      lang: "pt"
    }),
    signal
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Chave Geoapify inválida ou sem permissão."), { fatal: true });
  if (r.status === 429) throw Object.assign(new Error("Limite de cota da Geoapify excedido (429)."), { quota: true });
  if (r.status === 400) throw new Error("Geoapify rejeitou as categorias ou o filtro geográfico (HTTP 400).");
  if (!r.ok) throw new Error("Erro Geoapify HTTP " + r.status);
  const data = await r.json();
  if (!Array.isArray(data.features)) throw new Error("Resposta Geoapify fora do formato esperado.");
  return dedupe(geoapifyElements(data.features)).slice(0, limit);
}

async function searchCompanies(segment, radiusM, geo, limit, signal, onProgress) {
  if (CONFIG.GEOAPIFY_API_KEY && !CONFIG.GEOAPIFY_API_KEY.startsWith("COLE_")) {
    onProgress("Buscando empresas no Geoapify Places...");
    return geoapifyPlaces(segment, radiusM, geo.lat, geo.lon, limit, signal);
  }
  if (location.protocol === "file:") {
    throw new Error("A página está aberta por file:// e o navegador não envia uma origem identificável ao Overpass. Sirva o site por HTTP/HTTPS ou configure GEOAPIFY_API_KEY em env.js.");
  }
  const query = buildQuery(segment, radiusM, geo.lat, geo.lon, limit);
  const elements = await overpass(query, signal, (attempt, total) => onProgress(`Buscando empresas no OpenStreetMap (espelho ${attempt}/${total})...`));
  return dedupe(elements).slice(0, limit);
}

/* ================= GEMINI ================= */
const SYSTEM_PROMPT = `Atue como analista B2B. Use a busca na web para identificar o responsável atual por TI/tecnologia (Gerente ou Coordenador de TI, Head ou CTO) da empresa e região informadas.

Confirme o vínculo em fontes públicas confiáveis (site oficial, LinkedIn ou imprensa) e não confunda homônimos. Nunca invente dados. Só inclua contatos publicados e associados à empresa ou pessoa. Sem fonte confiável, use "Não identificado" em gestor_nome e "Não encontrado" nos demais campos. Em observacao, resuma a evidência ou diga que não foi encontrada. Use Alto para confirmação atual em fonte confiável, Médio para evidência indireta ou antiga, e Baixo sem confirmação suficiente.

Retorne somente JSON válido, sem Markdown ou texto adicional, com as chaves exatas abaixo. Escreva cargo, nivel_confianca e observacao em português:
{"empresa":"","gestor_nome":"Não identificado","cargo":"Não encontrado","linkedin":"Não encontrado","email":"Não encontrado","telefone":"Não encontrado","nivel_confianca":"Baixo","observacao":""}`;

function parseJson(text) {
  const clean = (text || "").replace(/```json|```/gi, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Resposta sem JSON válido");
  return JSON.parse(clean.slice(a, b + 1));
}

async function callGemini(body, signal) {
  const key = CONFIG.GEMINI_API_KEY, endpoint = CONFIG.GEMINI_API_ENDPOINT;
  if (!key || key.startsWith("COLE_")) throw new Error("Chave da API não configurada. Preencha o arquivo env.js.");
  if (!endpoint || endpoint.startsWith("COLE_")) throw new Error("Endpoint do Gemini não configurado. Preencha o arquivo env.js.");
  const headers = { "Content-Type": "application/json" };
  let url = endpoint;
  if (/[?&]key=/.test(endpoint)) { /* chave já na URL */ }
  else headers["x-goog-api-key"] = key;
  return fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body), signal }, CONFIG.GEMINI_TIMEOUT_MS);
}

async function enrich(c, city, signal) {
  const ctx = [`Empresa: ${c.empresa}`, `Cidade/região: ${city || "não informada"}`, c.endereco && `Endereço OSM: ${c.endereco}`,
    c.website && `Site: ${c.website}`, c.telefoneOsm && `Telefone OSM: ${c.telefoneOsm}`, `Coordenadas: ${c.lat}, ${c.lon}`].filter(Boolean).join("\n");
  const base = { systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: "user", parts: [{ text: ctx }] }] };
  const r = await callGemini({ ...base, tools: [{ google_search: {} }] }, signal);
  if (r.status === 429) throw Object.assign(new Error("Limite de cota excedido (429)."), { quota: true });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Chave de API inválida ou sem permissão."), { fatal: true });
  if (r.status === 400) throw new Error("Gemini rejeitou a busca na web (HTTP 400). Verifique se o modelo e o endpoint aceitam Google Search.");
  if (r.status === 404) throw new Error("Modelo Gemini não encontrado (HTTP 404). Atualize GEMINI_API_ENDPOINT para um modelo disponível.");
  if (!r.ok) throw new Error("Erro Gemini HTTP " + r.status);
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini retornou uma resposta vazia.");
  return normalizeManagerData(parseJson(text), c);
}

function normalizeManagerData(data, lead) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Resposta do Gemini fora do formato esperado.");
  const text = value => typeof value === "string" ? value.trim() : "";
  const field = (value, fallback) => {
    const result = text(value);
    return !result || /^(?:(?:não|nao) (?:identificado|encontrado)|not (?:identified|found))$/i.test(result) ? fallback : result;
  };
  const confidence = text(data.nivel_confianca);
  const confidenceKey = norm(confidence);
  return {
    empresa: lead.empresa,
    gestor_nome: field(data.gestor_nome, "Não identificado"),
    cargo: field(data.cargo, "Não encontrado"),
    linkedin: field(data.linkedin, "Não encontrado"),
    email: field(data.email, "Não encontrado"),
    telefone: field(data.telefone, "Não encontrado"),
    nivel_confianca: confidenceKey === "alto" ? "Alto" : confidenceKey === "medio" ? "Médio" : "Baixo",
    observacao: text(data.observacao)
  };
}

/* ================= CACHE (decisão automática) ================= */
const cacheKey = (c, city) => "lead:v2:" + norm(c.empresa) + "|" + norm(city);
function cacheGet(c, city) {
  const e = store.get(cacheKey(c, city), null);
  if (!e) return null;
  // Resultado com gestor identificado vale por N dias; resultado vazio expira em 1 dia para nova tentativa.
  const days = isEmptyVal(e.d.gestor_nome) ? 1 : CONFIG.CACHE_EXPIRATION_DAYS;
  return Date.now() - e.t > days * 864e5 ? null : e.d;
}
const cacheSet = (c, city, d) => store.set(cacheKey(c, city), { t: Date.now(), d });

/* ================= FILA ================= */
function setProgress(i, total, msg) {
  $("barFill").style.width = (total ? (i / total) * 100 : 0) + "%";
  $("status").textContent = msg;
}

async function processLead(lead, city, signal) {
  const cached = cacheGet(lead, city);
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
  abortCtrl = new AbortController(); const signal = abortCtrl.signal;
  running = true; paused = false; results = []; stats.cacheHits = 0; render();
  $("progressBox").hidden = false; $("btnStart").disabled = true; $("btnPause").textContent = "Pausar";
  try {
    setProgress(0, 1, "Validando endereço (ViaCEP)...");
    $("resolved").textContent = "";
    const geo = await resolveAddress(address, signal);
    $("resolved").textContent = "Localizado: " + geo.label;
    const radiusM = +$("radius").value * 1000;
    const found = await searchCompanies($("segment").value, radiusM, geo, limit, signal, message => setProgress(0, 1, message));
    if (!found.length) throw new Error("Nenhuma empresa com nome encontrada nesse raio/segmento.");
    window._city = geo.city;
    results = found.map(f => ({ ...f, pending: true })); render();
    let completed = 0, interruption = "";
    for (let i = 0; i < found.length; i++) {
      await waitIfPaused(signal);
      setProgress(i, found.length, `Processando ${i + 1} de ${found.length}: ${found[i].empresa}...`);
      try {
        const res = await processLead(found[i], geo.city, signal);
        results[i] = res; completed = i + 1; render();
        if (!res.fromCache && i < found.length - 1) {
          setProgress(i + 1, found.length, `Processando ${i + 1} de ${found.length}: ${found[i].empresa}... (aguardando intervalo de segurança)`);
          await sleep(CONFIG.REQUEST_DELAY_MS, signal);
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        results[i] = { ...found[i], error: e.message }; completed = i + 1; render();
        toast(e.message, "error");
        if (e.fatal || e.quota) {
          interruption = e.quota ? "cota do Gemini esgotada." : "falha de autenticação no Gemini.";
          break;
        }
      }
    }
    if (interruption) setProgress(completed, found.length, `Varredura interrompida: ${interruption}`);
    else {
      setProgress(found.length, found.length, "Varredura concluída.");
      toast("Varredura concluída.", "ok");
    }
  } catch (e) {
    if (e.name === "AbortError") { setProgress(0, 1, "Varredura cancelada."); toast("Varredura cancelada."); }
    else { setProgress(0, 1, "Falha: " + e.message); toast(e.message, "error"); }
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
$("btnCsv").onclick = () => {
  if (!results.length) return toast("Nada para exportar.", "error");
  const cols = ["empresa", "endereco", "maps", "gestor_nome", "cargo", "linkedin", "email", "telefone", "nivel_confianca", "observacao", "website"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(";"), ...results.map(r => cols.map(c => q(r[c])).join(";"))].join("\r\n");
  download("leads.csv", "\uFEFF" + csv, "text/csv;charset=utf-8");
};
render();
$("address").addEventListener("keydown", e => { if (e.key === "Enter") startScan(); });
if (!CONFIG.GEMINI_API_KEY || CONFIG.GEMINI_API_KEY.startsWith("COLE_")) toast("Chave da API ausente: preencha o arquivo env.js.", "error");
