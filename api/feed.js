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
        const { url: xmlUrl, costos_url: costosUrl, token } = req.query;

        // Leemos el token seguro configurado en las Environment Variables de Vercel
        const SERVER_TOKEN = process.env.API_SECRET_TOKEN;

        if (!SERVER_TOKEN) {
            return res.status(500).json({ success: false, error: 'Error de servidor: Falta configurar el token en Vercel.' });
        }

        // Validamos que el token enviado por la URL coincida con el secreto del servidor
        if (!token || token !== SERVER_TOKEN) {
            return res.status(401).json({ 
                success: false, 
                error: 'Acceso no autorizado. Token inválido o faltante.' 
            });
        }

        if (!xmlUrl) {
            return res.status(400).json({ success: false, error: 'Falta la URL del XML.' });
        }

        // Descarga y procesamiento del XML y costos (como veníamos armando)
        const response = await axios.get(xmlUrl, { responseType: 'text', timeout: 20000 });
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const jsonObj = parser.parse(response.data);

        let rawItems = jsonObj?.rss?.channel?.item || jsonObj?.elements || jsonObj?.catalog?.product || jsonObj?.item || [];
        if (!Array.isArray(rawItems)) rawItems = [rawItems];

        const normalizedProducts = rawItems.map(prod => ({
            sku: prod.sku || prod.g_id || prod.id ? String(prod.sku || prod.g_id || prod.id).trim() : null,
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
                costo: prod.cost ? Number(prod.cost) : null,
                stock: prod.stock !== undefined ? Number(prod.stock) : 0
            },
            catalogo: {
                descripcion_corta: prod.short_description || null,
                descripcion: prod.description || null,
                atributos: prod.attributes || null,
                imagenes: prod.image_link ? [prod.image_link] : null
            }
        }));

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
            error: 'No se pudo procesar el feed',
            details: error.message
        });
    }
};