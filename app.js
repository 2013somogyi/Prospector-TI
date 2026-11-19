/* ================= CONFIGURAÇÃO ================= */
const ENV = window.ENV || {};
const GEMINI_MODEL = ENV.GEMINI_MODEL || "gemini-2.5-flash";
const CONFIG = {
  GEMINI_API_KEY: ENV.GEMINI_API_KEY || "",
  // Se GEMINI_API_ENDPOINT não for definido no env.js, monta a URL a partir do modelo.
  GEMINI_API_ENDPOINT: ENV.GEMINI_API_ENDPOINT || `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
  // 0 = desliga o "raciocínio" (muito mais rápido no 2.5 Flash). Use null para não enviar.
  GEMINI_THINKING_BUDGET: ENV.GEMINI_THINKING_BUDGET === undefined ? 0 : ENV.GEMINI_THINKING_BUDGET,
  GEOAPIFY_API_KEY: ENV.GEOAPIFY_API_KEY || "",
  GEOAPIFY_ENDPOINT: "https://api.geoapify.com/v2/places",
  OVERPASS_MIRRORS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ],
  NOMINATIM_ENDPOINT: "https://nominatim.openstreetmap.org/search",
  CACHE_EXPIRATION_DAYS: 7,
  GEO_CACHE_DAYS: 30,
  HTTP_TIMEOUT_MS: 15000,
  OVERPASS_TIMEOUT_MS: 20000,
  GEMINI_TIMEOUT_MS: 45000,
  GEMINI_RETRIES: 3,
  CONCURRENCY: Number(ENV.CONCURRENCY) || 3, // empresas processadas em paralelo
  REQUEST_DELAY_MS: 300
};

/* ================= UTILIDADES ================= */
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch {
      // Cota do localStorage cheia: limpa caches antigos e tenta de novo.
      try {
        Object.keys(localStorage).filter(x => x.startsWith("lead:") || x.startsWith("geo:")).forEach(x => localStorage.removeItem(x));
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    }
  }
};
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmptyVal = v => {
  const value = String(v ?? "").trim();
  return !value || /^(?:(?:não|nao) (?:identificado|encontrado)|not (?:identified|found))\b/i.test(value);
};
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : "";

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
    if (timedOut) throw Object.assign(new Error(`Tempo limite excedido (${Math.ceil(timeoutMs / 1000)} s).`), { timeout: true });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new DOMException("Cancelado", "AbortError"));
    const onAbort = () => { clearTimeout(t); rej(new DOMException("Cancelado", "AbortError")); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
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

// Cache de geocodificação: o mesmo endereço não é consultado de novo (ViaCEP + Nominatim levam vários segundos).
const geoKey = raw => "geo:v1:" + norm(raw);
function geoCacheGet(raw) {
  const e = store.get(geoKey(raw), null);
  return e && Date.now() - e.t < CONFIG.GEO_CACHE_DAYS * 864e5 ? e.d : null;
}

// Aceita CEP ou endereço (com ou sem cidade/UF), padroniza via ViaCEP e geocodifica
async function resolveAddress(input, signal) {
  const raw = input.replace(/\s+/g, " ").trim();
  const cached = geoCacheGet(raw);
  if (cached) return cached;
  const cepM = raw.match(/\b(\d{5})-?(\d{3})\b/);
  let via = null, number = "";
  if (cepM) {
    via = await viaCepByCep(cepM[1] + cepM[2], signal);
    if (!via) throw new Error("CEP não encontrado. Confira os números ou informe o endereço completo.");
    number = (raw.replace(cepM[0], "").match(/\b\d{1,5}\b/) || [""])[0];
  } else {
    const p = parseAddress(raw); number = p.number;
    if (p.uf && p.city && p.street.length >= 3) {
      // ViaCEP é opcional aqui: se falhar, segue só com o Nominatim.
      try { via = await viaCepByAddr(p, signal); } catch (e) { if (e.name === "AbortError") throw e; }
    }
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
      const out = {
        lat: +g.lat, lon: +g.lon,
        city: via?.localidade || a.city || a.town || a.municipality || a.village || a.county || "",
        label: via ? joinParts([via.logradouro, number, via.bairro, `${via.localidade}/${via.uf}`, via.cep && "CEP " + via.cep]) : g.display_name
      };
      store.set(geoKey(raw), { t: Date.now(), d: out });
      return out;
    }
  }
  throw new Error("Endereço não encontrado. Tente informar o CEP ou incluir cidade e UF.");
}

/* ================= BUSCA DE EMPRESAS (OVERPASS / GEOAPIFY) ================= */
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
  // nwr = node + way + relation numa só cláusula (consulta menor e mais rápida)
  const parts = SEGMENTS[seg].map(f => `nwr${f}["name"](around:${radiusM},${lat},${lon});`).join("");
  const resultLimit = Math.max(50, Math.min(500, limit * 10));
  return `[out:json][timeout:25];(${parts});out center tags qt ${resultLimit};`;
}

// Consulta todos os espelhos em paralelo e usa o primeiro que responder.
async function overpass(query, signal, onAttempt = () => {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
  onAttempt(CONFIG.OVERPASS_MIRRORS.length);
  const tasks = CONFIG.OVERPASS_MIRRORS.map(async mirror => {
    const r = await fetchWithTimeout(mirror, {
      method: "POST", body: "data=" + encodeURIComponent(query),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctrl.signal
    }, CONFIG.OVERPASS_TIMEOUT_MS);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.json();
    if (json.remark && /error|timed out/i.test(json.remark) && !(json.elements || []).length) throw new Error(json.remark);
    return json.elements || [];
  });
  try {
    return await Promise.any(tasks);
  } catch (e) {
    if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
    const msgs = (e.errors || [e]).map(x => x.message).join(" | ");
    throw new Error("Todos os servidores Overpass falharam: " + msgs);
  } finally {
    ctrl.abort();
    signal?.removeEventListener("abort", onAbort);
  }
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

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
  const elements = await overpass(query, signal, total => onProgress(`Buscando empresas no OpenStreetMap (${total} servidores em paralelo)...`));
  // Overpass não ordena por distância: prioriza as mais próximas do endereço base.
  return dedupe(elements)
    .sort((a, b) => distKm(geo.lat, geo.lon, a.lat, a.lon) - distKm(geo.lat, geo.lon, b.lat, b.lon))
    .slice(0, limit);
}

/* ================= GEMINI ================= */
const SYSTEM_PROMPT = `Atue como analista B2B. Use a busca na web para identificar o responsável atual por TI/tecnologia (Gerente ou Coordenador de TI, Head ou CTO) da empresa e região informadas.

Confirme o vínculo em fontes públicas confiáveis (site oficial, LinkedIn ou imprensa) e não confunda homônimos. Nunca invente dados. Só inclua contatos publicados e associados à empresa ou pessoa. Sem fonte confiável, use "Não identificado" em gestor_nome e "Não encontrado" nos demais campos. Em observacao, resuma a evidência ou diga que não foi encontrada. Use Alto para confirmação atual em fonte confiável, Médio para evidência indireta ou antiga, e Baixo sem confirmação suficiente.

Seja rápido: faça poucas buscas objetivas e pare assim que tiver evidência suficiente.

Retorne somente JSON válido, sem Markdown ou texto adicional, com as chaves exatas abaixo. Escreva cargo, nivel_confianca e observacao em português:
{"empresa":"","gestor_nome":"Não identificado","cargo":"Não encontrado","linkedin":"Não encontrado","email":"Não encontrado","telefone":"Não encontrado","nivel_confianca":"Baixo","observacao":""}`;

// Extrai o primeiro objeto JSON balanceado do texto (tolera texto antes/depois e fences de Markdown).
function parseJson(text) {
  const clean = (text || "").replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{");
  if (start < 0) throw new Error("Resposta sem JSON válido");
  let depth = 0, inStr = false, esc_ = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc_) esc_ = false;
      else if (ch === "\\") esc_ = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(clean.slice(start, i + 1));
  }
  throw new Error("Resposta sem JSON válido");
}

let thinkingSupported = CONFIG.GEMINI_THINKING_BUDGET !== null;

// Chamada com retentativas (429/5xx/timeout) e espera exponencial.
async function callGemini(body, signal) {
  const key = CONFIG.GEMINI_API_KEY, endpoint = CONFIG.GEMINI_API_ENDPOINT;
  if (!key || key.startsWith("COLE_")) throw new Error("Chave da API não configurada. Preencha o arquivo env.js.");
  if (!endpoint || endpoint.startsWith("COLE_")) throw new Error("Endpoint do Gemini não configurado. Preencha o arquivo env.js.");
  const headers = { "Content-Type": "application/json" };
  if (!/[?&]key=/.test(endpoint)) headers["x-goog-api-key"] = key;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetchWithTimeout(endpoint, { method: "POST", headers, body: payload, signal }, CONFIG.GEMINI_TIMEOUT_MS);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt < CONFIG.GEMINI_RETRIES - 1 && (e.timeout || e instanceof TypeError)) { await sleep(1500 * (attempt + 1), signal); continue; }
      throw e;
    }
    if ([429, 500, 502, 503, 504].includes(r.status) && attempt < CONFIG.GEMINI_RETRIES) {
      const retryAfter = Number(r.headers.get("Retry-After")) || 0;
      const wait = retryAfter ? retryAfter * 1000 : 3000 * 3 ** attempt + Math.random() * 500;
      await sleep(Math.min(wait, 60000), signal);
      continue;
    }
    return r;
  }
}

function buildGeminiBody(ctx, withThinking) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: ctx }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
  };
  if (withThinking) body.generationConfig.thinkingConfig = { thinkingBudget: CONFIG.GEMINI_THINKING_BUDGET };
  return body;
}

function extractSources(data) {
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const urls = chunks.map(c => c.web?.uri).filter(safeUrl);
  return [...new Set(urls)].slice(0, 3);
}

async function enrich(c, city, signal) {
  const ctx = [`Empresa: ${c.empresa}`, `Cidade/região: ${city || "não informada"}`, c.endereco && `Endereço OSM: ${c.endereco}`,
    c.website && `Site: ${c.website}`, c.telefoneOsm && `Telefone OSM: ${c.telefoneOsm}`].filter(Boolean).join("\n");

  let r = await callGemini(buildGeminiBody(ctx, thinkingSupported), signal);
  // Alguns modelos não aceitam thinkingBudget=0: desliga a opção e tenta de novo.
  if (r.status === 400 && thinkingSupported) {
    thinkingSupported = false;
    r = await callGemini(buildGeminiBody(ctx, false), signal);
  }
  if (r.status === 429) throw Object.assign(new Error("Limite de cota excedido (429). Aguarde alguns minutos ou reduza CONCURRENCY."), { quota: true });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Chave de API inválida ou sem permissão."), { fatal: true });
  if (r.status === 400) throw new Error("Gemini rejeitou a requisição (HTTP 400). Verifique se o modelo/endpoint aceita Google Search.");
  if (r.status === 404) throw new Error("Modelo Gemini não encontrado (HTTP 404). Atualize GEMINI_MODEL/GEMINI_API_ENDPOINT para um modelo disponível.");
  if (!r.ok) throw new Error("Erro Gemini HTTP " + r.status);

  const data = await r.json();
  if (data.promptFeedback?.blockReason) throw new Error("Gemini bloqueou a requisição: " + data.promptFeedback.blockReason);
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini retornou uma resposta vazia" + (data.candidates?.[0]?.finishReason ? ` (${data.candidates[0].finishReason})` : "") + ".");
  return normalizeManagerData(parseJson(text), c, extractSources(data));
}

function normalizeManagerData(data, lead, sources = []) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Resposta do Gemini fora do formato esperado.");
  const text = value => typeof value === "string" ? value.trim() : "";
  const field = (value, fallback) => {
    const result = text(value);
    return !result || /^(?:(?:não|nao) (?:identificado|encontrado)|not (?:identified|found))$/i.test(result) ? fallback : result;
  };
  const confidenceKey = norm(text(data.nivel_confianca));
  let nivel = confidenceKey === "alto" ? "Alto" : confidenceKey === "medio" ? "Médio" : "Baixo";
  const gestor = field(data.gestor_nome, "Não identificado");
  // Trava anti-alucinação: "Alto" exige que a busca na web tenha retornado fontes.
  if (nivel === "Alto" && !sources.length && !isEmptyVal(gestor)) nivel = "Médio";
  return {
    empresa: lead.empresa,
    gestor_nome: gestor,
    cargo: field(data.cargo, "Não encontrado"),
    linkedin: field(data.linkedin, "Não encontrado"),
    email: field(data.email, "Não encontrado"),
    telefone: field(data.telefone, "Não encontrado"),
    nivel_confianca: nivel,
    observacao: text(data.observacao),
    fontes: sources
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

/* ================= FILA (PROCESSAMENTO PARALELO) ================= */
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
    setProgress(0, 1, "Validando endereço...");
    $("resolved").textContent = "";
    const geo = await resolveAddress(address, signal);
    $("resolved").textContent = "Localizado: " + geo.label;
    const radiusM = +$("radius").value * 1000;
    const found = await searchCompanies($("segment").value, radiusM, geo, limit, signal, message => setProgress(0, 1, message));
    if (!found.length) throw new Error("Nenhuma empresa com nome encontrada nesse raio/segmento.");
    window._city = geo.city;
    results = found.map(f => ({ ...f, pending: true })); render();

    let next = 0, completed = 0, interruption = "";
    const total = found.length;
    setProgress(0, total, `Processando ${total} empresas (${Math.min(CONFIG.CONCURRENCY, total)} em paralelo)...`);

    const worker = async () => {
      while (!interruption) {
        const i = next++;
        if (i >= total) return;
        await waitIfPaused(signal);
        if (interruption) return;
        try {
          const res = await processLead(found[i], geo.city, signal);
          results[i] = res;
          completed++; render();
          setProgress(completed, total, `Processadas ${completed} de ${total}...`);
          if (!res.fromCache) await sleep(CONFIG.REQUEST_DELAY_MS, signal);
        } catch (e) {
          if (e.name === "AbortError") throw e;
          results[i] = { ...found[i], error: e.message };
          completed++; render();
          setProgress(completed, total, `Processadas ${completed} de ${total}...`);
          if (e.fatal || e.quota) {
            if (!interruption) {
              interruption = e.quota ? "cota do Gemini esgotada." : "falha de autenticação no Gemini.";
              toast(e.message, "error");
            }
            return;
          } else toast(`${found[i].empresa}: ${e.message}`, "error");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONFIG.CONCURRENCY, total) }, worker));

    if (interruption) setProgress(completed, total, `Varredura interrompida: ${interruption}`);
    else {
      setProgress(total, total, "Varredura concluída.");
      toast("Varredura concluída.", "ok");
    }
  } catch (e) {
    if (e.name === "AbortError") { setProgress(0, 1, "Varredura cancelada."); toast("Varredura cancelada."); }
    else { setProgress(0, 1, "Falha: " + e.message); toast(e.message, "error"); }
  } finally {
    // Itens que não chegaram a ser processados deixam de ficar "Aguardando..." para sempre.
    results = results.map(r => r.pending ? { ...r, pending: false, error: "Não processado (varredura interrompida)" } : r);
    running = false; $("btnStart").disabled = false; render();
  }
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
    const fontes = (r.fontes || []).filter(safeUrl).map((u, n) => `<a href="${esc(u)}" target="_blank" rel="noopener">fonte ${n + 1}</a>`).join(" · ");
    return `<tr>
      <td><b>${esc(r.empresa)}</b><small>${esc(r.endereco || "Endereço não informado no OSM")}</small><small><a href="${esc(r.maps)}" target="_blank" rel="noopener">Ver no Google Maps</a></small></td>
      <td>${pend ? `<small>${pend}</small>` : `${esc(r.gestor_nome)}<small>${esc(r.cargo)}</small><small>${esc(r.observacao)}</small>${fontes ? `<small>${fontes}</small>` : ""}`}</td>
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
      results[+b.dataset.i] = { ...r, ...d, error: undefined, pending: false, fromCache: false }; toast("Lead reprocessado.", "ok");
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
  const cols = ["empresa", "endereco", "maps", "gestor_nome", "cargo", "linkedin", "email", "telefone", "nivel_confianca", "observacao", "fontes", "website"];
  const q = v => `"${String(Array.isArray(v) ? v.join(" | ") : v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(";"), ...results.map(r => cols.map(c => q(r[c])).join(";"))].join("\r\n");
  download("leads.csv", "\uFEFF" + csv, "text/csv;charset=utf-8");
};
render();
$("address").addEventListener("keydown", e => { if (e.key === "Enter") startScan(); });
if (!CONFIG.GEMINI_API_KEY || CONFIG.GEMINI_API_KEY.startsWith("COLE_")) toast("Chave da API ausente: preencha o arquivo env.js.", "error");
