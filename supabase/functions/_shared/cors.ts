/**
 * CORS handling for Edge Functions.
 *
 * Never `*`. These functions hold the service-role key and create accounts; a
 * wildcard would let any site on the internet put a request to them in front
 * of a signed-in user's browser. The allow-list is closed by default and an
 * origin that is not on it is refused.
 *
 * The list is built from two sources:
 *
 *  - `PRODUCTION_ORIGINS` below, checked in. These are the deployment's own
 *    public URLs. They are not secrets — anyone can read them off the address
 *    bar — and keeping them in source is deliberate: the alternative is a
 *    deployment that silently fails CORS until somebody remembers to set an
 *    environment variable, which is exactly what happened here. The guidance
 *    chatbot was unreachable in production for that reason alone, and the
 *    symptom was a browser CORS error rather than the function's own clean
 *    503, because an empty list used to fall through to a localhost origin.
 *
 *  - `ALLOWED_ORIGINS`, optional, comma separated. It *extends* the list
 *    rather than replacing it, so a preview deployment or a future custom
 *    domain can be added without a redeploy:
 *      supabase secrets set ALLOWED_ORIGINS="https://staging.example.com"
 *
 * Adding a hostname here is a real authorization decision. Only origins this
 * project controls belong in it.
 */
const PRODUCTION_ORIGINS = [
  'https://recovereasedev.vercel.app',
  // Vercel's name-derived alias for the same project, still live and serving
  // the same deployment. Kept so a bookmarked link does not hit a chat that
  // fails for no visible reason.
  'https://recoverease-zeta.vercel.app',
]

const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// Local development origins are always permitted; they are not reachable from
// anywhere but the developer's own machine. 4173 is `vite preview`, which is
// how the production build is checked before deploying.
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
]

const ALLOW_LIST = [...PRODUCTION_ORIGINS, ...configured, ...DEV_ORIGINS]

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOW_LIST.includes(origin) ? origin : null

  // An origin that is not on the list gets no `Access-Control-Allow-Origin`
  // header at all. The previous version fell back to `allowList[0]`, which
  // answered a production browser with a localhost origin — a denial that
  // reads like a misconfiguration and cost real time to diagnose. Saying
  // nothing is the honest form of "no".
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }

  if (allowed) headers['Access-Control-Allow-Origin'] = allowed

  return headers
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
    },
  })
}

export function handlePreflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders(request.headers.get('origin')) })
}
