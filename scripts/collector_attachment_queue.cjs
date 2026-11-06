const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

function originalAttachmentUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)) return null;
  if (url.pathname.startsWith('/attachments/')) {
    url.hostname = 'cdn.discordapp.com';
    for (const key of [...url.searchParams.keys()]) {
      if (!['ex','is','hm'].includes(key)) url.searchParams.delete(key);
    }
  } else if (!(url.hostname === 'media.discordapp.net' && url.pathname.startsWith('/external/'))) return null;
  url.hash = '';
  return url.href;
}

// Jobs live in the same daily SQLite transaction as their message. A successful
// capture acknowledgement therefore survives a process exit before any download.
function createAttachmentQueue({root,fetchImpl = globalThis.fetch,now = Date.now,
  concurrency = 3,timeoutMs = 15000,maxAttempts = 5,
  retryDelays = [5000,30000,120000,300000],onEvent = () => {}}) {
  const dates = new Set();
  const active = new Set();
  let started = false, timer, wakeup;
  function fileFor(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('invalid attachment archive date');
    return path.join(root,date,'messages.sqlite');
  }
  function notify(code,job,detail = {}) {
    try { onEvent({event_id:crypto.randomUUID(),at:now(),code,
      channel_id:job.channel_id,source_message_id:job.source_message_id,
      detail:{archive_date:job.date,message_id:job.message_id,attempt:job.attempts,...detail}}); }
    catch { /* Diagnostics must not change download outcomes. */ }
  }
  function enqueue(db,date,messageId,message) {
    const items = message.attachments.filter(item => {
      try { return !!originalAttachmentUrl(item?.source_url); } catch { return false; }
    });
    if (!items.length) return;
    db.exec(`CREATE TABLE IF NOT EXISTS discord_web_attachment_jobs (
      message_id INTEGER NOT NULL, source_url TEXT NOT NULL,
      channel_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(message_id,source_url));
      CREATE INDEX IF NOT EXISTS ix_attachment_jobs_due
      ON discord_web_attachment_jobs(status,next_attempt_at);`);
    const stamp = new Date(now()).toISOString();
    for (const item of items) {
      const existing = db.prepare('SELECT status FROM discord_web_attachment_files WHERE message_id=? AND source_url=?')
        .get(messageId,item.source_url);
      if (existing?.status === 'saved') continue;
      db.prepare(`INSERT OR IGNORE INTO discord_web_attachment_jobs
        (message_id,source_url,channel_id,source_message_id,status,next_attempt_at,updated_at)
        VALUES (?,?,?,?,'pending',?,?)`)
        .run(messageId,item.source_url,message.channel_id,message.source_message_id,now(),stamp);
      const job = db.prepare('SELECT status FROM discord_web_attachment_jobs WHERE message_id=? AND source_url=?')
        .get(messageId,item.source_url);
      if (['pending','retry','downloading'].includes(job.status)) {
        db.prepare(`INSERT INTO discord_web_attachment_files(message_id,source_url,status,updated_at)
          VALUES (?,?,'pending',?) ON CONFLICT(message_id,source_url)
          DO UPDATE SET status='pending',error=NULL,updated_at=excluded.updated_at`)
          .run(messageId,item.source_url,stamp);
        dates.add(date);
      }
    }
  }
  function recover() {
    for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const file = fileFor(entry.name);
      if (!fs.existsSync(file)) continue;
      const db = new DatabaseSync(file);
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_web_attachment_jobs'").get()) continue;
        // An interrupted download is safe to retry: it cannot send a QQ message.
        db.prepare(`UPDATE discord_web_attachment_jobs SET status='retry',next_attempt_at=?
          WHERE status='downloading'`).run(now());
        if (db.prepare("SELECT 1 FROM discord_web_attachment_jobs WHERE status IN ('pending','retry') LIMIT 1").get()) dates.add(entry.name);
      } finally { db.close(); }
    }
  }
  function claim() {
    // Newer archive dates first; a failed old image must not monopolize workers.
    for (const date of [...dates].sort().reverse()) {
      const db = new DatabaseSync(fileFor(date));
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_web_attachment_jobs'").get()) {
          dates.delete(date);
          continue;
        }
        const job = db.prepare(`SELECT * FROM discord_web_attachment_jobs
          WHERE status IN ('pending','retry') AND next_attempt_at<=?
          ORDER BY attempts,message_id DESC LIMIT 1`).get(now());
        if (!job) {
          if (!db.prepare("SELECT 1 FROM discord_web_attachment_jobs WHERE status IN ('pending','retry','downloading') LIMIT 1").get()) dates.delete(date);
          continue;
        }
        db.prepare(`UPDATE discord_web_attachment_jobs SET status='downloading',attempts=attempts+1,updated_at=?
          WHERE message_id=? AND source_url=?`).run(new Date(now()).toISOString(),job.message_id,job.source_url);
        return {...job,date,attempts:job.attempts+1};
      } finally { db.close(); }
    }
  }
  async function download(job) {
    const began = now();
    let localPath = null, digest = null, failure = null;
    try {
      const response = await fetchImpl(originalAttachmentUrl(job.source_url),{signal:AbortSignal.timeout(timeoutMs)});
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') || 0) > 20_000_000) throw Error('image too large');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20_000_000) throw Error('image too large');
      digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const ext = path.extname(new URL(job.source_url).pathname).toLowerCase();
      const directory = path.join(root,job.date,'attachments');
      fs.mkdirSync(directory,{recursive:true});
      localPath = path.join(directory,digest+(['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)?ext:'.bin'));
      if (!fs.existsSync(localPath)) fs.writeFileSync(localPath,bytes);
    } catch (error) {
      // Do not put signed URLs, response bodies, or proxy credentials in logs.
      failure = /^(HTTP \d{3}|image too large)$/.test(error.message) ? error.message
        : /timeout|abort/i.test(error.name+' '+error.message) ? 'attachment download timeout'
        : 'attachment download failed';
    }
    const retry = failure && job.attempts < maxAttempts;
    const status = failure ? (retry?'retry':'failed') : 'saved';
    const nextAt = retry ? now()+retryDelays[Math.min(job.attempts-1,retryDelays.length-1)] : 0;
    const db = new DatabaseSync(fileFor(job.date));
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE discord_web_attachment_files SET local_path=?,sha256=?,status=?,error=?,updated_at=?
        WHERE message_id=? AND source_url=?`).run(localPath,digest,retry?'pending':status,failure,
          new Date(now()).toISOString(),job.message_id,job.source_url);
      db.prepare(`UPDATE discord_web_attachment_jobs SET status=?,next_attempt_at=?,updated_at=?
        WHERE message_id=? AND source_url=?`).run(status,nextAt,new Date(now()).toISOString(),job.message_id,job.source_url);
      db.exec('COMMIT');
    } finally { db.close(); }
    notify(failure ? (retry?'ATTACHMENT_DOWNLOAD_RETRY':'ATTACHMENT_DOWNLOAD_FAILED') : 'ATTACHMENT_DOWNLOAD_SAVED',job,
      {duration_ms:now()-began,next_attempt_at:nextAt || null,error_type:failure});
  }
  function wake() {
    if (!started || wakeup) return;
    wakeup = setImmediate(() => {
      wakeup = null;
      runOnce().catch(() => {
        // A transient SQLite error must not kill the collector or drop its jobs.
        console.error('Attachment worker could not process queued jobs; retrying.');
      });
    });
  }
  async function runOnce() {
    const batch = [];
    while (active.size < concurrency) {
      const job = claim();
      if (!job) break;
      const task = download(job).catch(error => {
        // Recover a failed database write on the next pass as well as on restart.
        const db = new DatabaseSync(fileFor(job.date));
        try { db.prepare(`UPDATE discord_web_attachment_jobs SET status='retry',next_attempt_at=?
          WHERE message_id=? AND source_url=? AND status='downloading'`).run(now()+30000,job.message_id,job.source_url); }
        finally { db.close(); }
        throw error;
      }).finally(() => {active.delete(task);wake();});
      active.add(task);
      batch.push(task);
    }
    return Promise.allSettled(batch);
  }
  function start() {
    if (started) return;
    recover();
    started = true;
    timer = setInterval(wake,1000);
    timer.unref();
    wake();
  }
  function stop() {
    started = false;
    clearInterval(timer);
    if (wakeup) clearImmediate(wakeup);
    wakeup = null;
    return Promise.allSettled([...active]);
  }
  return {enqueue,start,stop,wake,runOnce,recover};
}

module.exports = {createAttachmentQueue,originalAttachmentUrl};
