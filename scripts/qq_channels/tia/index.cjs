const channelId = '1332650386720559105';

function isImage(item) {
  if (!item?.source_url || item.kind === 'video') return false;
  try {
    const url = new URL(item.source_url);
    return url.protocol === 'https:' && ['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)
      && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
  } catch { return false; }
}

function buildParts(heading, body, attachments, splitText) {
  const images = attachments.filter(isImage);
  // tia only forwards messages containing pictures, with their original caption.
  if (!images.length) return [];
  const caption = /^no text$/i.test(String(body || '').trim()) ? '' : String(body || '');
  const chunks = splitText(caption,1400);
  return [
    ...(chunks.length ? chunks.map((content,index) => ({type:'text',content:index ? content : `${heading}\n${content}`}))
      : [{type:'text',content:heading}]),
    ...images.map(item => ({type:'image',sourceUrl:item.source_url,content:' '})),
  ];
}

module.exports = {channelId,isImage,buildParts};
