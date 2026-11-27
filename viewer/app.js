(() => {
  'use strict';
  const paths = {
    grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    discord:'<path d="M8 5 5 6C3 9 2 13 3 17l4 2 1-2m8-12 3 1c2 3 3 7 2 11l-4 2-1-2M7 16c3 2 7 2 10 0M8 5c2 1 6 1 8 0"/><circle cx="8.5" cy="12" r="1"/><circle cx="15.5" cy="12" r="1"/>',
    telegram:'<path d="m21 3-5 18-5-7-8-4 18-7ZM11 14l10-11M11 14l-1 6 4-3"/>',
    send:'<path d="m21 3-6 18-4-8-8-4 18-6ZM11 13l5-5"/>',
    activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    shield:'<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    monitor:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m-5 0h5v5"/>',
    flask:'<path d="M9 3h6m-5 0v7L4 20h16l-6-10V3M7 15h10"/>',
    'arrow-right':'<path d="M4 12h16m-5-5 5 5-5 5"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    layers:'<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-5-5-8 10m-5-6 4-4 4 4"/>',
    'image-off':'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m4 4 16 16m0-4-4-5-3 4M4 16l4-4"/>',
    alert:'<path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v1"/>',
    link:'<path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M7 10l-2 2a5 5 0 0 0 7 7l2-2M8 16l8-8"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    file:'<path d="M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 12h8m-8 4h8"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    inbox:'<path d="M3 14 6 4h12l3 10v6H3v-6Zm0 0h5l2 3h4l2-3h5"/>',
    database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const data = window.MUSE_VIEWER || window.MUSE_DEMO;
  const live = Boolean(data.live);
  const allRecords = () => live ? [...data.messages,...data.queue] : data.messages;
  const state = {view:'overview',search:'',status:'all',group:'all',selected:null,detailTab:'content',simulated:0};
  const labels = {overview:['实时总览','从采集原文到 QQ 回执，每一步都看得见。','三路消息动态','落盘内容与发送记录'],discord:['DC 采集','查看 Discord 采集原文、图片与入库记录。','Discord 内容','按首次入库展示'],telegram:['TG 采集','按频道与话题，核对 Telegram 原文和归档图片。','Telegram 内容','频道 / 话题 / 相册'],queue:['QQ 发送队列','查看准备发送的内容、分段结果与接口回执。','发送任务','实时与历史补发'],connections:['连接与异常','把页面扫描、来源采集和发送连接分开查看。','连接状态','下列状态均为演示']};
  const statusLabels = {accepted:'接口已接受',queued:'待调度',deferred:'已延后',unknown:'结果未知',archived:'已归档',recorded:'分段已记录',processing:'发送中',skipped_duplicate:'去重跳过',skipped_attachment:'附件跳过',blocked_source:'来源已阻止'};
  const badge = (status, text) => `<span class="status ${escape(status)}">${icon(status === 'accepted' ? 'check' : status === 'unknown' ? 'alert' : 'clock')}${escape(text || statusLabels[status] || status)}</span>`;
  const sourceIcon = source => `<span class="source-icon ${source}">${icon(source === 'qq' ? 'send' : source)}</span>`;
  const sourceName = source => source === 'telegram' ? 'Telegram' : 'Discord';
  let toastTimer, previousFocus;

  function notify(message) {
    const el = $('#toast'); el.textContent = message; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function filtered() {
    const query = state.search.trim().toLocaleLowerCase();
    return (live && state.view === 'queue' ? data.queue : data.messages).filter(m => {
      if (query && ![m.body,m.channel,m.author,m.messageId,m.group,m.qqBody].join(' ').toLocaleLowerCase().includes(query)) return false;
      if (state.status === 'attention' && !['deferred','unknown'].includes(m.status)) return false;
      if (state.status === 'pending' && !['queued','deferred'].includes(m.status)) return false;
      if (state.status === 'accepted' && m.status !== 'accepted') return false;
      if (state.status === 'image' && !m.images.length) return false;
      if (state.view === 'queue' && state.group !== 'all' && m.group !== state.group) return false;
      return true;
    });
  }
  function renderMetrics() {
    const rows = data.messages;
    const queue = live ? data.queue : rows;
    const pending = live ? (data.queueCounts || []).filter(item=>['queued','deferred','processing'].includes(item.status)).reduce((total,item)=>total+item.count,0) : queue.filter(m=>['queued','deferred'].includes(m.status)).length;
    const accepted = live ? (data.queueCounts || []).find(item=>item.status==='accepted')?.count || 0 : queue.filter(m=>m.status==='accepted').length;
    const attention = queue.filter(m => ['deferred','unknown'].includes(m.status)).length;
    const metrics = [
      {name:live?'当前归档窗口':'已归档消息',value:rows.length,unit:'条',icon:'layers',foot:`DC ${rows.filter(m=>m.source==='discord').length} 条 · TG ${rows.filter(m=>m.source==='telegram').length} 条`,type:'archive'},
      {name:'QQ 接口已接受',value:accepted,unit:'条',icon:'check',foot:'已接受 ≠ 终端已送达',type:'sent'},
      {name:'待处理任务',value:pending,unit:'条',icon:'clock',foot:'包含待调度与等待原图',type:'pending'},
      {name:'窗口内需关注',value:attention,unit:'项',icon:'alert',foot:'延后与结果未知任务',type:'alert'}
    ];
    $('#metrics').innerHTML = metrics.map((m,index) => `<article class="metric ${m.type}"><div class="metric-head"><span>${m.name}</span><span class="metric-icon">${icon(m.icon)}</span></div><div class="metric-value">${m.value}<small>${m.unit}</small></div><div class="metric-foot">${index<2?'<span class="mini-dot"></span>':''}${escape(m.foot)}</div>${index===0?'<div class="spark" aria-hidden="true">'+[8,14,10,19,16,23,19,27].map(h=>`<i style="height:${h}px"></i>`).join('')+'</div>':''}</article>`).join('');
    $('#dc-count').textContent = rows.filter(m=>m.source==='discord').length;
    $('#tg-count').textContent = rows.filter(m=>m.source==='telegram').length;
    $('#queue-count').textContent = pending;
  }
  function imageMarkup(message, detail = false) {
    if (!message.images.length) return '';
    const saved = message.images.filter(i=>i.status==='saved');
    const unavailable = message.images.filter(i=>i.status!=='saved');
    return (saved.length ? `<div class="image-grid ${saved.length===1?'one':''}">${saved.map((img,i)=>`<button class="image-thumb" data-image="${escape(img.id)}" aria-label="放大${live?'归档':'演示'}图片：${escape(img.name)}"><img src="${escape(img.url)}" alt="${escape(img.name)}" loading="lazy"><span class="image-overlay">${detail?escape(img.size):`${i+1} / ${message.images.length}`} · ${live?'归档原图':'演示'}</span></button>`).join('')}</div>`:'') + unavailable.map(img=>`<div class="image-failed">${icon('image-off')}<div>${img.status==='failed'?'图片下载异常':'图片下载中'}<br><small>${escape(img.error||'等待采集端完成下载')}</small></div></div>`).join('');
  }
  function messageCard(m, qq = false, full = false) {
    const saved = m.images.filter(i=>i.status==='saved').length;
    return `<article class="message-card ${qq?'qq-card':''}">${full?`<div class="list-card-source">${sourceIcon(m.source)}<span>${sourceName(m.source)}</span><span>版本 ${m.version}</span></div>`:''}<div class="message-meta"><span class="channel-name">${escape(m.channel)}</span><time class="channel-time">${escape(qq?(m.acceptedTime||m.attemptTime||m.enqueuedTime||m.capturedTime):m.capturedTime)}</time></div>${qq?`<div class="qq-target">${icon('send')}${escape(m.group)}<span>·</span>${escape(m.origin)}</div>`:''}<p class="message-body">${escape(qq?(m.qqBody||m.body):m.body)}</p>${qq?(m.images.length?`<div class="mini-attachment">${icon('image')}${m.images.length} 张图片 · ${saved===m.images.length?'原图已归档':'附件未就绪'}</div>`:''):imageMarkup(m)}<div class="message-bottom">${qq?badge(m.status):badge(saved===m.images.length?'accepted':'deferred',m.images.length?`原图 ${saved}/${m.images.length}`:'正文已入库')}<span class="message-micro">${qq?(m.totalSeconds?`全链路 ${m.totalSeconds} 秒`:escape(m.status==='unknown'?'已隔离，禁止自动重发':'任务状态已落盘')):`原消息 ${escape(m.sourceTime)}${m.captureSeconds?` · 采集 ${m.captureSeconds}s`:''}`}</span><span class="message-arrow">${icon('arrow-right')}</span></div><button class="message-hit" data-message="${escape(m.id)}" data-open-tab="${qq?'parts':'content'}" aria-label="查看${escape(m.channel)}消息详情"></button></article>`;
  }
  const emptyMarkup = () => `<div class="empty">${icon('inbox')}<strong>没有符合条件的记录</strong><span>调整搜索关键词或筛选条件后重试</span></div>`;
  function stream(source, rows) {
    const isQQ = source === 'qq';
    const messages = isQQ ? (live ? data.queue : rows).slice(0,4) : rows.filter(m=>m.source===source).slice(0,3);
    const title = isQQ ? 'QQ 发送' : source === 'discord' ? 'DC 采集' : 'TG 采集';
    return `<section class="stream"><div class="stream-heading">${sourceIcon(source)}<div><h3>${title}</h3><p>${isQQ?live?'队列快照 / 实际分段回执':'准备发送 / 分段与回执':'已落盘的正文与原图'}</p></div><span class="stream-live">${live?'远端落盘':'演示视图'}</span></div><div class="stream-body">${messages.length?messages.map(m=>messageCard(m,isQQ)).join(''):emptyMarkup()}</div><button class="stream-footer" data-navigate="${isQQ?'queue':source}">查看全部${isQQ?'发送记录':'采集内容'}${icon('arrow-right')}</button></section>`;
  }
  function renderOverview(rows) {
    const issues = (live ? data.queue : rows).filter(m=>['deferred','unknown'].includes(m.status));
    return `<div class="streams">${['discord','telegram','qq'].map(s=>stream(s,rows)).join('')}</div><section class="attention-section"><div class="attention-heading"><h2>需要关注</h2><span class="attention-count">${issues.length}</span></div>${issues.length?`<div class="attention-list">${issues.map(m=>`<button class="attention-item" data-message="${escape(m.id)}" data-open-tab="trace"><span class="attention-symbol ${m.status==='unknown'?'red':''}">${icon(m.status==='unknown'?'alert':'image-off')}</span><span class="attention-text"><strong>${m.status==='unknown'?'发送结果未知':'图片尚未就绪'}</strong>${escape(m.channel)} · ${escape(m.reason)}</span><time class="attention-date">${escape(m.attemptTime||m.capturedTime)}</time>${icon('chevron')}</button>`).join('')}</div>`:`<div class="attention-list"><div class="empty" style="min-height:85px">当前筛选范围内没有异常记录</div></div>`}</section>`;
  }
  function renderQueue(rows) {
    if (!rows.length) return emptyMarkup();
    const priority = {unknown:0,deferred:1,queued:2,processing:2,accepted:3};
    const sorted = [...rows].sort((a,b)=>(priority[a.status] ?? 4)-(priority[b.status] ?? 4));
    if (live) return `<div class="table-container"><table class="queue-table"><thead><tr><th>来源 / 频道</th><th>队列正文快照</th><th>目标群</th><th>状态</th><th>队列尝试计数</th><th>操作</th></tr></thead><tbody>${sorted.map(message=>`<tr><td><div class="queue-source">${sourceIcon(message.source)}<div><strong>${escape(message.channel)}</strong><small>${escape(message.sourceTime||'未记录')} · ${escape(message.origin)}</small></div></div></td><td><button class="queue-preview" data-message="${escape(message.id)}" data-open-tab="parts"><strong>${escape(message.qqBody||message.body)}</strong><span>${message.images.length} 张归档图片 · 正文快照，非当次发送正文</span></button></td><td>${escape(message.group)}</td><td>${badge(message.status)}</td><td>${escape(message.attempts ?? '历史未记录')}</td><td><button class="text-button" data-message="${escape(message.id)}" data-open-tab="trace">追踪</button></td></tr>`).join('')}</tbody></table></div><p class="queue-note">真实队列与近期分段记录。QQ 正文是来源或队列快照；实际分段结果见详情，接口接受不代表群内送达。</p>`;
    return `<div class="table-container"><table class="queue-table"><thead><tr><th>来源 / 频道</th><th>发送内容</th><th>目标群</th><th>状态</th><th>尝试</th><th>操作</th></tr></thead><tbody>${sorted.map(m=>`<tr><td><div class="queue-source">${sourceIcon(m.source)}<div><strong>${escape(m.channel.split(' · ')[0])}</strong><small>${escape(m.sourceTime)} · ${escape(m.origin)}</small></div></div></td><td><button class="queue-preview" data-message="${escape(m.id)}" data-open-tab="parts"><strong>${escape(m.qqBody||m.body)}</strong><span>${icon(m.images.length?'image':'file')}${m.images.length?m.images.length+' 张图片 · ':''}${escape(m.channel)}</span></button></td><td>${escape(m.group)}</td><td>${badge(m.status)}</td><td class="num">${m.attempts} 次</td><td><button class="text-button" data-message="${escape(m.id)}" data-open-tab="trace">追踪${icon('arrow-right')}</button></td></tr>`).join('')}</tbody></table></div><p class="queue-note">演示记录包含实时任务与历史补发。接口接受只表示 QQ API 返回回执。</p>`;
  }
  function renderConnections() {
    if (live) return renderLiveConnections();
    const cards = [
      {source:'discord',name:'Discord 采集',rows:[['页面扫描','8 / 8 正常'],['最近扫描','14:27:58'],['最近入库','14:24:17'],['磁盘扩展版本','0.2.64']],note:'无新消息不等于采集离线；以页面扫描为准。'},
      {source:'telegram',name:'Telegram 采集',rows:[['来源扫描','3 / 3 已完成'],['最近成功扫描','14:27:55'],['当前阶段','等待下一轮'],['最近入库','14:25:53']],note:'展示每来源扫描进度，不把文件存在当作存活。'},
      {source:'qq',name:'QQ 发送连接',rows:[['Gateway','在线'],['最近心跳 ACK','14:27:59'],['最近调度','14:27:56'],['详细断线诊断','旧版本未记录']],note:'接口接受、Gateway ACK 与群内送达分别展示。'}
    ];
    const events = [
      ['14:27:59','QQ','心跳已确认，连接保持响应。','ok'],['14:27:55','TG','本轮三个来源扫描完成，等待下一轮。','ok'],['14:27:54','QQ','盘中状态更新的两个分段已获得接口回执。','ok'],['14:22:25','DC','原图下载超时，发送器等待附件就绪。','warn'],['14:16:22','QQ','历史补发请求结果未知，该条已隔离。','error']
    ];
    return `<div class="connection-grid">${cards.map(c=>`<article class="connection-card"><div class="connection-header">${sourceIcon(c.source)}<h3>${c.name}</h3>${badge('accepted','演示在线')}</div><dl class="connection-dl">${c.rows.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl><p class="connection-note">${c.note}</p></article>`).join('')}</div><div class="attention-heading"><h2>最近事件</h2><span class="soft-label">演示时间线</span></div><div class="event-log">${events.map(([time,source,text,type])=>`<div class="event-row"><time class="event-time">${time}</time><span class="event-dot ${type}"></span><div class="event-text"><strong>${source}</strong>${text}</div></div>`).join('')}</div>`;
  }
  function renderLiveConnections() {
    const health = data.connections || {};
    const asTime = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '当前版本未提供';
    const dc = health.discord || {}, tg = health.telegram || {}, qq = health.qq || {};
    const cards = [
      {source:'discord',name:'Discord 采集',status:dc.reachable?'接口可达':'接口不可达',rows:[['最近入库',data.messages.find(m=>m.source==='discord')?.capturedTime||'未读取'],['状态采样',asTime(data.sourceSamples?.discord?.at)],['页面状态',JSON.stringify(dc.pages||{})]],note:'接口可达不等于所有采集页面都在工作；页面上报见上方。'},
      {source:'telegram',name:'Telegram 采集',status:tg.stale?'状态陈旧':'状态文件已更新',rows:[['采集阶段',tg.phase||'未知'],['状态时间',asTime(tg.at)],['本轮完成',asTime(tg.round_finished_at)],['各来源',JSON.stringify((tg.sources||[]).map(s=>({id:s.peer_id,status:s.status,finished:s.finished_at}))) ]],note:'来自采集进程状态文件；超过 90 秒未更新会标记陈旧。'},
      {source:'qq',name:'QQ 发送连接',status:qq.reachable?qq.online?'Gateway 在线':'Gateway 离线':'接口不可达',rows:[['发送循环',qq.running?'正在处理':'空闲 / 等待下一轮'],['最近心跳 ACK','当前版本未提供'],['规划器状态',JSON.stringify(qq.planners||{})]],note:'健康接口返回的 online 状态；当前未接入心跳与断线日志。'}
    ];
    const replays = data.replays || [];
    return `<div class="connection-grid">${cards.map(card=>`<article class="connection-card"><div class="connection-header">${sourceIcon(card.source)}<h3>${card.name}</h3></div><p>${escape(card.status)}</p><dl class="connection-dl">${card.rows.map(([key,value])=>`<div><dt>${escape(key)}</dt><dd style="overflow-wrap:anywhere;max-width:70%">${escape(value)}</dd></div>`).join('')}</dl><p class="connection-note">${escape(card.note)}</p></article>`).join('')}</div><div class="attention-heading"><h2>最近历史补发请求</h2><span class="soft-label">实际落盘记录，最多 20 条</span></div><div class="event-log">${replays.map(request=>`<div class="event-row"><time>${escape(asTime(request.created_at))}</time><div class="event-text">#${escape(request.id)} · ${escape(request.status)} · ${escape(asTime(request.completed_at))}</div></div>`).join('')||'<p>暂无可读取的补发请求。</p>'}</div>`;
  }
  function render() {
    const config = labels[state.view];
    document.title = `Muse · ${config[0]}`;
    $('#breadcrumb-current').textContent = config[0]; $('#page-title').textContent = config[0]; $('#page-description').textContent = config[1];
    $('#section-title').textContent = config[2]; $('#section-label').textContent = live ? state.view==='queue'?'最多 100 条近期 + 100 条待发任务，另含近期分段':state.view==='connections'?'实际接口 / 状态文件':'每来源最近 100 条，DC 限今昨归档日' : config[3];
    $('#group-filter').hidden = state.view !== 'queue';
    $('.filter-controls').hidden = state.view === 'connections';
    document.querySelectorAll('[data-view]').forEach(a => {
      const active = a.dataset.view === state.view; a.classList.toggle('active',active);
      if(active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    });
    renderMetrics();
    const rows = filtered();
    $('#view-content').innerHTML = state.view === 'overview' ? renderOverview(rows) : state.view === 'queue' ? renderQueue(rows) : state.view === 'connections' ? renderConnections() : rows.some(m=>m.source===state.view)?`<div class="source-list">${rows.filter(m=>m.source===state.view).map(m=>messageCard(m,false,true)).join('')}</div>`:emptyMarkup();
  }
  function navigate(view) {
    if(!labels[view]) view='overview';
    state.view=view;
    if(location.hash !== '#'+view) history.replaceState(null,'','#'+view);
    render();
  }
  function renderDetail() {
    const m = allRecords().find(row=>row.id===state.selected); if(!m) return;
    if (live) {renderLiveDetail(m);return;}
    $('#detail-heading').innerHTML = `<div class="drawer-title-meta">${sourceIcon(m.source)}<span>${sourceName(m.source)} · 消息详情</span>${badge(m.status)}</div><h2 id="detail-title">${escape(m.channel)}</h2><div class="detail-id"><code>${escape(m.messageId)}</code><span>·</span><span>版本 ${m.version} · 演示</span></div>`;
    document.querySelectorAll('[data-detail-tab]').forEach(tab=>{const active=tab.dataset.detailTab===state.detailTab;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    $('#detail-content').setAttribute('aria-labelledby',`tab-${state.detailTab}`);
    if(state.detailTab==='content') {
      $('#detail-content').innerHTML = `<dl class="detail-dl"><div><dt>消息作者</dt><dd>${escape(m.author)}</dd></div><div><dt>目标 QQ 群</dt><dd>${escape(m.group)}</dd></div><div><dt>原消息时间（北京时间）</dt><dd>${escape(m.sourceTime)}</dd></div><div><dt>首次入库</dt><dd>${escape(m.capturedTime)}</dd></div></dl><section class="detail-section"><h3>原始正文<button class="text-button" id="copy-body" style="margin-left:auto">${icon('copy')}复制正文</button></h3><div class="full-body">${escape(m.body)}</div></section><section class="detail-section"><h3>归档图片<span class="soft-label">${m.images.filter(i=>i.status==='saved').length} / ${m.images.length} 已保存</span></h3>${m.images.length?imageMarkup(m,true):'<p class="detail-hint">这条消息没有附带图片。</p>'}<p class="detail-hint">当前图片为本地演示素材。接入后将按需读取远端归档原图。</p></section><div class="detail-warning">${icon('flask')}这是一条用于交互预览的构造消息，不代表真实采集或发送结果。</div>`;
    } else if(state.detailTab==='trace') {
      const stages = [
        {label:'源消息发布',time:m.sourceTime,note:'来源平台提供的消息时间'},
        {label:'首次入库',time:m.capturedTime,note:m.captureSeconds?`采集耗时 ${m.captureSeconds} 秒 · 正文已落盘`:'正文已保存到归档'},
        {label:'首次进入发送队列',time:m.enqueuedTime,note:m.enqueuedTime?'演示的不可变入队时间':'历史未记录，不能用状态更新时间替代'},
        {label:'开始发送尝试',time:m.attemptTime,note:m.attemptTime?`第 ${m.attempts} 次尝试 · ${m.group}`:'尚未开始发送'},
        {label:'QQ 接口接受',time:m.acceptedTime,note:m.acceptedTime?'必需分段均已接受；不代表终端已送达':m.reason||'等待发送结果'}
      ];
      $('#detail-content').innerHTML=`<div class="trace-summary"><div><span>${m.totalSeconds?'源消息 → 接口接受':'当前处理状态'}</span><strong>${m.totalSeconds?m.totalSeconds+'<small>秒</small>':escape(statusLabels[m.status])}</strong></div><span>${m.captureSeconds?`采集 ${m.captureSeconds}s<br>入库到接受 ${m.sendSeconds}s`:'尚无完整耗时'}</span></div><ol class="timeline">${stages.map(s=>`<li class="${s.time?'':s.label.includes('入队')?'missing':'pending'}"><div class="stage"><span>${s.label}</span><time>${escape(s.time||'未记录 / 待发生')}</time></div><p>${escape(s.note)}</p></li>`).join('')}</ol>${m.reason?`<div class="detail-warning">${icon('alert')}<div>${escape(m.reason)}${m.nextAttempt?`<br>演示下次尝试：${escape(m.nextAttempt)}`:''}</div></div>`:''}<p class="detail-hint" style="margin-top:22px">时间线为演示数据。正式接入后，未保存的历史阶段将显示“历史未记录”。</p>`;
    } else {
      const parts=[{type:'text',text:m.qqBody||m.body},...m.images.map(img=>({type:'image',image:img}))];
      $('#detail-content').innerHTML=`<dl class="detail-dl"><div><dt>目标群</dt><dd>${escape(m.group)}</dd></div><div><dt>任务类型</dt><dd>${escape(m.origin)}</dd></div><div><dt>发送尝试</dt><dd>${m.attempts} 次</dd></div><div><dt>当前状态</dt><dd>${escape(statusLabels[m.status])}</dd></div></dl><p class="detail-hint" style="margin-bottom:20px">以下展示拟议的实际发送内容布局。所有正文、分段与回执均为演示。</p>${parts.map((part,i)=>`<section class="send-part"><div class="part-top"><span class="part-number">${i+1}</span>${part.type==='text'?'文字分段':'图片分段'}<span>· ${i+1} / ${parts.length}</span>${badge(m.status)}</div>${part.type==='text'?`<div class="full-body">${escape(part.text)}</div>`:imageMarkup({...m,images:[part.image]},true)}${m.status==='accepted'?`<div class="part-receipt">演示回执 ID：demo_qq_${escape(m.id)}_${i+1}</div>`:''}</section>`).join('')}${m.status==='unknown'?`<div class="detail-warning">${icon('alert')}发送结果未知已隔离。这里不提供自动重发按钮。</div>`:''}`;
    }
  }
  function renderLiveDetail(m) {
    $('#detail-heading').innerHTML = `<div class="drawer-title-meta">${sourceIcon(m.source)}<span>${sourceName(m.source)} · 远端记录</span>${badge(m.status)}</div><h2 id="detail-title">${escape(m.channel)}</h2><div class="detail-id"><code>${escape(m.messageId)}</code><span>版本 ${escape(m.version || '未知')}</span></div>`;
    document.querySelectorAll('[data-detail-tab]').forEach(tab=>{const active=tab.dataset.detailTab===state.detailTab;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    $('#detail-content').setAttribute('aria-labelledby',`tab-${state.detailTab}`);
    if (state.detailTab === 'content') {
      $('#detail-content').innerHTML = `<dl class="detail-dl"><div><dt>作者</dt><dd>${escape(m.author)}</dd></div><div><dt>原消息时间（北京）</dt><dd>${escape(m.sourceTime||'未记录')}</dd></div><div><dt>首次入库（当前查询范围）</dt><dd>${escape(m.capturedTime||'未记录')}</dd></div></dl><section class="detail-section"><h3>归档原文<button class="text-button" id="copy-body">${icon('copy')}复制</button></h3><div class="full-body">${escape(m.body)}</div></section><section class="detail-section"><h3>归档图片 ${m.images.filter(image=>image.status==='saved').length} / ${m.images.length}</h3>${imageMarkup(m,true)}<p class="detail-hint">直接读取远端落盘文件；存在性已检查，未在每轮刷新重算哈希。附件清单完整不代表源平台绝无漏采。</p></section>${m.deliveries?.length?`<section class="detail-section"><h3>已关联的发送任务</h3>${m.deliveries.map(task=>`<p>${escape(task.group)} · ${badge(task.status)} <button class="text-button" data-message="qq:${escape(task.taskKey)}" data-open-tab="parts">查看记录</button></p>`).join('')}</section>`:`<p class="detail-hint">${escape(m.reason)}</p>`}`;
    } else if (state.detailTab === 'trace') {
      const stages = [['原消息发布',m.sourceTime,'来源平台时间'],['首次入库（当前查询范围）',m.capturedTime,m.captureSeconds!=null?`采集 ${m.captureSeconds} 秒`:'未保存入库时间'],['首次入队',null,'历史未记录，不能用状态更新时间替代'],['请求开始',null,'历史未记录；分段时间是结果写入时间'],['整条 QQ 接口接受',m.acceptedTime,m.acceptedTime?'队列 accepted 且已记录分段均 accepted；不代表群内送达':'尚无完整接受依据']];
      $('#detail-content').innerHTML = `<ol class="timeline">${stages.map(([label,time,note])=>`<li class="${time?'':'missing'}"><div class="stage"><span>${escape(label)}</span><time>${escape(time||'未记录 / 未完成')}</time></div><p>${escape(note)}</p></li>`).join('')}</ol><p class="detail-hint">${m.totalSeconds!=null?`源消息到接受 ${m.totalSeconds} 秒，入库到接受 ${m.sendSeconds ?? '未记录'} 秒。`:''}状态更新时间：${escape(m.updatedTime||'未记录')}；下次重试：${escape(m.nextAttempt||'未记录')}。</p><div class="detail-warning">${escape(m.reason)}</div>`;
    } else {
      $('#detail-content').innerHTML = `<dl class="detail-dl"><div><dt>目标群</dt><dd>${escape(m.group)}</dd></div><div><dt>类型 / 状态</dt><dd>${escape(m.origin)} / ${escape(statusLabels[m.status]||m.status)}</dd></div><div><dt>队列尝试计数</dt><dd>${escape(m.attempts ?? '历史未记录')}</dd></div></dl><section class="detail-section"><h3>来源 / 队列正文快照</h3><div class="full-body">${escape(m.qqBody||m.body)}</div><p class="detail-hint">用于核对来源内容；旧版未保存当次实际发送正文，无法还原当时标题、转换与文字拆段。</p></section><h3>实际分段结果</h3>${m.parts?.length?m.parts.map(part=>`<section class="send-part"><div class="part-top">#${escape(part.index)} · ${escape(part.type)} ${badge(part.status)}</div><p>${escape(part.time)} · HTTP ${escape(part.httpStatus ?? '未记录')}</p><div class="part-receipt">回执：${escape(part.receipt||'无')}</div>${part.error?`<p>${escape(part.error)}</p>`:''}</section>`).join(''):'<p class="detail-hint">当前查询窗口没有该任务的分段记录。</p>'}<p class="detail-hint">分段表保存每段最近结果，重试会覆盖旧结果，无法恢复完整历史。</p>`;
    }
  }
  function openDetail(id, tab='content') {
    if(!allRecords().some(m=>m.id===id)) return;
    if($('#detail-drawer').hidden) previousFocus=document.activeElement;
    state.selected=id;state.detailTab=tab;
    renderDetail();$('#drawer-backdrop').hidden=false;$('#detail-drawer').hidden=false;
    document.body.classList.add('drawer-open');$('#detail-drawer').focus();
  }
  function closeDetail() {
    $('#drawer-backdrop').hidden=true;$('#detail-drawer').hidden=true;document.body.classList.remove('drawer-open');
    if(previousFocus?.isConnected) previousFocus.focus();
  }
  function openImage(id) {
    const img=allRecords().flatMap(m=>m.images).find(i=>i.id===id);if(!img?.url)return;
    $('#full-image').src=img.url;$('#full-image').alt=img.name;$('#image-title').textContent=img.name;
    $('#image-description').textContent=`${img.size} · ${live?'远端归档文件':'演示素材 · 正式接入后从远端归档按需读取'}`;
    $('#image-dialog').showModal();
  }
  document.addEventListener('click',async event=>{
    const target=event.target.closest('button,a');if(!target)return;
    if(target.dataset.view){event.preventDefault();navigate(target.dataset.view);}
    else if(target.dataset.navigate){navigate(target.dataset.navigate);}
    else if(target.dataset.image){openImage(target.dataset.image);}
    else if(target.dataset.message){openDetail(target.dataset.message,target.dataset.openTab||'content');}
    else if(target.dataset.detailTab){state.detailTab=target.dataset.detailTab;renderDetail();}
    else if(target.id==='copy-body'){
      try{await navigator.clipboard.writeText(allRecords().find(m=>m.id===state.selected).body);notify('正文已复制');}
      catch{notify('浏览器未允许复制，可在正文区域选中文字复制');}
    }
  });
  $('#close-drawer').addEventListener('click',closeDetail);$('#drawer-backdrop').addEventListener('click',closeDetail);
  $('#close-image').addEventListener('click',()=>$('#image-dialog').close());
  $('#image-dialog').addEventListener('click',event=>{if(event.target===$('#image-dialog')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();}});
  $('#search').addEventListener('input',e=>{state.search=e.target.value;render();});
  $('#status-filter').addEventListener('change',e=>{state.status=e.target.value;render();});
  $('#group-filter').addEventListener('change',e=>{state.group=e.target.value;render();});
  $('#refresh').addEventListener('click',()=>{if(live){window.museRefresh();return;}render();$('#refresh-label').textContent='演示已重绘 · 未请求远端';notify('已刷新演示页面，未连接远端');});
  $('#simulate').addEventListener('click',()=>{
    if(state.simulated>=3){notify('已加入 3 条演示消息，重新打开页面可重置');return;}
    state.simulated++;
    const n=state.simulated;
    data.messages.unshift({id:`demo-new-${n}`,source:n%2?'telegram':'discord',channel:n%2?'Yekoi · 盘中状态更新':'研究讨论 · 盘中交流',author:'演示作者',messageId:`demo:new:${n}`,body:`这是第 ${n} 条模拟新消息，用于预览新增入库内容。\n消息已进入演示队列，尚未调用任何真实发送接口。`,sourceTime:`14:28:0${n}`,capturedTime:`14:28:1${n}`,enqueuedTime:`14:28:1${n}`,status:'queued',group:'盘中观察群',attempts:0,origin:'实时',images:[],version:1,reason:'演示待调度任务。'});
    render();notify('已加入一条演示消息，采集列表与 QQ 队列同步更新');
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!$('#image-dialog').open&&!$('#detail-drawer').hidden){event.preventDefault();closeDetail();}
    if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&$('#detail-drawer').hidden&&state.view!=='connections'){event.preventDefault();$('#search').focus();}
    if(!$('#detail-drawer').hidden&&!$('#image-dialog').open&&event.key==='Tab'){
      const controls=[...$('#detail-drawer').querySelectorAll('button:not([disabled]):not([tabindex="-1"]),a[href],[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===$('#detail-drawer'))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===$('#detail-drawer'))){event.preventDefault();first?.focus();}
    }
    const tab=event.target.closest('[data-detail-tab]');
    if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();const tabs=[...document.querySelectorAll('[data-detail-tab]')];let index=tabs.indexOf(tab);
      index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      state.detailTab=tabs[index].dataset.detailTab;renderDetail();tabs[index].focus();
    }
  });
  window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
  function updateLive() {
    const disconnected = data.disconnected;
    const errors = data.errors || [];
    $('.demo-tag').textContent = disconnected ? '断线' : data.sampledAt ? 'LIVE' : '连接中';
    $('.remote-label').textContent = disconnected ? '保留上次内容' : 'SSH · 只读';
    $('.demo-banner strong').textContent = disconnected ? '连接中断，数据未继续刷新' : errors.length ? '部分数据源读取失败' : '正在读取远端落盘内容';
    $('.demo-banner div > span').textContent = errors.length ? errors.join('；') : '每 5 秒限量刷新 · DC 今昨归档日 / TG 各最近 100 条 · QQ 为队列正文快照与实际回执';
    $('.page-footer > span').textContent = '真实数据 · 只读查询 · 北京时间';
    $('#refresh-label').textContent = data.sampledAt ? `数据截至 ${new Date(data.sampledAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 查询 ${data.queryMs} ms` : '等待首次读取';
    const groups = [...new Set((data.queue || []).map(item=>item.group))];
    $('#group-filter').innerHTML = '<option value="all">全部目标群</option>' + groups.map(group=>`<option value="${escape(group)}">${escape(group)}</option>`).join('');
    $('#group-filter').value = groups.includes(state.group) ? state.group : 'all';
    render();
    if (!$('#detail-drawer').hidden) renderDetail();
  }
  if (live) {
    $('#simulate').hidden = true;
    $('#refresh').innerHTML = icon('refresh') + '刷新';
    $('.drawer-bottom').textContent = '只读远端记录，不执行发送操作';
    $('.image-dialog-header div > span').textContent = '远端归档原图';
    $('.sample-date').textContent = '北京时间 · 最近归档窗口';
    $('.sidebar-footer div > span').textContent = '只读接入 v0.2';
    $('#metrics').setAttribute('aria-label','实际归档窗口与队列概况');
    window.addEventListener('muse-snapshot',updateLive);
    updateLive();
  }
  document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
  navigate(location.hash.slice(1)||'overview');
})();
