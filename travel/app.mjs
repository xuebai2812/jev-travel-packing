import { ITEMS } from './catalog.mjs';
import { PackingWorld } from './physics.mjs';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const byId = new Map(ITEMS.map(item => [item.id, item]));
const selected = new Set();
const packed = new Set();
const cache = new Map();
let inputTimer, toastTimer, epoch = 0, controller = null, activeTrip = '', result = null, composing = false, configured = false;
let currentTrip = '';

const world = new PackingWorld($('playground'), ITEMS, {
  onToggle(item) {
    if (!selected.has(item.id) && selected.size >= 24) { announce('先带 24 件吧，移出一件后就能再添加。'); return; }
    cancelPending();
    if (selected.has(item.id)) { selected.delete(item.id); packed.delete(item.id); }
    else selected.add(item.id);
    world.select([...selected]);
    updateList();
    showSelection(true);
  },
});

function announce(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2400);
}

function setStatus(kind, text, detail = '') {
  $('selectionCaption').className = `selection-caption ${kind}`;
  $('statusText').textContent = text;
  $('selectionDetail').textContent = detail;
  $('retryButton').hidden = kind !== 'error' || !currentTrip;
}

function setBusy(busy) {
  $('tripForm').classList.toggle('busy', busy);
  $('tripForm').setAttribute('aria-busy', String(busy));
  $('goButton').setAttribute('aria-label', busy ? '正在整理行李' : '整理这趟旅行的行李');
}

function showSelection(manual = false) {
  if (selected.size) {
    const count = selected.size;
    const monthNote = result ? (result.month_source === 'explicit' ? '按你填写的出行时间考虑' : `未写月份，按 ${result.assumed_month} 月考虑`) : '点一下物品，可随时加入或移出清单';
    setStatus('success', `${count} 件小东西，陪你去下一站。`, manual ? '已按你的选择调整 · 打开「我的行李」逐件打包' : monthNote);
  } else if (result) {
    setStatus('empty', '这次没有选中物品，试着补充一点行程。', '也可以直接点击下面的物品，自己挑选。');
  } else {
    setStatus('idle', '下一趟旅行，会带上哪些小东西？', '输入行程，看看它们自己找到位置。');
  }
}

function updateList() {
  $('playground').classList.toggle('many-selected', selected.size > 18);
  $('navCount').textContent = selected.size;
  $('drawerTrip').textContent = result?.trip || currentTrip || (selected.size ? '亲手挑选，也是一种出发前的仪式。' : '等一个目的地，也等一个出发的理由。');
  const categories = [...new Set(ITEMS.map(item => item.category))];
  $('packingList').innerHTML = selected.size ? categories.map(category => {
    const entries = ITEMS.filter(item => item.category === category && selected.has(item.id));
    if (!entries.length) return '';
    return `<section class="packing-category"><h3>${escapeHTML(category)}</h3>${entries.map(item => `<div class="packing-row${packed.has(item.id) ? ' is-packed' : ''}"><label><input type="checkbox" data-pack="${escapeHTML(item.id)}" ${packed.has(item.id) ? 'checked' : ''} aria-label="${escapeHTML(item.name)}已装好"><span class="row-emoji" aria-hidden="true">${escapeHTML(item.emoji)}</span><span class="row-name">${escapeHTML(item.name)}</span></label><button class="remove-item" data-remove="${escapeHTML(item.id)}" aria-label="移除${escapeHTML(item.name)}">${icon('close')}</button></div>`).join('')}</section>`;
  }).join('') : '<div class="empty-list"><span aria-hidden="true">🧳</span><p>行李箱还是空的。</p><p>说说你的旅行，或点选几件物品。</p></div>';
  updateProgress();
  $('copyButton').disabled = !selected.size;
  $('listNote').textContent = result ? `${result.month_source === 'explicit' ? '按你填写的出行时间考虑。' : `未写月份，按 ${result.assumed_month} 月考虑。`}未接入实时天气，数量与款式请按需要补充。` : '手动挑选的物品会出现在这里，装好一件就勾掉一件。';
}

function updateProgress() {
  const packedCount = [...packed].filter(id => selected.has(id)).length;
  $('progressText').textContent = `${packedCount} / ${selected.size} 件已装好`;
  $('progressFill').style.width = `${selected.size ? packedCount / selected.size * 100 : 0}%`;
  $('uncheckButton').hidden = !packedCount;
}

function cancelPending() {
  clearTimeout(inputTimer);
  epoch++;
  controller?.abort();
  controller = null;
  activeTrip = '';
  setBusy(false);
}

function clearSelection() {
  result = null;
  selected.clear();
  packed.clear();
  world.reset();
  updateList();
}

function updateExamples() {
  const text = $('tripInput').value.trim();
  document.querySelectorAll('[data-trip]').forEach(button => button.classList.toggle('active', button.dataset.trip === text));
  $('clearButton').hidden = !text;
}

function handleInput() {
  cancelPending();
  currentTrip = $('tripInput').value.trim();
  updateExamples();
  if (!currentTrip) { clearSelection(); showSelection(); return; }
  if (result?.trip === currentTrip) { showSelection(); return; }
  setStatus('idle', '写下目的地和时长，行李就会开始集合。', '停顿片刻自动整理，也可以按回车。');
  if (!composing && currentTrip.length >= 2) inputTimer = setTimeout(() => searchTrip(), 850);
}

const healthReady = fetch('/api/health')
  .then(response => response.ok ? response.json() : Promise.reject(Error('health')))
  .then(data => {
    configured = Boolean(data.configured);
    $('connectionText').textContent = configured ? 'Jev 已就绪' : 'Jev 尚未配置';
    $('connectionDot').classList.toggle('connected', configured);
  })
  .catch(() => { $('connectionText').textContent = '服务暂未连接'; });

async function searchTrip() {
  clearTimeout(inputTimer);
  if (composing) return;
  const trip = $('tripInput').value.trim();
  if (!trip) {
    cancelPending(); currentTrip = ''; clearSelection(); showSelection();
    $('tripInput').focus();
    return;
  }
  if (activeTrip === trip) return;
  if (result?.trip === trip) {
    cancelPending(); currentTrip = trip; updateExamples(); showSelection();
    return;
  }
  cancelPending();
  currentTrip = trip;
  const requestEpoch = epoch;
  updateExamples();
  if (trip.length < 2) { setStatus('error', '再写一点吧，例如「去三亚 5 天」。', '目的地和时长都有了，才好挑行李。'); return; }
  await healthReady;
  if (requestEpoch !== epoch) return;
  if (!configured) { setStatus('error', '还没有连上 Jev，暂时无法自动挑选。', '你仍可以点击物品手动打包；检查本地服务和 key 后刷新。'); return; }
  if (cache.has(trip)) { applyResult(cache.get(trip)); return; }
  const requestController = new AbortController();
  controller = requestController;
  activeTrip = trip;
  setBusy(true);
  setStatus('loading', '正在替这趟旅行挑行李…', '目的地、时长，还有你想做的事，都一起考虑。');
  const timer = setTimeout(() => requestController.abort('timeout'), 30000);
  try {
    const response = await fetch('/api/pack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip }), signal: requestController.signal,
    });
    const data = await response.json();
    if (requestEpoch !== epoch) return;
    if (!response.ok) throw Error(data.error || '这次没整理好，再试一次吧。');
    if (!Array.isArray(data.selected) || data.selected.some(item => !byId.has(item.id))) throw Error('收到的清单不完整，请重新试一次。');
    cache.set(trip, data);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    applyResult(data);
  } catch (error) {
    if (requestEpoch !== epoch) return;
    const message = requestController.signal.aborted ? '这次等待有点久，再试一次吧。' : error.message;
    setStatus('error', message, selected.size ? '已保留当前清单，可以修改描述重试，也可以继续手动调整。' : '可以修改描述重试，也可以手动点选物品。');
  } finally {
    clearTimeout(timer);
    if (requestEpoch === epoch) { controller = null; activeTrip = ''; setBusy(false); }
  }
}

function applyResult(data) {
  result = data;
  selected.clear();
  packed.clear();
  for (const item of data.selected) selected.add(item.id);
  world.select([...selected]);
  updateList();
  showSelection();
}

$('tripInput').addEventListener('input', handleInput);
$('tripInput').addEventListener('compositionstart', () => { composing = true; cancelPending(); });
$('tripInput').addEventListener('compositionend', () => { composing = false; handleInput(); });
$('tripForm').addEventListener('submit', event => { event.preventDefault(); searchTrip(); });
$('clearButton').addEventListener('click', () => { $('tripInput').value = ''; handleInput(); $('tripInput').focus(); });
document.querySelectorAll('[data-trip]').forEach(button => button.addEventListener('click', () => {
  $('tripInput').value = button.dataset.trip;
  handleInput();
  searchTrip();
}));
$('retryButton').addEventListener('click', () => searchTrip());
$('shuffleButton').addEventListener('click', () => world.shuffle());
$('packingButton').addEventListener('click', () => { updateList(); $('packDialog').showModal(); });
$('closePack').addEventListener('click', () => $('packDialog').close());
$('howButton').addEventListener('click', () => $('aboutDialog').showModal());
for (const id of ['closeAbout', 'understoodButton']) $(id).addEventListener('click', () => $('aboutDialog').close());
for (const id of ['packDialog', 'aboutDialog']) $(id).addEventListener('click', event => {
  if (event.target !== $(id)) return;
  const rect = $(id).getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close();
});
$('packingList').addEventListener('change', event => {
  const id = event.target.dataset.pack;
  if (!selected.has(id)) return;
  if (event.target.checked) packed.add(id); else packed.delete(id);
  event.target.closest('.packing-row').classList.toggle('is-packed', event.target.checked);
  updateProgress();
});
$('packingList').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  selected.delete(button.dataset.remove); packed.delete(button.dataset.remove);
  world.select([...selected]); updateList(); showSelection(true);
});
$('uncheckButton').addEventListener('click', () => { packed.clear(); updateList(); });
$('copyButton').addEventListener('click', async () => {
  const lines = ['🧳 带什么 · 旅行打包清单', result?.trip || currentTrip || '我的旅行', ''];
  for (const item of ITEMS.filter(item => selected.has(item.id))) lines.push(`${packed.has(item.id) ? '☑' : '☐'} ${item.emoji} ${item.name}`);
  lines.push('', result ? '根据行程挑选，出发前请再确认天气和个人需要。' : '手动整理的打包清单。');
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    $('copyButton').innerHTML = `${icon('check')}<span>已复制，准备出发</span>`;
    setTimeout(() => { $('copyButton').innerHTML = `${icon('copy')}<span>复制打包清单</span>`; }, 2200);
  } catch {
    $('copyButton').innerHTML = '<span>复制未成功，请允许剪贴板访问后重试</span>';
  }
});
window.addEventListener('pagehide', event => {
  cancelPending();
  if (!event.persisted) { world.destroy(); return; }
  if (currentTrip && !result && !selected.size) setStatus('notice', '行程已保留，按回车继续整理。', '也可以点一下物品，自己挑选。');
  else showSelection();
});
updateList();
