function render() { chrome.storage.local.get(['allowedChannels','channelLabels','queue','lastSavedAt','lastError','pageStatus','lastRefreshAt','lastRefreshRequested','lastRefreshCompleted','lastRefreshError','watchdogStatus','refreshTestMode','refreshHistory','diagnosticQueue','lastDiagnosticError','diagnosticDroppedCount'], d => {
  document.querySelector('b').textContent = `Discord 频道采集 v${chrome.runtime.getManifest().version}`;
  const age = d.pageStatus ? Math.round((Date.now() - d.pageStatus.at) / 1000) : null;
  const page = d.pageStatus;
  document.getElementById('state').textContent = `允许频道：${(d.allowedChannels || []).length} 个\n当前频道：${page?.channel_id || '未知'}\n频道匹配：${page ? (page.allowed ? '是' : '否') : '未知'}\n正文节点：${page?.contentCount ?? '未知'}\n页面消息节点：${page?.count ?? '未知'}\n可提取消息：${page?.extracted ?? '未知'}\n待发送：${(d.queue || []).length} 条\n待写入诊断日志：${(d.diagnosticQueue || []).length} 条\n最近页面扫描：${age === null ? '无' : age + ' 秒前'}\n最近入库：${d.lastSavedAt ? new Date(d.lastSavedAt).toLocaleString() : '无'}\n最近巡检：${d.lastRefreshAt ? new Date(d.lastRefreshAt).toLocaleString() : '无'}\n本轮发出请求：${(d.lastRefreshRequested || []).length} 个标签页；完成加载：${(d.lastRefreshCompleted || []).length} 个`;
  document.getElementById('state').style.whiteSpace = 'pre-line';
  const checks = d.watchdogStatus?.details || [];
  const issues = checks.filter(item => item.status !== 'healthy');
  const waitingForNew = checks.filter(item => item.status === 'healthy' && !item.liveVerifiedAt);
  const patrolAge = d.lastRefreshAt ? Math.round((Date.now() - d.lastRefreshAt) / 1000) : null;
  document.getElementById('health').textContent = checks.length
    ? `后台巡检：${patrolAge === null ? '等待首次巡检' : patrolAge > 180 ? '心跳超时，请检查 Edge 扩展' : patrolAge + ' 秒前'}\n页面扫描：${checks.length - issues.length}/${checks.length} 页正常` +
      (issues.length ? '\n' + issues.map(item =>
        `${d.channelLabels?.[item.channelId] || item.channelId}：${item.status === 'recovering' ? '正在恢复' : '未恢复，稍后重试'}（第 ${item.attempt} 次）${item.error ? '；' + item.error : ''}`).join('\n') : '') +
      (waitingForNew.length ? `\n等待新消息验证实时流入：${waitingForNew.map(item => d.channelLabels?.[item.channelId] || item.channelId).join('、')}` : '')
    : `后台巡检：${patrolAge === null ? '等待首次巡检' : patrolAge > 180 ? '心跳超时，请检查 Edge 扩展' : patrolAge + ' 秒前'}\n自动恢复：尚未检测到打开的采集页`;
  document.getElementById('error').textContent = [d.lastError, d.lastRefreshError,d.lastDiagnosticError,
    d.diagnosticDroppedCount ? `诊断队列溢出，已丢弃 ${d.diagnosticDroppedCount} 条最早记录` : ''].filter(Boolean).map(x => `错误：${x}`).join('\n');
  const mode = d.refreshTestMode || {};
  const history = d.refreshHistory || [];
  const format = value => value ? new Date(value).toLocaleTimeString('zh-CN', {hour12:false}) : '等待中';
  document.getElementById('test-mode').textContent = mode.enabled ? '提前结束巡检测试' : '开始单轮 10 秒巡检测试';
  document.getElementById('test-status').textContent = mode.enabled
    ? `已刷新 ${mode.seenTabIds?.length || 0} 页；下一次预计：${format(mode.nextAt)}。保持弹窗打开；全部频道各刷新一次后自动结束。`
    : '正常模式：每页固定约 30 分钟轮流刷新；每分钟最多刷新一页。';
  document.getElementById('refresh-history').textContent = history.length
    ? '最近实际刷新（最多 8 次）：\n' + history.map(item =>
      `${d.channelLabels?.[item.channelId] || item.channelId}〔${item.reason}〕\n请求 ${format(item.requestedAt)} · 加载 ${format(item.loadedAt)} · 恢复扫描 ${format(item.recoveredAt)}`).join('\n')
    : '尚无实际刷新记录。';
  if (page?.diagnostics) {
    const x = page.diagnostics;
    document.getElementById('diagnostics').textContent = `页面结构诊断：time ${x.times} / li ${x.listItems} / listitem ${x.roles} / message类 ${x.messageClasses}\n首个时间节点上层：${x.firstTimeAncestry.join(' > ') || '无'}`;
  }
}); }
render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['lastRefreshAt','lastRefreshRequested','lastRefreshCompleted','lastRefreshError','watchdogStatus','refreshTestMode','refreshHistory','diagnosticQueue','lastDiagnosticError','diagnosticDroppedCount'].some(key => key in changes)) render();
});
document.getElementById('test-mode').onclick = async () => {
  const button = document.getElementById('test-mode');
  button.disabled = true;
  try {
    const {refreshTestMode = {}} = await chrome.storage.local.get('refreshTestMode');
    const reply = await chrome.runtime.sendMessage({type:'setRefreshTestMode',enabled:!refreshTestMode.enabled});
    if (!reply?.ok) throw Error(reply?.error || '后台未响应');
    render();
  } catch (error) { document.getElementById('error').textContent = `测试模式设置失败：${error.message || error}`; }
  finally { button.disabled = false; }
};
setInterval(async () => {
  const {refreshTestMode = {}} = await chrome.storage.local.get('refreshTestMode');
  if (refreshTestMode.enabled) chrome.runtime.sendMessage({type:'refreshTestTick'}).catch(() => {});
  render();
}, 1000);
document.getElementById('refresh').onclick = async () => {
  const button = document.getElementById('refresh');
  button.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({type:'refreshNow'});
    if (!reply?.ok) document.getElementById('error').textContent = `刷新失败：${reply?.error || '后台未响应'}`;
    render();
  } catch (error) { document.getElementById('error').textContent = `刷新失败：${error.message || error}`; }
  finally { button.disabled = false; }
};
document.getElementById('settings').onclick = () => chrome.runtime.openOptionsPage();
