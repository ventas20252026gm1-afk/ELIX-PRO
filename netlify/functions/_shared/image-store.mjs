import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'elix-ai-image-edit-v1';
const TRANSFER_RX = /^eliximg-[A-Za-z0-9_-]{20,120}$/;
const MAX_CHUNKS = 240;

export function connectImageStore(event) {
  connectLambda(event);
}

function store() {
  return getStore(STORE_NAME);
}

export function assertImageTransferId(value) {
  const id = String(value || '').trim();
  if (!TRANSFER_RX.test(id)) {
    const err = new Error('Identificador temporal de imagen inválido.');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export function assertImageChunkCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) {
    const err = new Error('Cantidad de fragmentos de imagen inválida.');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function chunkKey(id, index) {
  return `input/${id}/chunk-${String(index).padStart(4, '0')}`;
}

function manifestKey(id) {
  return `input/${id}/manifest`;
}

export async function putImageChunk({ transferId, index, totalChunks, chunk }) {
  const id = assertImageTransferId(transferId);
  const total = assertImageChunkCount(totalChunks);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= total) {
    const err = new Error('Índice de fragmento de imagen inválido.');
    err.statusCode = 400;
    throw err;
  }

  const data = String(chunk || '');
  if (!data) {
    const err = new Error('El fragmento de imagen está vacío.');
    err.statusCode = 400;
    throw err;
  }
  if (data.length > 140000) {
    const err = new Error('El fragmento de imagen es demasiado grande.');
    err.statusCode = 413;
    throw err;
  }

  if (i === 0) {
    await store().setJSON(manifestKey(id), {
      transfer_id: id,
      total_chunks: total,
      created_at: new Date().toISOString(),
    });
  }

  await store().set(chunkKey(id, i), data);
  return { transfer_id: id, index: i, total_chunks: total };
}

export async function readImageTransfer(transferId, expectedChunks) {
  const id = assertImageTransferId(transferId);
  const expected = assertImageChunkCount(expectedChunks);
  const manifest = await store().get(manifestKey(id), { type: 'json' });
  if (!manifest) {
    const err = new Error('No se encontró la imagen temporal que se iba a editar.');
    err.statusCode = 404;
    throw err;
  }
  const total = assertImageChunkCount(manifest.total_chunks);
  if (total !== expected) {
    const err = new Error('La imagen temporal está incompleta o no coincide con la solicitud.');
    err.statusCode = 400;
    throw err;
  }

  const parts = [];
  for (let i = 0; i < total; i++) {
    const part = await store().get(chunkKey(id, i), { type: 'text' });
    if (typeof part !== 'string' || !part.length) {
      const err = new Error(`Falta el fragmento ${i + 1} de ${total} de la imagen temporal.`);
      err.statusCode = 400;
      throw err;
    }
    parts.push(part);
  }
  return parts.join('');
}

export async function deleteImageTransfer(transferId, totalChunks) {
  const id = assertImageTransferId(transferId);
  const total = assertImageChunkCount(totalChunks);
  const keys = [manifestKey(id)];
  for (let i = 0; i < total; i++) keys.push(chunkKey(id, i));
  await Promise.allSettled(keys.map(key => store().delete(key)));
}
