const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_XML_URL = '	https://casadelaudio.com/media/feed/feed-magento.xml';

module.exports = async (req, res) => {
    // Permitir CORS para que cualquier bot o cliente lo consuma libremente
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const xmlUrl = req.query.url || DEFAULT_XML_URL;

        if (!xmlUrl) {
            return res.status(400).json({ error: 'Falta la URL del feed XML' });
        }

        const response = await axios.get(xmlUrl, { responseType: 'text', timeout: 10000 });
        const xmlData = response.data;

        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_"
        });
        const jsonObj = parser.parse(xmlData);

        return res.status(200).json({
            success: true,
            updated_at: new Date().toISOString(),
            source_xml: xmlUrl,
            data: jsonObj
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: 'No se pudo procesar el feed XML',
            details: error.message
        });
    }
>>>>>>> f273f8fca5418738f3733aa047b9593743ad8903
};