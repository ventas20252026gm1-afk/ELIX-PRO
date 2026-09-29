import {
  json,
  onlyPost,
  parseBody,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';

const MODELS = [
  process.env.GROQ_ROUTER_MODEL,
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
].filter(Boolean);

function extractJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(clean.slice(a, b + 1)); } catch {}
  }
  return null;
}

function uniqueModels() {
  return [...new Set(MODELS)].filter(Boolean);
}

async function askGroq(apiKey, system, user, maxTokens = 520, options = {}) {
  const failures = [];
  const timeoutMs = Math.max(2500, Math.min(14000, Number(options.timeoutMs) || 14000));
  const maxModels = Math.max(1, Math.min(uniqueModels().length, Number(options.maxModels) || uniqueModels().length));
  for (const model of uniqueModels().slice(0, maxModels)) {
    try {
      const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
      }, timeoutMs);

      const data = await readJsonResponse(response);
      if (!response.ok) {
        failures.push(`${model}: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
        continue;
      }
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJson(content);
      if (!parsed) {
        failures.push(`${model}: respuesta JSON inválida`);
        continue;
      }
      return { ok: true, parsed };
    } catch (error) {
      failures.push(`${model}: ${error?.message || error}`);
    }
  }
  return { ok: false, reason: failures.join(' | ') || 'Router no disponible.' };
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null;
  const allowedIntent = new Set(['export_current', 'export_named', 'generate_then_export', 'none']);
  const allowedScope = new Set(['full_chat', 'last_answer', 'selection', 'generated_answer']);
  const intent = allowedIntent.has(String(d.intent || '')) ? String(d.intent) : 'none';
  const format = String(d.format || '').toLowerCase() === 'pdf' ? 'pdf' : 'docx';
  let exportScope = allowedScope.has(String(d.export_scope || '')) ? String(d.export_scope) : null;
  if (!exportScope) exportScope = intent === 'generate_then_export' ? 'generated_answer' : 'full_chat';
  return {
    intent,
    format,
    export_scope: exportScope,
    target_title: d.target_title == null ? null : String(d.target_title).trim() || null,
    chat_id: d.chat_id == null ? null : String(d.chat_id).trim() || null,
    clean_prompt: d.clean_prompt == null ? null : String(d.clean_prompt).trim() || null,
    selection_query: d.selection_query == null ? null : String(d.selection_query).trim() || null,
  };
}

function normalizeRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const allowedAction = new Set(['chat', 'image_generate', 'image_edit']);
  const action = allowedAction.has(String(r.action || '')) ? String(r.action) : 'chat';
  const rawConfidence = Number(r.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
  return {
    action,
    needs_web: Boolean(r.needs_web),
    confidence,
  };
}

function normalizeSelection(d, validIndices) {
  if (!d || typeof d !== 'object') return null;
  const valid = new Set(validIndices.map(Number));
  const raw = Array.isArray(d.message_indices) ? d.message_indices : [];
  const messageIndices = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && valid.has(n)))].sort((a,b)=>a-b);
  return {
    message_indices: messageIndices,
    reason: d.reason == null ? null : String(d.reason).slice(0, 300),
  };
}

export const handler = async (event) => {
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const body = parseBody(event);
    const mode = String(body.mode || 'classify');
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();

    // Groq nunca debe ser un punto único de fallo. El navegador tiene respaldo local.
    if (!apiKey) return json(200, { ok: false, fallback: true, reason: 'Router inteligente no disponible.' });

    if (mode === 'select_messages') {
      const chat = body.chat && typeof body.chat === 'object' ? body.chat : null;
      const messages = Array.isArray(chat?.messages) ? chat.messages.slice(0, 160) : [];
      if (!chat || !messages.length) return json(200, { ok: false, fallback: true, reason: 'No hay mensajes para seleccionar.' });

      const lines = messages.map(m => {
        const index = Number(m.index);
        const role = String(m.role || '') === 'assistant' ? 'ELIX' : 'USUARIO';
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
        return `[M${index}] ${role}: ${text}`;
      }).join('\n');

      const system = `Eres el selector determinista de fragmentos para exportación de Elix AI. NO respondas al usuario. Devuelve SOLO JSON válido.

Tu tarea es elegir qué mensajes del chat deben entrar al archivo solicitado.
- Respeta literalmente peticiones como: "solo la parte sobre...", "desde que hablamos de X hasta Y", "solo tu explicación de...", "solo las respuestas sobre...".
- Si se pide una explicación concreta, selecciona únicamente los mensajes necesarios. Incluye el mensaje del usuario que da contexto cuando sea útil, salvo que pida explícitamente "solo tu respuesta" o "solo la respuesta de Elix".
- No incluyas mensajes no relacionados solo por estar cerca.
- Los índices permitidos son únicamente los que aparecen como [M#].
- Si no puedes identificar una selección fiable, devuelve message_indices vacío.

Esquema exacto: {"message_indices":[0,1],"reason":"texto breve"}`;

      const user = `ORDEN ORIGINAL:\n${String(body.text || '')}\n\nSELECCIÓN PEDIDA:\n${String(body.selection_query || body.text || '')}\n\nCHAT: ${String(chat.title || '')}\n\nMENSAJES:\n${lines}`;
      const r = await askGroq(apiKey, system, user, 700);
      if (!r.ok) return json(200, { ok: false, fallback: true, reason: r.reason });
      const normalized = normalizeSelection(r.parsed, messages.map(m => Number(m.index)));
      if (!normalized) return json(200, { ok: false, fallback: true, reason: 'Selección inválida.' });
      return json(200, { ok: true, model: 'Elix Router', selection: normalized });
    }

    const text = String(body.text || '').trim();
    if (!text) {
      return json(200, { ok: true, decision: normalizeDecision({ intent:'none', format:'docx', export_scope:'full_chat' }), route: normalizeRoute({ action:'chat', needs_web:false, confidence:1 }) });
    }

    const chats = Array.isArray(body.chats) ? body.chats.slice(0, 80) : [];
    const currentId = String(body.current_chat_id || '');
    const currentTitle = String(body.current_chat_title || '');
    const chatList = chats.map(c => {
      const preview = String(c.preview || '').replace(/\s+/g, ' ').slice(0, 650);
      return `- ${String(c.id || '')}: ${String(c.title || '')}${preview ? ` | muestra: ${preview}` : ''}`;
    }).join('\n') || '(sin chats listados)';

    const hasGeneratedImage = Boolean(body.has_generated_image);
    const lastAssistantIsImage = Boolean(body.last_assistant_is_image);
    const hasPendingAttachments = Boolean(body.has_pending_attachments);
    const lastImagePrompt = String(body.last_image_prompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const recentMessages = Array.isArray(body.recent_messages) ? body.recent_messages.slice(-8) : [];
    const recentContext = recentMessages.map((m, i) => {
      const role = String(m?.role || '') === 'assistant' ? 'ELIX' : 'USUARIO';
      const txt = String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 900);
      const visual = m?.has_image ? ' [MENSAJE CON IMAGEN GENERADA]' : '';
      return `${i + 1}. ${role}${visual}: ${txt}`;
    }).join('\n') || '(sin contexto reciente)';

    const system = `Eres el router central de intención de Elix AI. NO respondas al usuario, NO redactes la tarea y NO expliques tu razonamiento. Devuelve SOLO un objeto JSON válido.

Debes resolver DOS cosas a la vez:
A) si existe una orden de exportación Word/PDF;
B) qué acción operativa debe ejecutar Elix con el prompt.

PARTE A — EXPORTACIÓN
Clasifica intent en UNA opción:
1. export_current: exportar contenido YA EXISTENTE del chat actual.
2. export_named: exportar contenido YA EXISTENTE de otro chat identificado por título o tema.
3. generate_then_export: primero hay que CREAR/INVESTIGAR/EXPLICAR/RESOLVER/ANALIZAR contenido nuevo y, al terminar, exportarlo.
4. none: no existe una orden real de exportación.

export_scope:
- full_chat: chat completo.
- last_answer: solo la última respuesta existente.
- selection: una parte concreta del chat; selection_query describe esa parte.
- generated_answer: solo la respuesta nueva de generate_then_export.

Reglas de exportación:
- Tolera errores de Word/DOCX: dox, dovx, dcx, wodr, wrd, wrod, doc y similares; también errores similares de PDF.
- "dámelo en Word", "formato Word", "quiero recibirlo en Word/PDF" sí son órdenes de archivo.
- Si pide tarea nueva + archivo => generate_then_export y clean_prompt contiene SOLO la tarea, sin Word/PDF/exportar/descargar/archivo.
- Si pide un chat existente por nombre/tema => export_named y usa el catálogo si hay coincidencia fiable.
- Si pide solo una sección => selection.
- Si pide "eso/lo anterior/tu última respuesta en Word" sin tarea nueva => last_answer.
- format="docx" para Word/doc/docx/dox/dovx y "pdf" para PDF.

PARTE B — ACCIÓN OPERATIVA
route.action debe ser exactamente una de:
- chat: responder normalmente, analizar archivos, explicar, calcular, conversar o cualquier tarea que NO sea crear/editar una imagen.
- image_generate: crear una imagen, infografía, póster, diagrama, ilustración, render, portada, banner u otra pieza visual NUEVA.
- image_edit: modificar la ÚLTIMA imagen generada por Elix en este chat.

Reglas MUY IMPORTANTES para image_edit:
- Solo puedes elegir image_edit si HAS_GENERATED_IMAGE=true.
- Interpreta continuidad conversacional, no solo palabras exactas. Si acaba de generarse/editarse una imagen y el usuario dice "ahora cambia...", "arregla eso", "igual el paréntesis...", "ponlo azul", "quita eso", "corrige el punto 3", "haz ese texto más grande", etc., normalmente es image_edit aunque no repita la palabra imagen.
- Si dice "en esa imagen", "la imagen que me mandaste", "la que hiciste", "esa infografía", "sobre la anterior" y pide un cambio visual, es image_edit.
- No confundas cambios sobre el chat/documento/respuesta/modelo con edición de imagen.
- Una pregunta SOBRE el contenido de la imagen ("qué significa esto", "explícame el punto 3") es chat, no image_edit, salvo que pida cambiar/corregir visualmente la imagen.
- Si pide una versión completamente nueva o una nueva imagen distinta, usa image_generate.
- Si hay un archivo/imagen adjunto y pide analizar/leer/describir, usa chat. Si pide crear una infografía/imagen BASADA en adjuntos, usa image_generate.

route.needs_web:
- true si para responder el prompt se necesita buscar fuentes, navegar, verificar información actual/reciente, noticias, precios, datos cambiantes o el usuario pide explícitamente investigar/buscar en internet.
- false para conocimiento estable, conversación, cálculos, edición/generación visual basada en material ya disponible, o si el usuario exige usar únicamente el contenido aportado.
- Esta decisión NO cambia los selectores manuales de modelo ni el modo académico; esos controles siguen mandando por separado.

route.confidence es un número de 0 a 1. Usa >=0.85 cuando la intención sea clara; baja de 0.55 si realmente es ambigua.

Esquema exacto:
{"intent":"export_current|export_named|generate_then_export|none","format":"docx|pdf","export_scope":"full_chat|last_answer|selection|generated_answer","target_title":null|string,"chat_id":null|string,"clean_prompt":null|string,"selection_query":null|string,"route":{"action":"chat|image_generate|image_edit","needs_web":true|false,"confidence":0.0}}`;

    const user = `TEXTO ACTUAL DEL USUARIO:\n${text}\n\nESTADO VISUAL DEL CHAT:\nHAS_GENERATED_IMAGE=${hasGeneratedImage}\nLAST_ASSISTANT_IS_IMAGE=${lastAssistantIsImage}\nHAS_PENDING_ATTACHMENTS=${hasPendingAttachments}\nÚLTIMO PROMPT DE IMAGEN: ${lastImagePrompt || '(ninguno)'}\n\nCONTEXTO RECIENTE:\n${recentContext}\n\nCHAT ACTUAL: ${currentId} | ${currentTitle}\n\nCATÁLOGO DE CHATS PARA EXPORTACIÓN:\n${chatList}`;
    const r = await askGroq(apiKey, system, user, 820, { timeoutMs: 7000, maxModels: 3 });
    if (!r.ok) return json(200, { ok: false, fallback: true, reason: r.reason });
    const parsed = normalizeDecision(r.parsed);
    const route = normalizeRoute(r.parsed?.route);
    if (!parsed) return json(200, { ok: false, fallback: true, reason: 'Clasificación de exportación inválida.' });
    return json(200, { ok: true, model: 'Elix Router', decision: parsed, route });
  } catch (error) {
    console.error('elix-export-router', error);
    return json(200, { ok: false, fallback: true, reason: error?.message || 'Router no disponible.' });
  }
};
