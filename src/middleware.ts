import { NextResponse, type NextRequest } from 'next/server';

// Single-user gate for the public deployment: HTTP Basic Auth, enforced only
// when BASIC_AUTH_PASS is set (local dev stays open). /api/health stays exempt
// so Fly's checks — which send no credentials — keep passing. Credentials live
// in Fly secrets (+ 1Password), never in the repo.

function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function middleware(req: NextRequest): NextResponse {
  const pass = process.env.BASIC_AUTH_PASS;
  if (!pass) return NextResponse.next();

  const user = process.env.BASIC_AUTH_USER ?? 'casey';
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const [gotUser, ...rest] = atob(header.slice(6)).split(':');
      const gotPass = rest.join(':');
      if (timingSafeEqualStr(gotUser ?? '', user) && timingSafeEqualStr(gotPass, pass)) {
        return NextResponse.next();
      }
    } catch {
      // fall through to challenge
    }
  }
  return new NextResponse('authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="fantasy terminal", charset="UTF-8"' },
  }) as NextResponse;
}

export const config = {
  matcher: ['/((?!api/health).*)'],
};
