import { NextRequest, NextResponse } from "next/server";
import { resolveAccessProtection } from "@/lib/access-protection";

export function proxy(request: NextRequest) {
  const user = process.env.TRIAL_BASIC_AUTH_USER;
  const password = process.env.TRIAL_BASIC_AUTH_PASSWORD;
  const publicAccess = process.env.PUBLIC_TRIAL_ACCESS;
  const protection = resolveAccessProtection({
    environment: process.env.NODE_ENV,
    user,
    password,
    publicAccess,
  });

  if (protection === "disabled") {
    return NextResponse.next();
  }
  if (protection === "misconfigured" || !user || !password) {
    return new NextResponse("Access protection is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const authorization = request.headers.get("authorization");
  const credentials = parseBasicAuth(authorization);

  if (credentials?.user === user && credentials.password === password) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Expert Supply Trial"',
    },
  });
}

function parseBasicAuth(authorization: string | null) {
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)"],
};
