import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * An HTTP proxy in front of an S3 service that misbehaves on request, in the ways the minimum common contract says
 * any service may: throttling, truncated or ignored reads, errors in successful responses, expired uploads, slow
 * responses and objects that are not readable yet after they were written.
 */
export type Fault =
  /** answer with an S3 error instead of forwarding */
  | { kind: 'error'; status: number; code: string }
  /** answer 200 with an error body instead of forwarding, like CompleteMultipartUpload may */
  | { kind: 'ok-with-error'; code: string }
  /** forward, then send only half of the body, with the original or a matching length */
  | { kind: 'truncate'; keepContentLength: boolean }
  /** forward, then hold the response back */
  | { kind: 'delay'; ms: number }
  /** forward, then answer like a service that ignored the Range header (200 without Content-Range) */
  | { kind: 'ignore-range' };

export interface ProxiedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

export const isCompleteMultipartUpload = ({ method, query }: ProxiedRequest) =>
  method === 'POST' && query.has('uploadId');
export const isUploadPart = ({ method, query }: ProxiedRequest) => method === 'PUT' && query.has('partNumber');
export const isPutObject = ({ method, query }: ProxiedRequest) => method === 'PUT' && !query.has('partNumber');
export const isGetObject = ({ method, query }: ProxiedRequest) =>
  method === 'GET' && !query.has('list-type') && !query.has('uploads');

interface Rule {
  match: (request: ProxiedRequest) => boolean;
  fault: Fault;
  remaining: number;
}

const errorBody = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code} injected by the contract tests</Message></Error>`;

export class FaultProxy {
  static async start(target: string) {
    const proxy = new this(new URL(target));
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  readonly requests: ProxiedRequest[] = [];
  private rules: Rule[] = [];
  private server: Server;

  private constructor(private target: URL) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => response.destroy());
    });
  }

  get endpoint() {
    const { port } = this.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  inject(match: Rule['match'], fault: Fault, times = 1) {
    this.rules.push({ match, fault, remaining: times });
  }

  reset() {
    this.rules = [];
    this.requests.length = 0;
  }

  stop() {
    return new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private takeFault(request: ProxiedRequest) {
    const rule = this.rules.find((rule) => rule.remaining > 0 && rule.match(request));
    if (rule) {
      rule.remaining--;
    }
    return rule?.fault;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', this.target);
    const proxied = { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams };
    this.requests.push(proxied);
    const fault = this.takeFault(proxied);

    const body = await buffer(request);
    if (fault?.kind === 'error' || fault?.kind === 'ok-with-error') {
      const status = fault.kind === 'error' ? fault.status : 200;
      response.writeHead(status, { 'Content-Type': 'application/xml' });
      response.end(errorBody(fault.code));
      return;
    }

    const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
      // headers are forwarded as they are, since they are signed
      const forwarded = httpRequest(url, { method: request.method, headers: request.headers }, resolve);
      forwarded.once('error', reject);
      forwarded.end(body);
    });
    const content = await buffer(upstream);

    if (fault?.kind === 'delay') {
      await sleep(fault.ms);
    }

    if (fault?.kind === 'truncate') {
      const half = content.subarray(0, Math.floor(content.length / 2));
      const truncatedHeaders = { ...upstream.headers };
      if (!fault.keepContentLength) {
        truncatedHeaders['content-length'] = String(half.length);
      }
      response.writeHead(upstream.statusCode ?? 500, truncatedHeaders);
      response.write(half);
      if (fault.keepContentLength) {
        // the connection drops before the announced length was sent
        response.destroy();
      } else {
        response.end();
      }
      return;
    }

    if (response.destroyed) {
      return;
    }

    if (fault?.kind === 'ignore-range') {
      const headers = { ...upstream.headers };
      delete headers['content-range'];
      response.writeHead(200, headers);
      response.end(content);
      return;
    }

    response.writeHead(upstream.statusCode ?? 500, upstream.headers);
    response.end(content);
  }
}
