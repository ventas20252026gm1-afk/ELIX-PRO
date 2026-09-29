import { json, onlyPost, parseBody, handleError } from './_shared/utils.mjs';
import {
  connectImageStore,
  assertImageTransferId,
  assertImageChunkCount,
  putImageChunk,
  deleteImageTransfer,
} from './_shared/image-store.mjs';

export const handler = async (event) => {
  connectImageStore(event);
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const body = parseBody(event);
    const action = String(body.action || 'upload').trim().toLowerCase();
    const transferId = assertImageTransferId(body.transfer_id);
    const totalChunks = assertImageChunkCount(body.total_chunks);

    if (action === 'cleanup') {
      await deleteImageTransfer(transferId, totalChunks);
      return json(200, { ok: true, cleaned: true });
    }
    if (action !== 'upload') return json(400, { error: 'Acción de imagen no válida.' });

    const saved = await putImageChunk({
      transferId,
      index: body.index,
      totalChunks,
      chunk: body.chunk,
    });
    return json(200, { ok: true, ...saved });
  } catch (error) {
    return handleError(error);
  }
};
