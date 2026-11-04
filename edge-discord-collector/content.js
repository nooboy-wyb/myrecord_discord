(() => {
  let lastRoute = "";
  const seen = new Map();
  const reportedImageGaps = new Set();
  let panel;
  let visibleMinutes = new Map();
  let lastLookupAt = 0;
  let lookupRunning = false;
  const minuteOf = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date).replace(' ', 'T')
      : '';
  };
  function ensurePanel() {
    if (panel || !document.body) return;
    const host = document.createElement('div');
    host.id = 'discord-local-capture-status';
    const shadow = host.attachShadow({mode:'closed'});
    shadow.innerHTML = `<style>
      :host { all:initial; position:fixed; top:76px; right:16px; z-index:2147483647; font:13px/1.45 system-ui,sans-serif; color:#202127; }
      section { width:280px; padding:12px; border:1px solid #b8bdc9; border-radius:10px; background:#fff; box-shadow:0 4px 20px #0003; }
      strong { font-size:14px; } label { display:block; margin:10px 0 5px; }
      input { box-sizing:border-box; width:100%; padding:6px; font:inherit; color:#202127; background:#fff; border:1px solid #9298a4; border-radius:5px; }
      button,select { margin-top:8px; padding:5px 9px; font:inherit; cursor:pointer; border:1px solid #9298a4; border-radius:5px; background:#f5f6f8; color:#202127; }
      .primary-action { display:block; width:100%; text-align:left; margin-top:9px; } #state { margin-top:9px; white-space:pre-wrap; }
      #results { margin-top:6px; max-height:180px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
      .item { padding:6px 0; border-top:1px solid #ddd; } .hint { color:#555; font-size:12px; }
      #recovery-list { max-height:300px; overflow:auto; margin-top:8px; white-space:pre-wrap; overflow-wrap:anywhere; }
      #recovery-status { margin-top:8px; white-space:pre-wrap; overflow-wrap:anywhere; }
      .unsent-count { color:#d32f2f; font-weight:700; }
      section.recovery-open { width:380px; }
    </style><section><strong>Discord 采集与转发</strong> <span id="extension-version" class="hint"></span>
      <button id="forwarding-toggle" class="primary-action" type="button" disabled>1. 读取实时转发状态…</button>
      <div id="forwarding-status" class="hint" role="status"></div>
      <button id="recover" class="primary-action" type="button">2. 查看历史漏发与补发</button>
      <button id="open-check" class="primary-action" type="button">3. 按时间检查与扫描</button>
      <div id="body" hidden><label for="minute">目标时间（北京时间）</label>
      <input id="minute" type="datetime-local" step="60"><button id="check" type="button">检查这一分钟入库</button>
      <button id="scan" type="button">扫描当前页面</button>
      <div id="scan-info" class="hint">尚未扫描</div>
      <div id="state" role="status">输入日期和时间后检查。</div><div id="results"></div>
      <div class="hint">只能扫描当前页面已加载的消息；时间查询显示本地归档，不代表 QQ 已收到。</div>
      <button id="check-back" type="button">返回功能列表</button></div>
      <div id="recovery" hidden><div id="recovery-channel"></div>
        <label for="recovery-group">目标 QQ 群</label><select id="recovery-group"></select>
        <button id="recovery-preview" type="button">重新查询漏发清单</button>
        <div id="recovery-status" role="status"></div><div id="recovery-list"></div>
        <button id="recovery-send" type="button" disabled>补发选中消息</button>
        <button id="cancel-recovery" type="button">取消当前补发请求</button>
        <div id="cancel-status" class="hint" role="status"></div>
        <button id="recovery-back" type="button">返回功能列表</button>
        <div class="hint">每次最多 20 条；已有发送尝试或正在补发的消息不会再次排队。</div>
      </div></section>`;
    document.body.appendChild(host);
    shadow.getElementById('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
    const input = shadow.getElementById('minute');
    const state = shadow.getElementById('state');
    const results = shadow.getElementById('results');
    shadow.getElementById('check').onclick = () => {
      if (!input.value) { state.textContent = '请先选择目标时间。'; return; }
      checkLookup(true);
    };
    shadow.getElementById('scan').onclick = async () => {
      state.textContent = '正在扫描当前页面…';
      try {
        const result = await scan(true);
        if (!result) { state.textContent = '当前页面不是 Discord 频道。'; return; }
        if (!result.allowed) { state.textContent = '此频道未加入采集列表。'; return; }
        state.textContent = `扫描完成，识别 ${result.extracted} 条。${input.value ? '正在核对入库状态…' : '选择目标时间可核对入库。'}`;
        if (input.value) setTimeout(() => checkLookup(true), 1000);
      } catch (error) { state.textContent = `扫描失败：${error.message || error}`; }
    };
    const recovery = shadow.getElementById('recovery');
    const group = shadow.getElementById('recovery-group');
    const recoveryStatus = shadow.getElementById('recovery-status');
    const recoveryList = shadow.getElementById('recovery-list');
    const recoverySend = shadow.getElementById('recovery-send');
    shadow.getElementById('recover').onclick = () => {
      shadow.getElementById('body').hidden = true;
      shadow.querySelector('section').classList.add('recovery-open');
      recovery.hidden = false;
      loadRecovery();
    };
    shadow.getElementById('open-check').onclick = () => {
      recovery.hidden = true;
      shadow.querySelector('section').classList.remove('recovery-open');
      shadow.getElementById('body').hidden = false;
    };
    shadow.getElementById('cancel-recovery').onclick = () => cancelRecovery();
    shadow.getElementById('forwarding-toggle').onclick = async () => {
      const channelId = route()?.channel_id;
      if (!channelId || !panel) return;
      if (typeof panel.forwardingPaused !== 'boolean') { loadForwarding(); return; }
      panel.forwardingButton.disabled = true;
      panel.forwardingStatus.textContent = '正在更新当前频道的自动转发…';
      try {
        const reply = await chrome.runtime.sendMessage({type:'forwardingPause',channelId,paused:!panel.forwardingPaused});
        if (!reply?.ok) throw Error(reply?.error || '更新失败');
        if (route()?.channel_id !== channelId) return;
        showForwarding(reply);
      } catch (error) {
        panel.forwardingStatus.textContent = `更新失败：${error.message || error}`;
        panel.forwardingButton.disabled = false;
      }
    };
    shadow.getElementById('recovery-back').onclick = () => {
      recovery.hidden = true;
      shadow.querySelector('section').classList.remove('recovery-open');
    };
    shadow.getElementById('check-back').onclick = () => {
      shadow.getElementById('body').hidden = true;
    };
    shadow.getElementById('recovery-preview').onclick = () => loadRecovery();
    group.onchange = () => loadRecovery();
    recoverySend.onclick = () => sendRecovery();
    input.onchange = () => checkLookup(true);
    panel = {host,input,state,results,scanInfo:shadow.getElementById('scan-info'),
      cancelStatus:shadow.getElementById('cancel-status'),
      forwardingButton:shadow.getElementById('forwarding-toggle'),
      forwardingStatus:shadow.getElementById('forwarding-status'),
      recovery:{root:recovery,group,status:recoveryStatus,list:recoveryList,send:recoverySend}};
  }
  function showForwarding(reply) {
    panel.forwardingPaused = reply.paused;
    panel.forwardingButton.disabled = false;
    panel.forwardingButton.textContent = reply.paused ? '1. 启动当前频道实时转发' : '1. 暂停当前频道实时转发';
    panel.forwardingStatus.textContent = reply.paused
      ? `${reply.label}：自动转发已暂停，仍继续采集入库。`
      : `${reply.label}：自动转发运行中。`;
  }
  async function loadForwarding() {
    const channelId = route()?.channel_id;
    if (!panel || !channelId) return;
    panel.forwardingPaused = undefined;
    panel.forwardingButton.disabled = true;
    panel.forwardingButton.textContent = '1. 读取实时转发状态…';
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const reply = await chrome.runtime.sendMessage({type:'forwardingStatus',channelId});
        if (route()?.channel_id !== channelId) return;
        if (!reply?.ok) throw Error(reply?.error || '读取失败');
        showForwarding(reply);
        return;
      } catch (error) {
        lastError = String(error?.message || error);
        const transient = /message channel closed|port closed|Extension context|Failed to fetch|timed out|aborted/i.test(lastError);
        if (!transient || attempt === 2) break;
        panel.forwardingStatus.textContent = `本机转发服务暂时没响应，正在重试（${attempt + 1}/2）…`;
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
    panel.forwardingStatus.textContent = /message channel closed|port closed|Failed to fetch|timed out|aborted/i.test(lastError)
      ? '转发状态读取失败：本机转发服务 127.0.0.1:8765 没有响应。确认服务窗口仍在运行后，点上面的按钮重新读取。'
      : `转发状态读取失败：${lastError}`;
    panel.forwardingButton.disabled = false;
    panel.forwardingButton.textContent = '1. 重新读取转发状态';
  }
  async function cancelRecovery() {
    const channelId = route()?.channel_id;
    if (!panel || !channelId) return;
    const group = panel.recovery.group.value;
    panel.cancelStatus.textContent = '正在取消当前频道的手动补发…';
    try {
      const reply = await chrome.runtime.sendMessage({type:'recoveryCancel',channelId,group});
      if (!reply?.ok) throw Error(reply?.error || '取消失败');
      if (!reply.found) { panel.cancelStatus.textContent = reply.message; return; }
      panel.cancelStatus.textContent = reply.status === 'cancelled'
        ? `补发请求 #${reply.request_id} 已取消；已发送的消息保留。`
        : `补发请求 #${reply.request_id} 正在取消；当前发送中的消息可能完成。`;
      if (!panel.recovery.root.hidden) loadRecovery();
      if (reply.status === 'cancelling') watchCancel(channelId,reply.request_id);
    } catch (error) { panel.cancelStatus.textContent = `取消失败：${error.message || error}`; }
  }
  async function watchCancel(channelId, requestId) {
    if (route()?.channel_id !== channelId || !panel) return;
    try {
      const reply = await chrome.runtime.sendMessage({type:'recoveryStatus',channelId,requestId});
      if (!reply?.ok) throw Error(reply?.error || '查询失败');
      if (reply.request.status === 'cancelled') {
        panel.cancelStatus.textContent = `补发请求 #${requestId} 已取消；已发送的消息保留。`;
        if (!panel.recovery.root.hidden) loadRecovery();
        return;
      }
      if (['complete','blocked'].includes(reply.request.status)) {
        panel.cancelStatus.textContent = `补发请求 #${requestId} 当前状态：${reply.request.status}；请查看补发清单。`;
        return;
      }
      setTimeout(() => watchCancel(channelId,requestId),3000);
    } catch (error) { panel.cancelStatus.textContent = `取消状态查询失败：${error.message || error}`; }
  }
  async function loadRecovery() {
    const ui = panel?.recovery;
    const context = route();
    if (!ui || ui.root.hidden || !context) return;
    const channelId = context.channel_id;
    ui.status.textContent = '正在读取本地归档和 QQ 发送记录…';
    ui.list.replaceChildren();
    ui.send.disabled = true;
    const requestedGroup = ui.group.value || '1';
    try {
      const reply = await chrome.runtime.sendMessage({type:'recoveryPreview',channelId,group:requestedGroup});
      if (route()?.channel_id !== channelId || ui.root.hidden || (ui.group.value && ui.group.value !== requestedGroup)) return;
      if (!reply?.ok) throw Error(reply?.error || '本地服务未响应');
      const selectedGroup = reply.group;
      ui.group.replaceChildren();
      for (const target of reply.groups || []) {
        const option = document.createElement('option');
        option.value = target.number;
        option.textContent = target.label;
        ui.group.appendChild(option);
      }
      ui.group.value = selectedGroup;
      panel.recovery.channelId = channelId;
      panel.recovery.preview = reply.items || [];
      panel.recovery.groupNumber = selectedGroup;
      panel.recovery.root.querySelector('#recovery-channel').textContent = `当前频道：${channelId}`;
      const ready = (reply.items || []).filter(item => item.ready).length;
      const unsentCount = document.createElement('span');
      unsentCount.className = 'unsent-count';
      unsentCount.textContent = String(reply.total_unsent);
      ui.status.replaceChildren(document.createTextNode('未转发 '), unsentCount,
        document.createTextNode(` 条；本次显示最近 ${reply.items.length} 条，其中 ${ready} 条可发送。时间为北京时间。排队中 ${reply.queued_count || 0} 条；去重跳过 ${reply.duplicate_skipped_count || 0} 条；补发阻止 ${reply.blocked_count || 0} 条；发送状态不明 ${reply.uncertain_count || 0} 条（需人工核对）。`));
      for (const item of reply.items || []) {
        const row = document.createElement('label');
        row.className = 'item';
        row.style.display = 'block';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = item.ready;
        check.disabled = !item.ready;
        check.value = item.id;
        check.dataset.hash = item.hash;
        row.append(check);
        const time = item.time ? new Date(item.time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '时间未知';
        const imageIssue = item.missing_image_hint ? '；正文提到图片，但本地未采到，暂不能发送'
          : item.ready ? '' : '；原图未完整保存，暂不能发送';
        row.append(document.createTextNode(` ${time}｜${item.author || '未知作者'}\n${item.excerpt || '（无正文）'}\n消息 ID ${item.id}；图片 ${item.image_count}${imageIssue}`));
        ui.list.appendChild(row);
      }
      ui.send.disabled = ready === 0;
    } catch (error) { ui.status.textContent = `读取失败：${error.message || error}`; }
  }
  async function sendRecovery() {
    const ui = panel?.recovery;
    const channelId = route()?.channel_id;
    if (!ui || !channelId || channelId !== ui.channelId) return;
    const selected = [...ui.list.querySelectorAll('input[type="checkbox"]:checked')]
      .map(check => ({id:check.value,hash:check.dataset.hash}));
    if (!selected.length) { ui.status.textContent = '请至少勾选一条可发送的消息。'; return; }
    ui.send.disabled = true;
    ui.status.textContent = `正在提交 ${selected.length} 条补发请求…`;
    try {
      const reply = await chrome.runtime.sendMessage({type:'recoveryQueue',channelId,group:ui.group.value,selected});
      if (!reply?.ok) throw Error(reply?.error || '提交失败');
      ui.status.textContent = `已提交请求 #${reply.request_id}，共 ${reply.count} 条；等待 QQ 发送。`;
      ui.list.replaceChildren();
      watchRecovery(channelId,reply.request_id);
    } catch (error) { ui.status.textContent = `提交失败：${error.message || error}`; ui.send.disabled = false; }
  }
  async function watchRecovery(channelId, requestId) {
    const ui = panel?.recovery;
    if (!ui || ui.root.hidden || route()?.channel_id !== channelId) return;
    try {
      const reply = await chrome.runtime.sendMessage({type:'recoveryStatus',channelId,requestId});
      if (!reply?.ok) throw Error(reply?.error || '状态查询失败');
      const counts = {};
      for (const item of reply.items || []) counts[item.status] = (counts[item.status] || 0) + 1;
      ui.status.textContent = `请求 #${requestId}：${reply.request.cancel_requested && reply.request.status === 'processing' ? '正在取消' : reply.request.status}；已接受 ${counts.accepted || 0}，去重跳过 ${counts.skipped_duplicate || 0}，已有记录 ${counts.already_attempted || 0}，已取消 ${counts.cancelled || 0}，待处理 ${counts.pending || 0}，状态不明 ${counts.unknown || 0}。`;
      if (['complete','blocked','cancelled'].includes(reply.request.status)) {
        const result = ui.status.textContent;
        await loadRecovery();
        ui.status.textContent = `${result}\n${ui.status.textContent}`;
        return;
      }
    } catch (error) { ui.status.textContent = `状态查询失败：${error.message || error}`; return; }
    setTimeout(() => watchRecovery(channelId,requestId),5000);
  }
  async function checkLookup(force = false) {
    if (!panel || !panel.input.value || lookupRunning) return;
    if (!force && Date.now() - lastLookupAt < 2500) return;
    const context = route();
    if (!context) return;
    const minute = panel.input.value;
    lookupRunning = true;
    lastLookupAt = Date.now();
    panel.state.textContent = '正在检查本地归档…';
    try {
      const reply = await chrome.runtime.sendMessage({type:'lookupMinute',channelId:context.channel_id,localMinute:minute});
      if (minute !== panel.input.value || context.channel_id !== route()?.channel_id) return;
      panel.results.replaceChildren();
      if (!reply?.ok) { panel.state.textContent = `查询失败：${reply?.error || '服务未响应'}`; return; }
      const messages = reply.messages || [];
      if (!messages.length) {
        const visible = visibleMinutes.get(minute) || 0;
        panel.state.textContent = visible
          ? `网页已识别这分钟的 ${visible} 条消息，尚未入库。请稍候。`
          : '本地未入库；当前页面也未识别这分钟的消息。请滚动到目标消息并停留。';
        return;
      }
      panel.state.textContent = `已入库 ${messages.length} 条。`;
      for (const message of messages) {
        const item = document.createElement('div');
        item.className = 'item';
        const time = minuteOf(message.source_timestamp)?.replace('T', ' ') || '时间未知';
        const second = message.source_timestamp ? new Date(message.source_timestamp).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) : '';
        item.textContent = `${time}${second ? `:${second.slice(-2)}` : ''} ${message.author || ''}\n${message.excerpt || '（无正文）'}\n图片 ${message.images_saved}/${message.image_count} 已保存${message.image_errors?.length ? `；失败：${message.image_errors.join('；')}` : ''}`;
        panel.results.appendChild(item);
      }
    } catch (error) { panel.state.textContent = `查询失败：${error.message || error}`; }
    finally { lookupRunning = false; }
  }
  const text = (root, selectors) => {
    for (const selector of selectors) {
      const value = root.querySelector(selector)?.textContent?.trim();
      if (value) return value;
    }
    return "";
  };
  const route = () => {
    const match = location.pathname.match(/^\/channels\/(\d+|@me)\/(\d+)/);
    return match ? {guild_id: match[1] === "@me" ? null : match[1], channel_id: match[2]} : null;
  };
  function messageContainer(content) {
    const id = content.id?.match(/^message-content-(\d+)$/)?.[1];
    const exact = id && content.closest(`[id="chat-messages-${id}"]`);
    let ancestor = content.parentElement;
    let fallback = exact || content;
    while (ancestor && ancestor !== document.body) {
      const contents = ancestor.querySelectorAll('[id^="message-content-"]');
      if (contents.length !== 1 || contents[0] !== content) break;
      if (ancestor.querySelector('time[datetime]')) fallback = ancestor;
      if (ancestor.matches('li[class*="messageListItem"], [data-message-id]')) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return fallback;
  }
  function originalAttachmentUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) return null;
      if (url.pathname.startsWith('/attachments/')) {
        url.hostname = 'cdn.discordapp.com';
        for (const key of [...url.searchParams.keys()]) {
          if (!['ex', 'is', 'hm'].includes(key)) url.searchParams.delete(key);
        }
        url.search = url.searchParams.toString();
      } else if (!(url.hostname === 'media.discordapp.net' && url.pathname.startsWith('/external/'))) {
        return null;
      }
      url.hash = '';
      return url.href;
    } catch { return null; }
  }
  function inheritedAuthor(node, sourceTimestamp) {
    const content = node.matches('[id^="message-content-"]') ? node
      : node.querySelector('[id^="message-content-"]');
    const contents = [...document.querySelectorAll('[id^="message-content-"]')];
    const index = contents.indexOf(content);
    if (index < 0) return '';
    const currentTime = Date.parse(sourceTimestamp || '');
    for (let i = index - 1; i >= 0 && index - i <= 30; i--) {
      const prior = messageContainer(contents[i]);
      if (!prior) continue;
      const priorTime = Date.parse(prior.querySelector('time[datetime]')?.getAttribute('datetime') || '');
      if (Number.isFinite(currentTime) && Number.isFinite(priorTime)
        && currentTime - priorTime > 10 * 60_000) break;
      const author = text(prior, ['[id^="message-username-"]', '[class*="username"]']);
      if (author) return author;
    }
    return '';
  }
  function extract(node, context, channelLabel) {
    const content = node.matches('[id^="message-content-"]') ? node
      : node.querySelector('[id^="message-content-"]') || node.querySelector('[class*="messageContent"]');
    const nodeId = node.id?.match(/^chat-messages-(?:\d+-)?(\d+)$/)?.[1];
    const contentId = content?.id?.match(/^message-content-(\d+)$/)?.[1];
    const id = nodeId || contentId
      || node.id?.match(/^message-(\d+)$/)?.[1]
      || node.dataset.messageId || null;
    if (!id) return null;
    const inheritedContent = nodeId && contentId && nodeId !== contentId;
    const body = inheritedContent ? '' : content?.innerText ?? '';
    const timeEl = node.querySelector('time[datetime]');
    const sourceTimestamp = inheritedContent
      ? new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString()
      : timeEl?.getAttribute('datetime') || null;
    const displayedTime = inheritedContent ? ''
      : timeEl?.textContent?.trim() || timeEl?.getAttribute('aria-label') || '';
    const directAuthor = text(node, ['[id^="message-username-"]', '[class*="username"]']);
    const inherited = directAuthor ? '' : inheritedAuthor(node, sourceTimestamp);
    const author = directAuthor || inherited;
    const attachments = new Map();
    for (const anchor of node.querySelectorAll('a[href]')) {
      const original = originalAttachmentUrl(anchor.href);
      if (original && /\.(?:png|jpe?g|webp|gif)$/i.test(new URL(original).pathname)) {
        attachments.set(original,{kind:'image',source_url:original});
      }
    }
    for (const img of node.querySelectorAll('a[href] img, img[src], img[srcset]')) {
      const anchor = img.closest('a[href]');
      for (const url of [anchor?.href, img.currentSrc, img.src]) {
        const original = originalAttachmentUrl(url);
        if (original) {
          attachments.set(original, {kind: 'image', source_url: original});
          break;
        }
      }
    }
    if (!body && !attachments.size) return null;
    const bodyKind = !body.trim() || body.trim().toLowerCase() === 'no text'
      ? attachments.size === 1 ? 'single_image' : attachments.size > 1 ? 'images_only' : 'missing_image'
      : attachments.size ? 'text_and_image' : 'text_only';
    return {
      schema_version: 1, source: 'discord_web', ...context,
      channel_name: channelLabel || document.title,
      source_message_id: id,
      message_url: `https://discord.com/channels/${context.guild_id || '@me'}/${context.channel_id}/${id}`,
      author_display: author, author_source: directAuthor ? 'dom' : inherited ? 'previous_dom_message' : 'unknown',
      displayed_time: displayedTime,
      source_timestamp: sourceTimestamp, body_raw: body, body_kind: bodyKind,
      attachments: [...attachments.values()],
      capture_method: 'dom'
    };
  }
  function messageNodes() {
    const nodesById = document.querySelectorAll('[id^="chat-messages-"]');
    const contentNodes = document.querySelectorAll('[id^="message-content-"]');
    const classNodes = document.querySelectorAll('li[class*="messageListItem"], [data-message-id]');
    const nodes = new Set([...contentNodes].map(messageContainer));
    for (const node of nodesById) nodes.add(node);
    for (const node of classNodes) {
      if (!node.querySelector('[id^="message-content-"]')) nodes.add(node);
    }
    return {nodesById, contentNodes, nodes};
  }
  function combineExtracted(messages) {
    const byId = new Map();
    for (const message of messages) {
      const prior = byId.get(message.source_message_id);
      if (!prior) {
        byId.set(message.source_message_id, message);
        continue;
      }
      const attachments = new Map([...prior.attachments, ...message.attachments]
        .map(item => [item.source_url, item]));
      const body = prior.body_raw || message.body_raw;
      const merged = {
        ...prior,
        body_raw: body,
        attachments: [...attachments.values()],
        source_timestamp: prior.source_timestamp || message.source_timestamp,
        displayed_time: prior.displayed_time || message.displayed_time,
        author_display: prior.author_display || message.author_display,
        author_source: prior.author_display ? prior.author_source : message.author_source
      };
      merged.body_kind = body.trim()
        ? attachments.size ? 'text_and_image' : 'text_only'
        : attachments.size === 1 ? 'single_image' : attachments.size > 1 ? 'images_only' : 'missing_image';
      byId.set(message.source_message_id, merged);
    }
    return [...byId.values()];
  }
  let scanSequence = 0;
  async function scan(forceResubmit = false, poll = null) {
    const context = route();
    if (!context) return;
    const startedAt = Date.now();
    const scanId = `${startedAt}-${++scanSequence}`;
    const progress = stage => {
      if (!poll?.requestId) return;
      chrome.runtime.sendMessage({type:'scanProgress',channel_id:context.channel_id,
        request_id:poll.requestId,stage,at:Date.now(),visibility:document.visibilityState}).catch(() => {});
    };
    progress('received');
    try {
    ensurePanel();
    const key = `${context.guild_id}/${context.channel_id}`;
    if (key !== lastRoute) {
      lastRoute = key;
      seen.clear();
      reportedImageGaps.clear();
      loadForwarding();
      if (panel?.recovery && !panel.recovery.root.hidden) loadRecovery();
    }
    progress('config_wait');
    const {allowedChannels = [], channelLabels = {}} = await chrome.storage.local.get(['allowedChannels', 'channelLabels']);
    const configReadAt = Date.now();
    progress('dom_scan');
    const allowed = allowedChannels.includes(context.channel_id);
    if (panel) panel.host.style.display = allowed ? '' : 'none';
    if (!allowed) {
      if (panel) panel.scanInfo.textContent = '此频道未加入采集列表';
      chrome.runtime.sendMessage({type: 'pageStatus', channel_id: context.channel_id, allowed, count: 0, extracted: 0, at: Date.now()}).catch(() => {});
      return {allowed:false, extracted:0};
    }
    const {nodesById, contentNodes, nodes} = messageNodes();
    for (const node of nodesById) {
      const candidateUrls = [...node.querySelectorAll('a[href],img[src],img[srcset]')]
        .flatMap(item => [item.href,item.currentSrc,item.src]);
      const acceptedUrls = candidateUrls.filter(value => {
        const original = value && originalAttachmentUrl(value);
        return original && /\.(?:png|jpe?g|webp|gif)$/i.test(new URL(original).pathname);
      });
      if (!acceptedUrls.length) continue;
      const included = nodes.has(node);
      const extracted = extract(node,context,channelLabels[context.channel_id]);
      if (included && extracted?.attachments.length) continue;
      const sourceId = node.id?.match(/(\d{15,22})$/)?.[1];
      if (!sourceId || reportedImageGaps.has(sourceId)) continue;
      reportedImageGaps.add(sourceId);
      chrome.runtime.sendMessage({type:'imageNodeGap',channelId:context.channel_id,sourceId,
        detail:{nodeId:node.id || '',included,contentId:node.querySelector('[id^="message-content-"]')?.id || '',
          extractedId:extracted?.source_message_id || '',extractedAttachmentCount:extracted?.attachments.length ?? null,
          acceptedUrlCount:acceptedUrls.length,imageCount:node.querySelectorAll('img').length}}).catch(() => {});
    }
    let extracted = 0;
    let latestSourceId = '';
    visibleMinutes = new Map();
    const messages = combineExtracted([...nodes]
      .map(node => extract(node, context, channelLabels[context.channel_id])).filter(Boolean));
    for (const message of messages) {
      extracted++;
      if (/^\d+$/.test(message.source_message_id)
        && (!latestSourceId || BigInt(message.source_message_id) > BigInt(latestSourceId))) {
        latestSourceId = message.source_message_id;
      }
      const minute = minuteOf(message.source_timestamp);
      if (minute) visibleMinutes.set(minute, (visibleMinutes.get(minute) || 0) + 1);
      const fingerprint = JSON.stringify([message.author_display, message.displayed_time, message.body_raw, message.attachments]);
      if (!forceResubmit && seen.get(message.source_message_id) === fingerprint) continue;
      seen.set(message.source_message_id, fingerprint);
      message.capture_trace = {scan_id:scanId,scan_started_at:startedAt,
        observed_at:Date.now(),config_ms:configReadAt - startedAt};
      chrome.runtime.sendMessage({type: 'capture', message}).catch(() => {});
    }
    const firstTime = document.querySelector('time');
    const ancestry = [];
    for (let el = firstTime, i = 0; el && i < 5; el = el.parentElement, i++) {
      ancestry.push(`${el.tagName.toLowerCase()}#${el.id || ''}.${String(el.className || '').split(/\s+/).slice(0, 2).join('.')}`);
    }
    chrome.runtime.sendMessage({
      type: 'pageStatus', channel_id: context.channel_id, allowed,
      count: nodes.size, extracted, latestSourceId, contentCount: contentNodes.length,
      diagnostics: {
        times: document.querySelectorAll('time').length,
        listItems: document.querySelectorAll('li').length,
        roles: document.querySelectorAll('[role="listitem"]').length,
        messageClasses: document.querySelectorAll('[class*="message"]').length,
        firstTimeAncestry: ancestry
      },
      at: Date.now(),
      scan_trace:poll?.requestId ? {scan_id:scanId,request_id:poll.requestId,
        requested_at:poll.requestedAt,started_at:startedAt,completed_at:Date.now(),
        config_ms:configReadAt - startedAt,dom_ms:Date.now() - configReadAt,
        visibility:document.visibilityState} : undefined
    }).catch(() => {});
    if (panel) panel.scanInfo.textContent = `最近扫描 ${new Date().toLocaleTimeString('zh-CN')}；识别 ${extracted} 条`;
    if (panel?.input.value && visibleMinutes.has(panel.input.value)) checkLookup();
    progress('complete');
    return {allowed:true, extracted};
    } catch (error) {
      progress('error');
      throw error;
    }
  }
  let timer;
  const scheduleScan = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 750);
  };
  new MutationObserver(scheduleScan).observe(document.documentElement, {childList: true, subtree: true, characterData: true});
  document.addEventListener('scroll', scheduleScan, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });
  window.addEventListener('focus', scheduleScan);
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type !== 'pollScan' || route()?.channel_id !== request.channelId) return;
    scan(false,request).then(result => sendResponse(result || {allowed:false, extracted:0}))
      .catch(error => sendResponse({error:String(error)}));
    return true;
  });
  setInterval(scan, 15000);
  setInterval(() => checkLookup(), 5000);
  scan();
})();
