import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const ATTEMPT_TIMEOUT_MS = 60 * 1000;

// Fuentes preferidas para los modos científicos de mayor rigor.
// Tavily las aplica como filtro real (restrict), no como una simple sugerencia.
const ACADEMIC_DOMAINS = [
  'pubmed.ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'nature.com',
  'science.org',
  'cell.com',
  'sciencedirect.com',
  'elsevier.com',
  'link.springer.com',
  'springer.com',
  'onlinelibrary.wiley.com',
  'wiley.com',
  'academic.oup.com',
  'oxfordacademic.com',
  'journals.plos.org',
  'pnas.org',
  'annualreviews.org',
  'frontiersin.org',
  'bmj.com',
  'nejm.org',
  'thelancet.com',
  'jamanetwork.com',
  'pubs.acs.org',
  'acs.org',
  'pubs.rsc.org',
  'rsc.org',
  'ieeexplore.ieee.org',
  'ieee.org',
  'tandfonline.com',
  'sagepub.com',
  'cambridge.org',
  'jstor.org',
  'projectmuse.jhu.edu',
  'scielo.org',
  'scielo.br',
  'who.int',
  'nih.gov',
  'cdc.gov',
  'fao.org',
  'nasa.gov',
  'noaa.gov',
  'usgs.gov',
  'epa.gov',
  'harvard.edu',
  'mit.edu',
  'stanford.edu',
  'ox.ac.uk',
  'cam.ac.uk',
];

async function tavilyRequest(apiKey, payload, useBodyKey = false) {
  return fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: useBodyKey
      ? { 'Content-Type': 'application/json' }
      : {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
    body: JSON.stringify(useBodyKey ? { api_key: apiKey, ...payload } : payload),
  }, ATTEMPT_TIMEOUT_MS);
}

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const q = String(body.query || '').trim();
    if (!q) throw new Error('La consulta de búsqueda está vacía.');

    const rigor = String(body.rigor || 'standard').toLowerCase();
    const isRigorous = rigor === 'high' || rigor === 'max';

    const apiKey = requireEnv('TAVILY_API_KEY');
    const payload = {
      query: q,
      search_depth: 'advanced',
      chunks_per_source: 3,
      max_results: isRigorous ? 20 : 8,
      topic: 'general',
      include_published_date: isRigorous,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    };

    if (isRigorous) {
      payload.include_domains = ACADEMIC_DOMAINS;
      payload.include_domains_mode = 'restrict';
    }

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      progress: isRigorous
        ? 'Elix AI buscando literatura científica de alto nivel.'
        : 'Elix AI buscando fuentes.',
      rigor,
      started_at: new Date().toISOString(),
    });

    let response = await tavilyRequest(apiKey, payload, false);
    let data = await readJsonResponse(response);

    // Compatibilidad con cuentas/implementaciones que acepten api_key en el body.
    if (!response.ok && [400, 401, 403, 422].includes(response.status)) {
      await setJob(jobId, {
        status: 'running',
        provider: 'elix',
        progress: isRigorous
          ? 'Elix AI reintentando la búsqueda académica.'
          : 'Elix AI reintentando la búsqueda.',
        rigor,
      });

      response = await tavilyRequest(apiKey, payload, true);
      data = await readJsonResponse(response);
    }

    if (!response.ok) {
      const err = new Error(`Elix AI: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
      err.statusCode = response.status;
      throw err;
    }

    await setJob(jobId, {
      status: 'done',
      provider: 'elix',
      result: {
        ...data,
        _elix_rigor: rigor,
        _elix_academic_filter: isRigorous,
      },
      result_count: Array.isArray(data?.results) ? data.results.length : 0,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('elix-search-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'elix',
          error: error?.message || 'Error interno en Elix AI.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job Elix:', storeError);
      }
    }
  }
};
