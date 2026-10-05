(function () {
    // URL base de tu app en Vercel (detecta automáticamente el dominio activo)
    const VERCEL_DOMAIN = "https://xml-json-feed-magento-cda.vercel.app";
    const API_FEED_URL = `${VERCEL_DOMAIN}/api/feed?url=https%3A%2F%2Fcasadelaudio.com%2Fmedia%2Ffeed%2Ffeed-magento.xml`;

    let catalogCache = null;

    // 1. Inyectar Estilos CSS del Chat
    const style = document.createElement('style');
    style.innerHTML = `
        #cda-chat-container {
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        #cda-chat-btn {
            background: #0d6efd; color: white; border: none; border-radius: 50px;
            padding: 12px 20px; font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 14px;
            transition: transform 0.2s;
        }
        #cda-chat-btn:hover { transform: scale(1.05); }
        #cda-chat-window {
            display: none; width: 350px; height: 480px; background: white;
            border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            margin-bottom: 12px; overflow: hidden; border: 1px solid #dee2e6;
            display: flex; flex-direction: column;
        }
        #cda-chat-header {
            background: #0d6efd; color: white; padding: 14px; font-weight: bold;
            display: flex; justify-content: space-between; align-items: center; font-size: 15px;
        }
        #cda-chat-close {
            background: none; border: none; color: white; cursor: pointer; font-size: 20px; font-weight: bold;
        }
        #cda-chat-messages {
            flex: 1; padding: 15px; overflow-y: auto; background: #f8f9fa; display: flex; flex-direction: column; gap: 10px;
        }
        .cda-msg {
            max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.4;
        }
        .cda-msg-bot {
            background: white; color: #212529; align-self: flex-start; border: 1px solid #e9ecef; box-shadow: 0 2px 5px rgba(0,0,0,0.02);
        }
        .cda-msg-user {
            background: #0d6efd; color: white; align-self: flex-end;
        }
        #cda-chat-input-area {
            padding: 12px; background: white; border-top: 1px solid #dee2e6; display: flex; gap: 8px;
        }
        #cda-chat-input {
            flex: 1; padding: 9px 12px; border: 1px solid #ced4da; border-radius: 8px; font-size: 13px; outline: none;
        }
        #cda-chat-send {
            background: #0d6efd; color: white; border: none; padding: 9px 14px; border-radius: 8px; font-weight: bold; cursor: pointer;
        }
    `;
    document.head.appendChild(style);

    // 2. Inyectar Estructura HTML del Chat
    const chatContainer = document.createElement('div');
    chatContainer.id = 'cda-chat-container';
    chatContainer.innerHTML = `
        <div id="cda-chat-window" style="display: none;">
            <div id="cda-chat-header">
                <span>🤖 Asistente Casa del Audio</span>
                <button id="cda-chat-close">&times;</button>
            </div>
            <div id="cda-chat-messages">
                <div class="cda-msg cda-msg-bot">
                    ¡Hola! 👋 Soy el asistente virtual de Casa del Audio. ¿En qué producto, precio o stock te puedo ayudar hoy?
                </div>
            </div>
            <div id="cda-chat-input-area">
                <input type="text" id="cda-chat-input" placeholder="Ej: ¿Tienen stock de heladeras?" />
                <button id="cda-chat-send">Enviar</button>
            </div>
        </div>
        <button id="cda-chat-btn">💬 Asistente CDA</button>
    `;
    document.body.appendChild(chatContainer);

    // 3. Lógica de Interacción
    const chatBtn = document.getElementById('cda-chat-btn');
    const chatWindow = document.getElementById('cda-chat-window');
    const chatClose = document.getElementById('cda-chat-close');
    const chatSend = document.getElementById('cda-chat-send');
    const chatInput = document.getElementById('cda-chat-input');
    const chatMessages = document.getElementById('cda-chat-messages');

    chatBtn.addEventListener('click', () => {
        chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
        if (chatWindow.style.display === 'flex') chatInput.focus();
    });

    chatClose.addEventListener('click', () => {
        chatWindow.style.display = 'none';
    });

    function appendMessage(text, sender) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `cda-msg ${sender === 'user' ? 'cda-msg-user' : 'cda-msg-bot'}`;
        msgDiv.innerHTML = text;
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function handleUserMessage() {
        const query = chatInput.value.trim();
        if (!query) return;

        appendMessage(query, 'user');
        chatInput.value = '';
        
        // Indicador de "escribiendo..."
        const typingId = 'typing-' + Date.now();
        const typingDiv = document.createElement('div');
        typingDiv.id = typingId;
        typingDiv.className = 'cda-msg cda-msg-bot';
        typingDiv.innerHTML = '<i>Buscando información...</i>';
        chatMessages.appendChild(typingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        try {
            // Descargar o usar caché del catálogo de Vercel
            if (!catalogCache) {
                const response = await fetch(API_FEED_URL);
                const json = await response.json();
                if (!json.success) throw new Error("No se pudo conectar con la API");
                catalogCache = json.data;
            }

            let items = catalogCache?.rss?.channel?.item || catalogCache?.elements || catalogCache?.item || [];
            if (!Array.isArray(items)) items = [items];

            // Buscar coincidencias con lo que preguntó el usuario
            const queryLower = query.toLowerCase();
            const matches = items.filter(prod => {
                const prodStr = JSON.stringify(prod).toLowerCase();
                return prodStr.includes(queryLower);
            }).slice(0, 3); // Top 3 resultados

            document.getElementById(typingId).remove();

            if (matches.length === 0) {
                appendMessage(`No encontré productos específicos para "<b>${query}</b>". Podés consultarnos por WhatsApp o revisar las categorías principales de la tienda.`, 'bot');
                return;
            }

            let botResponse = `Encontré estas opciones para vos:<br><br>`;
            matches.forEach(prod => {
                const name = prod.title || prod.name || prod.g_title || 'Producto';
                const price = prod.price || prod.g_price || 'Consultar';
                const link = prod.link || prod.g_link || '#';
                
                botResponse += `📦 <b>${name}</b><br>💰 Precio: $${price}<br><a href="${link}" target="_blank" style="color:#0d6efd;">Ver producto en tienda</a><br><hr style="margin:6px 0;">`;
            });

            appendMessage(botResponse, 'bot');

        } catch (err) {
            document.getElementById(typingId)?.remove();
            appendMessage('Disculpà, ocurrió un error al consultar el catálogo en este momento.', 'bot');
        }
    }

    chatSend.addEventListener('click', handleUserMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUserMessage();
    });
})();