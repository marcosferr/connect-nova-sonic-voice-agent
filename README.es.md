# Agente de voz Connect × Nova Sonic — 100% CDK, verificado con una llamada sintética

Agente telefónico que toma pedidos para una pizzería ficticia (**Forno Pizza**, español de Chile)
sobre **Amazon Connect AI agents**, **Amazon Nova 2 Sonic** (speech-to-speech) y **tools MCP detrás
de Amazon Bedrock AgentCore Gateway**. Se despliega completo con **un solo `cdk deploy`**
(constructs L1, sin pasos de consola) y se verifica con un **llamador sintético que hace una
llamada de audio real**.

> 🇬🇧 English version: [README.md](README.md)

## Qué resuelve

La mayoría de los ejemplos de Connect + AgentCore todavía registran el servidor MCP y las tools
del agente desde la consola. Hoy casi todo se puede declarar en CloudFormation: gateway y targets
Lambda, el JWT de Connect validado por `iss`, la app `MCP_SERVER`, el prompt ORCHESTRATION en
YAML, el agente con tools `MODEL_CONTEXT_PROTOCOL`, el security profile, Nova Sonic en Lex
(`UnifiedSpeechSettings`) y el contact flow. La tabla completa está en el [README](README.md).

Solo dos llamadas no tienen recurso CloudFormation y van como `AwsCustomResource`: asociar el
security profile al AI agent y asociar un número al flow.

## La capa de confiabilidad: el modelo de voz propone, las tools deciden

| Riesgo | Protección |
|---|---|
| El modelo inventa o entiende mal el teléfono | El caller ID viene de la red (`$.CustomerEndpoint.Address`) a la sesión como `{{$.Custom.customer_phone}}` |
| Teléfono dictado o mal formado | Normalizado a E.164 o `INVALID_PHONE` |
| Pizza fuera del menú | `PIZZA_NOT_ON_MENU` **+ el catálogo real** para ofrecer una alternativa válida |
| "dos", 0 o 50 pizzas | Entero 1–10 por línea o `INVALID_QUANTITY` |
| Total mal calculado | El total lo calcula el servidor con los precios de DynamoDB |
| El modelo reintenta → pedido duplicado | `orderId = uuid5(contactId + lines)` + put condicional → `duplicate` |
| Token falsificado contra el gateway | `CUSTOM_JWT` atado al issuer de la instancia → `401` |

## Desplegar → verificar → limpiar

```bash
cp .env.example .env            # AWS_ACCOUNT_ID; el resto tiene defaults
npm ci && npm run build && npm test
npx cdk deploy "Dev/*"
python scripts/seed.py

(cd tools/webrtc-caller && npm ci && npm run build)
python scripts/synthesize-audio.py
python scripts/call-test.py     # llamada real por WebRTC + verificación en DynamoDB y ListSpans

scripts/teardown.sh             # borra todo
```

Requisitos: cuenta AWS en us-east-1 con CDK bootstrap, acceso en Bedrock a Nova Pro y Nova 2
Sonic, Node 20+, Python 3.12+ con boto3 y AWS CLI v2.

## Lecciones aprendidas

- No pongas `AllowedAudience=<gateway-id>`: el JWT de Connect no lo trae y el servidor MCP
  lista **0 tools**. Valida `iss` con `CustomClaims`.
- El cuerpo del AI prompt debe ser YAML MESSAGES; texto plano falla.
- Nova Sonic S2S no existe en `es_419`: usa `es_US` (voz `Lupe`).
- Lex `BotVersion` solo toma el DRAFT al crearse: aquí un hash de la config fuerza versión nueva.
- Las cuentas nuevas suelen chocar con la cuota de números reclamados por instancia; el
  llamador WebRTC no necesita número.

Licencia MIT-0. Marca ficticia, sin relación con ninguna empresa real.
