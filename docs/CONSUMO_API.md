# Guía de consumo de la API de productos

Esta guía está dirigida a sistemas que consultan el catálogo publicado por la API. Las consultas requieren autenticación y son de solo lectura.

## Acceso

URL base:

```text
https://xml-json-feed-magento-cda.vercel.app/api/feed
```

En todas las solicitudes enviá el token entregado para la integración mediante el encabezado:

```http
Authorization: Bearer <TOKEN>
```

No incluyas el token en código del navegador, aplicaciones públicas ni logs.

## Descargar el catálogo

```http
GET /api/feed
Authorization: Bearer <TOKEN>
```

Devuelve el último catálogo generado. Esta consulta no vuelve a consultar los sistemas de origen ni genera una actualización.

Ejemplo:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${API_TOKEN}" \
  "https://xml-json-feed-magento-cda.vercel.app/api/feed"
```

La respuesta incluye fechas del snapshot, el total y una lista de productos. Ejemplo abreviado:

```json
{
  "generated_at": "2026-10-23T12:00:00.000Z",
  "pricing_updated_at": "2026-10-23T12:00:00.000Z",
  "catalog_updated_at": "2026-10-23T06:00:00.000Z",
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
      "updated_at": "2026-10-23T05:40:00.000Z",
      "pricing": {
        "precio_lista": 100000,
        "precio_un_pago": 90000,
        "cuotas_sin_interes": 6
      },
      "logistica": {
        "stock": 4,
        "stock_por_sucursal": {
          "Sucursal Centro": 2,
          "Sucursal Norte": 2
        }
      },
      "catalogo": {
        "descripcion": "Descripción del producto",
        "atributos": { "color": "Negro" },
        "imagenes": ["https://tienda.example/media/producto.jpg"]
      }
    }
  ]
}
```

Los valores son ilustrativos. Los campos sin datos pueden omitirse. `stock_por_sucursal` solo aparece cuando hay sucursales con stock positivo. `logistica.costo` puede estar presente y corresponde a un dato interno: consumilo únicamente si está autorizado para esta integración.

Los productos deshabilitados se incluyen con la misma información disponible que los habilitados, según la configuración del catálogo. Para omitirlos en una consulta, agregá `?include_disabled=0`.

## Consultar productos con GraphQL

GraphQL permite filtrar productos y solicitar solo los campos necesarios. Enviá una solicitud `POST` a `/api/feed?mode=graphql` con `Content-Type: application/json`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"query":"query Producto($sku: String!) { product(sku: $sku) { sku nombre habilitado updated_at pricing { precio_lista precio_un_pago cuotas_sin_interes } logistica { stock stock_por_sucursal } catalogo { descripcion atributos imagenes } } }","variables":{"sku":"SKU-123"}}' \
  "https://xml-json-feed-magento-cda.vercel.app/api/feed?mode=graphql"
```

También se puede consultar una lista paginada:

```graphql
query {
  products(search: "televisor", habilitado: true, limit: 20, offset: 0) {
    sku
    nombre
    pricing { precio_un_pago }
    logistica { stock }
  }
  total_products(search: "televisor", habilitado: true)
}
```

Los filtros disponibles son `sku` (coincidencia exacta), `search` (busca en SKU, nombre, marca y categoría), `categoria`, `habilitado`, `limit` y `offset`. `limit` admite valores de 1 a 100 y su valor predeterminado es 50. También se puede usar `include_disabled` para controlar la inclusión de productos deshabilitados.

## Fechas y actualización

- `generated_at`: momento en que se generó el snapshot que se está consultando.
- `pricing_updated_at`: momento de la última actualización procesada de precios y logística.
- `catalog_updated_at`: momento de la última actualización procesada del catálogo.
- `updated_at`: fecha de modificación que informa el feed de origen para ese producto. No es la fecha de generación del JSON.

La actualización de precios y stock conserva el `updated_at` del producto. En una actualización de catálogo, el valor se vuelve a leer desde el feed de origen. La API no determina por sí sola qué cambios hacen que el sistema de origen modifique esa fecha; para usarla como indicador exclusivo de cambios en contenido, hay que confirmar esa semántica con el proveedor del feed.

Las automatizaciones actuales procesan el catálogo diariamente y precios/logística cada hora. La disponibilidad y frescura también dependen de que los feeds de origen se procesen correctamente. La respuesta normal siempre representa el último snapshot guardado.

## Disponibilidad y errores

Para comprobar que la API responde y que el token es válido:

```http
GET /api/feed?mode=ping
Authorization: Bearer <TOKEN>
```

Una respuesta correcta es `{"success":true}`. Códigos habituales:

| HTTP | Significado |
| --- | --- |
| `400` | Solicitud o parámetros inválidos. |
| `401` | Token ausente o inválido. |
| `404` | Todavía no hay un snapshot disponible. |
| `405` | Método HTTP no permitido. |
| `500` | Error de configuración o procesamiento en el servidor. |

El consumidor debe comprobar el código HTTP antes de procesar la respuesta. Las fechas se expresan como ISO 8601 en UTC.