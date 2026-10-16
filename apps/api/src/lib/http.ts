import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/** Throw a JSON error response: { error, code, details }. */
export function fail(status: ContentfulStatusCode, error: string, code?: string, details?: unknown): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error, code, details }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  });
}

export function notFound(what = 'resource'): never {
  fail(404, `${what} not found`, 'NOT_FOUND');
}

/** Parse and validate a JSON body; 400 with zod issues on failure. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'invalid JSON body', 'BAD_JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) fail(400, 'validation failed', 'VALIDATION', r.error.issues);
  return r.data;
}

export function query<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) fail(400, 'invalid query', 'VALIDATION', r.error.issues);
  return r.data;
}
