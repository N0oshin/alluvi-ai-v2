// Prints a new access token signing key as one line of JSON, ready to be
// added to ACCESS_TOKEN_KEYS. Run with: npm run keys:generate [kid]

import { generateAccessTokenKey } from './access-token.js';

const key = await generateAccessTokenKey(process.argv[2]);
process.stdout.write(`${JSON.stringify(key)}\n`);
