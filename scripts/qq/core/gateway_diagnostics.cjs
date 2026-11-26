function safeGatewayText(value, redactions = []) {
  if (!['string','number','boolean'].includes(typeof value)) return null;
  let text = String(value);
  for (const secret of redactions) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi,'[url]')
    .replace(/\b(?:QQBot|Bearer)\s+[^\s,;"']+/gi,'[authorization]')
    .replace(/((?:access_token|clientSecret|session_id|authorization|token|cookie|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[redacted]')
    .slice(0,512);
}

function gatewayError(error, redactions = []) {
  const details = [];
  const seen = new Set();
  const pending = [error];
  while (pending.length && details.length < 4) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    details.push({name:safeGatewayText(current.name,redactions),
      code:safeGatewayText(current.code,redactions),
      message:safeGatewayText(typeof current === 'string' ? current : current.message,redactions)});
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0,3));
  }
  return {available:details.some(item => item.message || item.code),details};
}

module.exports = {safeGatewayText,gatewayError};
