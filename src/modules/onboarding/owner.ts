// Who the onboarding data belongs to: a guest while the person is answering,
// or a signed-in user. Shared by every onboarding route.

import type { FastifyRequest } from 'fastify';
import type { OnboardingOwner } from '../../db/onboarding-store.js';
import { AppError } from '../../shared/http/errors.js';

// The authentication hook has already refused anonymous callers on these
// routes; the throw is the same kind of safety net as requireUser in
// src/http/auth.ts.
export function ownerOf(request: FastifyRequest): OnboardingOwner {
  const principal = request.principal;
  switch (principal.kind) {
    case 'user':
      return { userId: principal.userId };
    case 'guest':
      return { guestSessionId: principal.guestSessionId };
    case 'anonymous':
      throw new AppError('unauthenticated');
  }
}
