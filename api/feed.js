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

        // 2. Obtener la URL del XML (por defecto apunta al nuevo feed de Uke)
        const xmlUrl = req.query.url || process.env.MAGENTO_XML_URL || 'https://casadelaudio.com/media/feed/api_info_uke.xml';
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

        // 5. Parsear XML (Adaptado a la nueva estructura <catalog><product>...</product></catalog>)
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const jsonObj = parser.parse(xmlResponse.data);

        let rawItems = jsonObj?.catalog?.product || jsonObj?.rss?.channel?.item || jsonObj?.elements || jsonObj?.item || [];
        if (!Array.isArray(rawItems)) rawItems = [rawItems];

        // 6. Normalizar y cruzar costos según la nueva estructura de nodos
        const normalizedProducts = rawItems.map(prod => {
            const sku = prod.sku ? String(prod.sku).trim() : null;
            const costoFinal = (sku && costosMap[sku] !== undefined) ? costosMap[sku] : null;

            // Procesamiento de atributos dinámicos
            let atributosMap = {};
            if (prod.catalogo && prod.catalogo.atributos) {
                let rawAtribs = prod.catalogo.atributos.atributo;
                if (!Array.isArray(rawAtribs)) rawAtribs = [rawAtribs];
                rawAtribs.forEach(atrib => {
                    if (atrib && atrib.codigo && atrib.valor !== undefined) {
                        atributosMap[atrib.codigo] = atrib.valor;
                    }
                });
            }

            // Procesamiento de imágenes múltiples
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
                    stock: prod.logistica?.stock !== undefined ? Number(prod.logistica.stock) : 0
                },
                catalogo: {
                    descripcion_corta: prod.catalogo?.descripcion_corta !== 'null' ? prod.catalogo.descripcion_corta : null,
                    descripcion: prod.catalogo?.descripcion !== 'null' ? prod.catalogo.descripcion : null,
                    atributos: atributosMap,
                    imagenes: imagenesList.length > 0 ? imagenesList : null
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