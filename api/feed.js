const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const GLOBAL_FEEDS = [
    'https://casadelaudio.com/media/feed/api_info_uke.xml',
];

function cleanDescription(htmlText) {
    if (!htmlText || htmlText === 'null') return null;
    let clean = htmlText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    clean = clean.replace(/#html-body\s*\[data-pb-style[^\]]*\]\s*\{[^}]*\}/gi, '');
    clean = clean.replace(/<[^>]*>?/gm, '');
    return clean.trim() !== '' ? clean.trim() : null;
}

function sanitizeUnit(value, unit) {
    if (!value || value === 'null') return null;
    let strVal = String(value).trim();
    strVal = strVal.replace(new RegExp(`\\s*${unit}\\s*${unit}`, 'gi'), ` ${unit}`);
    if (!strVal.toLowerCase().includes(unit.toLowerCase())) {
        strVal += ` ${unit}`;
    }
    return strVal;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const authHeader = req.headers.authorization;
        const SERVER_TOKEN = process.env.API_SECRET_TOKEN;

        let tokenValid = false;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            if (authHeader.split(' ')[1] === SERVER_TOKEN) tokenValid = true;
        }

        if (!tokenValid) {
            return res.status(401).json({ 
                generated_at: new Date().toISOString(),
                success: false, 
                error: 'Acceso no autorizado. Token inválido o cabecera Authorization faltante.' 
            });
        }

        const mode = req.query.mode || 'pricing'; 
        const sinceFilter = req.query.since ? new Date(req.query.since) : null;
        const targetCostosUrl = process.env.COSTOS_JSON_URL;

        const feedPromises = GLOBAL_FEEDS.map(url => 
            axios.get(url, { responseType: 'text', timeout: 25000 })
                 .then(response => ({ url, data: response.data, error: false }))
                 .catch(err => ({ url, error: true, message: err.message }))
        );

        if (targetCostosUrl) {
            feedPromises.push(axios.get(targetCostosUrl, { timeout: 20000 }).catch(() => ({ data: [] })));
        }

        const responses = await Promise.all(feedPromises);
        const costosData = targetCostosUrl ? (responses[responses.length - 1].data || []) : [];
        const xmlResponses = targetCostosUrl ? responses.slice(0, -1) : responses;

        const costosMap = {};
        if (Array.isArray(costosData)) {
            costosData.forEach(item => {
                const skuKey = String(item.sku || item.SKU || '').trim();
                if (skuKey) {
                    costosMap[skuKey] = {
                        costo: Number(item.costo || item.cost || item.precio_costo || 0),
                        stock: item.stock !== undefined ? Number(item.stock) : null
                    };
                }
            });
        }

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        let processedProducts = [];
        let processedFeedsList = [];

        for (const xmlRes of xmlResponses) {
            if (xmlRes.error) {
                processedFeedsList.push({ url: xmlRes.url, status: 'error', message: xmlRes.message });
                continue;
            }

            processedFeedsList.push({ url: xmlRes.url, status: 'success' });

            const jsonObj = parser.parse(xmlRes.data);
            let rawItems = jsonObj?.catalog?.product || jsonObj?.rss?.channel?.item || jsonObj?.elements || jsonObj?.item || [];
            if (!Array.isArray(rawItems)) rawItems = [rawItems];

            const mappedItems = rawItems.map(prod => {
                const sku = prod.sku ? String(prod.sku).trim() : null;
                const localData = (sku && costosMap[sku]) ? costosMap[sku] : { costo: null, stock: null };

                const prodUpdatedAt = prod.updated_at ? new Date(prod.updated_at) : new Date();
                if (sinceFilter && prodUpdatedAt < sinceFilter) {
                    return null; 
                }

                const finalStock = localData.stock !== null ? localData.stock : (prod.logistica?.stock !== undefined ? Number(prod.logistica.stock) : 0);

                if (mode === 'pricing') {
                    return {
                        sku: sku,
                        habilitado: prod.habilitado === true || prod.habilitado === 'true',
                        updated_at: prod.updated_at || new Date().toISOString(),
                        pricing: {
                            precio_lista: prod.pricing?.precio_lista ? Number(prod.pricing.precio_lista) : null,
                            precio_un_pago: prod.pricing?.precio_un_pago ? Number(prod.pricing.precio_un_pago) : null,
                            cuotas_sin_interes: prod.pricing?.cuotas_sin_interes ? Number(prod.pricing.cuotas_sin_interes) : null
                        },
                        logistica: {
                            costo: localData.costo,
                            stock: finalStock
                        }
                    };
                }

                let atributosMap = {};
                if (prod.ean) atributosMap['ean'] = String(prod.ean).trim();
                if (prod.modelo) atributosMap['modelo'] = String(prod.modelo).trim();
                if (prod.color) atributosMap['color'] = String(prod.color).trim();
                if (prod.alto_producto) atributosMap['alto'] = sanitizeUnit(prod.alto_producto, 'cm');
                if (prod.ancho_producto) atributosMap['ancho'] = sanitizeUnit(prod.ancho_producto, 'cm');
                if (prod.profundidad_producto) atributosMap['profundidad'] = sanitizeUnit(prod.profundidad_producto, 'cm');
                if (prod.peso) atributosMap['peso'] = sanitizeUnit(prod.peso, 'kg');

                if (prod.litros_brutos) atributosMap['litros_brutos'] = `${prod.litros_brutos} L`;
                if (prod.litros_netos) atributosMap['litros_netos'] = `${prod.litros_netos} L`;
                if (prod.potencia_w) atributosMap['potencia'] = `${prod.potencia_w} W`;
                if (prod.frigorias) atributosMap['frigorias'] = String(prod.frigorias).trim();
                if (prod.pulgadas) atributosMap['pulgadas'] = `${prod.pulgadas}"`;
                if (prod.carga_kg) atributosMap['carga'] = `${prod.carga_kg} kg`;
                if (prod.almacenamiento) atributosMap['almacenamiento'] = String(prod.almacenamiento).trim();
                if (prod.ram) atributosMap['ram'] = String(prod.ram).trim();

                let imagenesList = [];
                if (prod.catalogo && prod.catalogo.imagenes) {
                    let rawImgs = prod.catalogo.imagenes.imagen;
                    if (!Array.isArray(rawImgs)) rawImgs = [rawImgs];
                    imagenesList = rawImgs.filter(img => img && typeof img === 'string');
                }

                return {
                    sku: sku,
                    nombre: prod.nombre !== 'null' ? prod.nombre : null,
                    marca: prod.marca !== 'null' ? prod.marca : null,
                    categoria: prod.categoria !== 'null' ? prod.categoria : null,
                    url: prod.url || null,
                    updated_at: prod.updated_at || new Date().toISOString(),
                    catalogo: {
                        descripcion_corta: cleanDescription(prod.catalogo?.descripcion_corta),
                        descripcion: cleanDescription(prod.catalogo?.descripcion),
                        atributos: atributosMap,
                        imagenes: imagenesList.length > 0 ? imagenesList : null
                    }
                };
            }).filter(item => item !== null);

            processedProducts = processedProducts.concat(mappedItems);
        }

        return res.status(200).json({
            generated_at: new Date().toISOString(),
            success: true,
            mode: mode,
            feeds_processed: processedFeedsList,
            total_products: processedProducts.length,
            products: processedProducts
        });

    } catch (error) {
        return res.status(500).json({
            generated_at: new Date().toISOString(),
            success: false,
            error: 'No se pudo procesar el feed solicitado',
            details: error.message
        });
    }
};