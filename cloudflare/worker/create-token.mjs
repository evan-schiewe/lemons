#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
const secret = process.env.TOKEN_SIGNING_SECRET || args.secret;

if (!secret || !args.sub) {
  console.error(
    'Usage: TOKEN_SIGNING_SECRET=... node cloudflare/worker/create-token.mjs --sub alice@example.com [--app-url https://example.github.io/lemons/]',
  );
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const days = Number.parseInt(args.days || '28', 10);
const payload = {
  jti: args.jti || randomUUID(),
  sub: args.sub,
  workspace_id: args.workspace || 'main',
  scope: splitArg(
    args.scope || 'annotations:read,annotations:write,races:read,races:write',
  ),
  races: splitArg(args.races || '*'),
  iat: now,
  exp: now + days * 24 * 60 * 60,
};
const token = sign(payload, secret);

if (args['app-url']) {
  const url = new URL(args['app-url']);
  url.searchParams.set('edit_token', token);
  console.log(url.toString());
} else {
  console.log(token);
}

function sign(payloadValue, signingSecret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payloadValue));
  const signature = createHmac('sha256', signingSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function splitArg(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
