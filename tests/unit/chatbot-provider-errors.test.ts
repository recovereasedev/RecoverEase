import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isProviderTimeout,
  providerErrorSummary,
} from '../../supabase/functions/_shared/reply-outcome'

/**
 * How `chatbot-reply` treats a provider that fails after answering: what of
 * an error response reaches the log, and how a body that stops arriving is
 * reported.
 */

const PATIENT_TEXT = 'Is some swelling normal after the operation?'

/** The shape of a Google API error, quoting the request as such errors can. */
const googleError = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    error: {
      code: 400,
      message: `Invalid value at 'input[1].type' near "${PATIENT_TEXT}"`,
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [
            { field: 'input[1].type', description: `Unknown turn type for "${PATIENT_TEXT}"` },
          ],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'INVALID_TURN_TYPE',
          domain: 'googleapis.com',
          metadata: { text: PATIENT_TEXT },
        },
      ],
      ...overrides,
    },
  })

describe('providerErrorSummary', () => {
  it('keeps the status and the machine-readable parts of a Google API error', () => {
    expect(JSON.parse(providerErrorSummary(400, googleError()))).toEqual({
      event: 'gemini_error',
      status: 400,
      provider_code: 400,
      provider_status: 'INVALID_ARGUMENT',
      reasons: ['INVALID_TURN_TYPE'],
      fields: ['input[1].type'],
    })
  })

  it('never logs the message, a description or metadata, which can quote the patient', () => {
    const line = providerErrorSummary(400, googleError())
    expect(line).not.toContain('swelling')
    expect(line).not.toContain('Invalid value')
    expect(line).not.toContain('Unknown turn type')
  })

  it('drops anything that is not shaped like an enum name or a request path', () => {
    const line = providerErrorSummary(
      429,
      googleError({
        status: `RESOURCE EXHAUSTED: ${PATIENT_TEXT}`,
        details: [
          { reason: PATIENT_TEXT },
          { fieldViolations: [{ field: `input[0].content = ${PATIENT_TEXT}` }, { field: 42 }] },
        ],
      }),
    )
    expect(JSON.parse(line)).toMatchObject({ provider_status: null, reasons: [], fields: [] })
    expect(line).not.toContain('swelling')
  })

  it('logs only the status when the body is not a Google error', () => {
    for (const body of ['', `<html><body>${PATIENT_TEXT}</body></html>`, '[]', 'null', '{"error":"busy"}']) {
      expect(JSON.parse(providerErrorSummary(503, body)), body).toEqual({
        event: 'gemini_error',
        status: 503,
        provider_code: null,
        provider_status: null,
        reasons: [],
        fields: [],
      })
    }
  })

  it('does not parse a body larger than any error the provider sends', () => {
    const line = providerErrorSummary(500, googleError({ padding: 'x'.repeat(70_000) }))
    expect(JSON.parse(line)).toMatchObject({ provider_code: null, provider_status: null })
  })

  it('keeps a code only when it is an HTTP status, and at most five of each list', () => {
    const many = Array.from({ length: 8 }, (_, index) => `REASON_${index}`)
    const line = JSON.parse(
      providerErrorSummary(
        500,
        googleError({
          code: 'five hundred',
          details: [...many, 'REASON_0'].map((reason) => ({ reason })),
        }),
      ),
    )
    expect(line.provider_code).toBeNull()
    expect(line.reasons).toEqual(many.slice(0, 5))
    expect(JSON.parse(providerErrorSummary(500, googleError({ code: 9_000 }))).provider_code).toBeNull()
  })
})

describe('a provider that stalls after its headers', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  })

  it('fails the body read with the time limit’s own error, which counts as a timeout', async () => {
    // Node's fetch. Deno 2.1.4's rejects the same way; that was checked
    // outside this suite, since there is no Deno here.
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"outputs": [')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(100) })
    expect(response.ok).toBe(true)
    const cause = await response.json().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(cause).toBeDefined()
    expect(isProviderTimeout(cause)).toBe(true)
  })
})

describe('chatbot-reply', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase/functions/chatbot-reply/index.ts'),
    'utf8',
  )
  const bodyRead = source.slice(
    source.indexOf('payload = await response.json()'),
    source.indexOf('parseAssistantReply(extractOutputText(payload))'),
  )

  it('reports a body that stops arriving as a timeout, and anything else unreadable as malformed', () => {
    expect(bodyRead).toMatch(
      /catch \(cause\) \{[\s\S]*if \(isProviderTimeout\(cause\)\) \{[\s\S]*504, 'timeout'\)[\s\S]*\}\s*throw new AssistantReplyError/,
    )
  })

  it('logs a provider error only through its summary', () => {
    // The body is read once and used once: nothing else can log or forward it.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code.match(/\bdetail\b/g)).toHaveLength(2)
    expect(source).toContain("const detail = await response.text().catch(() => '')")
    expect(source).toContain('console.error(providerErrorSummary(response.status, detail))')
  })
})
