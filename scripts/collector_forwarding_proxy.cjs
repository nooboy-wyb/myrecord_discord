async function proxyForwarding(req,res,port,token) {
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid sender port');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32768) throw Error('Forwarding request too large');
      chunks.push(chunk);
    }
    const response = await fetch(`http://127.0.0.1:${port}${req.url}`, {
      method:req.method, headers:{'content-type':'application/json','x-collector-token':token},
      ...(['GET','HEAD'].includes(req.method) ? {} : {body:Buffer.concat(chunks)}),
      signal:AbortSignal.timeout(5000)
    });
    res.writeHead(response.status,{'content-type':'application/json'});
    res.end(await response.text());
  } catch {
    res.writeHead(503,{'content-type':'application/json'});
    res.end(JSON.stringify({error:'QQ sender unavailable; collection continues independently'}));
  }
}
module.exports = {proxyForwarding};
