const assert = require('node:assert/strict');
const {test} = require('node:test');
const {gatewayError,safeGatewayText} = require('../scripts/qq/core/gateway_diagnostics.cjs');

test('Gateway diagnostics redact credentials, session identities, URLs and named sensitive fields',() => {
  const raw = 'known-secret session-value https://example.invalid/?key=private '+
    'wss://example.invalid/path Bearer unknown-value token=private '+
    '"session_id":"private" cookie=private password=private clientSecret=private';
  const text = safeGatewayText(raw,['known-secret','session-value']);
  assert(!/known-secret|session-value|example|private|unknown-value/.test(text));
  assert.equal(safeGatewayText({token:'do-not-serialize'}),null);
  assert.equal(safeGatewayText('message'.repeat(1000)).length,512);
});

test('Gateway diagnostics bound cyclic and aggregate causes while retaining transport codes',() => {
  const network = Object.assign(Error('read ECONNRESET'),{code:'ECONNRESET'});
  const aggregate = new AggregateError([network,Object.assign(Error('timeout'),{code:'ETIMEDOUT'})],'connection failed');
  network.cause = aggregate;
  const result = gatewayError(Object.assign(Error('WebSocket error'),{cause:aggregate}));
  assert.equal(result.available,true);
  assert.equal(result.details.length,4);
  assert(result.details.some(item => item.code === 'ECONNRESET'));
  assert(result.details.some(item => item.code === 'ETIMEDOUT'));
});

test('Gateway diagnostics do not serialize arbitrary event, message or request payloads',() => {
  const result = gatewayError({target:{token:'hidden'},request:{body:'hidden'},data:'hidden'});
  assert.equal(result.available,false);
  assert(!JSON.stringify(result).includes('hidden'));
});
