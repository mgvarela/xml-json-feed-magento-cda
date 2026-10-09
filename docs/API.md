# API del catálogo JSON

Esta guía describe cómo consultar desde otro sistema (por ejemplo, una integración de Magento o un chatbot) el catálogo normalizado por esta aplicación.

## URL y autenticación

URL de producción actual:

```text
https://xml-json-feed-magento-cda.vercel.app/api/feed
```

Todas las consultas requieren el header:

```http
Authorization: Bearer <API_SECRET_TOKEN>
```

El valor debe solicitarse al responsable de la aplicación y guardarse como secreto en el servidor consumidor. No debe incluirse en JavaScript del navegador, aplicaciones públicas ni prompts enviados a un proveedor de IA.

La API está pensada para consumo servidor a servidor. No se debe asumir que se puede llamar directamente desde el navegador.

## Consultar el catálogo actual

```http
GET /api/feed
Authorization: Bearer <API_SECRET_TOKEN>
```

Devuelve el último snapshot consolidado que quedó guardado. Esta consulta no vuelve a leer los feeds de Magento ni regenera el catálogo.

Ejemplo con cURL:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${API_SECRET_TOKEN}" \
  "https://xml-json-feed-magento-cda.vercel.app/api/feed"
```

Respuesta resumida:

```json
{
  "generated_at": "2026-10-07T20:00:00.000Z",
  "pricing_updated_at": "2026-10-07T20:00:00.000Z",
  "catalog_updated_at": "2026-10-07T06:00:00.000Z",
  "total_products": 1,
  "products": [
    {
      "sku": "SKU-123",
      "parent_sku": null,
      "nombre": "Producto de ejemplo",
      "marca": "Marca",
      "categoria": "Categoría",
      "url": "https://tienda.example/producto",
      "habilitado": true,
      "updated_at": "2026-10-07T17:00:00.000Z",
      "pricing": {
        "precio_lista": 100000,
        "precio_un_pago": 90000,
        "vigencia_desde": null,
        "vigencia_hasta": null,
        "cuotas_sin_interes": 6
      },
      "logistica": {
        "costo": 50000,
        "stock": 4,
        "stock_por_sucursal": {
          "Sucursal Centro": 2,
          "Sucursal Norte": 2
        }
      },
      "catalogo": {
        "descripcion_corta": "Descripción breve",
        "descripcion": "Descripción del producto",
        "atributos": {
          "color": "Negro",
          "pulgadas": "55\""
        },
        "imagenes": [
          "https://tienda.example/media/producto.jpg"
        ]
      }
    }
  ]
}
```

Los valores del ejemplo son ilustrativos. Algunos campos pueden ser `null`, y `stock_por_sucursal` solo se incluye cuando hay datos de sucursales. `atributos` es dinámico: sus claves dependen de los atributos disponibles en el feed. Las variantes se devuelven como productos independientes, con su propio `sku` y el `parent_sku` del producto padre.

### Campos del snapshot

- `generated_at`: momento de la última generación del snapshot.
- `pricing_updated_at`: momento de la última actualización procesada de precios y logística.
- `catalog_updated_at`: momento de la última actualización de catálogo.
- `total_products`: cantidad de productos en el snapshot.
- `products`: catálogo consolidado.
- `pricing`: precios y vigencias, si el feed los informa.
- `logistica`: costo interno, stock total y, cuando está disponible, stock por sucursal.
- `catalogo`: descripciones limpiadas, atributos normalizados e imágenes.

**Importante sobre datos sensibles:** `logistica.costo` puede ser un costo interno. No lo muestres a clientes ni lo envíes al contexto de un chatbot salvo que exista una necesidad aprobada. Filtrá este campo en el backend consumidor antes de exponer productos al público.

## Consultar con GraphQL

La API también permite consultar el mismo snapshot con GraphQL. Esta opción solo cambia la salida: no vuelve a leer Magento ni modifica la generación, actualización o almacenamiento del catálogo. La consulta sigue requiriendo el header `Authorization`.

Usá `POST /api/feed?mode=graphql` con `Content-Type: application/json`:

```json
{
  "query": "query Productos($texto: String, $cantidad: Int) { total_products(search: $texto) products(search: $texto, limit: $cantidad) { sku nombre marca pricing { precio_un_pago } logistica { stock } } }",
  "variables": {
    "texto": "televisor",
    "cantidad": 10
  }
}
```

GraphQL devuelve solamente los campos pedidos. `products` acepta:

- `sku`: coincidencia exacta, sin distinguir mayúsculas.
- `search`: busca por SKU, nombre, marca o categoría.
- `categoria`: coincidencia parcial en la categoría.
- `habilitado`: filtra por estado.
- `include_disabled`: incluye u omite productos deshabilitados; si se omite, conserva la configuración general.
- `limit` y `offset`: paginación; `limit` admite de 1 a 100 y por defecto es 50.

`total_products` acepta los filtros de producto y devuelve el total antes de paginar. `product(sku: "...")` devuelve un único producto. Para descripciones largas, atributos dinámicos, imágenes y stock por sucursal, el schema expone `catalogo { descripcion atributos imagenes }` y `logistica { stock_por_sucursal }`; los objetos dinámicos (`atributos` y `stock_por_sucursal`) usan el escalar JSON.

También se admite `GET /api/feed?mode=graphql&query=...` para consultas pequeñas. Para POST, variables y consultas más largas, se recomienda el método POST mostrado arriba.

## Disponibilidad

Para comprobar que la API responde y que las credenciales son válidas:

```http
GET /api/feed?mode=ping
Authorization: Bearer <API_SECRET_TOKEN>
```

Respuesta:

```json
{ "success": true }
```

## Actualizar el snapshot

La lectura normal de `GET /api/feed` devuelve el snapshot existente. La actualización se ejecuta mediante los siguientes modos:

### Actualización de precios y logística

```http
GET /api/feed?mode=pricing
Authorization: Bearer <API_SECRET_TOKEN>
```

Actualiza `habilitado`, `pricing` y `logistica` de los productos existentes. Si el feed contiene un SKU que todavía no está en el snapshot, ese producto se agrega con sus datos completos. Si todavía no existe snapshot, la solicitud crea uno realizando una actualización de catálogo.

### Actualización del catálogo

```http
GET /api/feed?mode=catalog
Authorization: Bearer <API_SECRET_TOKEN>
```

Lee los feeds habilitados, normaliza los productos y guarda el snapshot. El snapshot contiene únicamente los productos de los feeds seleccionados; los de feeds no seleccionados se descartan. Si un feed seleccionado falla, se conservan sus productos previos.

Ambos modos devuelven por defecto un resumen del proceso, no el catálogo. Para incluir el snapshot completo en la respuesta:

```http
GET /api/feed?mode=catalog&full=1
GET /api/feed?mode=pricing&full=1
```

La respuesta incluye los datos del resumen y `products`.

### Actualización incremental de catálogo

```http
GET /api/feed?mode=catalog&since=last
```

También se puede indicar una fecha reconocida por JavaScript, preferentemente ISO 8601:

```http
GET /api/feed?mode=catalog&since=2026-10-06T06:00:00.000Z
```

Los productos con `updated_at` posterior a la fecha reciben una actualización completa de catálogo. Para los productos no modificados se actualizan únicamente habilitación, precios y logística. El snapshot se conserva como catálogo completo; **esta opción no devuelve solamente una lista de cambios**. Si se usa `full=1`, `products` sigue siendo el snapshot entero.

`since=last` toma como referencia el `catalog_updated_at` del snapshot anterior. Si no hay snapshot todavía, la primera actualización construye el catálogo completo. Si un producto no tiene `updated_at`, se considera modificable y recibe actualización completa durante una corrida incremental.

## Feeds configurados

Para consultar qué feeds están habilitados:

```http
GET /api/feed?mode=feeds
Authorization: Bearer <API_SECRET_TOKEN>
```

La misma ruta acepta un `POST` para guardar los feeds habilitados:

```http
POST /api/feed?mode=feeds
Authorization: Bearer <API_SECRET_TOKEN>
Content-Type: application/json

{
  "enabled_feeds": [
    "https://tienda.example/media/feed/catalogo.xml"
  ],
  "include_disabled": true
}
```

include_disabled (opcional, por defecto 	rue) define si el JSON incluye los productos deshabilitados. Un producto deshabilitado se entrega en una sola línea mínima (sku, parent_sku, 
ombre, habilitado: false), sin atributos, precios ni stock; con alse se omiten por completo. Se puede forzar por consulta con ?include_disabled=0|1.

Solo se aceptan URLs que estén incluidas en la configuración de feeds de la aplicación. Este endpoint es administrativo y normalmente no hace falta para un consumidor que únicamente consulta el catálogo.

## Formato y consideraciones de consumo

- La respuesta usa JSON UTF-8; las fechas normalizadas se expresan en ISO 8601/UTC.
- Los importes y cantidades numéricas se devuelven como números JSON o `null`.
- La respuesta JSON normal entrega el snapshot completo; para filtros, búsqueda, paginación y selección de campos, se puede usar GraphQL (`mode=graphql`).
- Para consultas frecuentes, se recomienda descargar y guardar el snapshot en el backend consumidor en vez de solicitarlo por cada interacción del usuario.
- Las actualizaciones automáticas se ejecutan mediante workflows programados: catálogo diariamente y precios/logística cada hora. La disponibilidad efectiva depende de que esos workflows y los feeds de origen hayan finalizado correctamente.
- La API responde con `Cache-Control: private, no-store`; el consumidor puede implementar su propia estrategia de almacenamiento y actualización.

## Errores esperables

| HTTP | Significado |
|------|-------------|
| `400` | Parámetros o body inválidos, modo desconocido o no hay feeds seleccionados. |
| `401` | Falta el token o no es válido. |
| `404` | Aún no existe un snapshot; primero debe ejecutarse `mode=catalog`. |
| `405` | Método HTTP no permitido para la operación. |
| `500` | Error de configuración o fallo al procesar la solicitud. |
| `502` | Ninguno de los feeds seleccionados pudo procesarse; el snapshot anterior no se modifica. |

Las respuestas de error son JSON y normalmente incluyen `success: false` y `error`. En fallos de actualización pueden aparecer además `details`, `feeds_processed` o advertencias. El cliente debe comprobar el código HTTP y `success` antes de usar la respuesta como catálogo actualizado.

## Configuración del servidor

Estas variables se configuran en el entorno de despliegue, no en el consumidor:

- `API_SECRET_TOKEN` (requerida): credencial para llamar a la API.
- `FEED_URLS` (opcional): lista de URLs de feeds separadas por comas. Si no se define, se usan los feeds predeterminados del código.
- `COSTOS_JSON_URL` (opcional): URL del JSON local de costos y stock.
- `PANEL_PASSWORD` (opcional): contraseña usada por el panel administrativo; no reemplaza `API_SECRET_TOKEN`.

## Buscador de productos por SKU y PDF

La página estática `/buscador.html` (ver `public/buscador.html`) permite buscar un producto por SKU, ver toda su información y descargar una ficha en PDF con nombre, SKU, descripción y atributos. Usa la contraseña del panel (`PANEL_PASSWORD`) y consulta el snapshot mediante `?mode=graphql`; el PDF se genera en el navegador con jsPDF. Acepta `/buscador.html?sku=XXXX` para abrir un producto directamente.

