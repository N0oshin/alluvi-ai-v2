// The two files that let a tap on a magic link open the app instead of the
// browser (document 04 Phase 2.3, "Universal Link / App Link domain
// verification files"). The phones fetch them from the link's domain:
//
//   GET /.well-known/apple-app-site-association   iOS Universal Links
//   GET /.well-known/assetlinks.json              Android App Links
//
// Each one says "the app with this id may handle these URLs". Without them
// the OS refuses to hand the URL to the app. Backend notes, entry 48.

import type { FastifyPluginCallback } from 'fastify';

export interface AppLinkConfig {
  appleTeamId: string | undefined;
  iosBundleId: string | undefined;
  androidPackageName: string | undefined;
  androidCertSha256: string[] | undefined;
  // The path the links use, from MAGIC_LINK_BASE_URL; e.g. '/auth/magic-link'.
  linkPath: string;
}

export interface WellKnownDependencies {
  appLinks: AppLinkConfig;
}

// Apple's file. `appIDs` plus `components` is the current form (iOS 13+);
// `appID` plus `paths` is kept for older systems. The `?` component means
// "only URLs that carry a token query parameter".
export function appleAppSiteAssociation(config: AppLinkConfig): object | undefined {
  if (config.appleTeamId === undefined || config.iosBundleId === undefined) return undefined;
  const appId = `${config.appleTeamId}.${config.iosBundleId}`;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: appId,
          appIDs: [appId],
          paths: [`${config.linkPath}*`],
          components: [{ '/': config.linkPath, '?': { token: '*' } }],
        },
      ],
    },
  };
}

// Android's file. `handle_all_urls` is the relation that makes links open
// the app; fingerprints are upper-case colon-separated SHA-256.
export function androidAssetLinks(config: AppLinkConfig): object[] | undefined {
  if (
    config.androidPackageName === undefined ||
    config.androidCertSha256 === undefined ||
    config.androidCertSha256.length === 0
  ) {
    return undefined;
  }
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.androidPackageName,
        sha256_cert_fingerprints: config.androidCertSha256.map((f) => f.toUpperCase()),
      },
    },
  ];
}

export function wellKnownRoutes(deps: WellKnownDependencies): FastifyPluginCallback {
  return (app, _options, done) => {
    // Apple fetches this with no file extension and expects JSON; set the
    // content type by hand. No caching headers: the OS refetches rarely
    // anyway, and a stale copy after a change is worse than an extra fetch.
    app.get('/apple-app-site-association', async (_request, reply) => {
      const body = appleAppSiteAssociation(deps.appLinks);
      if (body === undefined) return reply.code(404).send();
      return reply.type('application/json').send(body);
    });

    app.get('/assetlinks.json', async (_request, reply) => {
      const body = androidAssetLinks(deps.appLinks);
      if (body === undefined) return reply.code(404).send();
      return reply.type('application/json').send(body);
    });

    done();
  };
}
