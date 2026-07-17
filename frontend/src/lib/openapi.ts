import type { ApiScope } from './api';

/**
 * Builds an OpenAPI 3.0 document for the agent API from the live scope catalog
 * (method/path/scope/description reported by GET /api/tokens/scopes). Endpoints
 * are documented against the same-origin `/agent` base path and secured with a
 * bearer token (either a Supabase JWT for the web UI or a `sot_` API token).
 */
export function buildOpenApi(scopes: ApiScope[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  for (const s of scopes) {
    const tag = s.scope.split(':')[0];
    tagSet.add(tag);
    const path = (paths[s.path] ??= {});
    path[s.method.toLowerCase()] = {
      tags: [tag],
      summary: s.description,
      description: `Requires the \`${s.scope}\` scope when called with an API token.`,
      'x-required-scope': s.scope,
      security: [{ bearerAuth: [] }],
      responses: {
        '200': { description: 'Success' },
        '401': { description: 'Missing or invalid token' },
        '403': { description: 'Token lacks the required scope' },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Soteria TACACS+ Agent API',
      version: '1.0.0',
      description:
        'Programmatic control of the Soteria TACACS+ server. Authenticate with a bearer token: ' +
        'a Supabase session JWT (web UI) or a scoped API token (`sot_…`) created under Settings > API Tokens. ' +
        'Entity writes (PUT) require an active Edit Config session (POST /api/staging) and are applied by POST /api/staging/commit.',
    },
    servers: [{ url: '/agent', description: 'Same-origin proxy to the agent' }],
    tags: [...tagSet].sort().map((t) => ({ name: t })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Supabase JWT (web UI) or an API token of the form sot_… .',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

export const METHOD_BADGE: Record<string, string> = {
  GET: 'badge-readonly',
  POST: 'badge-success',
  PUT: 'badge-warning',
  DELETE: 'badge-danger',
};
