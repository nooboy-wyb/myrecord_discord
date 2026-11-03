const fs = require('node:fs');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const yanchi = require('../../qq_channels/yanchi/index.cjs');
const fengxun = require('../../qq_channels/fengxun/index.cjs');
const liuyudong = require('../../qq_channels/liuyudong/index.cjs');

function createManualRecovery({state,target,additionalChannelIds,additionalTargets,sourceFiles,sourceTime,
  replayMessages,processMessage,isOnline,isPaused,pauseGroup}) {
  if (!state.prepare('PRAGMA table_info(replay_requests)').all().some(column => column.name === 'cancel_requested')) {
    state.exec('ALTER TABLE replay_requests ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
  }
function recoveryTargets(channelId) {
  if (!/^\d+$/.test(channelId || '')) throw Error('无效频道');
  const groups = additionalChannelIds.has(channelId) ? []
    : [{number:'1',label:'群 1（主群）',openid:target.group_openid}];
  for (const route of additionalTargets()) {
    if (route.channel_ids.includes(channelId)) {
      groups.push({number:String(route.qq_group_number),label:`附加群（${route.qq_group_number}）`,openid:route.group_openid});
    }
  }
  if (!groups.length) throw Error('当前频道没有配置 QQ 群路由');
  return groups;
}
function recoveryCandidates(channelId, groupNumber, limit = 20) {
  const groups = recoveryTargets(channelId);
  const group = groups.find(item => item.number === String(groupNumber)) || groups[0];
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('每次最多预览 20 条');
  const byId = new Map();
  for (const file of sourceFiles()) {
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      for (const row of db.prepare(`SELECT id,channel_id,source_message_id,source_timestamp,captured_at,
        author_display,body_raw,attachments_json,content_sha256 FROM discord_web_messages WHERE channel_id=?`).all(channelId)) {
        const old = byId.get(row.source_message_id);
        if (old && old.captured_at >= row.captured_at) continue;
        const attachments = JSON.parse(row.attachments_json);
        const files = db.prepare('SELECT source_url,local_path,status FROM discord_web_attachment_files WHERE message_id=?').all(row.id);
        const missingImageHint = channelId === liuyudong.channelId && attachments.length === 0
          && /图(?:[一二三四五六七八九]|[1-9])/u.test(row.body_raw);
        const ready = !missingImageHint && attachments.every(image => {
          const saved = files.find(item => item.source_url === image.source_url);
          return saved?.status === 'saved' && saved.local_path && fs.existsSync(saved.local_path)
            && /\.(png|jpe?g)$/i.test(saved.local_path) && fs.statSync(saved.local_path).size <= 5_000_000;
        });
        byId.set(row.source_message_id,{...row,ready,missingImageHint,image_count:attachments.length});
      }
    } finally { db.close(); }
  }
  const attemptRows = state.prepare('SELECT source_message_id,status FROM forward_attempts WHERE group_openid=?').all(group.openid);
  const attempts = new Set(attemptRows.map(row => row.source_message_id));
  const uncertain = new Set(attemptRows.filter(row => row.status !== 'accepted').map(row => row.source_message_id));
  const queuedRows = state.prepare(`SELECT ri.source_message_id,ri.status AS item_status,rr.status AS request_status
    FROM replay_items ri JOIN replay_requests rr ON rr.id=ri.request_id
    WHERE rr.group_openid=? AND rr.channel_id=? AND rr.mode='manual' AND rr.status IN ('pending','processing','blocked')`)
    .all(group.openid,channelId);
  const queued = new Set(queuedRows.map(row => row.source_message_id));
  const duplicateSkips = new Set();
  if (channelId === fengxun.channelId || channelId === yanchi.fanwanChannelId) {
    const table = channelId === fengxun.channelId ? 'fengxun_duplicate_skips' : 'yanchi_alert_duplicate_skips';
    const findSkip = state.prepare(`SELECT 1 FROM ${table} WHERE task_key=?`);
    for (const row of byId.values()) {
      const key = crypto.createHash('sha256').update(JSON.stringify([
        group.openid,channelId,row.source_message_id,row.content_sha256])).digest('hex');
      if (findSkip.get(key)) duplicateSkips.add(row.source_message_id);
    }
  }
  const unsent = [...byId.values()].filter(row => !attempts.has(row.source_message_id)
    && !queued.has(row.source_message_id) && !duplicateSkips.has(row.source_message_id))
    .sort((a,b) => sourceTime(b)-sourceTime(a) || String(b.source_message_id).localeCompare(String(a.source_message_id)));
  const items = unsent.slice(0,limit).reverse().map(row => ({
    id:row.source_message_id,hash:row.content_sha256,time:row.source_timestamp,
    author:row.author_display,excerpt:row.body_raw.slice(0,120),image_count:row.image_count,
    ready:row.ready,missing_image_hint:row.missingImageHint
  }));
  return {channel_id:channelId,groups:groups.map(({number,label})=>({number,label})),group:group.number,
    total_unsent:unsent.length,uncertain_count:[...byId.keys()].filter(id => uncertain.has(id)).length,
    duplicate_skipped_count:duplicateSkips.size,
    queued_count:[...byId.keys()].filter(id => queuedRows.some(row => row.source_message_id === id
      && row.request_status !== 'blocked' && row.item_status === 'pending')).length,
    blocked_count:[...byId.keys()].filter(id => queuedRows.some(row => row.source_message_id === id
      && row.request_status === 'blocked' && ['pending','unknown'].includes(row.item_status))).length,items};
}
function queueRecovery(channelId, groupNumber, selected) {
  if (!isOnline()) throw Error('QQ Gateway 未连接，不能提交补发');
  const groups = recoveryTargets(channelId);
  const group = groups.find(item => item.number === String(groupNumber));
  if (!group) throw Error('当前频道没有该群的路由');
  if (isPaused(group.openid)) {
    throw Error('目标群转发已暂停，请先检查常驻窗口');
  }
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 20
    || selected.some(item => !/^\d+$/.test(item?.id || '') || !/^[a-f0-9]{64}$/.test(item?.hash || ''))
    || new Set(selected.map(item => item.id)).size !== selected.length) throw Error('请选择 1 到 20 条有效消息');
  const preview = recoveryCandidates(channelId,groupNumber,20);
  const available = new Map(preview.items.map(item => [item.id,item]));
  for (const item of selected) {
    const current = available.get(item.id);
    if (!current || current.hash !== item.hash || !current.ready) throw Error(`消息 ${item.id} 已变化、缺少原图或已有发送记录，请重新预览`);
  }
  state.exec('BEGIN IMMEDIATE');
  try {
    if (state.prepare(`SELECT id FROM replay_requests WHERE group_openid=? AND channel_id=? AND mode='manual'
      AND status IN ('pending','processing','blocked') LIMIT 1`).get(group.openid,channelId)) throw Error('该群和频道已有待处理的手动补发');
    const result = state.prepare(`INSERT INTO replay_requests(channel_id,message_limit,status,created_at,group_openid,mode)
      VALUES (?,?,'pending',?,?,'manual')`).run(channelId,selected.length,new Date().toISOString(),group.openid);
    for (const item of selected) {
      const current = available.get(item.id);
      state.prepare(`INSERT INTO replay_items(request_id,source_message_id,content_sha256,channel_id,source_timestamp,status)
        VALUES (?,?,?,?,?,'pending')`).run(result.lastInsertRowid,item.id,item.hash,channelId,current.time);
    }
    state.exec('COMMIT');
    return {request_id:Number(result.lastInsertRowid),count:selected.length};
  } catch (error) { state.exec('ROLLBACK'); throw error; }
}
function recoveryStatus(requestId) {
  if (!Number.isInteger(requestId) || requestId < 1) throw Error('无效请求编号');
  const request = state.prepare("SELECT id,channel_id,status,message_limit,created_at,completed_at,cancel_requested FROM replay_requests WHERE id=? AND mode='manual'")
    .get(requestId);
  if (!request) throw Error('补发请求不存在');
  const items = state.prepare('SELECT source_message_id,status FROM replay_items WHERE request_id=? ORDER BY source_timestamp,source_message_id')
    .all(requestId);
  return {request,items};
}
function cancelRecovery(channelId, groupNumber) {
  const groups = recoveryTargets(channelId);
  const group = groupNumber ? groups.find(item => item.number === String(groupNumber)) : groups[0];
  if (!group) throw Error('当前频道没有该群的路由');
  state.exec('BEGIN IMMEDIATE');
  try {
    const request = state.prepare(`SELECT id,status FROM replay_requests WHERE group_openid=? AND channel_id=?
      AND mode='manual' AND status IN ('pending','processing','blocked') ORDER BY id DESC LIMIT 1`)
      .get(group.openid,channelId);
    if (!request) { state.exec('COMMIT'); return {found:false,message:'当前频道没有待取消的手动补发'}; }
    if (request.status === 'processing') {
      state.prepare('UPDATE replay_requests SET cancel_requested=1 WHERE id=?').run(request.id);
      state.exec('COMMIT');
      return {found:true,request_id:request.id,status:'cancelling'};
    }
    state.prepare("UPDATE replay_requests SET status='cancelled',cancel_requested=1,completed_at=? WHERE id=?")
      .run(new Date().toISOString(),request.id);
    state.prepare("UPDATE replay_items SET status='cancelled' WHERE request_id=? AND status='pending'").run(request.id);
    state.exec('COMMIT');
    return {found:true,request_id:request.id,status:'cancelled'};
  } catch (error) { state.exec('ROLLBACK'); throw error; }
}
function cancelRequested(requestId) {
  return state.prepare('SELECT cancel_requested FROM replay_requests WHERE id=?').get(requestId)?.cancel_requested === 1;
}
async function processNext() {
  const request = state.prepare("SELECT * FROM replay_requests WHERE status IN ('pending','processing') AND mode='manual' ORDER BY id LIMIT 1").get();
  if (!request || isPaused(request.group_openid)) return;
  if (cancelRequested(request.id)) {
    state.prepare("UPDATE replay_items SET status='cancelled' WHERE request_id=? AND status='pending'").run(request.id);
    state.prepare("UPDATE replay_requests SET status='cancelled',completed_at=? WHERE id=?")
      .run(new Date().toISOString(),request.id);
    return;
  }
  state.prepare("UPDATE replay_requests SET status='processing' WHERE id=?").run(request.id);
  let blocked = false;
  try {
    for (const message of replayMessages(request)) {
      if (cancelRequested(request.id)) break;
      const item = state.prepare('SELECT status FROM replay_items WHERE request_id=? AND source_message_id=?')
        .get(request.id,message.source_message_id);
      if (item?.status !== 'pending') continue;
      const previous = state.prepare('SELECT status,replay_request_id FROM forward_attempts WHERE group_openid=? AND source_message_id=? LIMIT 1')
        .get(request.group_openid,message.source_message_id);
      if (previous?.replay_request_id === request.id) {
        state.prepare('UPDATE replay_items SET status=? WHERE request_id=? AND source_message_id=?')
          .run('unknown',request.id,message.source_message_id);
        blocked = true;
        break;
      }
      if (previous) {
        state.prepare('UPDATE replay_items SET status=? WHERE request_id=? AND source_message_id=?')
          .run('already_attempted',request.id,message.source_message_id);
        continue;
      }
      const outcome = await processMessage(message,{group_openid:request.group_openid,history:true,replayRequestId:request.id});
      state.prepare('UPDATE replay_items SET status=? WHERE request_id=? AND source_message_id=?')
        .run(outcome,request.id,message.source_message_id);
      if (outcome === 'unknown') { blocked = true; break; }
    }
  } catch (error) {
    blocked = true;
    pauseGroup(request.group_openid);
    console.error(`手动补发请求 ${request.id} 已阻止：${error.message}`);
  }
  if (blocked) {
    state.prepare("UPDATE replay_requests SET status='blocked' WHERE id=?").run(request.id);
  } else if (cancelRequested(request.id)) {
    state.prepare("UPDATE replay_items SET status='cancelled' WHERE request_id=? AND status='pending'").run(request.id);
    state.prepare("UPDATE replay_requests SET status='cancelled',completed_at=? WHERE id=?")
      .run(new Date().toISOString(),request.id);
  } else {
    state.prepare("UPDATE replay_requests SET status='complete',completed_at=? WHERE id=?")
      .run(new Date().toISOString(),request.id);
  }
}

  return {recoveryCandidates,queueRecovery,recoveryStatus,cancelRecovery,processNext};
}
module.exports = {createManualRecovery};
