/**
 * CORS handling for Edge Functions.
 *
 * The allowed origins are read from the ALLOWED_ORIGINS secret rather than
 * hard-coded to `*`. These functions hold the service-role key and create
 * accounts; a wildcard would let any site on the internet put a request to
 * them in front of a signed-in user's browser.
 *
 * Set it in deployment, comma separated:
 *   supabase secrets set ALLOWED_ORIGINS="https://recoverease.vercel.app"
 */
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

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowList = [...configured, ...DEV_ORIGINS]
  const allowed = origin && allowList.includes(origin) ? origin : allowList[0]

  return {
    'Access-Control-Allow-Origin': allowed ?? '',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
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
