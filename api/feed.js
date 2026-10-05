const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// 1. Listado de todos los feeds por categoría que querés unificar en el JSON global
const GLOBAL_FEEDS = [
    'https://casadelaudio.com/media/feed/api_info_uke.xml',
    // Acá podés sumar las demás categorías cuando las generes en Magento:
    // 'https://casadelaudio.com/media/feed/api_info_electro.xml',
    // 'https://casadelaudio.com/media/feed/api_info_tecno.xml'
];

// Función auxiliar para normalizar unidades de medida si es necesario
function sanitizeUnit(value, defaultUnit) {
    if (!value) return '';
    let text = String(value).trim();
    if (text.toLowerCase().includes(defaultUnit)) {
        return text.replace(/\s+/g, ' ');
    }
    return `${text}${defaultUnit}`;
}

module.exports = async (req, res) => {
    // Headers de caché horaria en Vercel y CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // 2. Validar Token por Header (Authorization: Bearer)
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

        const targetCostosUrl = process.env.COSTOS_JSON_URL;

        // 3. Preparar peticiones en paralelo: Descargar TODOS los XMLs de las categorías + Costos locales
        const feedPromises = GLOBAL_FEEDS.map(url => 
            axios.get(url, { responseType: 'text', timeout: 25000 }).catch(err => ({ error: true, message: err.message }))
        );

        if (targetCostosUrl) {
            feedPromises.push(axios.get(targetCostosUrl, { timeout: 20000 }).catch(() => ({ data: [] })));
        }

        const responses = await Promise.all(feedPromises);
        
        // Separar costos (último elemento si existía targetCostosUrl, o array vacío)
        const costosData = targetCostosUrl ? (responses[responses.length - 1].data || []) : [];
        const xmlResponses = targetCostosUrl ? responses.slice(0, -1) : responses;

        // 4. Mapear costos y stock por SKU para cruce rápido en memoria O(1)
        const costosMap = {};
        if (Array.isArray(costosData)) {
            costosData.forEach(item => {
                const skuKey = String(item.sku || item.SKU || '').trim().toUpperCase();
                if (skuKey) {
                    costosMap[skuKey] = {
                        costo: Number(item.costo || item.cost || item.precio_costo || 0),
                        stock: item.stock !== undefined ? Number(item.stock) : undefined
                    };
                }
            });
        }

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        let allNormalizedProducts = [];

        // Atributos base o internos que no deben entrar en el mapa dinámico de especificaciones técnicas
        const keysToExclude = [
            'sku', 'nombre', 'marca', 'categoria', 'url', 'habilitado', 'updated_at', 
            'pricing', 'logistica', 'catalogo', 'atributos', 'imagenes'
        ];

        // 5. Procesar cada XML de categoría, aplicar atributos dinámicos y unificar
        for (const xmlRes of xmlResponses) {
            if (xmlRes.error) continue; // Si un feed falla, salta al siguiente sin romper el global

            const jsonObj = parser.parse(xmlRes.data);
            let rawItems = jsonObj?.catalog?.product || jsonObj?.rss?.channel?.item || jsonObj?.elements || jsonObj?.item || [];
            if (!Array.isArray(rawItems)) rawItems = [rawItems];

            const normalizedProducts = rawItems.map(prod => {
                const sku = prod.sku ? String(prod.sku).trim() : null;
                const skuKey = sku ? sku.toUpperCase() : '';
                const infoExterna = (skuKey && costosMap[skuKey]) ? costosMap[skuKey] : {};

                const costoFinal = infoExterna.costo !== undefined ? infoExterna.costo : null;
                const stockFinal = infoExterna.stock !== undefined ? infoExterna.stock : (prod.logistica?.stock !== undefined ? Number(prod.logistica.stock) : 0);

                // EXTRACCIÓN DINÁMICA DE ATRIBUTOS (Reemplazando el mapeo estático anterior)
                let atributosMap = {};

                // A. Si los atributos vienen en el formato estructurado tradicional del XML del feed
                if (prod.catalogo && prod.catalogo.atributos) {
                    let rawAtribs = prod.catalogo.atributos.atributo;
                    if (!Array.isArray(rawAtribs)) rawAtribs = [rawAtribs];
                    rawAtribs.forEach(atrib => {
                        if (atrib && atrib.codigo && atrib.valor !== undefined) {
                            const codigo = String(atrib.codigo).trim();
                            // Omitir filtros por rangos
                            if (!codigo.includes('filtro') && !codigo.endsWith('_filtro')) {
                                atributosMap[codigo] = String(atrib.valor).trim();
                            }
                        }
                    });
                }

                // B. Bionda de barrido dinámico general sobre las propiedades planas del producto si existieran
                for (const [key, value] of Object.entries(prod)) {
                    if (value === undefined || value === null || String(value).trim() === '' || String(value) === 'null') continue;
                    if (keysToExclude.includes(key)) continue;
                    if (key.includes('filtro') || key.endsWith('_filtro')) continue;

                    let cleanKey = key.toLowerCase();
                    let cleanVal = String(value).trim();

                    // Normalización inteligente opcional de unidades si vienen planas
                    if (cleanKey.includes('alto') || cleanKey.includes('ancho') || cleanKey.includes('profundidad')) {
                        atributosMap[cleanKey.replace('_producto', '')] = sanitizeUnit(cleanVal, 'cm');
                    } else if (cleanKey.includes('peso') || cleanKey.includes('carga')) {
                        atributosMap['peso'] = sanitizeUnit(cleanVal, 'kg');
                    } else if (cleanKey.includes('litros')) {
                        atributosMap[cleanKey] = `${cleanVal} L`;
                    } else if (cleanKey.includes('potencia')) {
                        atributosMap['potencia'] = `${cleanVal} W`;
                    } else if (cleanKey.includes('pulgadas')) {
                        atributosMap['pulgadas'] = `${cleanVal}"`;
                    } else {
                        atributosMap[cleanKey] = cleanVal;
                    }
                }

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
                    habilitado: prod.habilitado === true || prod.habilitado === 'true',
                    updated_at: prod.updated_at || new Date().toISOString(),
                    pricing: {
                        precio_lista: prod.pricing?.precio_lista !== 'null' && prod.pricing?.precio_lista !== undefined ? Number(prod.pricing.precio_lista) : null,
                        precio_un_pago: prod.pricing?.precio_un_pago !== 'null' && prod.pricing?.precio_un_pago !== undefined ? Number(prod.pricing.precio_un_pago) : null,
                        cuotas_sin_interes: prod.pricing?.cuotas_sin_interes !== 'null' && prod.pricing?.cuotas_sin_interes !== undefined ? Number(prod.pricing.cuotas_sin_interes) : null
                    },
                    logistica: {
                        costo: costoFinal,
                        stock: stockFinal
                    },
                    catalogo: {
                        descripcion_corta: prod.catalogo?.descripcion_corta !== 'null' ? prod.catalogo.descripcion_corta : null,
                        descripcion: prod.catalogo?.descripcion !== 'null' ? prod.catalogo.descripcion : null,
                        atributos: atributosMap,
                        imagenes: imagenesList.length > 0 ? imagenesList : null
                    }
                };
            });

            allNormalizedProducts = allNormalizedProducts.concat(normalizedProducts);
        }

        return res.status(200).json({
            generated_at: new Date().toISOString(),
            success: true,
            total_feeds_processed: xmlResponses.filter(r => !r.error).length,
            total_products: allNormalizedProducts.length,
            products: allNormalizedProducts
        });

    } catch (error) {
        return res.status(500).json({
            generated_at: new Date().toISOString(),
            success: false,
            error: 'No se pudo procesar el consolidado global de feeds',
            details: error.message
        });
    }
};