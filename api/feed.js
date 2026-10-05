const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const xmlUrl = req.query.url;

        if (!xmlUrl) {
            return res.status(400).json({ success: false, error: 'Falta el parámetro ?url=' });
        }

        const response = await axios.get(xmlUrl, { responseType: 'text', timeout: 15000 });
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
        const jsonObj = parser.parse(response.data);

        return res.status(200).json({
            success: true,
            updated_at: new Date().toISOString(),
            source_xml: xmlUrl,
            data: jsonObj
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: 'No se pudo descargar o parsear el XML',
            details: error.message
        });
    }
};