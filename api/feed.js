const axios = require('axios');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { put, get } = require('@vercel/blob');

// Feeds por categoría a unificar (también configurables con FEED_URLS separados por coma)
const GLOBAL_FEEDS = process.env.FEED_URLS
    ? process.env.FEED_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : [
        'https://casadelaudio.com/media/feed/api_info_uke.xml',
        'https://casadelaudio.com/media/feed/api_info_electro.xml',
        'https://casadelaudio.com/media/feed/api_info_lineablanca.xml',
        'https://casadelaudio.com/media/feed/api_info_hogar.xml',
        'https://casadelaudio.com/media/feed/api_info_peque_electro.xml'
    ];

const SNAPSHOT_PATH = 'feed/snapshot.json';
const CONFIG_PATH = 'feed/config.json';

// ---------- Helpers de valores ----------

function val(x) {
    if (x === undefined || x === null) return null;
    if (typeof x === 'object') x = x['#text'];
    if (x === undefined || x === null) return null;
    const s = String(x).trim();
    return s === '' || s.toLowerCase() === 'null' ? null : s;
}

function toNumber(x) {
    const s = val(x);
    if (s === null) return null;
    let t = s.replace(/[^\d.,-]/g, '');
    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
        t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else if (lastComma >= 0) {
        t = t.replace(',', '.');
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function toBool(x) {
    if (x === true || x === 1) return true;
    const s = val(x);
    return s !== null && ['true', '1', 'yes', 'si', 'sí', 'enabled', 'habilitado', 'activo'].includes(s.toLowerCase());
}

function toIsoDate(x) {
    const s = val(x);
    if (s === null || s.toLowerCase() === 'now') return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function toHttps(u) {
    return typeof u === 'string' ? u.replace(/^http:\/\//i, 'https://') : u;
}

// Elimina recursivamente claves null/undefined para reducir el payload
function pruneNulls(o) {
    if (Array.isArray(o)) return o.map(pruneNulls).filter(v => v !== null && v !== undefined);
    if (o && typeof o === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(o)) {
            if (v === null || v === undefined) continue;
            out[k] = pruneNulls(v);
        }
        return out;
    }
    return o;
}

// DTO público: normaliza snapshots antiguos (http, nulls, sucursales sin stock)
function toPublicProduct(p) {
    const { _feed, ...base } = p;
    const out = { ...base, url: toHttps(p.url) };
    const sucursales = p.logistica?.stock_por_sucursal;
    if (sucursales) {
        const conStock = Object.fromEntries(Object.entries(sucursales).filter(([, q]) => q > 0));
        out.logistica = { ...p.logistica, stock_por_sucursal: Object.keys(conStock).length ? conStock : undefined };
    }
    return pruneNulls(out);
}

// Producto deshabilitado: una sola línea mínima, sin atributos, precios ni stock
function toDisabledStub(p) {
    return pruneNulls({ sku: p.sku, parent_sku: p.parent_sku, nombre: p.nombre, habilitado: false });
}

function buildPublicProducts(products, includeDisabled) {
    const out = [];
    for (const p of products) {
        if (p.habilitado === false) {
            if (includeDisabled) out.push(toDisabledStub(p));
        } else {
            out.push(toPublicProduct(p));
        }
    }
    return out;
}

function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

function updatedAtValue(x) {
    if (x === undefined || x === null || typeof x !== 'object') return x;
    const atributo = asArray(x.atributo).find(a => val(a?.codigo)?.toLowerCase() === 'updated_at');
    return atributo?.valor ?? x['#text'] ?? null;
}

// Descripciones: quita <style>, bloques CSS del Page Builder y etiquetas; deja texto plano
function cleanDescription(html) {
    let t = val(html);
    if (t === null) return null;
    t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/#html-body[^{}]*\{[^}]*\}/g, ' ');
    t = t.replace(/\[data-pb-style=[^\]]*\][^{}]*\{[^}]*\}/g, ' ');
    t = t.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/&amp;/gi, '&');
    t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
    return t || null;
}

// "32.5 cm cm" -> "32.5 cm"; "32.5" -> "32.5 cm"
function normalizeUnit(value, unit) {
    let t = String(value).replace(/\s+/g, ' ').trim();
    t = t.replace(/([a-zA-Zº"]+)(?:\s+\1)+$/i, '$1');
    if (/^[\d.,]+$/.test(t)) return `${t} ${unit}`;
    return t;
}

// ---------- Atributos dinámicos ----------

function canonKey(raw) {
    const k = String(raw).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        .replace(/_producto$/, '');
    if (/^(ean|gtin|codigo_de_barras|codigo_barras)/.test(k)) return 'ean';
    if (/^modelo/.test(k)) return 'modelo';
    if (/^color/.test(k)) return 'color';
    if (/^(alto|altura)/.test(k)) return 'alto';
    if (/^ancho/.test(k)) return 'ancho';
    if (/^(profundidad|fondo)/.test(k)) return 'profundidad';
    if (/carga/.test(k)) return 'carga_kg';
    if (/^peso/.test(k)) return 'peso';
    if (/(litros|capacidad).*bruto|bruto.*(litros|capacidad)/.test(k)) return 'litros_brutos';
    if (/(litros|capacidad).*neto|neto.*(litros|capacidad)/.test(k)) return 'litros_netos';
    if (/^(litros|capacidad)/.test(k)) return 'capacidad_litros';
    if (/potencia|^watts?$/.test(k)) return 'potencia';
    if (/frigori/.test(k)) return 'frigorias';
    if (/pulgada/.test(k)) return 'pulgadas';
    if (/almacenamiento|memoria_interna/.test(k)) return 'almacenamiento';
    if (/^(ram|memoria_ram)$/.test(k)) return 'ram';
    return k;
}

const UNIT_BY_KEY = {
    alto: 'cm', ancho: 'cm', profundidad: 'cm',
    peso: 'kg', carga_kg: 'kg',
    litros_brutos: 'L', litros_netos: 'L', capacidad_litros: 'L',
    potencia: 'W', frigorias: 'fg', pulgadas: '"'
};

function formatAttr(key, value) {
    const unit = UNIT_BY_KEY[key];
    return unit ? normalizeUnit(value, unit) : value;
}

// Un rango de filtro ("Mas de 5000") no es un valor exacto
function isRangeValue(v) {
    return /^(mas|más|menos|hasta|entre|desde)\b/i.test(v) || /\d\s*(a|-)\s*\d/.test(v);
}

function buildAttributes(prod, descripcion) {
    const out = {};
    const set = (rawKey, rawValue) => {
        const v = val(rawValue);
        if (v === null) return;
        const key = canonKey(rawKey);
        if (key === 'frigorias' && isRangeValue(v)) return;
        out[key] = formatAttr(key, v);
    };

    // A. Formato estructurado: <catalogo><atributos><atributo><codigo/><valor/>
    for (const a of asArray(prod.catalogo?.atributos?.atributo)) {
        if (!a || !a.codigo) continue;
        const codigo = String(a.codigo).trim();
        if (/filtro/i.test(codigo)) continue;
        // Preferir el texto de la opción sobre el id interno de Magento
        set(codigo, a.valor_texto ?? a.texto ?? a.label ?? a.valor);
    }

    // B. Propiedades planas del producto
    const excluded = new Set([
        'sku', 'sku_padre', 'nombre', 'marca', 'categoria', 'url', 'habilitado', 'updated_at',
        'pricing', 'logistica', 'catalogo', 'atributos', 'imagenes', 'variantes',
        'descripcion', 'stock', 'costo'
    ]);
    for (const [key, value] of Object.entries(prod)) {
        if (excluded.has(key) || /filtro/i.test(key) || typeof value === 'object') continue;
        set(key, value);
    }

    // C. Respaldo desde título/descripción para los datos que el agente compara
    const texto = `${val(prod.nombre) || ''} ${descripcion || ''}`;
    const fromText = (key, regex) => {
        if (out[key]) return;
        const m = texto.match(regex);
        if (m) out[key] = formatAttr(key, m[1].replace(/\./g, ''));
    };
    fromText('frigorias', /(\d[\d.]*)\s*(?:fg|frigor[ií]as)/i);
    fromText('potencia', /(\d[\d.]*)\s*(?:w|watts?)\b/i);
    fromText('pulgadas', /(\d{2,3})\s*(?:"|''|pulgadas|pulg\b)/i);

    return out;
}

// Stock por sucursal: solo sucursales con stock mayor a cero
function parseBranchStock(logistica) {
    const out = {};
    for (const s of asArray(logistica?.sucursales?.sucursal)) {
        const name = val(s?.nombre);
        const qty = toNumber(s?.stock);
        if (name && qty !== null && qty > 0) out[name] = qty;
    }
    return out;
}

// ---------- Normalización de productos ----------

function buildProduct(prod, parentSku, costosMap, costosOk, prev) {
    const sku = val(prod.sku);
    const stockPorSucursal = parseBranchStock(prod.logistica);
    const ext = sku ? costosMap[sku.toUpperCase()] : undefined;
    const feedStock = toNumber(prod.logistica?.stock_total ?? prod.logistica?.stock ?? prod.stock_total ?? prod.stock);

    let costo;
    let stock;
    let stockDiscrepancy = false;
    if (!costosOk && prev) {
        // Sin JSON de costos disponible: se conserva lo último conocido
        costo = prev.logistica?.costo ?? null;
        stock = prev.logistica?.stock ?? feedStock;
    } else {
        costo = ext && ext.costo !== null ? ext.costo : toNumber(prod.logistica?.costo ?? prod.costo);
        // El stock local tiene prioridad sobre el del feed
        stock = ext && ext.stock !== null ? ext.stock : feedStock;
        stockDiscrepancy = !!ext && ext.stock !== null && feedStock !== null && ext.stock !== feedStock;
    }

    const descripcion = cleanDescription(prod.catalogo?.descripcion ?? prod.descripcion);
    const imagenes = asArray(prod.catalogo?.imagenes?.imagen ?? prod.imagenes?.imagen)
        .map(i => val(i)).filter(Boolean);

    const p = prod.pricing || {};
    return {
        stockDiscrepancy,
        record: pruneNulls({
            sku,
            nombre: val(prod.nombre),
            marca: val(prod.marca),
            categoria: val(prod.categoria),
            parent_sku: parentSku || null,
            url: toHttps(val(prod.url)),
            habilitado: toBool(prod.habilitado),
            updated_at: toIsoDate(updatedAtValue(prod.updated_at)),
            pricing: {
                precio_lista: toNumber(p.precio_lista),
                precio_un_pago: toNumber(p.precio_un_pago),
                cuotas_sin_interes: toNumber(p.cuotas_sin_interes)
            },
            logistica: Object.keys(stockPorSucursal).length ? { costo, stock, stock_por_sucursal: stockPorSucursal } : { costo, stock },
            catalogo: {
                descripcion,
                atributos: buildAttributes(prod, descripcion),
                imagenes: imagenes.length ? imagenes : null
            }
        })
    };
}

// Expande variantes como productos propios con su sku y el sku del padre
function flattenProducts(prod, costosMap, costosOk, prevMap, stats) {
    const result = [];
    const parent = buildProduct(prod, null, costosMap, costosOk, prevMap[(val(prod.sku) || '').toUpperCase()]);
    if (parent.stockDiscrepancy) stats.stockDiscrepancies++;
    result.push(parent.record);

    for (const v of asArray(prod.variantes?.variante)) {
        if (!v || !val(v.sku)) continue;
        const merged = { ...prod, ...v, variantes: undefined, pricing: { ...(prod.pricing || {}), ...(v.pricing || {}) } };
        const child = buildProduct(merged, parent.record.sku, costosMap, costosOk, prevMap[val(v.sku).toUpperCase()]);
        if (child.stockDiscrepancy) stats.stockDiscrepancies++;
        result.push(child.record);
    }
    return result;
}

// ---------- Costos / stock local ----------

function buildCostosMap(data) {
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const map = {};
    for (const item of list) {
        const key = val(item.clave ?? item.sku ?? item.SKU);
        if (!key) continue;
        map[key.toUpperCase()] = {
            costo: toNumber(item.costo ?? item.cost ?? item.precio_costo),
            stock: toNumber(item.stock ?? item.existencias)
        };
    }
    return map;
}

// ---------- Persistencia (Vercel Blob privado) ----------

async function readSnapshot() {
    const res = await get(SNAPSHOT_PATH, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return JSON.parse(await new Response(res.stream).text());
}

async function writeSnapshot(snapshot) {
    await put(SNAPSHOT_PATH, JSON.stringify(snapshot), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json'
    });
}

// Config guardada (sin config: todos los feeds y se incluyen deshabilitados en formato mínimo)
async function readConfig() {
    const fallback = { enabledFeeds: [...GLOBAL_FEEDS], includeDisabled: true };
    try {
        const res = await get(CONFIG_PATH, { access: 'private', useCache: false });
        if (!res || res.statusCode !== 200) return fallback;
        const cfg = JSON.parse(await new Response(res.stream).text());
        return {
            enabledFeeds: GLOBAL_FEEDS.filter(u => Array.isArray(cfg.enabled_feeds) && cfg.enabled_feeds.includes(u)),
            includeDisabled: cfg.include_disabled !== false
        };
    } catch (e) {
        return fallback;
    }
}

async function readEnabledFeeds() {
    return (await readConfig()).enabledFeeds;
}

async function writeConfig(enabled, includeDisabled) {
    await put(CONFIG_PATH, JSON.stringify({ enabled_feeds: enabled, include_disabled: includeDisabled, updated_at: new Date().toISOString() }), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json'
    });
}

// ---------- Auth ----------

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Cliente/cron: Bearer con API_SECRET_TOKEN. Panel interno: x-panel-password con PANEL_PASSWORD
function tokenValid(req) {
    const expected = process.env.API_SECRET_TOKEN;
    const header = req.headers.authorization;
    if (expected && header && header.startsWith('Bearer ') && safeEqual(header.slice(7), expected)) return true;

    const panelPw = process.env.PANEL_PASSWORD;
    const sent = req.headers['x-panel-password'];
    return !!(panelPw && sent && safeEqual(sent, panelPw));
}

const PRICING_PARTS = ['habilitado', 'pricing', 'logistica'];

// ---------- Handler ----------

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método no permitido' });

    if (!process.env.API_SECRET_TOKEN) {
        return res.status(500).json({ success: false, error: 'API_SECRET_TOKEN no configurado en el servidor' });
    }
    if (!tokenValid(req)) {
        return res.status(401).json({
            generated_at: new Date().toISOString(),
            success: false,
            error: 'Acceso no autorizado. Token inválido o cabecera Authorization faltante.'
        });
    }

    try {
        const query = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const mode = query.mode;
        const wantFull = query.full === '1' || query.full === 'true';
        const resolveIncludeDisabled = async q => {
            if (q.include_disabled === '1' || q.include_disabled === 'true') return true;
            if (q.include_disabled === '0' || q.include_disabled === 'false') return false;
            return (await readConfig()).includeDisabled;
        };

        if (mode === 'ping') return res.status(200).json({ success: true });

        if (mode === 'feeds') {
            if (req.method === 'POST') {
                let body = req.body;
                if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
                if (!body || !Array.isArray(body.enabled_feeds)) {
                    return res.status(400).json({ success: false, error: 'Body inválido. Enviá { "enabled_feeds": [urls] }.' });
                }
                const current = await readConfig();
                const includeDisabled = typeof body.include_disabled === 'boolean' ? body.include_disabled : current.includeDisabled;
                await writeConfig(GLOBAL_FEEDS.filter(u => body.enabled_feeds.includes(u)), includeDisabled);
            }
            const { enabledFeeds: enabled, includeDisabled } = await readConfig();
            return res.status(200).json({
                success: true,
                include_disabled: includeDisabled,
                feeds: GLOBAL_FEEDS.map(url => ({ url, enabled: enabled.includes(url) }))
            });
        }

        if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Método no permitido' });

        // Sin mode: se sirve el JSON final almacenado (lo que consume el cliente)
        if (!mode) {
            const snapshot = await readSnapshot();
            if (!snapshot) {
                return res.status(404).json({
                    success: false,
                    error: 'Todavía no existe un JSON generado. Ejecutá ?mode=catalog primero.'
                });
            }
            const products = buildPublicProducts(snapshot.products, await resolveIncludeDisabled(query));
            return res.status(200).json({ ...snapshot, total_products: products.length, products });
        }

        if (!['pricing', 'catalog'].includes(mode)) {
            return res.status(400).json({ success: false, error: 'mode inválido. Usá pricing o catalog.' });
        }

        const previous = await readSnapshot();
        // Sin base previa, pricing necesita construir también el catálogo
        const effectiveMode = mode === 'pricing' && !previous ? 'catalog' : mode;

        let sinceMs = null;
        if (effectiveMode === 'catalog' && query.since && previous) {
            sinceMs = query.since === 'last' ? Date.parse(previous.catalog_updated_at) : Date.parse(query.since);
            if (isNaN(sinceMs)) {
                return res.status(400).json({ success: false, error: 'since inválido. Usá una fecha ISO o "last".' });
            }
        }

        const costosUrl = process.env.COSTOS_JSON_URL;
        const selectedFeeds = await readEnabledFeeds();
        if (selectedFeeds.length === 0) {
            return res.status(400).json({ success: false, error: 'No hay feeds seleccionados para procesar.' });
        }
        const feedPromises = selectedFeeds.map(url =>
            axios.get(url, { responseType: 'text', timeout: 25000 })
                .then(r => ({ url, data: r.data }))
                .catch(err => ({ url, error: true, message: err.message }))
        );
        const costosPromise = costosUrl
            ? axios.get(costosUrl, { timeout: 20000 }).then(r => ({ data: r.data })).catch(err => ({ error: true, message: err.message }))
            : Promise.resolve({ data: [] });

        const [feedResults, costosResult] = await Promise.all([Promise.all(feedPromises), costosPromise]);

        const warnings = [];
        const costosOk = !costosResult.error;
        if (!costosOk) warnings.push(`JSON de costos no disponible (${costosResult.message}); se conservaron costo/stock previos`);
        const costosMap = costosOk ? buildCostosMap(costosResult.data) : {};

        const feedsProcessed = feedResults.map(f => ({
            url: f.url,
            status: f.error ? 'error' : 'success',
            message: f.error ? f.message : 'OK'
        }));
        feedsProcessed.filter(f => f.status === 'error').forEach(f => warnings.push(`Feed fallido: ${f.url} (${f.message})`));

        const okFeeds = feedResults.filter(f => !f.error);
        if (okFeeds.length === 0) {
            return res.status(502).json({
                generated_at: new Date().toISOString(),
                success: false,
                error: 'Ningún feed pudo procesarse; el JSON almacenado no se modificó',
                feeds_processed: feedsProcessed
            });
        }

        const prevProducts = previous ? previous.products : [];
        const prevMap = {};
        prevProducts.forEach(p => { if (p.sku) prevMap[p.sku.toUpperCase()] = p; });

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const stats = { stockDiscrepancies: 0, updatedCatalog: 0, pricingOnly: 0, added: 0 };
        const prevBySku = new Map(prevProducts.map(p => [p.sku, p]));
        const merged = new Map();

        for (const f of okFeeds) {
            let json = parser.parse(f.data);
            f.data = null;
            const rawItems = asArray(json?.catalog?.product || json?.rss?.channel?.item || json?.elements || json?.item);

            for (const raw of rawItems) {
                for (const rec of flattenProducts(raw, costosMap, costosOk, prevMap, stats)) {
                    if (!rec.sku) continue;
                    rec._feed = f.url;
                    const old = prevBySku.get(rec.sku);

                    const modifiedSince = sinceMs === null || !rec.updated_at || Date.parse(rec.updated_at) > sinceMs;
                    const fullRefresh = !old || (effectiveMode === 'catalog' && modifiedSince);

                    if (fullRefresh) {
                        if (!old) stats.added++; else stats.updatedCatalog++;
                        merged.set(rec.sku, rec);
                    } else {
                        stats.pricingOnly++;
                        const next = { ...old, _feed: f.url };
                        PRICING_PARTS.forEach(k => { next[k] = rec[k]; });
                        merged.set(rec.sku, next);
                    }
                }
            }
            json = null;
        }

        // Solo quedan productos de los feeds seleccionados. Si un feed seleccionado falló,
        // se conservan sus productos previos (y los de origen desconocido) para no perderlos
        const failedFeeds = new Set(feedResults.filter(f => f.error).map(f => f.url));
        if (failedFeeds.size > 0) {
            for (const p of prevProducts) {
                if (!merged.has(p.sku) && (!p._feed || failedFeeds.has(p._feed))) merged.set(p.sku, p);
            }
        }
        const removed = prevProducts.filter(p => !merged.has(p.sku)).length;

        const now = new Date().toISOString();
        const snapshot = {
            generated_at: now,
            pricing_updated_at: now,
            catalog_updated_at: effectiveMode === 'catalog' ? now : (previous?.catalog_updated_at || now),
            total_products: merged.size,
            products: [...merged.values()]
        };
        await writeSnapshot(snapshot);
        const publicProducts = buildPublicProducts(snapshot.products, await resolveIncludeDisabled(query));

        const summary = {
            success: true,
            mode: effectiveMode,
            since: sinceMs !== null ? new Date(sinceMs).toISOString() : null,
            generated_at: now,
            total_feeds_processed: okFeeds.length,
            feeds_processed: feedsProcessed,
            total_products: publicProducts.length,
            stats: { ...stats, removed },
            warnings
        };
        return res.status(200).json(wantFull ? { ...summary, products: publicProducts } : summary);

    } catch (error) {
        console.error('feed error:', error && error.message);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(500).json({ success: false, message: 'Error al generar el feed' });
    }
};
