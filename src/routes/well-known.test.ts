import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../test/app-deps.js';
import { buildApp } from '../app.js';
import type { AppLinkConfig } from './well-known.js';

const configured: AppLinkConfig = {
  appleTeamId: 'A1B2C3D4E5',
  iosBundleId: 'ai.alluvi.app',
  androidPackageName: 'ai.alluvi.app',
  androidCertSha256: ['aa:bb:cc', 'dd:ee:ff'],
  linkPath: '/auth/magic-link',
};

describe('/.well-known', () => {
  it('serves the Apple file as JSON naming TEAMID.bundle and the link path', async () => {
    const app = buildApp(fakeDeps({ appLinks: configured }));
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/apple-app-site-association',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: 'A1B2C3D4E5.ai.alluvi.app',
            appIDs: ['A1B2C3D4E5.ai.alluvi.app'],
            paths: ['/auth/magic-link*'],
            components: [{ '/': '/auth/magic-link', '?': { token: '*' } }],
          },
        ],
      },
    });
  });

  it('serves the Android file with upper-cased fingerprints', async () => {
    const app = buildApp(fakeDeps({ appLinks: configured }));
    const response = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'ai.alluvi.app',
          sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'],
        },
      },
    ]);
  });

  it('answers 404 for a file whose values are not configured', async () => {
    const app = buildApp(
      fakeDeps({ appLinks: { ...configured, appleTeamId: undefined, androidCertSha256: [] } }),
    );
    const apple = await app.inject({
      method: 'GET',
      url: '/.well-known/apple-app-site-association',
    });
    expect(apple.statusCode).toBe(404);
    const android = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    expect(android.statusCode).toBe(404);
  });
});
