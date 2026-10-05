const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // 1. Validar Token por Header (Authorization: Bearer)
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

        // 2. Obtener la URL del XML desde la variable de entorno (o por query si se envía explícitamente)
        const xmlUrl = req.query.url || process.env.MAGENTO_XML_URL;
        const targetCostosUrl = process.env.COSTOS_JSON_URL;

        if (!xmlUrl) {
            return res.status(400).json({ 
                generated_at: new Date().toISOString(),
                success: false, 
                error: 'No se encontró la URL del XML configurada en el servidor.' 
            });
        }

        // 3. Descargar XML de Magento y Costos en paralelo
        const requests = [axios.get(xmlUrl, { responseType: 'text', timeout: 20000 })];
        if (targetCostosUrl) {
            requests.push(axios.get(targetCostosUrl, { timeout: 20000 }).catch(() => ({ data: [] })));
        }

        const responses = await Promise.all(requests);
        const xmlResponse = responses[0];
        const costosData = responses[1] ? responses[1].data : [];

        // 4. Mapear costos por SKU
        const costosMap = {};
        if (Array.isArray(costosData)) {
            costosData.forEach(item => {
                const skuKey = String(item.sku || item.SKU || '').trim();
                const costVal = item.costo || item.cost || item.precio_costo || 0;
                if (skuKey) costosMap[skuKey] = Number(costVal);
            });
        }

        // 5. Parsear XML
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const jsonObj = parser.parse(xmlResponse.data);

        let rawItems = jsonObj?.rss?.channel?.item || jsonObj?.elements || jsonObj?.catalog?.product || jsonObj?.item || [];
        if (!Array.isArray(rawItems)) rawItems = [rawItems];

        // 6. Normalizar y cruzar costos
        const normalizedProducts = rawItems.map(prod => {
            const sku = prod.sku || prod.g_id || prod.id ? String(prod.sku || prod.g_id || prod.id).trim() : null;
            const costoFinal = (sku && costosMap[sku] !== undefined) ? costosMap[sku] : (prod.cost ? Number(prod.cost) : null);

            return {
                sku: sku,
                nombre: prod.title || prod.name || prod.g_title || null,
                marca: prod.brand || prod.g_brand || null,
                categoria: prod.product_type || prod.category || null,
                url: prod.link || prod.g_link || null,
                habilitado: prod.status === '1' || prod.availability === 'in stock' ? true : null,
                updated_at: prod.updated_at || new Date().toISOString(),
                pricing: {
                    precio_lista: prod.price ? Number(prod.price) : null,
                    precio_un_pago: prod.sale_price ? Number(prod.sale_price) : null,
                    cuotas_sin_interes: prod.installments ? Number(prod.installments) : null
                },
                logistica: {
                    costo: costoFinal,
                    stock: prod.stock !== undefined ? Number(prod.stock) : 0
                },
                catalogo: {
                    descripcion_corta: prod.short_description || null,
                    descripcion: prod.description || null,
                    atributos: prod.attributes || null,
                    imagenes: prod.image_link ? [prod.image_link] : null
                }
            };
        });

        return res.status(200).json({
            generated_at: new Date().toISOString(),
            success: true,
            total_products: normalizedProducts.length,
            products: normalizedProducts
        });

    } catch (error) {
        return res.status(500).json({
            generated_at: new Date().toISOString(),
            success: false,
            error: 'No se pudo procesar el feed o cruzar los costos',
            details: error.message
        });
    }
};