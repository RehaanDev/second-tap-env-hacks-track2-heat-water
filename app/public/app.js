// Second Tap: browser code. Plain JavaScript, no framework.
//
// Sections in this file:
//   1. Helpers            small tools used everywhere
//   2. Map                the shared map set-up
//   3. Find water         a construction site searches, sees a plan, posts a request
//   4. List spare water   an apartment publishes, edits, pauses or deletes a listing
//   5. Water wanted       apartments browse requests from sites
//   6. Close a request    a site closes its request from its private link
//   7. How water is checked
//   8. Page switching

(function () {
  'use strict';

  // Approximate centres of Bengaluru areas, for people who would rather pick
  // a name than tap a map. Tapping the map afterwards gives the exact spot.
  const AREAS = [
    ['Banashankari', 12.9255, 77.5468], ['Bellandur', 12.9304, 77.6784], ['Devanahalli', 13.2437, 77.7172],
    ['Electronic City', 12.8452, 77.6602], ['Hebbal', 13.0358, 77.597], ['Hennur', 13.0401, 77.6431],
    ['HSR Layout', 12.9116, 77.6389], ['Indiranagar', 12.9784, 77.6408], ['Jakkur', 13.0784, 77.6069],
    ['JP Nagar', 12.9063, 77.5857], ['Kengeri', 12.9177, 77.4838], ['Koramangala', 12.9352, 77.6245],
    ['KR Puram', 13.0075, 77.6959], ['Marathahalli', 12.9569, 77.7011], ['Rajajinagar', 12.9982, 77.553],
    ['Sarjapur Road', 12.91, 77.685], ['Varthur', 12.9389, 77.7412], ['Whitefield', 12.9698, 77.75],
    ['Yelahanka', 13.1005, 77.5963], ['Yeshwanthpur', 13.028, 77.5409],
  ].map(([name, lat, lng]) => ({ name, lat, lng }));

  const BENGALURU = [12.9716, 77.5946];
  const VERDICT_TEXT = { fit: 'Fit', check: 'Check first', unfit: 'Not suitable' };
  const VERDICT_COLOUR = { fit: '#1b7f4b', check: '#d08a00', unfit: '#b3261e', plain: '#0e6e73' };
  const QUALITY_FIELDS = ['ph', 'bod', 'cod', 'tss', 'fc', 'chloride', 'sulphate'];

  let uses = []; // filled from the server: [{ id, label }]
  let requestDays = 30;
  const useLabel = (id) => (uses.find((u) => u.id === id) || {}).label || '';

  // =====================================================================
  // 1. HELPERS
  // =====================================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const fmt = (n) => Number(n).toLocaleString('en-IN');
  const rupees = (n) => '₹' + fmt(n);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  // Build DOM elements safely. Text is always inserted as text, never as HTML,
  // so a listing name can never inject a script.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw { message: 'Could not reach the server. Check your internet connection and try again.' };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = res.status === 429 ? 'Too many requests just now. Wait a few seconds and try again.' : data.message;
      throw { status: res.status, message: message || 'Something went wrong. Try again.', errors: data.errors };
    }
    return data;
  }

  function clearErrors(form) {
    form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
    form.querySelectorAll('.field .error').forEach((p) => { p.hidden = true; p.textContent = ''; });
    const top = $('.form-error', form);
    top.hidden = true;
    top.textContent = '';
  }

  function showErrors(form, err) {
    const errors = err.errors || {};
    let first;
    for (const [name, message] of Object.entries(errors)) {
      const field = form.querySelector(`[data-field="${name}"]`);
      if (!field) continue;
      field.classList.add('invalid');
      const p = $('.error', field);
      p.textContent = message;
      p.hidden = false;
      first = first || field;
    }
    const top = $('.form-error', form);
    top.textContent = first ? 'Fix the highlighted details above, then try again.' : err.message || 'Something went wrong. Try again.';
    top.hidden = false;
    if (first) {
      const input = $('input, select, button', first);
      if (input) input.focus();
      first.scrollIntoView({ block: 'center' });
    }
  }

  // Runs a form's submit action with the button disabled and a "working" label.
  async function withBusyButton(form, busyText, action) {
    const button = $('button[type="submit"]', form);
    const idleText = button.textContent;
    clearErrors(form);
    button.disabled = true;
    button.textContent = busyText;
    try {
      await action();
    } catch (err) {
      showErrors(form, err);
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  }

  function numberOrEmpty(id) {
    const v = $(id).value.trim();
    return v === '' ? '' : Number(v);
  }

  function daysAgo(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!Number.isFinite(days) || days <= 0) return 'today';
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }

  // Straight-line distance in km (same formula the server uses).
  function distanceKm(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  }

  const privateLink = (view, id, token) => `${location.origin}${location.pathname}#${view}?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  const whatsapp = (phone, text) => `https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(text)}`;

  // A box showing a private link, with Copy and "send to myself" buttons.
  function keepLinkBox(title, why, link) {
    const input = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Your private link' });
    const copy = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Copy link');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        input.select(); // older browsers: select it so the person can copy by hand
        return;
      }
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
    });
    input.addEventListener('focus', () => input.select());
    return h('div', { class: 'keep' },
      h('h3', null, title),
      h('p', null, why),
      h('div', { class: 'linkbox' }, input, copy),
      h('a', { class: 'btn btn-quiet', href: whatsapp('', `My Second Tap private link (do not share): ${link}`), target: '_blank', rel: 'noopener' }, 'Send it to myself on WhatsApp'));
  }

  // Call and WhatsApp buttons, or a note for sample records.
  function contactActions(record, message, extra) {
    if (record.sample) return h('p', { class: 'note' }, 'This is a sample for demonstration, so it has no contact number.');
    return h('div', { class: 'actions' },
      h('a', { class: 'btn btn-call', href: `tel:+91${record.phone}` }, `Call ${record.contactName}`),
      h('a', { class: 'btn btn-quiet', href: whatsapp(record.phone, message), target: '_blank', rel: 'noopener' }, 'WhatsApp'),
      extra);
  }

  // =====================================================================
  // 2. MAP
  // =====================================================================
  function makeMap(elementId, onPick) {
    if (!window.L) return null; // the page still works without the map
    const map = L.map(elementId, { scrollWheelZoom: false }).setView(BENGALURU, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    let pin, circle;
    if (onPick) map.on('click', (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }, 'map'));
    return {
      map,
      layer,
      squareIcon: () => L.divIcon({ className: '', html: '<div class="site-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      setPin(loc, zoom) {
        if (pin) pin.setLatLng([loc.lat, loc.lng]);
        else pin = L.marker([loc.lat, loc.lng], { icon: this.squareIcon(), keyboard: false, zIndexOffset: 1000 }).addTo(map);
        map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), zoom || 13));
      },
      clearPin() {
        if (pin) pin.remove();
        pin = null;
      },
      setRadius(loc, km) {
        if (circle) circle.remove();
        circle = L.circle([loc.lat, loc.lng], { radius: km * 1000, color: '#17262b', weight: 1.5, dashArray: '6 6', fillOpacity: 0.04, interactive: false }).addTo(map);
        map.fitBounds(circle.getBounds(), { padding: [10, 10] });
      },
      refresh() { setTimeout(() => map.invalidateSize(), 0); },
    };
  }

  function useGps(button, onFound, status) {
    if (!navigator.geolocation) {
      status.textContent = 'This browser cannot share its location. Pick an area or tap the map.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        button.disabled = false;
        onFound({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'gps');
      },
      () => {
        button.disabled = false;
        status.textContent = 'Could not get your location. Pick an area or tap the map instead.';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function clearLocationError(form) {
    const field = form.querySelector('[data-field="location"]');
    field.classList.remove('invalid');
    $('.error', field).hidden = true;
  }

  // =====================================================================
  // 3. FIND WATER
  // =====================================================================
  const find = { loc: null, areaName: '', map: null, supplies: [], requests: [] };

  function setFindLocation(loc, source, areaName) {
    find.loc = loc;
    find.areaName = source === 'area' ? areaName : '';
    const status = $('#find-loc-status');
    if (source === 'area') status.textContent = `Using the centre of ${areaName}. Tap the map to mark the exact spot.`;
    else {
      status.textContent = source === 'gps' ? 'Using your current location.' : 'Using the spot you marked on the map.';
      $('#find-area').value = '';
    }
    clearLocationError($('#find-form'));
    if (find.map) find.map.setPin(loc);
  }

  function updateNeedHint() {
    const need = Number($('#find-need').value);
    const tanker = Number($('#find-tanker').value) || 12;
    $('#find-need-hint').textContent =
      need > 0
        ? `${fmt(need)} KL is ${fmt(need * 1000)} litres, about ${Math.ceil(need / tanker)} tanker loads of ${tanker} KL.`
        : '1 KL is 1,000 litres.';
  }

  function plotSupplies(items) {
    // items: [{ supply, verdict? }]
    if (!find.map) return {};
    find.map.layer.clearLayers();
    const markers = {};
    for (const { supply, verdict } of items) {
      const marker = L.circleMarker([supply.lat, supply.lng], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: VERDICT_COLOUR[verdict || 'plain'], fillOpacity: 1,
      }).addTo(find.map.layer);
      marker.bindPopup(
        h('div', null,
          h('strong', null, supply.name), h('br'),
          `${supply.area}, ${fmt(supply.surplusKld)} KL a day at ${rupees(supply.pricePerKl)} per KL`,
          verdict ? [h('br'), VERDICT_TEXT[verdict]] : null)
      );
      markers[supply.id] = marker;
    }
    return markers;
  }

  function renderWelcome() {
    const total = find.supplies.reduce((sum, s) => sum + s.surplusKld, 0);
    const wanted = find.requests.reduce((sum, r) => sum + r.needKld, 0);
    $('#results').replaceChildren(
      find.supplies.length
        ? h('div', { class: 'empty' },
            h('h2', null, `${plural(find.supplies.length, 'apartment is', 'apartments are')} listing ${fmt(total)} KL of spare treated water a day`),
            h('p', null, 'Fill in your site details above to see which of them are near you and suit your work.'),
            find.requests.length > 0 && h('p', null, `${plural(find.requests.length, 'site is', 'sites are')} asking for ${fmt(wanted)} KL a day. `, h('a', { href: '#wanted' }, 'See what sites want')))
        : h('div', { class: 'empty' },
            h('h2', null, 'No apartments have listed water yet'),
            h('p', null, 'If you manage an apartment with a sewage treatment plant, you can be the first.'),
            h('a', { class: 'btn btn-quiet', href: '#list' }, 'List spare water'))
    );
  }

  function checksTable(checks) {
    const word = { pass: 'Within limit', fail: 'Over limit', missing: 'Not reported' };
    return h('div', { class: 'table-wrap' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Reported'), h('th', null, 'Limit'), h('th', null, 'Result'))),
        h('tbody', null, checks.map((c) =>
          h('tr', null,
            h('td', null, c.label, c.unit ? ` (${c.unit})` : ''),
            h('td', { class: 'num' }, c.value === null ? 'none' : fmt(c.value)),
            h('td', null, `${c.limit}, ${c.source}`),
            h('td', { class: 's-' + c.status }, word[c.status]))))));
  }

  // One line telling the buyer how far to trust the numbers.
  function trustLine(s) {
    if (s.sample) return null;
    if (s.reportStatus === 'matches') return h('p', { class: 'trust trust-ok' }, 'The numbers match the attached lab report.');
    if (s.reportStatus === 'differs') return h('p', { class: 'trust trust-bad' }, 'The numbers do not match the attached lab report.');
    if (s.reportStatus === 'unchecked') return h('p', { class: 'trust' }, 'A lab report is attached. Open it to confirm the numbers.');
    return h('p', { class: 'trust' }, 'No lab report attached. The seller typed these numbers in.');
  }

  function resultCard(match, request, markers) {
    const s = match.supply;
    const c = match.cost;
    const covered = Math.round(match.coverage * 100);
    const usable = match.verdict !== 'unfit';

    const costLine = s.delivery === 'pipeline'
      ? h('p', { class: 'cost' }, h('b', null, rupees(c.total)), ` a day for ${fmt(c.volumeKl)} KL of water. This seller can supply by pipeline, so no tanker trips are counted.`)
      : h('p', { class: 'cost' }, h('b', null, rupees(c.total)), ` a day: ${rupees(c.waterCost)} for water and ${rupees(c.transportCost)} for ${plural(c.trips, 'tanker trip', 'tanker trips')}. That is ${rupees(c.perKl)} per KL.`);

    const message = `Hello, I found your treated water listing on Second Tap. My site needs about ${request.needKld} KL a day for ${useLabel(request.use).toLowerCase()}. Is it available?`;
    const reportButton = s.hasReport && h('a', { class: 'btn btn-quiet', href: `/api/report?id=${encodeURIComponent(s.id)}`, target: '_blank', rel: 'noopener' }, 'Lab report');

    const card = h('article', { class: `card v-${match.verdict}`, 'data-id': s.id },
      h('div', { class: 'card-head' },
        h('div', null,
          h('h3', null, s.name, s.sample && h('span', { class: 'sample' }, 'Sample')),
          h('p', { class: 'where' }, `${s.area}, ${match.distanceKm < 0.1 ? 'less than 0.1' : match.distanceKm} km away in a straight line`)),
        h('span', { class: `tag tag-${match.verdict}` }, VERDICT_TEXT[match.verdict])),
      h('ul', { class: 'reasons' }, match.reasons.map((r) => h('li', null, r))),
      usable && trustLine(s),
      usable && h('div', { class: 'gauge' },
        h('div', { class: 'gauge-pipe', role: 'img', 'aria-label': `Covers ${covered} percent of your need` },
          h('div', { class: 'gauge-fill', style: `width:${covered}%` })),
        h('p', null, `Can supply ${fmt(c.volumeKl)} of the ${fmt(request.needKld)} KL you need each day (has ${fmt(s.surplusKld)} KL spare).`)),
      usable && costLine,
      h('details', null,
        h('summary', null, `Lab values, tested ${s.testDate}`),
        checksTable(match.checks)),
      usable && contactActions(s, message, reportButton),
      usable && !s.sample && h('p', { class: 'updated' }, `Listing updated ${daysAgo(s.updatedAt)}.`));

    card.addEventListener('mouseenter', () => highlight(card, markers));
    card.addEventListener('focusin', () => highlight(card, markers));
    return card;
  }

  function highlight(card, markers) {
    document.querySelectorAll('.card.active').forEach((el) => el.classList.remove('active'));
    card.classList.add('active');
    // Make this listing's dot on the map bigger, and the others normal.
    for (const [id, marker] of Object.entries(markers)) {
      const on = id === card.dataset.id;
      marker.setStyle({ radius: on ? 14 : 9, color: on ? '#17262b' : '#ffffff' });
      if (on) marker.bringToFront();
    }
  }

  // The suggested order: how much to take from which apartment.
  function planBox(plan, request) {
    if (plan.steps.length === 0) return null;
    return h('div', { class: 'plan' },
      h('h2', null, plan.steps.length === 1 ? 'Suggested order' : `Suggested order from ${plan.steps.length} apartments`),
      h('ol', null, plan.steps.map((s) =>
        h('li', null, h('strong', null, `${fmt(s.volumeKl)} KL from ${s.name}`),
          s.trips > 0 ? `, ${plural(s.trips, 'tanker trip', 'tanker trips')}, ${rupees(s.total)}` : `, by pipeline, ${rupees(s.total)}`))),
      h('p', { class: 'total' }, h('b', null, rupees(plan.total)), ` a day for ${fmt(plan.coveredKl)} KL, which is ${rupees(plan.perKl)} per KL.`),
      plan.shortKl > 0 && h('p', { class: 'short' }, `That leaves you ${fmt(plan.shortKl)} KL a day short. Post your request below so more apartments can find you.`));
  }

  // The form a site uses to post its request publicly.
  function postRequestPanel(request) {
    const form = h('form', { class: 'panel post', novalidate: true },
      h('h2', null, 'Let apartments come to you'),
      h('p', null, `Post this request for ${fmt(request.needKld)} KL a day and apartment managers nearby can see it and call you. It stays up for ${requestDays} days, or until you close it.`),
      h('div', { class: 'field', 'data-field': 'siteName' },
        h('label', { for: 'post-site' }, 'Site or project name'),
        h('input', { id: 'post-site', type: 'text', maxlength: '80' }),
        h('p', { class: 'error', hidden: true })),
      h('div', { class: 'field', 'data-field': 'area' },
        h('label', { for: 'post-area' }, 'Area'),
        h('input', { id: 'post-area', type: 'text', maxlength: '60', value: find.areaName }),
        h('p', { class: 'error', hidden: true })),
      h('div', { class: 'pair' },
        h('div', { class: 'field', 'data-field': 'contactName' },
          h('label', { for: 'post-contact' }, 'Your name'),
          h('input', { id: 'post-contact', type: 'text', maxlength: '60', autocomplete: 'name' }),
          h('p', { class: 'error', hidden: true })),
        h('div', { class: 'field', 'data-field': 'phone' },
          h('label', { for: 'post-phone' }, 'Mobile number'),
          h('input', { id: 'post-phone', type: 'tel', inputmode: 'numeric', maxlength: '14', autocomplete: 'tel' }),
          h('p', { class: 'error', hidden: true }))),
      h('p', { class: 'hint' }, 'Your name and number are shown publicly on the request so apartments can call.'),
      h('button', { class: 'btn btn-main', type: 'submit' }, 'Post my request'),
      h('p', { class: 'form-error error', hidden: true, role: 'alert' }));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      withBusyButton(form, 'Posting…', async () => {
        const data = await api('POST', '/api/requests', {
          siteName: $('#post-site').value, area: $('#post-area').value,
          lat: request.lat, lng: request.lng, needKld: request.needKld, use: request.use,
          contactName: $('#post-contact').value, phone: $('#post-phone').value,
        });
        const done = h('div', { class: 'done post' },
          h('h2', null, 'Your request is posted'),
          h('p', null, `Apartment managers can now see that ${data.request.siteName} needs ${fmt(data.request.needKld)} KL a day and call ${data.request.contactName}. It stays up for ${data.days} days.`),
          keepLinkBox('Keep this private link', 'Open it when you have found water, to take your request down. Anyone with this link can close the request, so do not share it.', privateLink('close', data.request.id, data.manageToken)),
          h('a', { class: 'btn btn-quiet', href: '#wanted' }, 'See it under Water wanted'));
        form.replaceWith(done);
        done.scrollIntoView({ block: 'center' });
        loadLists();
      });
    });
    return form;
  }

  function renderMatches({ request, matches, plan }) {
    const box = $('#results');
    const label = useLabel(request.use).toLowerCase();
    const markers = plotSupplies(matches);
    if (find.map) find.map.setRadius(request, request.radiusKm);

    if (matches.length === 0) {
      box.replaceChildren(
        h('div', { class: 'empty' },
          h('h2', null, `No apartments within ${request.radiusKm} km have listed water`),
          h('p', null, 'Try a wider search distance, or check the spot you marked on the map.'),
          h('p', null, 'You can also post your request, so apartments near you can find it.')),
        postRequestPanel(request));
      box.scrollIntoView({ block: 'start' });
      return;
    }

    const fit = matches.filter((m) => m.verdict === 'fit');
    const check = matches.filter((m) => m.verdict === 'check');

    let headline, detail;
    if (fit.length > 0) {
      headline = `${plural(fit.length, 'apartment', 'apartments')} within ${request.radiusKm} km can supply water fit for ${label}`;
      detail = h('p', null, 'Together they cover ', h('strong', null, `${fmt(plan.coveredKl)} of your ${fmt(request.needKld)} KL a day`),
        `. That is ${fmt(plan.freshWaterSavedLitres)} litres of fresh water a day that does not have to come from a borewell.`);
    } else if (check.length > 0) {
      headline = `${check.length} nearby ${check.length === 1 ? 'apartment needs' : 'apartments need'} a check before use for ${label}`;
      detail = h('p', null, 'Nothing fails the limits, but some information is missing or out of date. See each listing for what to ask.');
    } else {
      headline = `No nearby apartment has water suitable for ${label}`;
      detail = h('p', null, 'The listings below are over a limit. Try a wider search distance or a different use.');
    }

    box.replaceChildren(
      h('div', { class: 'summary' }, h('h2', null, headline), detail),
      ...[planBox(plan, request)].filter(Boolean),
      ...matches.map((m) => resultCard(m, request, markers)),
      postRequestPanel(request));
    box.scrollIntoView({ block: 'start' });
  }

  function submitFind(event) {
    event.preventDefault();
    const form = event.currentTarget;
    withBusyButton(form, 'Finding water…', async () => {
      try {
        renderMatches(await api('POST', '/api/match', {
          lat: find.loc ? find.loc.lat : '',
          lng: find.loc ? find.loc.lng : '',
          needKld: numberOrEmpty('#find-need'),
          use: $('#find-use').value,
          radiusKm: Number($('input[name="radius"]:checked').value),
          tankerKl: numberOrEmpty('#find-tanker'),
          tripCost: numberOrEmpty('#find-trip'),
        }));
      } catch (err) {
        if (err.errors && (err.errors.tankerKl || err.errors.tripCost)) $('#find-form .more').open = true;
        throw err;
      }
    });
  }

  // Loads the public lists (listings and requests) used by several screens.
  async function loadLists() {
    const [supplies, requests] = await Promise.all([
      api('GET', '/api/supplies').then((d) => d.supplies, () => []),
      api('GET', '/api/requests').then((d) => d.requests, () => []),
    ]);
    find.supplies = supplies;
    find.requests = requests;
    // Only redraw the welcome state if the person has not searched yet.
    if (!$('#results .summary') && !$('#results .post')) {
      plotSupplies(supplies.map((supply) => ({ supply })));
      renderWelcome();
    }
    renderWanted();
  }

  function initFind() {
    const areaSelect = $('#find-area');
    for (const a of AREAS) areaSelect.append(h('option', { value: a.name }, a.name));
    areaSelect.addEventListener('change', () => {
      const area = AREAS.find((a) => a.name === areaSelect.value);
      if (area) setFindLocation(area, 'area', area.name);
    });
    find.map = makeMap('find-map', (loc, source) => setFindLocation(loc, source));
    $('#find-gps').addEventListener('click', (e) => useGps(e.currentTarget, setFindLocation, $('#find-loc-status')));
    $('#find-need').addEventListener('input', updateNeedHint);
    $('#find-tanker').addEventListener('input', updateNeedHint);
    $('#find-form').addEventListener('submit', submitFind);
    updateNeedHint();
  }

  // =====================================================================
  // 4. LIST SPARE WATER (and manage an existing listing)
  // =====================================================================
  const REPORT_HINT = 'We read the numbers from it and fill them in below. Up to 5 MB. Buyers trust listings with a report more.';
  const list = {
    loc: null, map: null,
    upload: { types: [], maxBytes: 5242880 },
    reportKey: '',      // storage key of a report uploaded in this visit
    reportWork: null,   // the upload-and-read job in progress, if any
    edit: null,         // { id, token, supply } when managing an existing listing
  };

  function setListLocation(loc, source, areaName) {
    list.loc = loc;
    const status = $('#list-loc-status');
    if (source === 'area') status.textContent = `Using the centre of ${areaName}. Tap the map to mark your apartment exactly.`;
    else if (source === 'saved') status.textContent = 'Using your saved location. Tap the map to move it.';
    else status.textContent = source === 'gps' ? 'Using your current location.' : 'Using the spot you marked on the map.';
    clearLocationError($('#list-form'));
    if (list.map) list.map.setPin(loc, 14);
  }

  function setReportStatus(text, tone) {
    const status = $('#report-status');
    status.textContent = text;
    status.className = 'hint' + (tone ? ' ' + tone : '');
  }

  function reportError(message) {
    const field = $('#list-form [data-field="report"]');
    field.classList.add('invalid');
    const p = $('.error', field);
    p.textContent = message;
    p.hidden = false;
  }

  // Runs as soon as a file is chosen: upload it, then ask the AI to read it.
  async function handleReportFile(file) {
    const field = $('#list-form [data-field="report"]');
    field.classList.remove('invalid');
    $('.error', field).hidden = true;
    list.reportKey = '';
    document.querySelectorAll('#list-form .field.filled').forEach((f) => f.classList.remove('filled'));

    if (!file) return setReportStatus(REPORT_HINT);
    if (!list.upload.types.includes(file.type)) {
      setReportStatus(REPORT_HINT);
      return reportError('Upload a PDF, JPG or PNG file.');
    }
    if (file.size > list.upload.maxBytes) {
      setReportStatus(REPORT_HINT);
      return reportError('That file is larger than 5 MB. Choose a smaller one.');
    }

    try {
      setReportStatus('Uploading your report…', 'working');
      const ticket = await api('POST', '/api/upload-url', { contentType: file.type });
      const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file }).catch(() => null);
      if (!put || !put.ok) throw new Error('upload');
      list.reportKey = ticket.key;
    } catch {
      setReportStatus(REPORT_HINT);
      return reportError('The lab report could not be uploaded. Try again, or publish without it.');
    }

    // From here on the report is attached. Reading it is a bonus.
    setReportStatus('Report attached. Reading the numbers from it…', 'working');
    let reading;
    try {
      reading = await api('POST', '/api/read-report', { key: list.reportKey });
    } catch {
      reading = { available: false };
    }
    if (!reading.available) return setReportStatus('Report attached. Type the numbers from it below.', 'good');
    if (!reading.isWaterReport) return setReportStatus('Report attached, but it does not look like a water test report. Check that you chose the right file.', 'working');

    let filled = 0;
    for (const key of QUALITY_FIELDS) {
      if (reading.values[key] === undefined) continue;
      const input = $(`#q-${key}`);
      input.value = reading.values[key];
      input.closest('.field').classList.add('filled');
      filled += 1;
    }
    if (reading.testDate) {
      $('#q-date').value = reading.testDate;
      $('#q-date').closest('.field').classList.add('filled');
      filled += 1;
    }
    setReportStatus(
      filled > 0
        ? `Report attached. We filled in ${plural(filled, 'value', 'values')} from it. Check each one against your report before you publish.`
        : 'Report attached, but we could not read the numbers. Type them in below.',
      'good');
  }

  function listFormData() {
    return {
      name: $('#list-name').value,
      area: $('#list-area').value,
      lat: list.loc ? list.loc.lat : '',
      lng: list.loc ? list.loc.lng : '',
      surplusKld: numberOrEmpty('#list-surplus'),
      pricePerKl: numberOrEmpty('#list-price'),
      delivery: $('#list-delivery').value,
      quality: Object.fromEntries(QUALITY_FIELDS.map((key) => [key, numberOrEmpty(`#q-${key}`)])),
      testDate: $('#q-date').value,
      reportKey: list.reportKey,
      contactName: $('#list-contact').value,
      phone: $('#list-phone').value,
    };
  }

  function fitList(fitByUse) {
    return [
      h('ul', null, fitByUse.map((f) =>
        h('li', null, h('span', null, f.label), h('span', { class: `tag tag-${f.verdict}` }, VERDICT_TEXT[f.verdict])))),
      fitByUse.some((f) => f.verdict !== 'fit') && h('p', { class: 'hint' }, 'To move a result up to "Fit", test the missing values or fix the ones over the limit. ', h('a', { href: '#rules' }, 'How water is checked')),
    ];
  }

  function reportStatusLine(supply) {
    if (supply.reportStatus === 'matches') return h('p', { class: 'trust trust-ok' }, 'Your numbers match your lab report. Buyers will see this.');
    if (supply.reportStatus === 'differs') return h('p', { class: 'trust trust-bad' }, 'Some numbers you entered do not match your lab report. Buyers will see this until you correct them.');
    if (supply.reportStatus === 'unchecked') return h('p', { class: 'trust' }, 'Your lab report is attached. Buyers can open it.');
    return h('p', { class: 'trust' }, 'No lab report attached. Buyers trust listings with a report more.');
  }

  // Sites near this apartment that are already asking for water.
  function nearbyDemand(supply) {
    const near = find.requests.filter((r) => distanceKm(supply, r) <= 5);
    if (near.length === 0) return null;
    const total = near.reduce((sum, r) => sum + r.needKld, 0);
    return h('div', { class: 'nearby' },
      h('p', null, h('strong', null, `${plural(near.length, 'site', 'sites')} within 5 km ${near.length === 1 ? 'is' : 'are'} already asking for ${fmt(total)} KL a day.`), ' You can call them now.'),
      h('a', { class: 'btn btn-quiet', href: '#wanted' }, 'See who wants water'));
  }

  function resetListForm() {
    const form = $('#list-form');
    form.reset();
    clearErrors(form);
    form.hidden = false;
    list.loc = null;
    list.reportKey = '';
    if (list.map) list.map.clearPin();
    document.querySelectorAll('#list-form .field.filled').forEach((f) => f.classList.remove('filled'));
    setReportStatus(REPORT_HINT);
    $('#list-loc-status').textContent = 'Tap the map to mark your apartment.';
    $('#list-done').replaceChildren();
  }

  function renderPublished({ supply, fitByUse, manageToken }) {
    $('#list-form').hidden = true;
    const done = $('#list-done');
    done.replaceChildren(h('div', { class: 'done' },
      h('h2', null, `${supply.name} is listed`),
      h('p', null, `Construction sites near ${supply.area} can now find your ${fmt(supply.surplusKld)} KL a day and call ${supply.contactName}.`),
      keepLinkBox('Keep this private link', 'It is the only way to update, pause or remove your listing. Anyone with this link can change the listing, so do not share it.', privateLink('manage', supply.id, manageToken)),
      reportStatusLine(supply),
      nearbyDemand(supply),
      h('p', null, 'From your lab values, your water screens as:'),
      fitList(fitByUse),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-call', href: '#find' }, 'See it on the map'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { resetListForm(); window.scrollTo(0, 0); } }, 'List another'))));
    done.scrollIntoView({ block: 'start' });
    loadLists();
  }

  function submitList(event) {
    event.preventDefault();
    const form = event.currentTarget;
    withBusyButton(form, list.edit ? 'Saving…' : 'Publishing…', async () => {
      if (list.reportWork) await list.reportWork; // let a running upload finish first
      if (list.edit) {
        const data = await api('POST', '/api/supplies/update', {
          ...listFormData(), paused: list.edit.supply.paused, id: list.edit.id, token: list.edit.token,
        });
        list.edit.supply = data.supply;
        list.reportKey = '';
        $('#q-file').value = '';
        renderManageBar('Changes saved. Your listing is up to date.', data.fitByUse);
        $('#manage-bar').scrollIntoView({ block: 'start' });
        loadLists();
      } else {
        renderPublished(await api('POST', '/api/supplies', listFormData()));
      }
    });
  }

  // ----- managing an existing listing through its private link -----
  function renderManageBar(notice, fitByUse) {
    const { supply, id, token } = list.edit;
    const bar = $('#manage-bar');
    const key = { id, token };

    const pauseButton = h('button', { class: 'btn btn-quiet', type: 'button' }, supply.paused ? 'Show listing again' : 'Pause listing');
    pauseButton.addEventListener('click', async () => {
      pauseButton.disabled = true;
      try {
        const data = await api('POST', '/api/supplies/pause', { ...key, paused: !supply.paused });
        list.edit.supply = data.supply;
        renderManageBar(data.supply.paused ? 'Listing paused. Construction sites cannot see it.' : 'Listing is live again.');
        loadLists();
      } catch (err) {
        pauseButton.disabled = false;
        renderManageBar(err.message);
      }
    });

    // Deleting takes two clicks, so it cannot happen by accident.
    const deleteButton = h('button', { class: 'btn btn-danger', type: 'button' }, 'Delete listing');
    deleteButton.addEventListener('click', async () => {
      if (!deleteButton.classList.contains('sure')) {
        deleteButton.classList.add('sure');
        deleteButton.textContent = 'Yes, delete it for good';
        return;
      }
      deleteButton.disabled = true;
      try {
        await api('POST', '/api/supplies/delete', key);
        list.edit = null;
        $('#list-form').hidden = true;
        bar.replaceChildren(h('div', { class: 'done' },
          h('h2', null, `${supply.name} has been deleted`),
          h('p', null, 'The listing and its lab report are gone. You can list again whenever you have water to spare.'),
          h('a', { class: 'btn btn-quiet', href: '#list' }, 'List spare water')));
        loadLists();
      } catch (err) {
        deleteButton.disabled = false;
        renderManageBar(err.message);
      }
    });

    bar.replaceChildren(h('div', { class: 'panel' },
      notice && h('p', { class: 'notice' }, notice),
      h('h2', null, supply.name),
      supply.paused
        ? h('p', null, h('span', { class: 'status-paused' }, 'Paused.'), ' Construction sites cannot see this listing.')
        : h('p', null, h('span', { class: 'status-live' }, 'Live.'), ` Construction sites near ${supply.area} can see this listing. Last updated ${daysAgo(supply.updatedAt)}.`),
      reportStatusLine(supply),
      fitByUse && h('div', { class: 'done-fit' }, fitList(fitByUse)),
      h('div', { class: 'actions' }, pauseButton, deleteButton)));
  }

  function fillListForm(supply) {
    $('#list-name').value = supply.name;
    $('#list-area').value = supply.area;
    $('#list-surplus').value = supply.surplusKld;
    $('#list-price').value = supply.pricePerKl;
    $('#list-delivery').value = supply.delivery;
    for (const key of QUALITY_FIELDS) $(`#q-${key}`).value = supply.quality[key] ?? '';
    $('#q-date').value = supply.testDate;
    $('#list-contact').value = supply.contactName;
    $('#list-phone').value = supply.phone;
    setListLocation({ lat: supply.lat, lng: supply.lng }, 'saved');
    setReportStatus(supply.hasReport ? 'A lab report is already attached. Choose a file only if you want to replace it.' : REPORT_HINT);
  }

  function setListMode(editing) {
    $('#list-title').textContent = editing ? 'Update your listing' : "List your apartment's spare treated water";
    $('#list-lead').textContent = editing
      ? 'Change anything below and save. Update the spare water figure whenever it changes, and upload each new lab report.'
      : 'If your sewage treatment plant makes more water than you use for flushing and gardens, nearby construction sites can take it. Upload your latest lab report and we will fill in the numbers for you.';
    $('#list-form button[type="submit"]').textContent = editing ? 'Save changes' : 'Publish listing';
  }

  async function openManage(params) {
    resetListForm();
    setListMode(true);
    $('#list-form').hidden = true;
    const bar = $('#manage-bar');
    bar.replaceChildren(h('div', { class: 'panel' }, h('p', null, 'Opening your listing…')));
    try {
      const key = { id: params.get('id') || '', token: params.get('token') || '' };
      const data = await api('POST', '/api/supplies/manage', key);
      list.edit = { ...key, supply: data.supply };
      fillListForm(data.supply);
      $('#list-form').hidden = false;
      renderManageBar(null, data.fitByUse);
      if (list.map) list.map.refresh();
    } catch (err) {
      list.edit = null;
      bar.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, 'This link did not open a listing'),
        h('p', null, err.status === 403 ? 'Check that you copied the whole private link. If the listing was deleted, the link no longer works.' : err.message),
        h('a', { class: 'btn btn-quiet', href: '#list' }, 'List spare water')));
    }
  }

  function openNewListing() {
    if (list.edit || $('#manage-bar').childElementCount > 0) {
      list.edit = null;
      $('#manage-bar').replaceChildren();
      resetListForm();
    }
    setListMode(false);
  }

  function initList() {
    const options = $('#area-options');
    for (const a of AREAS) options.append(h('option', { value: a.name }));
    $('#list-area').addEventListener('change', (e) => {
      const area = AREAS.find((a) => a.name.toLowerCase() === e.target.value.trim().toLowerCase());
      if (area && !list.loc) setListLocation(area, 'area', area.name);
    });
    list.map = makeMap('list-map', (loc, source) => setListLocation(loc, source));
    $('#list-gps').addEventListener('click', (e) => useGps(e.currentTarget, setListLocation, $('#list-loc-status')));
    const now = new Date();
    $('#q-date').max = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $('#q-file').addEventListener('change', (e) => {
      list.reportWork = handleReportFile(e.target.files[0]).finally(() => { list.reportWork = null; });
    });
    // Once someone edits a value the AI filled in, stop highlighting it.
    $('#list-form').addEventListener('input', (e) => {
      const field = e.target.closest('.field.filled');
      if (field && e.target.type !== 'file') field.classList.remove('filled');
    });
    $('#list-form').addEventListener('submit', submitList);
  }

  // =====================================================================
  // 5. WATER WANTED
  // =====================================================================
  const wanted = { map: null };

  function renderWanted() {
    const box = $('#wanted-list');
    const area = AREAS.find((a) => a.name === $('#wanted-area').value);
    let items = find.requests.map((r) => ({ r, km: area ? distanceKm(area, r) : null }));
    if (area) items.sort((a, b) => a.km - b.km);

    if (wanted.map) {
      wanted.map.layer.clearLayers();
      for (const { r } of items) {
        L.marker([r.lat, r.lng], { icon: wanted.map.squareIcon(), keyboard: false })
          .bindPopup(h('div', null, h('strong', null, r.siteName), h('br'), `${r.area}, needs ${fmt(r.needKld)} KL a day`))
          .addTo(wanted.map.layer);
      }
      if (area) wanted.map.map.setView([area.lat, area.lng], 12);
    }

    if (items.length === 0) {
      box.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, 'No sites are asking for water right now'),
        h('p', null, 'List your spare water and sites will find you when they search.'),
        h('a', { class: 'btn btn-quiet', href: '#list' }, 'List my spare water')));
      return;
    }

    box.replaceChildren(...items.map(({ r, km }) => {
      const message = `Hello, I saw on Second Tap that ${r.siteName} needs about ${r.needKld} KL of treated water a day. Our apartment has treated water to spare.`;
      return h('article', { class: 'card v-site' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('h3', null, r.siteName, r.sample && h('span', { class: 'sample' }, 'Sample')),
            h('p', { class: 'where' }, r.area, km !== null && `, ${Math.round(km * 10) / 10} km from ${area.name}`))),
        h('p', { class: 'wanted-need' }, h('b', null, `${fmt(r.needKld)} KL a day`), ` for ${useLabel(r.use).toLowerCase() || 'construction'}`),
        h('p', { class: 'updated' }, `Posted ${daysAgo(r.createdAt)}.`),
        contactActions(r, message));
    }));
  }

  function initWanted() {
    const select = $('#wanted-area');
    for (const a of AREAS) select.append(h('option', { value: a.name }, a.name));
    select.addEventListener('change', renderWanted);
    wanted.map = makeMap('wanted-map');
  }

  // =====================================================================
  // 6. CLOSE A REQUEST (from the site's private link)
  // =====================================================================
  async function openClose(params) {
    const box = $('#close-box');
    const key = { id: params.get('id') || '', token: params.get('token') || '' };
    box.replaceChildren(h('p', null, 'Opening your request…'));
    try {
      const { request } = await api('POST', '/api/requests/manage', key);
      const button = h('button', { class: 'btn btn-main', type: 'button' }, 'Close this request');
      const problem = h('p', { class: 'error', hidden: true, role: 'alert' });
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api('POST', '/api/requests/close', key);
          box.replaceChildren(h('div', { class: 'done' },
            h('h2', null, 'Request closed'),
            h('p', null, `${request.siteName} is no longer shown to apartments. You can search again any time.`),
            h('a', { class: 'btn btn-quiet', href: '#find' }, 'Find water')));
          loadLists();
        } catch (err) {
          button.disabled = false;
          problem.textContent = err.message;
          problem.hidden = false;
        }
      });
      box.replaceChildren(h('div', { class: 'panel' },
        h('h2', null, request.siteName),
        h('p', null, `${request.area}. Needs ${fmt(request.needKld)} KL a day for ${useLabel(request.use).toLowerCase() || 'construction'}. Posted ${daysAgo(request.createdAt)}.`),
        h('p', null, 'Close it once you have found water, so apartments stop calling.'),
        button, problem));
    } catch (err) {
      box.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, 'This link did not open a request'),
        h('p', null, err.status === 403 ? `Check that you copied the whole private link. Requests also close by themselves after ${requestDays} days.` : err.message),
        h('a', { class: 'btn btn-quiet', href: '#find' }, 'Find water')));
    }
  }

  // =====================================================================
  // 7. HOW WATER IS CHECKED
  // =====================================================================
  function limitsTable(table, limits) {
    const range = (l) => [l.min !== undefined ? `at least ${l.min}` : null, l.max !== undefined ? `at most ${fmt(l.max)}` : null].filter(Boolean).join(', ');
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Limit'), h('th', null, 'Source'))),
      h('tbody', null, limits.map((l) => h('tr', null, h('td', null, l.label), h('td', null, range(l), l.unit ? ` ${l.unit}` : ''), h('td', null, l.source)))));
  }

  async function loadConfig() {
    const config = await api('GET', '/api/config');
    uses = config.uses;
    requestDays = config.requestDays;
    list.upload = config.upload;
    const select = $('#find-use');
    for (const u of config.uses) select.append(h('option', { value: u.id }, u.label));
    limitsTable($('#rules-baseline'), config.limits.baseline);
    limitsTable($('#rules-concrete'), config.limits.concrete);
    $('#rules-age').textContent = config.limits.reportMaxAgeDays;
  }

  // =====================================================================
  // 8. PAGE SWITCHING
  // =====================================================================
  // The part of the address after "#" picks the screen, for example
  // "#list" or "#manage?id=...&token=...".
  const VIEWS = { find: 'find', list: 'list', manage: 'list', wanted: 'wanted', close: 'close', rules: 'rules' };

  function showView() {
    const [rawName, query = ''] = location.hash.slice(1).split('?');
    const name = VIEWS[rawName] ? rawName : 'find';
    const params = new URLSearchParams(query);
    const section = VIEWS[name];

    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${section}`;
    for (const tab of document.querySelectorAll('.tabs a')) {
      if (tab.dataset.tab === section) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }

    if (name === 'manage') openManage(params);
    if (name === 'list') openNewListing();
    if (name === 'close') openClose(params);

    if (section === 'find' && find.map) find.map.refresh();
    if (section === 'list' && list.map) list.map.refresh();
    if (section === 'wanted' && wanted.map) wanted.map.refresh();
    window.scrollTo(0, 0);
  }

  initFind();
  initList();
  initWanted();
  window.addEventListener('hashchange', showView);
  // Load the settings first, because several screens need the list of uses.
  loadConfig()
    .catch(() => {
      $('#find-error').textContent = 'Could not load the page settings. Refresh to try again.';
      $('#find-error').hidden = false;
    })
    .then(() => {
      showView();
      loadLists();
    });
})();
