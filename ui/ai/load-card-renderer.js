function compactLocation(location = {}) {
  const city = String(location?.city || '').trim();
  const state = String(location?.state || '').trim();
  return [city, state].filter(Boolean).join(', ');
}

function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : '';
}

function formatWeight(value) {
  const text = formatNumber(value);
  return text ? `${text} lbs` : '';
}

function formatDimensions(load = {}) {
  const parts = [];
  const length = Number(load.length || 0);
  if (length > 0) parts.push(`${length}' L`);

  const raw = load.raw || {};
  const width = Number(raw.dimensionsWidth || raw.width || 0);
  const height = Number(raw.dimensionsHeight || raw.height || 0);
  if (width > 0) parts.push(`${width}' W`);
  if (height > 0) parts.push(`${height}' H`);

  return parts.join(' | ');
}

function formatMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? `$${num.toLocaleString('en-US')}` : '';
}

function formatRpm(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? `$${num.toFixed(2)}/mi` : '';
}

function formatDateWindow(start, end) {
  const from = String(start || '').trim();
  const to = String(end || '').trim();
  if (from && to && from !== to) return `${from} - ${to}`;
  return from || to || '';
}

function extractAdditionalStops(load = {}) {
  const raw = load.raw || {};
  const candidates = [
    raw.additionalLoadStops,
    raw.numberOfStops,
    raw.stopsCount,
    raw.stopCount
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return `${num} additional stop${num === 1 ? '' : 's'}`;
    }
  }

  return '';
}

function buildRouteInfoLines(load = {}) {
  const origin = compactLocation(load.origin);
  const destination = compactLocation(load.destination);
  const deadhead = Number(load.deadhead || 0);
  const route = [
    deadhead > 0 ? `${origin} (${Math.round(deadhead)} mi)` : origin,
    destination
  ].filter(Boolean).join(' → ');

  const lines = [];
  if (route) lines.push(route);

  const stops = extractAdditionalStops(load);
  if (stops) lines.push(stops);

  const pickupWindow = formatDateWindow(load.pickupDate, load.pickupDateEnd);
  if (pickupWindow) lines.push(`Pickup: ${pickupWindow}`);

  return lines;
}

function buildLoadDetailsLine(load = {}) {
  return [
    load.miles ? `${Math.round(load.miles)} mi` : '',
    String(load.equipmentName || load.equipment || '').trim(),
    formatWeight(load.weight),
    formatDimensions(load)
  ].filter(Boolean).join(' | ');
}

function rawBrokerName(load = {}) {
  const raw = load.raw || {};
  return raw.contactName || raw.dispatchName || raw.contact?.name || raw.postAsUser?.firstName || '';
}

function formatBrokerPhone(broker = {}) {
  const phone = String(broker.phone || '').trim();
  const ext = String(broker.phoneExt || '').trim();
  if (!phone) return '';
  return ext ? `${phone} ext. ${ext}` : phone;
}

function buildContactLines(load = {}) {
  const broker = load.broker || {};
  return [
    String(broker.company || '').trim(),
    broker.mc || broker.dot ? [`Broker MC: ${broker.mc || ''}`, broker.dot ? `DOT: ${broker.dot}` : ''].filter(Boolean).join(' | ') : '',
    String(rawBrokerName(load) || '').trim(),
    formatBrokerPhone(broker),
    String(broker.email || '').trim()
  ].filter(Boolean);
}

function createCardSection(title, lines = []) {
  const filtered = lines.filter(Boolean);
  if (!filtered.length) return null;

  const section = document.createElement('div');
  section.className = 'ai-load-card-section';

  const titleEl = document.createElement('div');
  titleEl.className = 'ai-load-card-section-title';
  titleEl.textContent = title;
  section.appendChild(titleEl);

  const body = document.createElement('div');
  body.className = 'ai-load-card-section-body';
  body.textContent = filtered.join('\n');
  section.appendChild(body);

  return section;
}

export function createLoadCardNode(load = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'ai-msg assistant ai-load-card-msg';

  const card = document.createElement('div');
  card.className = 'ai-load-card';

  const header = document.createElement('div');
  header.className = 'ai-load-card-header';
  header.textContent = compactLocation(load.origin) && compactLocation(load.destination)
    ? `${compactLocation(load.origin)} → ${compactLocation(load.destination)}`
    : (load.id || 'Load');
  card.appendChild(header);

  const routeSection = createCardSection('Route Info', buildRouteInfoLines(load));
  const detailsSection = createCardSection('Load Details', [buildLoadDetailsLine(load)]);
  const rateSection = createCardSection('Rate Info', [
    load.rate ? `Posted Rate: ${formatMoney(load.rate)}` : '',
    load.rpm ? `RPM: ${formatRpm(load.rpm)}` : ''
  ]);
  const descriptionSection = createCardSection('Full Description', [String(load.notes || '').trim()]);
  const contactSection = createCardSection('Contact Information', buildContactLines(load));

  [routeSection, detailsSection, rateSection, descriptionSection, contactSection]
    .filter(Boolean)
    .forEach((section) => card.appendChild(section));

  wrapper.appendChild(card);
  return wrapper;
}

export function renderChatLoadCards(loads = [], appendChatNode, limit = 3) {
  const selectedLoads = Array.isArray(loads) ? loads.slice(0, limit) : [];
  selectedLoads.forEach((load) => {
    appendChatNode(createLoadCardNode(load));
  });
}
